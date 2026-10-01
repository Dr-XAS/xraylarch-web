"""Read-only display transforms of saved Artemis fit curves."""
from __future__ import annotations

import numpy as np
from fastapi import APIRouter
from larch.xafs import feffit_transform
from pydantic import Field, field_validator

from .artemis import FitTransform, StrictModel, _LARCH_LOCK
from .artemis_persistence import validate_result
from .errors import WebInputError


def _fail(message):
    raise WebInputError("invalid_artemis_plot", message, fields=("result", "kweight"),
                        recovery="Choose another display k weight or run and save a new fit.")


class PlotTransformRequest(StrictModel):
    version: int = Field(ge=0)
    kweight: int = Field(ge=0, le=4)
    result: dict

    @field_validator("result")
    @classmethod
    def saved_result(cls, value):
        return validate_result(value)


def transform_result(result: dict, kweight: int) -> dict:
    """Transform a saved snapshot without evaluating parameters or FEFF paths.

    Archives written before plot_source was added retain weighted chi(k). For
    positive display weights the unavailable raw k=0 value cancels exactly.
    A zero display weight requires an actual saved unweighted value.
    """
    validate_result(result)
    if type(kweight) is not int or kweight not in range(5):
        _fail("Display k weight must be an integer from 0 to 4.")
    metadata = result["metadata"]
    if not isinstance(metadata, dict):
        _fail("The saved fit does not include its Fourier transform metadata.")
    kstep, nfft, rwindow = (metadata.get(name) for name in ("kstep", "nfft", "rwindow"))
    if (metadata.get("engine") != "larch.feffit" or metadata.get("phase_corrected") is not False
            or metadata.get("background_refined") is not False
            or type(kstep) not in (float, int) or not 0 < kstep <= 1
            or type(nfft) is not int or not 256 <= nfft <= 16384 or nfft & (nfft - 1)
            or rwindow not in ("hanning", "kaiser", "parzen", "welch")):
        _fail("The saved fit has unsupported Fourier transform metadata.")
    k, r = np.asarray(result["k"]["x"]), np.asarray(result["r"]["x"])
    if (len(k) > nfft or len(r) > nfft // 2
            or not np.allclose(k, np.arange(len(k)) * kstep, rtol=0, atol=1e-10)
            or not np.allclose(r, np.arange(len(r)) * np.pi / (kstep * nfft), rtol=0, atol=1e-10)):
        _fail("The saved fit axes do not match its Fourier transform grid.")

    source = result.get("plot_source")
    if source is not None:
        data, model = (np.asarray(source[name]) for name in ("data", "model"))
        paths = [np.asarray(path["chi"]) for path in source["paths"]]
    else:
        old_weight = result["k"]["weight"]
        if old_weight > 0 and kweight == 0:
            _fail("This older fit saved only weighted chi(k), so its unweighted k=0 value is unavailable. A new saved fit is needed for k weight 0.")
        factor = k ** old_weight

        def recover(values):
            # At positive weights, k=0 contributes exactly zero to both the
            # displayed curve and Fourier transform; no raw value is inferred.
            return np.divide(values, factor, out=np.zeros(len(k)), where=factor != 0)

        data, model = (recover(result["k"][name]) for name in ("data", "model"))
        paths = [recover(path["k"]["chi"]) for path in result["paths"]]

    options = FitTransform.model_validate(result["transform"]).model_dump()
    options["kweight"] = kweight
    with _LARCH_LOCK, np.errstate(over="raise", invalid="raise", divide="raise"):
        transform = feffit_transform(**options, kstep=kstep, nfft=nfft, rwindow=rwindow)
        try:
            r_data, r_model = (transform.fftf(values)[:len(r)] for values in (data, model))
            r_paths = [transform.fftf(values)[:len(r)] for values in paths]
            weighted_data, weighted_model = (values * k ** kweight for values in (data, model))
            weighted_paths = [values * k ** kweight for values in paths]
        except (FloatingPointError, ValueError) as exc:
            _fail("The saved curves cannot be transformed to this display k weight.")

    def curve(values):
        if not np.isfinite(values).all():
            _fail("The saved curves produced a nonfinite display transform.")
        return values.tolist()

    def components(values):
        return {name: curve(function(values)) for name, function in
                (("mag", np.abs), ("re", np.real), ("im", np.imag))}

    return dict(kweight=kweight, warnings=[],
                k=dict(x=k.tolist(), data=curve(weighted_data), model=curve(weighted_model),
                       residual=curve(weighted_data - weighted_model), weight=kweight),
                r=dict(x=r.tolist(), **{f"{name}_{part}": values
                       for name, array in (("data", r_data), ("model", r_model), ("residual", r_data - r_model))
                       for part, values in components(array).items()}),
                paths=[dict(id=path["id"], k=dict(chi=curve(weighted)), r=components(chir))
                       for path, weighted, chir in zip(result["paths"], weighted_paths, r_paths)])


def build_plot_router(store):
    router = APIRouter(tags=["Artemis display"])

    @router.post("/projects/{ident}/groups/{group_id}/plot-transform")
    def plot_transform(ident: str, group_id: str, request: PlotTransformRequest):
        project = store.load(ident)
        if project.get("integration") is True:
            _fail("Import the integration draft into a local project before viewing fit transforms.")
        store.check(project, request.version)
        store.group(project, group_id)
        # Imported fit archives intentionally keep their original project/group
        # identity; the route addresses the current group, not that old origin.
        result = transform_result(request.result, request.kweight)
        store.check(store.load(ident), request.version)
        return dict(project_id=ident, group_id=group_id, version=request.version, **result)

    return router
