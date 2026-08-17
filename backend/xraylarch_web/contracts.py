from dataclasses import dataclass
from typing import Mapping

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
