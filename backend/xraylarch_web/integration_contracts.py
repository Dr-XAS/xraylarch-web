"""Versioned, portable contracts for the Dr.XAS integration boundary."""

from __future__ import annotations

from datetime import datetime, timedelta
from enum import StrEnum
import hashlib
import json
import math
import re
from typing import Annotated, Literal
import unicodedata

from pydantic import (
    AwareDatetime,
    BaseModel,
    ConfigDict,
    Field,
    JsonValue,
    StringConstraints,
    field_validator,
    model_validator,
)


SCHEMA_VERSION = 1
MAX_SPECTRUM_POINTS = 100_000
MAX_OPERATION_IDS = 128
MAX_NFFT = 65_536
MAX_LAUNCH_LIFETIME = timedelta(seconds=300)
MAX_DRAFT_LIFETIME = timedelta(days=7)
_ENERGY_TO_K = 3.80998212
_WINDOWS_DEVICE_NAMES = re.compile(r"^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)", re.IGNORECASE)

Identifier = Annotated[str, StringConstraints(strict=True, min_length=1, max_length=255)]
LaunchHandle = Annotated[
    str,
    StringConstraints(
        strict=True, min_length=22, max_length=128, pattern=r"^[A-Za-z0-9_-]+$"
    ),
]
Sha256 = Annotated[str, StringConstraints(strict=True, pattern=r"^[0-9a-f]{64}$")]
Window = Literal["hanning", "parzen", "welch", "gaussian", "sine", "kaiser"]
FiniteFloat = Annotated[float, Field(strict=True, allow_inf_nan=False)]
Weight = Annotated[float, Field(strict=True, ge=0, le=4, allow_inf_nan=False)]
TaperWidth = Annotated[float, Field(strict=True, ge=0, le=20, allow_inf_nan=False)]
SchemaVersion = Literal[1]


class IntegrationModel(BaseModel):
    model_config = ConfigDict(strict=True, frozen=True, extra="forbid", allow_inf_nan=False)


class ArtifactSourceIdentity(IntegrationModel):
    conversation_id: Identifier
    turn_id: Identifier
    artifact_id: Identifier
    artifact_version: int = Field(strict=True, ge=1)
    artifact_sha256: Sha256
    branch_id: Identifier
    branch_revision: int = Field(strict=True, ge=0)


class PortableProvenance(IntegrationModel):
    source_filename: Identifier
    parse_recipe_id: Identifier | None = None
    column_signature_sha256: Sha256 | None = None
    operation_ids: tuple[Identifier, ...] = Field(default=(), max_length=MAX_OPERATION_IDS)

    @field_validator("source_filename")
    @classmethod
    def basename_only(cls, value: str) -> str:
        if value in {".", ".."} or "/" in value or "\\" in value:
            raise ValueError("source_filename must be a basename without path components.")
        if any(unicodedata.category(character) == "Cc" for character in value):
            raise ValueError("source_filename must not contain control characters.")
        if re.match(r"^[A-Za-z]:", value):
            raise ValueError("source_filename must not be a Windows drive-relative name.")
        if _WINDOWS_DEVICE_NAMES.match(value):
            raise ValueError("source_filename must not be a reserved Windows device name.")
        return value


class AuthoritativeSpectrum(IntegrationModel):
    energy: tuple[FiniteFloat, ...] = Field(min_length=3, max_length=MAX_SPECTRUM_POINTS)
    mu: tuple[FiniteFloat, ...] = Field(min_length=3, max_length=MAX_SPECTRUM_POINTS)

    @model_validator(mode="after")
    def aligned_increasing_arrays(self):
        if len(self.energy) != len(self.mu):
            raise ValueError("energy and mu must have equal length.")
        if any(
            current <= previous
            for previous, current in zip(self.energy, self.energy[1:])
        ):
            raise ValueError("energy must be strictly increasing.")
        return self


