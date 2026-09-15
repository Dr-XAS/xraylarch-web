from __future__ import annotations

from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
import hashlib
import hmac
from pathlib import Path
import re
import secrets
import shutil
from typing import Iterator, Mapping, Sequence, get_args

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .athena import AthenaParameters, AthenaStore, now as athena_now, uid
from .config import Settings
from .integration_contracts import (
    AuthoritativeSpectrum,
    CoreProcessingRecipe,
    ComputedArray,
    ComputedImportResult,
    ImportSnapshot,
    ImportActionRequest,
    ImportState,
    snapshot_sha256,
    DraftStatus,
    LaunchEnvelope,
    OneTimeLaunchHandle,
    SealedImportEnvelope,
    canonical_sha256,
)
from .integration_storage import (
    BrowserSession,
    DraftRecord,
    IntegrationNotFoundError,
    IntegrationConflictError,
    IntegrationStorage,
    capability_for_handle,
)


_LOWER_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_REQUIRED_HEADERS = (
    "x-drxas-issuer",
    "x-drxas-audience",
    "x-drxas-timestamp",
    "x-drxas-nonce",
    "x-drxas-body-sha256",
    "x-drxas-signature",
)
_CORE_READ_ACTIONS = {"read_project", "export"}
_CORE_MUTATION_ACTIONS = {"metadata", "parameters", "set_e0", "undo", "redo"}


class SealedExportRequest(BaseModel):
    """Signed body of a sealed-export call.

    The draft id is carried in the body as well as the path because only the
    body is covered by the signature; without it a signed export could be
    redirected at a draft the caller never authorized.
    """

    model_config = ConfigDict(extra="forbid")
    draft_id: str = Field(min_length=1, max_length=200)
    owner_capability: str = Field(min_length=16, max_length=128, pattern=r"^[A-Za-z0-9_-]+$")


class IntegrationAuthenticationError(ValueError):
    pass


class IntegrationAuthorizationError(ValueError):
    pass


