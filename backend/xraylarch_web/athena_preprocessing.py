"""Import preprocessing, using Demeter's Larch alignment template.

Reference: Demeter 06afc8da, process/larch/align.tmpl, Data/E0.pm and
UI/Athena/IO.pm. This is the import path's smoothed derivative fit.
"""
from pydantic import BaseModel, ConfigDict, Field, model_validator


class ImportPreprocessing(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    mark: bool = Field(default=False, strict=True)
    standard_id: str | None = Field(default=None, min_length=1, max_length=100, strict=True)
    copy_parameters: bool = Field(default=False, strict=True)
    align: bool = Field(default=False, strict=True)

    @model_validator(mode="after")
    def standard_required(self):
        if (self.copy_parameters or self.align) and not self.standard_id:
            raise ValueError("Choose a preprocessing standard before copying parameters or aligning.")
        return self


def import_alignment(moving, standard, *, sg_window=31, sg_order=9):
    """Use the same native Larch fit as the alignment panel, without plotting."""
    from .athena_alignment import fit_alignment
    return fit_alignment(moving, standard, sg_window=sg_window, sg_order=sg_order)['summary']
