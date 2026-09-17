from __future__ import annotations

from contextlib import contextmanager
from dataclasses import replace
from datetime import UTC, datetime, timedelta
import hashlib
import json
import hmac
import math
from pathlib import Path
import re
import secrets
import shutil
from typing import Any, Callable, Iterator, Mapping, Sequence, get_args

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
from .integration_contracts import (
    AthenaInternalSource,
    AthenaUploadedSource,
    ExistingDrXasSource,
    ExportReservation,
    ExportedGroup,
    ExportedGroupScience,
    ProjectBootstrapRequest,
    ProjectQuota,
    ProjectSummary,
    RecomputableGroupScience,
    SelectedGroupExportBatch,
    SelectedGroupRef,
    V2_CONTRACT_VERSION,
    validate_recipe_for_spectrum,
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
_NATIVE_ATHENA_OPERATIONS = (
    "read_project", "upload", "import", "preview", "read_upload", "command",
    "report", "plot", "read_group", "analyze", "restore", "export", "project",
    "example", "reorder", "metadata", "parameters", "set_e0", "undo", "redo",
    "duplicate", "merge", "sum", "difference", "rebin", "multi_electron",
    "convolve", "deglitch", "truncate", "delete", "change_datatype",
    "xdi_comments", "selection", "background_standard", "copy_series",
    "copy_parameters", "reset_parameters", "context_parameters", "align", "smooth",
    "deconvolve", "self_absorption", "tie_reference", "untie_reference",
)


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


def v2_signing_payload(*, method: str, path: str, issuer: str, audience: str,
                       timestamp: str, nonce: str, body_sha256: str) -> bytes:
    return "\n".join(("v2", method.upper(), path, issuer, audience, timestamp, nonce, body_sha256)).encode()


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

    def _verify_v2(self, *, method: str, path: str, raw_body: bytes,
                   headers: Mapping[str, str], now: datetime) -> tuple[str, datetime]:
        if hasattr(headers, "getlist") and any(len(headers.getlist(name)) != 1 for name in _REQUIRED_HEADERS):
            raise IntegrationAuthenticationError("Integration authentication failed.")
        values = self._headers(headers)
        issuer = values["x-drxas-issuer"]
        audience = values["x-drxas-audience"]
        timestamp_text = values["x-drxas-timestamp"]
        nonce = values["x-drxas-nonce"]
        digest = values["x-drxas-body-sha256"]
        signature = values["x-drxas-signature"]
        if (
            not hmac.compare_digest(issuer, self.settings.integration_issuer or "")
            or not hmac.compare_digest(audience, self.settings.integration_audience or "")
            or not timestamp_text.isascii() or not timestamp_text.isdigit()
            or len(timestamp_text) > 16
            or not re.fullmatch(r"[A-Za-z0-9_-]{16,128}", nonce)
            or not _LOWER_SHA256.fullmatch(digest)
            or not _LOWER_SHA256.fullmatch(signature)
        ):
            raise IntegrationAuthenticationError("Integration authentication failed.")
        try:
            timestamp = datetime.fromtimestamp(int(timestamp_text), tz=UTC)
        except (OverflowError, OSError, ValueError):
            raise IntegrationAuthenticationError("Integration authentication failed.") from None
        if abs((now.astimezone(UTC) - timestamp).total_seconds()) > 300:
            raise IntegrationAuthenticationError("Integration authentication failed.")
        if not hmac.compare_digest(hashlib.sha256(raw_body).hexdigest(), digest):
            raise IntegrationAuthenticationError("Integration authentication failed.")
        expected = hmac.new(
            (self.settings.integration_hmac_secret or "").encode(),
            v2_signing_payload(method=method, path=path, issuer=issuer, audience=audience,
                               timestamp=timestamp_text, nonce=nonce, body_sha256=digest),
            hashlib.sha256,
        ).hexdigest()
        if not hmac.compare_digest(expected, signature):
            raise IntegrationAuthenticationError("Integration authentication failed.")
        return nonce, timestamp

    def verify_v2_request(self, *, method: str, path: str, raw_body: bytes,
                          headers: Mapping[str, str], now: datetime) -> tuple[str, datetime]:
        return self._verify_v2(method=method, path=path, raw_body=raw_body,
                               headers=headers, now=now)

    def claim_v2_nonce(self, nonce: str, timestamp: datetime) -> None:
        self.storage.claim_nonce(
            nonce=nonce, expires_at=timestamp + timedelta(seconds=300, microseconds=1)
        )

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

    def _quota(self, persistent: bool) -> ProjectQuota:
        if persistent:
            return ProjectQuota(
                max_projects=self.settings.integration_max_projects,
                max_files=self.settings.integration_max_files,
                max_bytes=self.settings.integration_max_bytes,
                max_groups=self.settings.integration_max_groups,
                max_exports=self.settings.integration_max_exports,
                ttl_seconds=None,
            )
        return ProjectQuota(
            max_projects=self.settings.integration_guest_max_projects,
            max_files=self.settings.integration_guest_max_files,
            max_bytes=self.settings.integration_guest_max_bytes,
            max_groups=self.settings.integration_guest_max_groups,
            max_exports=self.settings.integration_guest_max_exports,
            ttl_seconds=self.settings.integration_guest_ttl_seconds,
        )

    def _project_summary(self, project, record) -> ProjectSummary:
        return ProjectSummary(
            project_id=record.project_id, name=project["name"], persistent=record.persistent,
            project_version=project["version"], group_count=len(project["groups"]), file_count=0,
            stored_bytes=record.stored_bytes, expires_at=record.expires_at,
        )

    @staticmethod
    def _project_bytes(project: dict) -> int:
        return len(json.dumps(project, allow_nan=False, separators=(",", ":")).encode())

    @classmethod
    def _processed_project_byte_bound(cls, project: dict) -> int:
        """Conservatively bound JSON growth from processing one seeded group.

        Bound each output family by the grid that actually produces it. FFT
        allocation size alone does not determine serialized R/q lengths: those
        are truncated by rmax_out/qmax_out. A finite JSON float plus separator
        needs at most 32 bytes; fixed metadata gets a separate allowance.
        """
        if not project["groups"]:
            return cls._project_bytes(project)
        group = project["groups"][0]
        parameters = group["parameters"]
        source_points = len(group["energy"])
        e0 = parameters["e0"]
        if e0 is None:
            # The edge finder selects an interior measured energy.
            energy_span = group["energy"][-1] - group["energy"][1]
        else:
            energy_span = max(0.0, group["energy"][-1] + parameters["energy_shift"] - e0)
        available_kmax = math.sqrt(3.80998212 * energy_span)
        kmax = min(parameters["bkg_kmax"] or available_kmax, available_kmax)
        k_points = min(parameters["nfft"] // 2, int(1.01 + kmax / parameters["kstep"]))
        rstep = 3.141592653589793 / (parameters["kstep"] * parameters["nfft"])
        rmax = parameters["rmax_out"] or max(
            10.0, parameters["rmax"] + parameters["dr"] / 2 + rstep
        )
        r_points = min(parameters["nfft"] // 2, int(rmax / rstep) + 2)
        reverse_nfft = parameters["reverse_nfft"] or parameters["nfft"]
        qmax = parameters["qmax_out"] or kmax
        # Larch xftr ignores its kstep argument. It derives q spacing from the
        # actual input R grid and reverse nfft; q itself is not FFT-half capped,
        # while the transformed chiq arrays are slices of the nfft output.
        reverse_kstep = math.pi / (rstep * reverse_nfft)
        q_points = int(1.05 + qmax / reverse_kstep)
        chiq_points = min(q_points, reverse_nfft)
        # 9 E-space, 4 k-space, 5 R-space plus rwin, q, and four/five chiq arrays.
        array_values = (
            9 * source_points + 4 * k_points + 6 * r_points
            + q_points + (5 if parameters["reverse_with_phase"] else 4) * chiq_points
        )
        return cls._project_bytes(project) + array_values * 32 + 131_072

    def create_v2_project(self, request: ProjectBootstrapRequest, *, now: datetime) -> tuple[str, str, ProjectSummary]:
        quota = self._quota(request.persistent)
        project_id = uid()
        project = {
            "id": project_id, "format": "athena-web", "schema_version": 1,
            "name": request.name, "version": 0, "groups": [], "journal": "",
            "history": [], "undo": [], "redo": [], "analyses": [],
            "created": athena_now(), "updated": athena_now(), "integration": True,
            "group_versions": {},
        }
        if request.seed is not None:
            group = {
                "id": uid(), "label": "Dr.XAS source", "energy": list(request.seed.spectrum.energy),
                "mu": list(request.seed.spectrum.mu), "data_type": "mu",
                "parameters": self._parameters(request.seed), "marked": True, "frozen": False,
                "multiplier": 1.0, "offset": 0.0, "notes": "", "reference_id": None,
                "background_standard_id": None, "source": request.seed.source.model_dump(mode="json"),
                "result": None, "processing_error": None, "is_difference": False,
            }
            project["groups"].append(group)
            project["group_versions"][group["id"]] = project["version"]
        # Processing materializes many derived arrays. Reject against their
        # conservative serialized ceiling before spending CPU or mutating Athena.
        if self._processed_project_byte_bound(project) > quota.max_bytes:
            raise IntegrationConflictError("Integration project byte quota is exhausted.")
        if request.seed is not None:
            self.athena_store.process(project["groups"][0])
        stored_bytes = self._project_bytes(project)
        if stored_bytes > quota.max_bytes:
            raise IntegrationConflictError("Integration project byte quota is exhausted.")
        # Reserve durable capacity only after the full in-memory project passes quota.
        record, capability = self.storage.create_project_record(
            project_id=project_id, persistent=request.persistent, quota=quota,
            source=request.source, now=now,
        )
        try:
            self.athena_store.storage.workspace_dir(project_id, create=True)
            self.athena_store.storage.write_json(project_id, "project.json", project)
            stored_bytes = self.athena_store.storage.path(project_id, "project.json").stat().st_size
            record = self.storage.set_project_stored_bytes(project_id, capability, stored_bytes, now=now)
            return project_id, capability, self._project_summary(project, record)
        except Exception:
            self.storage.delete_project_record(project_id, capability, now=now)
            shutil.rmtree(self.athena_store.storage.root / project_id, ignore_errors=True)
            raise

    def _rename_intent_path(self, project_id: str) -> Path:
        return self.storage.rename_intents_dir / f"{hashlib.sha256(project_id.encode()).hexdigest()}.json"

    def _recover_rename_locked(
        self, project_id: str, capability: str, *, now: datetime,
    ):
        record = self.storage._load_active_project(project_id, capability, now)
        intent_path = self._rename_intent_path(project_id)
        if not intent_path.exists():
            return record
        project = self.athena_store.storage.read_json(project_id, "project.json")
        committed_bytes = self.athena_store.storage.path(project_id, "project.json").stat().st_size
        if record.stored_bytes != committed_bytes:
            record = self.storage._set_project_stored_bytes_locked(
                record, committed_bytes, now=now,
            )
        intent_path.unlink(missing_ok=True)
        self.storage._fsync_directory(self.storage.rename_intents_dir)
        return record

    def launch_v2_project(self, project_id: str, capability: str, *, now: datetime) -> str:
        with self.storage.project_lock(project_id):
            with self.athena_store.storage.lock(project_id):
                record = self._recover_rename_locked(
                    project_id, capability, now=now,
                )
                project = self.athena_store.load(project_id)
                seed_group = None
                if project["groups"]:
                    group = project["groups"][0]
                    seed_group = {"group_id": group["id"], "label": group["label"],
                                  "source": group.get("source")}
                return self.storage.create_project_launch_handle(
                    project_id=project_id, capability=capability, expires_at=now + timedelta(seconds=300),
                    seed_group=seed_group, allowed_operations=_NATIVE_ATHENA_OPERATIONS,
                    return_reference={"project_id": project_id, "persistent": record.persistent},
                )

    def consume_v2_handle(self, handle: str, *, now: datetime) -> dict:
        value = self.storage.consume_project_launch_handle(handle, now=now)
        project_id, capability = value["project_id"], value["capability"]
        with self.storage.project_lock(project_id):
            with self.athena_store.storage.lock(project_id):
                record = self._recover_rename_locked(
                    project_id, capability, now=now,
                )
                project = self.athena_store.load(project_id)
        session_capability = self.storage.create_project_session(
            project_id=project_id,
            owner_capability=capability,
            allowed_operations=tuple(value["allowed_operations"]),
            expires_at=now + timedelta(seconds=300),
            now=now,
        )
        return {
            "project_id": project_id, "capability": session_capability,
            "project": self._project_summary(project, record).model_dump(mode="json"),
            "seed_group": value["seed_group"],
            "allowed_operations": value["allowed_operations"],
            "return_reference": value["return_reference"],
        }

    @staticmethod
    def _workspace_bytes(workspace: Path) -> int:
        return sum(
            path.stat().st_size
            for path in workspace.iterdir()
            if path.is_file() and path.name != "workspace.lock"
        )

    @staticmethod
    def _upload_count(workspace: Path) -> int:
        return sum(
            path.name.startswith("upload-") and path.suffix == ".source"
            or path.name.startswith("project-upload-") and path.suffix == ".bin"
            for path in workspace.iterdir()
            if path.is_file()
        )

    def mutate_v2_project(
        self,
        project_id: str,
        session_capability: str,
        operation: str,
        mutate: Callable[[], Any],
        *,
        now: datetime,
        lock_workspace: bool = False,
    ) -> Any:
        """Run an Athena mutation as one quota-checked integration transaction."""
        with self.storage.project_lock(project_id):
            record, allowed = self.storage._load_project_session_locked(
                project_id, session_capability, now=now
            )
            if operation not in allowed:
                raise IntegrationAuthorizationError("Integration project was not found.")
            workspace = self.athena_store.storage.workspace_dir(project_id)
            backup = {
                path.name: path.read_bytes()
                for path in workspace.iterdir()
                if path.is_file() and path.name != "workspace.lock"
            }
            try:
                if lock_workspace:
                    with self.athena_store.storage.lock(project_id):
                        result = mutate()
                else:
                    result = mutate()
                project = self.athena_store.load(project_id)
                stored_bytes = self._workspace_bytes(workspace)
                if record.quota is not None and (
                    len(project["groups"]) > record.quota.max_groups
                    or self._upload_count(workspace) > record.quota.max_files
                    or stored_bytes > record.quota.max_bytes
                ):
                    raise IntegrationConflictError(
                        "Integration project quota is exhausted."
                    )
                self.storage._set_project_stored_bytes_locked(
                    record, stored_bytes, now=now
                )
                return result
            except Exception:
                with self.athena_store.storage.lock(project_id):
                    for path in workspace.iterdir():
                        if path.is_file() and path.name != "workspace.lock":
                            path.unlink(missing_ok=True)
                    for name, data in backup.items():
                        self.athena_store.storage.write_bytes(project_id, name, data)
                raise

    def rename_v2_project(self, project_id: str, capability: str, name: str, *, now: datetime) -> ProjectSummary:
        # Lock order is integration project, then Athena workspace. All coordinated
        # lifecycle mutations must use this order to avoid cross-store deadlocks.
        with self.storage.project_lock(project_id):
            with self.athena_store.storage.lock(project_id):
                record = self._recover_rename_locked(
                    project_id, capability, now=now,
                )
                intent_path = self._rename_intent_path(project_id)
                project = self.athena_store.load(project_id)
                project["name"] = name
                candidate_bytes = self._project_bytes(project)
                if record.quota is not None and candidate_bytes > record.quota.max_bytes:
                    raise IntegrationConflictError("Integration project byte quota is exhausted.")
                self.storage._atomic_json(intent_path, {"project_id": project_id, "name": name})
                self.athena_store.storage.write_json(project_id, "project.json", project)
                committed_bytes = self.athena_store.storage.path(project_id, "project.json").stat().st_size
                record = self.storage._set_project_stored_bytes_locked(record, committed_bytes, now=now)
                intent_path.unlink()
                self.storage._fsync_directory(self.storage.rename_intents_dir)
                return self._project_summary(project, record)

    def delete_v2_project(self, project_id: str, capability: str, *, now: datetime) -> dict:
        # Retire durable access first. Cleanup may be retried with the same
        # capability, but can never make the record active again. Consume rename
        # intent under the same integration->workspace lock order as rename/access.
        with self.storage.project_lock(project_id):
            record = self.storage._read_project_unchecked(project_id)
            if (record.status not in {"active", "deleted"}
                    or not isinstance(capability, str)
                    or not hmac.compare_digest(record.capability_hash, hashlib.sha256(capability.encode()).hexdigest())):
                raise IntegrationNotFoundError("Integration project was not found.")
            if record.status == "active":
                with self.athena_store.storage.lock(project_id):
                    record = self._recover_rename_locked(project_id, capability, now=now)
                    deleted = replace(record, status="deleted", updated_at=now.astimezone(UTC))
                    self.storage._atomic_json(
                        self.storage._project_path(project_id),
                        self.storage._serialize_project(deleted),
                    )
            intent_path = self._rename_intent_path(project_id)
            intent_path.unlink(missing_ok=True)
            self.storage._fsync_directory(self.storage.rename_intents_dir)
        workspace = self.athena_store.storage.root / project_id
        try:
            shutil.rmtree(workspace, ignore_errors=False)
        except FileNotFoundError:
            pass
        except OSError:
            return {"project_id": project_id, "status": "deleted", "cleanup_pending": True}
        return {"project_id": project_id, "status": "deleted", "cleanup_pending": False}

    def reserve_v2_export(self, project_id: str, capability: str, selections: tuple[SelectedGroupRef, ...], reservation_id: str, *, project_version: int, now: datetime) -> ExportReservation:
        # Resolve the selection before reserving, so the reservation records the
        # revisions it actually pins instead of an unbinding placeholder.
        with self.athena_store.storage.lock(project_id):
            self._selected_groups(
                self.athena_store.load(project_id), project_version, selections
            )
        return self.storage.reserve_export(
            project_id, capability, selections, reservation_id,
            project_version=project_version, now=now,
        )

    def complete_v2_export(self, project_id: str, capability: str, reservation_id: str, *, commit: bool, now: datetime) -> ExportReservation:
        complete = self.storage.commit_export_reservation if commit else self.storage.abort_export_reservation
        return complete(project_id, capability, reservation_id, now=now)

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

    def export_v2_group_science(
        self,
        project_id: str,
        capability: str,
        selections: tuple[SelectedGroupRef, ...],
        *,
        project_version: int,
        now: datetime,
    ) -> SelectedGroupExportBatch:
        """Export the science of the selected groups at the revisions pinned.

        Read-only: the owner capability authorizes one project, and every
        selection names the project version its group last changed in, so a
        caller can never be handed science from a revision it did not choose.
        """

        self.storage.load_project(project_id, capability, now=now)
        with self.athena_store.storage.lock(project_id):
            project = self.athena_store.load(project_id)
            exported = [
                self._exported_group(group, selection.group_version)
                for selection, group in zip(
                    selections,
                    self._selected_groups(project, project_version, selections),
                )
            ]
        return SelectedGroupExportBatch(
            contract_version=V2_CONTRACT_VERSION,
            project_id=project_id,
            project_version=project_version,
            groups=tuple(exported),
        )

    @staticmethod
    def _selected_groups(
        project: dict, project_version: int, selections: tuple[SelectedGroupRef, ...]
    ) -> list[dict]:
        """Resolve selections against the exact revisions they name.

        Both the project version and each group's own revision must match, so a
        caller is never served — or handed a reservation over — science from a
        revision it did not choose.
        """

        if project["version"] != project_version:
            raise IntegrationConflictError(
                "Integration project has changed since the selection was made."
            )
        revisions = project.get("group_versions") or {}
        groups = {group["id"]: group for group in project["groups"]}
        resolved = []
        for selection in selections:
            group = groups.get(selection.group_id)
            if group is None or revisions.get(selection.group_id) != selection.group_version:
                raise IntegrationConflictError(
                    "Selected group is absent or has changed since it was selected."
                )
            resolved.append(group)
        return resolved

    def _exported_group(self, group: dict, group_version: int) -> ExportedGroup:
        if group.get("processing_error") or not isinstance(group.get("result"), dict):
            raise IntegrationConflictError(
                "Selected group has no processed result; repair its processing first."
            )
        larch_version = group["result"].get("larch_version")
        if not isinstance(larch_version, str) or not larch_version:
            # Results cached before the computing version was recorded cannot be
            # attributed, and unattributed science must not cross the boundary.
            raise IntegrationConflictError(
                "Selected group's cached result predates version attribution; reprocess it."
            )
        # A chi(k) or detector group keeps its own abscissa in the energy slot,
        # which the exported data type names; the axis is authoritative either way.
        spectrum = AuthoritativeSpectrum.model_validate(
            {"energy": tuple(group["energy"]), "mu": tuple(group["mu"])}
        )
        source = self._exported_source(group)
        return ExportedGroup(
            group_id=group["id"],
            group_version=group_version,
            label=group["label"],
            larch_version=larch_version,
            source=source,
            source_sha256=canonical_sha256(source),
            spectrum=spectrum,
            spectrum_sha256=canonical_sha256(spectrum),
            science=self._group_science(group, spectrum, larch_version),
        )

    @staticmethod
    def _exported_source(group: dict):
        """Map Athena's open-ended source metadata onto the portable shapes.

        Only a Dr.XAS seed and a column-mapped upload have a portable identity;
        everything else — derived, combined, natively imported — keeps its
        provenance inside xraylarch-web and names only its parents.
        """

        source = group.get("source") or {}
        if source.get("kind") == "drxas":
            # Athena enriches a stored source in place (an inferred edge
            # identity, XDI history), so project it back onto the seed's own
            # fields rather than handing the accumulated dict to a strict model.
            return ExistingDrXasSource.model_validate(
                {
                    name: value
                    for name, value in source.items()
                    if name in ExistingDrXasSource.model_fields
                }
            )
        if source.get("original_filename") and source.get("source_sha256"):
            try:
                return AthenaUploadedSource(
                    original_filename=source["original_filename"],
                    raw_sha256=source["source_sha256"],
                    parse_metadata=source.get("parse_metadata") or {},
                )
            except ValidationError:
                pass
        parents = source.get("parents") if isinstance(source.get("parents"), list) else None
        if parents is None and isinstance(source.get("parent"), str):
            parents = [source["parent"]]
        return AthenaInternalSource(
            parent_group_ids=tuple(
                parent for parent in (parents or ()) if isinstance(parent, str) and parent
            )
        )

    def _group_science(
        self, group: dict, spectrum: AuthoritativeSpectrum, larch_version: str
    ) -> RecomputableGroupScience | ExportedGroupScience:
        """Pick the strongest kind this group's processing can honestly cross as.

        Recomputable is offered only when the portable recipe really describes
        this spectrum and the cached result is complete; anything short of that
        travels as computed arrays under xraylarch-web's own authority, naming
        which shortfall it hit.
        """

        result = group["result"]
        arrays = result.get("arrays") or {}
        effective = result.get("effective") or {}
        if group["is_difference"]:
            return self._exported_science(group, "difference", arrays, effective)
        if group["data_type"] != "mu":
            return self._exported_science(group, "data_type", arrays, effective)
        try:
            recipe = self._recipe_from_parameters(
                group["parameters"], recipe_version=1, larch_version=larch_version
            )
        except (ValidationError, KeyError, TypeError):
            return self._exported_science(group, "unportable_recipe", arrays, effective)
        try:
            validate_recipe_for_spectrum(spectrum, recipe)
        except ValueError:
            return self._exported_science(group, "unportable_recipe", arrays, effective)
        try:
            computed = ComputedImportResult.model_validate({
                "arrays": {name: tuple(arrays.get(name, ())) for name in get_args(ComputedArray)},
                "e0": effective.get("e0"), "edge_step": effective.get("edge_step"),
            })
        except ValidationError:
            return self._exported_science(group, "incomplete_result", arrays, effective)
        return RecomputableGroupScience(
            recipe=recipe, recipe_sha256=canonical_sha256(recipe), computed=computed
        )

    @staticmethod
    def _exported_science(
        group: dict, reason: str, arrays: Mapping, effective: Mapping
    ) -> ExportedGroupScience:
        def positive(name: str) -> float | None:
            value = effective.get(name)
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                return None
            return float(value) if math.isfinite(value) and value > 0 else None

        present = {
            name: tuple(arrays[name])
            for name in get_args(ComputedArray)
            if arrays.get(name)
        }
        try:
            return ExportedGroupScience(
                reason=reason, data_type=group["data_type"], arrays=present,
                e0=positive("e0"), edge_step=positive("edge_step"),
            )
        except ValidationError as exc:
            raise IntegrationConflictError(
                "Selected group's cached result is not exportable; reprocess it."
            ) from exc

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