class IntegrationService:
    def __init__(
        self,
        settings: Settings,
        athena_store: AthenaStore,
        storage: IntegrationStorage,
    ) -> None:
        self.settings = settings
        self.athena_store = athena_store
        self.storage = storage

    @staticmethod
    def _headers(headers: Mapping[str, str]) -> dict[str, str]:
        normalized = {key.lower(): value for key, value in headers.items()}
        if any(not normalized.get(name) for name in _REQUIRED_HEADERS):
            raise IntegrationAuthenticationError("Integration authentication failed.")
        return normalized

    def _verify(
        self, *, raw_body: bytes, headers: Mapping[str, str], now: datetime
    ) -> tuple[str, datetime]:
        values = self._headers(headers)
        issuer = values["x-drxas-issuer"]
        audience = values["x-drxas-audience"]
        if not hmac.compare_digest(issuer, self.settings.integration_issuer or ""):
            raise IntegrationAuthenticationError("Integration authentication failed.")
        if not hmac.compare_digest(audience, self.settings.integration_audience or ""):
            raise IntegrationAuthenticationError("Integration authentication failed.")
        timestamp_text = values["x-drxas-timestamp"]
        nonce = values["x-drxas-nonce"]
        digest = values["x-drxas-body-sha256"]
        signature = values["x-drxas-signature"]
        if (
            not timestamp_text.isascii()
            or not timestamp_text.isdigit()
            or len(timestamp_text) > 16
            or not re.fullmatch(r"[A-Za-z0-9_-]{16,128}", nonce)
            or not _LOWER_SHA256.fullmatch(digest)
            or not _LOWER_SHA256.fullmatch(signature)
        ):
            raise IntegrationAuthenticationError("Integration authentication failed.")
        try:
            timestamp = datetime.fromtimestamp(int(timestamp_text), tz=UTC)
        except (OverflowError, OSError, ValueError):
            raise IntegrationAuthenticationError(
                "Integration authentication failed."
            ) from None
        if abs((now.astimezone(UTC) - timestamp).total_seconds()) > 300:
            raise IntegrationAuthenticationError("Integration authentication failed.")
        actual_digest = hashlib.sha256(raw_body).hexdigest()
        if not hmac.compare_digest(actual_digest, digest):
            raise IntegrationAuthenticationError("Integration authentication failed.")
        signing_input = "\n".join(
            (issuer, audience, timestamp_text, nonce, digest)
        ).encode()
        expected = hmac.new(
            (self.settings.integration_hmac_secret or "").encode(),
            signing_input,
            hashlib.sha256,
        ).hexdigest()
        if not hmac.compare_digest(expected, signature):
            raise IntegrationAuthenticationError("Integration authentication failed.")
        return nonce, timestamp

    @staticmethod
    def _parameters(envelope: LaunchEnvelope) -> dict:
        recipe = envelope.recipe
        values = AthenaParameters().model_dump()
        values.update(
            e0=recipe.normalization.e0,
            step=recipe.normalization.edge_step,
            pre1=recipe.normalization.pre1,
            pre2=recipe.normalization.pre2,
            norm1=recipe.normalization.norm1,
            norm2=recipe.normalization.norm2,
            nnorm=recipe.normalization.nnorm,
            nvict=recipe.normalization.nvict,
            flatten=recipe.normalization.flatten,
            energy_shift=recipe.normalization.energy_shift,
            rbkg=recipe.autobk.rbkg,
            bkg_kmin=recipe.autobk.kmin,
            bkg_kmax=recipe.autobk.kmax,
            bkg_kweight=recipe.autobk.kweight,
            bkg_dk=recipe.autobk.dk,
            bkg_window=recipe.autobk.window,
            nknots=recipe.autobk.nknots,
            nclamp=recipe.autobk.nclamp,
            clamp_lo=recipe.autobk.clamp_lo,
            clamp_hi=recipe.autobk.clamp_hi,
            kmin=recipe.forward_ft.kmin,
            kmax=recipe.forward_ft.kmax,
            kweight=recipe.forward_ft.kweight,
            dk=recipe.forward_ft.dk,
            dk2=recipe.forward_ft.dk2,
            window=recipe.forward_ft.window,
            rmax_out=recipe.forward_ft.rmax_out,
            forward_with_phase=recipe.forward_ft.with_phase,
            rmin=recipe.reverse_ft.rmin,
            rmax=recipe.reverse_ft.rmax,
            dr=recipe.reverse_ft.dr,
            dr2=recipe.reverse_ft.dr2,
            rwindow=recipe.reverse_ft.window,
            qmax_out=recipe.reverse_ft.qmax_out,
            reverse_nfft=recipe.reverse_ft.nfft,
            reverse_kstep=recipe.reverse_ft.kstep,
            reverse_with_phase=recipe.reverse_ft.with_phase,
            nfft=recipe.forward_ft.nfft,
            kstep=recipe.forward_ft.kstep,
        )
        return AthenaParameters.model_validate(values).model_dump()

    @staticmethod
    def _recipe_from_parameters(
        values: Mapping, *, recipe_version: int, larch_version: str
    ) -> CoreProcessingRecipe:
        """Invert ``_parameters``.

        Every recipe field maps to a distinct Athena key, so this is exact — but
        the recipe's own version stamps have no Athena home and must be supplied
        by the caller from the persisted launch origin.
        """

        return CoreProcessingRecipe.model_validate(
            {
                "recipe_version": recipe_version,
                "larch_version": larch_version,
                "normalization": {
                    "e0": values["e0"],
                    "edge_step": values["step"],
                    "pre1": values["pre1"],
                    "pre2": values["pre2"],
                    "norm1": values["norm1"],
                    "norm2": values["norm2"],
                    "nnorm": values["nnorm"],
                    "nvict": values["nvict"],
                    "flatten": values["flatten"],
                    "energy_shift": values["energy_shift"],
                },
                "autobk": {
                    "rbkg": values["rbkg"],
                    "kmin": values["bkg_kmin"],
                    "kmax": values["bkg_kmax"],
                    "kweight": values["bkg_kweight"],
                    "dk": values["bkg_dk"],
                    "window": values["bkg_window"],
                    "nknots": values["nknots"],
                    "nclamp": values["nclamp"],
                    "clamp_lo": values["clamp_lo"],
                    "clamp_hi": values["clamp_hi"],
                },
                "forward_ft": {
                    "kmin": values["kmin"],
                    "kmax": values["kmax"],
                    "kweight": values["kweight"],
                    "dk": values["dk"],
                    "dk2": values["dk2"],
                    "window": values["window"],
                    "rmax_out": values["rmax_out"],
                    "nfft": values["nfft"],
                    "kstep": values["kstep"],
                    "with_phase": values["forward_with_phase"],
                },
                "reverse_ft": {
                    "rmin": values["rmin"],
                    "rmax": values["rmax"],
                    "dr": values["dr"],
                    "dr2": values["dr2"],
                    "window": values["rwindow"],
                    "qmax_out": values["qmax_out"],
                    "nfft": values["reverse_nfft"],
                    "kstep": values["reverse_kstep"],
                    "with_phase": values["reverse_with_phase"],
                },
            }
        )

    def verified_export(
        self, *, raw_body: bytes, headers: Mapping[str, str], draft_id: str, now: datetime
    ) -> SealedImportEnvelope:
        """Authenticate a Dr.XAS-signed export call and build the envelope.

        Export needs BOTH proofs: the HMAC signature shows the caller is Dr.XAS,
        and the owner capability shows the draft is theirs. The browser holds the
        capability but can never produce the signature, so it cannot seal its own
        import source.
        """

        request = self._verified_export_request(raw_body=raw_body, headers=headers, draft_id=draft_id, now=now)
        return self.sealed_export(
            draft_id=draft_id, capability=request.owner_capability, now=now
        )

    def verified_snapshot(self, *, raw_body: bytes, headers: Mapping[str, str], draft_id: str, now: datetime) -> ImportSnapshot:
        request = self._verified_export_request(raw_body=raw_body, headers=headers, draft_id=draft_id, now=now)
        return self.import_snapshot(draft_id=draft_id, capability=request.owner_capability, now=now)

    def _verified_export_request(self, *, raw_body: bytes, headers: Mapping[str, str], draft_id: str, now: datetime, request_model=SealedExportRequest):
        nonce, timestamp = self._verify(raw_body=raw_body, headers=headers, now=now)
        request = request_model.model_validate_json(raw_body)
        # Redundant with the capability check below — a capability is derived
        # from one draft's handle and cannot authorize another — but it keeps
        # the signature an attestation of WHICH draft Dr.XAS authorized.
        if not hmac.compare_digest(request.draft_id, draft_id):
            raise IntegrationAuthorizationError("Integration draft was not found.")
        # Claimed only after the body validates, so a malformed signed request
        # does not burn a nonce the caller would then have to work around.
        self.storage.claim_nonce(
            nonce=nonce,
            expires_at=timestamp + timedelta(seconds=300, microseconds=1),
        )
        return request

    def verified_import_action(self, *, raw_body: bytes, headers: Mapping[str, str], draft_id: str, now: datetime) -> ImportState:
        request = self._verified_export_request(raw_body=raw_body, headers=headers,
            draft_id=draft_id, now=now, request_model=ImportActionRequest)
        self.storage.expire_due(now)
        if request.action == "status":
            record = self.storage.load_draft(draft_id, request.owner_capability)
            if record.status is DraftStatus.DISCARDED or (
                record.status is DraftStatus.EXPIRED and record.import_binding is None
            ):
                raise IntegrationNotFoundError("Integration draft was not found.")
        elif request.action == "prepare":
            def validate_snapshot(record):
                snapshot = self._snapshot_locked(draft_id=draft_id, capability=request.owner_capability, now=now)
                if (snapshot.project_version != request.binding.project_version
                        or snapshot_sha256(snapshot) != request.binding.snapshot_sha256):
                    raise IntegrationConflictError("The editor snapshot changed.")
            record = self.storage.prepare_import(draft_id, request.owner_capability,
                request.binding, now, validate_snapshot)
        else:
            record = self.storage.complete_import(draft_id, request.owner_capability,
                request.binding, now, commit=request.action == "finalize")
        return ImportState(source_sha256=record.source_sha256, status=record.status, binding=record.import_binding)

    def sealed_export(
        self, *, draft_id: str, capability: str, now: datetime
    ) -> SealedImportEnvelope:
        """Build the sealed import envelope for an owner-authorized draft.

        Read-only: sealing the draft is a separate transition so a failed or
        rejected import never leaves a draft that can no longer be edited.
        """

        self.storage.expire_due(now)
        with self.storage.draft_lock(draft_id):
            return self._export_locked(draft_id=draft_id, capability=capability, now=now)[0]

    def import_snapshot(self, *, draft_id: str, capability: str, now: datetime) -> ImportSnapshot:
        """Capture the cached displayed science and its version under the mutation lock."""
        self.storage.expire_due(now)
        with self.storage.draft_lock(draft_id):
            return self._snapshot_locked(draft_id=draft_id, capability=capability, now=now)

    def _snapshot_locked(self, *, draft_id: str, capability: str, now: datetime) -> ImportSnapshot:
        envelope, project, group = self._export_locked(draft_id=draft_id, capability=capability, now=now)
        if group.get("processing_error") or not isinstance(group.get("result"), dict):
            raise IntegrationAuthorizationError("Editor result is unavailable.")
        result = group["result"]
        effective = result.get("effective") or {}
        arrays = result.get("arrays") or {}
        computed = ComputedImportResult.model_validate({
            "arrays": {name: tuple(arrays.get(name, ())) for name in get_args(ComputedArray)},
            "e0": effective.get("e0"), "edge_step": effective.get("edge_step"),
        })
        return ImportSnapshot(envelope=envelope, project_version=project["version"], computed=computed)

    def _export_locked(self, *, draft_id: str, capability: str, now: datetime):
        try:
            draft = self.storage.load_draft(draft_id, capability)
        except IntegrationNotFoundError as exc:
            raise IntegrationAuthorizationError(
                "Integration draft was not found."
            ) from exc
        self.allowed_operation("export", group_ids=(draft.group_id,), draft=draft)
        if draft.origin is None:
            raise IntegrationAuthorizationError("Integration draft was not found.")

        project = self.athena_store.load(draft.project_id)
        group = next(
            (
                candidate
                for candidate in project.get("groups", ())
                if candidate.get("id") == draft.group_id
            ),
            None,
        )
        if group is None:
            raise IntegrationAuthorizationError("Integration draft was not found.")

        spectrum = AuthoritativeSpectrum.model_validate(
            {"energy": tuple(group["energy"]), "mu": tuple(group["mu"])}
        )
        spectrum_sha256 = canonical_sha256(spectrum)
        if spectrum_sha256 != draft.origin.spectrum_sha256:
            # The editor never edits the authoritative arrays, so a changed
            # digest means the workspace was tampered with rather than edited.
            raise IntegrationAuthorizationError("Integration draft was not found.")

        recipe = self._recipe_from_parameters(
            group["parameters"],
            recipe_version=draft.origin.recipe_version,
            larch_version=draft.origin.larch_version,
        )
        envelope = SealedImportEnvelope(
            schema_version=1,
            draft_id=draft.id,
            source=draft.origin.source,
            spectrum=spectrum,
            recipe=recipe,
            spectrum_sha256=spectrum_sha256,
            recipe_sha256=canonical_sha256(recipe),
            sealed_at=now,
        )

        return envelope, project, group

    def _project(self, envelope: LaunchEnvelope, project_id: str, group_id: str) -> dict:
        parameters = self._parameters(envelope)
        group = {
            "id": group_id,
            "label": envelope.provenance.source_filename or "Dr.XAS spectrum",
            "energy": list(envelope.spectrum.energy),
            "mu": list(envelope.spectrum.mu),
            "data_type": "mu",
            "parameters": parameters,
            "marked": True,
            "frozen": False,
            "multiplier": 1.0,
            "offset": 0.0,
            "notes": "",
            "reference_id": None,
            "background_standard_id": None,
            "source": {
                "integration": True,
                "artifact_sha256": envelope.source.artifact_sha256,
                "spectrum_sha256": envelope.spectrum_sha256,
            },
            "result": None,
            "processing_error": None,
            "is_difference": False,
        }
        try:
            self.athena_store.process(group)
        except Exception as exc:
            group["processing_error"] = str(exc)
        stamp = athena_now()
        return {
            "id": project_id,
            "format": "athena-web",
            "schema_version": 1,
            "name": envelope.provenance.source_filename or "Dr.XAS draft",
            "version": 0,
            "groups": [group],
            "journal": "",
            "history": [],
            "undo": [],
            "redo": [],
            "analyses": [],
            "created": stamp,
            "updated": stamp,
            "integration": True,
        }

    def bootstrap(
        self, *, raw_body: bytes, headers: Mapping[str, str], now: datetime
    ) -> OneTimeLaunchHandle:
        nonce, timestamp = self._verify(raw_body=raw_body, headers=headers, now=now)
        envelope = LaunchEnvelope.model_validate_json(raw_body)
        if now.astimezone(UTC) > envelope.expires_at:
            raise IntegrationAuthenticationError("Integration authentication failed.")
        self.storage.claim_nonce(
            nonce=nonce,
            expires_at=timestamp + timedelta(seconds=300, microseconds=1),
        )
        project_id = uid()
        group_id = uid()
        handle = secrets.token_urlsafe(32)
        owner_capability = capability_for_handle(
            handle, self.settings.integration_hmac_secret or ""
        )
        project_dir: Path | None = None
        draft: DraftRecord | None = None
        try:
            project_dir = self.athena_store.storage.workspace_dir(project_id, create=True)
            self.athena_store.storage.write_json(
                project_id, "project.json", self._project(envelope, project_id, group_id)
            )
            draft = self.storage.create_draft(
                envelope=envelope,
                owner_capability=owner_capability,
                browser_handle=handle,
                project_id=project_id,
                group_id=group_id,
                created_at=now,
            )
            return OneTimeLaunchHandle(
                schema_version=1,
                launch_handle=handle,
                created_at=now,
                expires_at=min(envelope.expires_at, now + timedelta(seconds=300)),
            )
        except Exception:
            if draft is not None:
                self.storage.remove_draft_artifacts(draft.id)
            if project_dir is not None:
                shutil.rmtree(project_dir, ignore_errors=True)
            raise

    def consume_browser_handle(self, handle: str, now: datetime) -> BrowserSession:
        return self.storage.consume_handle(handle, now)

    def authorize_project(
        self,
        project_id: str,
        capability: str,
        now: datetime,
        *,
        allow_terminal: bool = False,
    ) -> DraftRecord:
        self.storage.expire_due(now)
        draft = self.storage.find_draft_by_project(project_id)
        if draft is None:
            raise IntegrationAuthorizationError("Integration project was not found.")
        try:
            draft = self.storage.load_draft(draft.id, capability)
        except IntegrationNotFoundError as exc:
            raise IntegrationAuthorizationError("Integration project was not found.") from exc
        if not allow_terminal and draft.status is not DraftStatus.ACTIVE:
            raise IntegrationAuthorizationError("Integration project was not found.")
        return draft

    @contextmanager
    def authorized_operation(
        self,
        project_id: str,
        capability: str,
        action: str,
        group_ids: Sequence[str],
        now: datetime,
    ) -> Iterator[DraftRecord]:
        self.storage.expire_due(now)
        draft = self.storage.find_draft_by_project(project_id)
        if draft is None:
            raise IntegrationAuthorizationError("Integration project was not found.")
        with self.storage.draft_lock(draft.id):
            try:
                current = self.storage.load_draft(draft.id, capability)
            except IntegrationNotFoundError as exc:
                raise IntegrationAuthorizationError(
                    "Integration project was not found."
                ) from exc
            if current.status is not DraftStatus.ACTIVE:
                raise IntegrationAuthorizationError(
                    "Operation is unavailable for this draft."
                )
            self.allowed_operation(action, group_ids=group_ids, draft=current)
            yield current

    @staticmethod
    def allowed_operation(
        action: str, *, group_ids: Sequence[str], draft: DraftRecord
    ) -> None:
        allowed = _CORE_READ_ACTIONS | _CORE_MUTATION_ACTIONS
        if action not in allowed:
            raise IntegrationAuthorizationError("Operation is unavailable for this draft.")
        if group_ids and set(group_ids) != {draft.group_id}:
            raise IntegrationAuthorizationError("Operation is unavailable for this draft.")
        if draft.status is not DraftStatus.ACTIVE and action in _CORE_MUTATION_ACTIONS:
            raise IntegrationAuthorizationError("Operation is unavailable for this draft.")
        if draft.status in {DraftStatus.DISCARDED, DraftStatus.EXPIRED}:
            raise IntegrationAuthorizationError("Operation is unavailable for this draft.")