class NormalizationParameters(IntegrationModel):
    e0: Annotated[float, Field(strict=True, gt=0, le=1e7, allow_inf_nan=False)]
    edge_step: Annotated[float, Field(strict=True, gt=0, allow_inf_nan=False)]
    pre1: Annotated[float, Field(strict=True, lt=0, allow_inf_nan=False)] | None = None
    pre2: Annotated[float, Field(strict=True, le=0, allow_inf_nan=False)] | None = None
    norm1: Annotated[float, Field(strict=True, ge=0, allow_inf_nan=False)] | None = None
    norm2: Annotated[float, Field(strict=True, gt=0, allow_inf_nan=False)] | None = None
    nnorm: Annotated[int, Field(strict=True, ge=0, le=3)] | None = None
    nvict: int = Field(default=0, strict=True, ge=0, le=10)
    flatten: bool = Field(default=True, strict=True)
    energy_shift: Annotated[float, Field(strict=True, ge=-100_000, le=100_000, allow_inf_nan=False)] = 0.0

    @model_validator(mode="after")
    def ordered_ranges(self):
        _ordered_optional(self, "pre1", "pre2")
        _ordered_optional(self, "norm1", "norm2")
        return self


class AutobkParameters(IntegrationModel):
    rbkg: Annotated[float, Field(strict=True, gt=0, le=20, allow_inf_nan=False)] = 1.0
    kmin: Annotated[float, Field(strict=True, ge=0, le=100, allow_inf_nan=False)] = 0.0
    kmax: Annotated[float, Field(strict=True, gt=0, le=100, allow_inf_nan=False)]
    kweight: Weight = 2.0
    dk: TaperWidth = 1.0
    window: Window = "hanning"
    nknots: int = Field(default=0, strict=True, ge=0, le=10_000)
    nclamp: int = Field(default=5, strict=True, ge=0, le=100)
    clamp_lo: Annotated[
        float, Field(strict=True, ge=0, le=1000, allow_inf_nan=False)
    ] = 0.0
    clamp_hi: Annotated[
        float, Field(strict=True, ge=0, le=1000, allow_inf_nan=False)
    ] = 1.0

    @model_validator(mode="after")
    def valid_window_and_range(self):
        _ordered(self, "kmin", "kmax")
        _positive_special_window(self.window, self.dk, "dk")
        return self


class ForwardFtParameters(IntegrationModel):
    kmin: Annotated[float, Field(strict=True, ge=0, le=100, allow_inf_nan=False)] = 3.0
    kmax: Annotated[float, Field(strict=True, gt=0, le=100, allow_inf_nan=False)]
    kweight: Weight = 2.0
    dk: TaperWidth = 1.0
    dk2: TaperWidth = 1.0
    window: Window = "hanning"
    rmax_out: Annotated[
        float, Field(strict=True, gt=0, le=1000, allow_inf_nan=False)
    ] = 10.0
    nfft: int = Field(default=2048, strict=True, ge=128, le=MAX_NFFT)
    kstep: Annotated[float, Field(strict=True, ge=0.001, le=1, allow_inf_nan=False)] = 0.05
    with_phase: bool = Field(default=False, strict=True)

    @model_validator(mode="after")
    def valid_transform(self):
        _ordered(self, "kmin", "kmax")
        _power_of_two(self.nfft)
        _positive_special_window(self.window, self.dk, "dk")
        return self


class ReverseFtParameters(IntegrationModel):
    rmin: Annotated[float, Field(strict=True, ge=0, le=100, allow_inf_nan=False)] = 1.0
    rmax: Annotated[float, Field(strict=True, gt=0, le=100, allow_inf_nan=False)] = 3.0
    dr: TaperWidth = 0.0
    dr2: TaperWidth = 0.0
    window: Window = "hanning"
    qmax_out: Annotated[
        float, Field(strict=True, gt=0, le=100, allow_inf_nan=False)
    ] = 30.0
    nfft: int = Field(default=2048, strict=True, ge=128, le=MAX_NFFT)
    kstep: Annotated[float, Field(strict=True, ge=0.001, le=1, allow_inf_nan=False)] = 0.05
    with_phase: bool = Field(default=False, strict=True)

    @model_validator(mode="after")
    def valid_transform(self):
        _ordered(self, "rmin", "rmax")
        _power_of_two(self.nfft)
        _positive_special_window(self.window, self.dr, "dr")
        return self


