from dataclasses import dataclass
from typing import Literal, Mapping

import numpy as np
from pydantic import BaseModel, Field


class ColumnInfo(BaseModel):
    name: str
    index: int
    numeric: bool
    unit: str | None = None
    role_hint: str | None = None
    preview: tuple[float, ...] = Field(default_factory=tuple, max_length=5)


class FieldIssue(BaseModel):
    code: str
    message: str
    fields: tuple[str, ...] = ()
    recovery: str


class ErrorEnvelope(BaseModel):
    code: str
    message: str
    fields: tuple[str, ...] = ()
    recovery: str


class UploadInspection(BaseModel):
    display_name: str
    row_count: int
    columns: tuple[ColumnInfo, ...]
    warnings: tuple[str, ...] = ()
    issues: tuple[FieldIssue, ...] = ()


class InspectionResponse(UploadInspection):
    upload_id: str


class MappingRequest(BaseModel):
    upload_id: str
    energy_column: str
    signal_column: str


class RecipeDraft(BaseModel):
    e0: float | None = None
    step: float | None = None
    nnorm: int | None = None
    pre1: float | None = None
    pre2: float | None = None
    norm1: float | None = None
    norm2: float | None = None
    rbkg: float = 1.0
    kmin: float = 0.0
    kmax: float | None = None
    kweight: int = 2
    autobk_dk: float | None = None
    autobk_window: str | None = None
    ft_dk: float = 1.0
    ft_dk2: float | None = None
    ft_window: str = "kaiser"
    nfft: int = 2048
    kstep: float = 0.05
    rmax_out: float = 10.0


class PreviewRequest(BaseModel):
    source_revision_id: int
    recipe: RecipeDraft


class ApplyRequest(PreviewRequest):
    expected_parent_revision: int | None


class RestoreRequest(BaseModel):
    revision_id: int
    expected_parent_revision: int | None


class EffectiveRecipe(BaseModel):
    e0: float
    edge_step: float
    rbkg: float
    kmin: float
    kmax: float
    kweight: int
    autobk_dk: float
    autobk_window: str
    ft_dk: float
    ft_dk2: float | None = None
    ft_window: str
    nfft: int
    kstep: float
    rmax_out: float


class PlotTrace(BaseModel):
    id: Literal["raw_mu", "norm_mu", "chi_k", "chi_r"]
    label: str
    x_label: str
    y_label: str
    x_unit: str
    y_unit: str
    x: tuple[float, ...]
    y: tuple[float, ...]


class PlotBundle(BaseModel):
    plots: tuple[PlotTrace, ...]


class ProcessingResult(PlotBundle):
    effective: EffectiveRecipe


class RevisionSummary(BaseModel):
    revision_id: int
    kind: Literal["mapping", "applied"]
    parent_revision_id: int | None = None
    source_revision_id: int | None = None
    restored_from_revision_id: int | None = None
    recipe: RecipeDraft | None = None
    effective: EffectiveRecipe | None = None


class WorkspaceSnapshot(BaseModel):
    workspace_id: str
    active_revision_id: int | None = None
    revisions: tuple[RevisionSummary, ...] = ()
    active_result: ProcessingResult | None = None


@dataclass(frozen=True)
class ParsedUpload:
    display_name: str
    row_count: int
    columns: tuple[ColumnInfo, ...]
    arrays: Mapping[str, np.ndarray]
    warnings: tuple[str, ...]
    issues: tuple[FieldIssue, ...]
    source_bytes: bytes

    def __post_init__(self) -> None:
        object.__setattr__(self, "source_bytes", bytes(self.source_bytes))
        object.__setattr__(self, "arrays", dict(self.arrays))

    def inspection(self) -> UploadInspection:
        return UploadInspection(
            display_name=self.display_name,
            row_count=self.row_count,
            columns=self.columns,
            warnings=self.warnings,
            issues=self.issues,
        )