class CoreProcessingRecipe(IntegrationModel):
    recipe_version: Literal[1]
    larch_version: Identifier
    normalization: NormalizationParameters
    autobk: AutobkParameters
    forward_ft: ForwardFtParameters
    reverse_ft: ReverseFtParameters

    @model_validator(mode="after")
    def fft_supports_reverse_range(self):
        rlast = (
            math.pi
            / (self.forward_ft.kstep * self.forward_ft.nfft)
            * (self.forward_ft.nfft // 2 - 1)
        )
        if self.reverse_ft.rmax + self.reverse_ft.dr / 2 > rlast:
            raise ValueError("reverse_ft rmax + dr/2 exceeds the FFT R range.")
        return self


class DraftStatus(StrEnum):
    ACTIVE = "active"
    IMPORTING = "importing"
    SEALED = "sealed"
    DISCARDED = "discarded"
    EXPIRED = "expired"
    FAILED = "failed"


class ParityStatus(StrEnum):
    MATCHED = "matched"
    MISMATCHED = "mismatched"
    NOT_CHECKED = "not_checked"


class NumericalTolerances(IntegrationModel):
    """Non-negotiable local policy for later numerical parity checks."""

    scalar_absolute: Literal[1e-8] = 1e-8
    scalar_relative: Literal[1e-6] = 1e-6
    array_absolute: Literal[1e-7] = 1e-7
    array_relative: Literal[1e-5] = 1e-5
    minimum_match_fraction: Literal[0.999] = 0.999


def canonical_json_bytes(model: IntegrationModel) -> bytes:
    """Encode a model as UTF-8 compact sorted JSON with non-finite values forbidden."""

    return json.dumps(
        model.model_dump(mode="json"),
        allow_nan=False,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")


def canonical_sha256(model: IntegrationModel) -> str:
    """Return lowercase SHA-256 of the model's canonical UTF-8 JSON bytes."""

    return hashlib.sha256(canonical_json_bytes(model)).hexdigest()


class LaunchEnvelope(IntegrationModel):
    schema_version: SchemaVersion
    source: ArtifactSourceIdentity
    provenance: PortableProvenance
    spectrum: AuthoritativeSpectrum
    recipe: CoreProcessingRecipe
    spectrum_sha256: Sha256
    recipe_sha256: Sha256
    created_at: AwareDatetime
    expires_at: AwareDatetime

    @model_validator(mode="after")
    def validate_envelope(self):
        _bounded_lifetime(
            self.created_at, self.expires_at, MAX_LAUNCH_LIFETIME, "expires_at"
        )
        _validate_digests_and_science(self)
        return self


class OneTimeLaunchHandle(IntegrationModel):
    schema_version: SchemaVersion
    launch_handle: LaunchHandle
    created_at: AwareDatetime
    expires_at: AwareDatetime

    @model_validator(mode="after")
    def valid_lifetime(self):
        _bounded_lifetime(
            self.created_at, self.expires_at, MAX_LAUNCH_LIFETIME, "expires_at"
        )
        return self


class DraftSummary(IntegrationModel):
    draft_id: Identifier
    status: DraftStatus
    created_at: AwareDatetime
    updated_at: AwareDatetime
    expires_at: AwareDatetime
    operation_count: int = Field(strict=True, ge=0)
    latest_operation_id: Identifier | None = None

    @model_validator(mode="after")
    def valid_dates(self):
        if self.updated_at < self.created_at:
            raise ValueError("updated_at must not precede created_at.")
        if self.updated_at >= self.expires_at:
            raise ValueError("updated_at must be earlier than expires_at.")
        _bounded_lifetime(
            self.created_at, self.expires_at, MAX_DRAFT_LIFETIME, "expires_at"
        )
        if (self.operation_count == 0) != (self.latest_operation_id is None):
            raise ValueError(
                "operation_count must be zero if and only if latest_operation_id is None."
            )
        return self


class DraftSummaryList(IntegrationModel):
    schema_version: SchemaVersion = SCHEMA_VERSION
    drafts: tuple[DraftSummary, ...] = ()

    @model_validator(mode="after")
    def chronologically_ordered(self):
        if any(
            current.updated_at < previous.updated_at
            for previous, current in zip(self.drafts, self.drafts[1:])
        ):
            raise ValueError("drafts must be ordered by updated_at ascending.")
        return self


class SealedImportEnvelope(IntegrationModel):
    schema_version: SchemaVersion
    draft_id: Identifier
    source: ArtifactSourceIdentity
    spectrum: AuthoritativeSpectrum
    recipe: CoreProcessingRecipe
    spectrum_sha256: Sha256
    recipe_sha256: Sha256
    sealed_at: AwareDatetime
    parity_status: Literal[ParityStatus.NOT_CHECKED] = ParityStatus.NOT_CHECKED

    @model_validator(mode="after")
    def validate_envelope(self):
        _validate_digests_and_science(self)
        return self


ComputedArray = Literal[
    "energy", "mu", "norm", "flat", "pre_edge", "post_edge", "k", "chi",
    "r", "chir_re", "chir_im", "chir_mag", "q", "chiq_re", "chiq_im", "chiq_mag",
]
ComputedValues = Annotated[tuple[FiniteFloat, ...], Field(min_length=1, max_length=MAX_SPECTRUM_POINTS)]


class ComputedImportResult(IntegrationModel):
    arrays: dict[ComputedArray, ComputedValues]
    e0: Annotated[float, Field(strict=True, gt=0, le=1e7, allow_inf_nan=False)]
    edge_step: Annotated[float, Field(strict=True, gt=0, allow_inf_nan=False)]

    @model_validator(mode="after")
    def complete_aligned_results(self):
        groups = (
            ("energy", "mu", "norm", "flat", "pre_edge", "post_edge"),
            ("k", "chi"), ("r", "chir_re", "chir_im", "chir_mag"),
            ("q", "chiq_re", "chiq_im", "chiq_mag"),
        )
        if set(self.arrays) != {name for group in groups for name in group}:
            raise ValueError("Computed import result is incomplete.")
        for group in groups:
            if len({len(self.arrays[name]) for name in group}) != 1:
                raise ValueError("Computed import result arrays are not aligned.")
        return self


class ImportSnapshot(IntegrationModel):
    envelope: SealedImportEnvelope
    project_version: int = Field(strict=True, ge=0)
    computed: ComputedImportResult


class ImportBinding(IntegrationModel):
    import_id: Annotated[str, StringConstraints(strict=True, pattern=r"^[0-9a-f]{32}$")]
    attempt_id: Annotated[str, StringConstraints(strict=True, pattern=r"^[0-9a-f]{32}$")]
    project_version: int = Field(strict=True, ge=0)
    snapshot_sha256: Sha256


class ImportState(IntegrationModel):
    source_sha256: Sha256
    status: DraftStatus
    binding: ImportBinding | None = None


class ImportActionRequest(IntegrationModel):
    draft_id: Identifier
    owner_capability: LaunchHandle
    action: Literal["status", "prepare", "finalize", "abort"]
    binding: ImportBinding | None = None

    @model_validator(mode="after")
    def binding_for_action(self):
        if (self.action == "status") != (self.binding is None):
            raise ValueError("Only status omits the import binding.")
        return self


def snapshot_sha256(snapshot: ImportSnapshot) -> str:
    value = snapshot.model_dump(mode="json")
    value["envelope"].pop("sealed_at")
    return hashlib.sha256(json.dumps(value, allow_nan=False, ensure_ascii=False,
                                    separators=(",", ":"), sort_keys=True).encode()).hexdigest()


class IntegrationContractBundle(IntegrationModel):
    """Root model used to export and compare the complete integration JSON schema."""

    launch: LaunchEnvelope
    launch_handle: OneTimeLaunchHandle
    draft_summaries: DraftSummaryList
    sealed_import: SealedImportEnvelope
    import_snapshot: ImportSnapshot
    import_state: ImportState
    import_action: ImportActionRequest
    tolerances: NumericalTolerances = NumericalTolerances()


def normalized_contract_schema() -> dict:
    """Return the complete wire schema in deterministic JSON-normalized form."""

    return json.loads(
        json.dumps(IntegrationContractBundle.model_json_schema(), sort_keys=True)
    )


def contract_schema_fingerprint() -> str:
    """Return SHA-256 of compact sorted JSON for the complete wire schema."""

    encoded = json.dumps(
        normalized_contract_schema(), separators=(",", ":"), sort_keys=True
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _ordered(model: BaseModel, low: str, high: str) -> None:
    if getattr(model, low) >= getattr(model, high):
        raise ValueError(f"{high} must be greater than {low}.")


def _ordered_optional(model: BaseModel, low: str, high: str) -> None:
    low_value = getattr(model, low)
    high_value = getattr(model, high)
    if low_value is not None and high_value is not None and low_value >= high_value:
        raise ValueError(f"{high} must be greater than {low}.")


def _positive_special_window(window: Window, width: float, name: str) -> None:
    if window in {"gaussian", "kaiser"} and width <= 0:
        raise ValueError(f"{window} requires a positive taper width ({name}).")


def _power_of_two(nfft: int) -> None:
    if nfft & (nfft - 1):
        raise ValueError("nfft must be a power of two from 128 through 65536.")


def _bounded_lifetime(
    start: datetime, end: datetime, maximum: timedelta, end_name: str
) -> None:
    if end <= start:
        raise ValueError(f"{end_name} must be later than the preceding timestamp.")
    if end - start > maximum:
        raise ValueError(
            f"{end_name} must be no more than {int(maximum.total_seconds())} seconds "
            "after the preceding timestamp."
        )


# Version 2 persistent-project wire contract.  These models intentionally do not
# inherit v1's schema-version aliases, preserving the v1 wire surface unchanged.
V2_CONTRACT_VERSION = 2
MAX_PROJECT_NAME_LENGTH = 120
MAX_GROUP_SELECTIONS = 128

ProjectId = Annotated[str, StringConstraints(strict=True, min_length=1, max_length=255)]
ProjectName = Annotated[
    str, StringConstraints(strict=True, min_length=1, max_length=MAX_PROJECT_NAME_LENGTH)
]
GroupId = Annotated[str, StringConstraints(strict=True, min_length=1, max_length=255)]
ReservationId = Annotated[str, StringConstraints(strict=True, min_length=1, max_length=255)]
V2SchemaVersion = Literal[2]
V2PositiveInt = Annotated[int, Field(strict=True, gt=0)]


class PersistentIntegrationModel(BaseModel):
    """Strict, immutable v2 integration models independent of the v1 contract."""

    model_config = ConfigDict(strict=True, frozen=True, extra="forbid", allow_inf_nan=False)


class ExistingDrXasSource(PersistentIntegrationModel):
    kind: Literal["drxas"] = "drxas"
    turn_id: Identifier
    artifact_id: Identifier
    artifact_version: int = Field(strict=True, ge=1)
    source_sha256: Sha256


class AthenaUploadedSource(PersistentIntegrationModel):
    kind: Literal["athena_upload"] = "athena_upload"
    original_filename: Identifier
    raw_sha256: Sha256
    parse_metadata: dict[str, JsonValue]


ProjectSource = Annotated[
    ExistingDrXasSource | AthenaUploadedSource, Field(discriminator="kind")
]


class ProjectBootstrapRequest(PersistentIntegrationModel):
    contract_version: V2SchemaVersion = V2_CONTRACT_VERSION
    name: ProjectName
    persistent: bool
    source: ProjectSource | None = None


class ProjectLaunch(PersistentIntegrationModel):
    contract_version: V2SchemaVersion = V2_CONTRACT_VERSION
    project_id: ProjectId
    capability: LaunchHandle
    project: "ProjectSummary"


class ProjectSummary(PersistentIntegrationModel):
    contract_version: V2SchemaVersion = V2_CONTRACT_VERSION
    project_id: ProjectId
    name: ProjectName
    persistent: bool
    project_version: int = Field(strict=True, ge=0)
    group_count: int = Field(strict=True, ge=0)
    file_count: int = Field(strict=True, ge=0)
    stored_bytes: int = Field(strict=True, ge=0)
    expires_at: AwareDatetime | None

    @model_validator(mode="after")
    def persistence_matches_expiry(self):
        if self.persistent != (self.expires_at is None):
            raise ValueError("expires_at must be absent for persistent projects and present for guests.")
        return self


class SelectedGroupRef(PersistentIntegrationModel):
    group_id: GroupId
    group_version: int = Field(strict=True, ge=0)


class SelectedGroupExportRequest(PersistentIntegrationModel):
    contract_version: V2SchemaVersion = V2_CONTRACT_VERSION
    project_id: ProjectId
    project_version: int = Field(strict=True, ge=0)
    selections: tuple[SelectedGroupRef, ...] = Field(min_length=1, max_length=MAX_GROUP_SELECTIONS)

    @model_validator(mode="after")
    def selections_are_unique(self):
        keys = {(selection.group_id, selection.group_version) for selection in self.selections}
        if len(keys) != len(self.selections):
            raise ValueError("selected group references must be unique.")
        return self


class SelectedGroupExportBatch(PersistentIntegrationModel):
    contract_version: V2SchemaVersion = V2_CONTRACT_VERSION
    project_id: ProjectId
    project_version: int = Field(strict=True, ge=0)
    sources: tuple[ProjectSource, ...] = Field(min_length=1, max_length=MAX_GROUP_SELECTIONS)


class ExportReservation(PersistentIntegrationModel):
    contract_version: V2SchemaVersion = V2_CONTRACT_VERSION
    reservation_id: ReservationId
    project_id: ProjectId
    project_version: int = Field(strict=True, ge=0)
    selections: tuple[SelectedGroupRef, ...] = Field(min_length=1, max_length=MAX_GROUP_SELECTIONS)
    status: Literal["prepared", "committed", "aborted"]

    @model_validator(mode="after")
    def selections_are_unique(self):
        keys = {(selection.group_id, selection.group_version) for selection in self.selections}
        if len(keys) != len(self.selections):
            raise ValueError("selected group references must be unique.")
        return self


class ProjectQuota(PersistentIntegrationModel):
    max_projects: V2PositiveInt
    max_files: V2PositiveInt
    max_bytes: V2PositiveInt
    max_groups: V2PositiveInt
    max_exports: V2PositiveInt
    ttl_seconds: V2PositiveInt | None


def _validate_digests_and_science(
    envelope: LaunchEnvelope | SealedImportEnvelope,
) -> None:
    if envelope.spectrum_sha256 != canonical_sha256(envelope.spectrum):
        raise ValueError("spectrum_sha256 does not match the canonical spectrum.")
    if envelope.recipe_sha256 != canonical_sha256(envelope.recipe):
        raise ValueError("recipe_sha256 does not match the canonical recipe.")

    normalization = envelope.recipe.normalization
    shifted_min = envelope.spectrum.energy[0] + normalization.energy_shift
    shifted_max = envelope.spectrum.energy[-1] + normalization.energy_shift
    e0_min = envelope.spectrum.energy[1] + normalization.energy_shift
    e0_max = envelope.spectrum.energy[-2] + normalization.energy_shift
    if not e0_min <= normalization.e0 <= e0_max:
        raise ValueError(
            "normalization.e0 must lie between the second and penultimate shifted "
            "energy points."
        )
    relative_min = shifted_min - normalization.e0
    relative_max = shifted_max - normalization.e0
    for name in ("pre1", "pre2", "norm1", "norm2"):
        value = getattr(normalization, name)
        if value is not None and not relative_min <= value <= relative_max:
            raise ValueError(
                f"normalization.{name} must lie within the shifted measured "
                f"range [{relative_min:.12g}, {relative_max:.12g}] relative to e0."
            )

    reachable_k = math.sqrt(max(shifted_max - normalization.e0, 0) / _ENERGY_TO_K)
    forward_ft = envelope.recipe.forward_ft
    processing_kmax = envelope.recipe.autobk.kmax
    if forward_ft.kmax > processing_kmax:
        raise ValueError("forward_ft.kmax must not exceed autobk.kmax.")
    required_points = int(
        1.01
        + max(processing_kmax, forward_ft.kmax + forward_ft.dk2)
        / forward_ft.kstep
    )
    if required_points > forward_ft.nfft:
        raise ValueError(
            "The selected forward FFT capacity (nfft) cannot represent the requested k range."
        )
    for name, kmax in (
        ("autobk.kmax", processing_kmax),
        ("forward_ft.kmax", forward_ft.kmax),
    ):
        if kmax > reachable_k:
            raise ValueError(
                f"{name} exceeds reachable k={reachable_k:.12g} from the shifted "
                "measured energy axis and normalization.e0."
            )
