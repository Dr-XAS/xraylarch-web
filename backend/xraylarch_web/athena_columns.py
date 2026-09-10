"""Shared, full-data detector arithmetic for Athena preview and import."""
import numpy as np

from .errors import WebInputError


def fail(message):
    raise WebInputError("athena_invalid", message, recovery="Check the selected columns and measurement mode, then retry.")


def map_columns(arrays, request):
    def column(key):
        if key not in arrays:
            fail("Choose columns from the inspected file.")
        return np.asarray(arrays[key], dtype=float)

    x = column(request.energy_column) * (1000 if request.units == "keV" and request.data_type != "chi" else 1)
    if len(set(request.numerator)) != len(request.numerator):
        fail("Select each numerator channel only once.")
    denominator = column(request.denominator) if request.mode != "mu" else None

    def signal(numerator, denominator, logarithm=False, reference=False):
        if denominator is None:
            out = numerator.copy()
        else:
            if np.any(denominator == 0):
                fail("Reference denominator contains zero counts." if reference else "The denominator contains zero detector counts.")
            if reference and logarithm and (np.any(numerator <= 0) or np.any(denominator <= 0)):
                fail("Reference transmission channels must contain positive counts.")
            with np.errstate(over="ignore", divide="ignore", invalid="ignore"):
                out = numerator / denominator
                if logarithm:
                    if np.any(out <= 0):
                        fail("Transmission requires a positive incident/transmitted ratio at every point.")
                    out = np.log(out)
        if not np.isfinite(out).all():
            fail("Selected detector arithmetic produces non-finite values; check signal magnitudes and denominators.")
        return out

    selections = [[key] for key in request.numerator] if request.individual_channels else [request.numerator]
    samples = []
    for keys in selections:
        with np.errstate(over="ignore", invalid="ignore"):
            numerator = np.sum([column(key) for key in keys], axis=0)
        samples.append({"columns": keys, "numerator": numerator,
                        "y": signal(numerator, denominator, request.mode == "transmission")})
    reference = None
    if request.reference_numerator or request.reference_denominator:
        if request.data_type == "chi":
            fail("Reference detector channels need an energy axis; they cannot be imported with chi(k).")
        if not request.reference_numerator or not request.reference_denominator:
            fail("Select both reference numerator and denominator, or clear both.")
        a, b = column(request.reference_numerator), column(request.reference_denominator)
        reference = {"numerator": a, "denominator": b, "y": signal(a, b, request.reference_log, True)}
    order = np.argsort(x, kind="stable") if request.sort else np.arange(len(x))
    return {"x": x[order], "samples": samples, "denominator": denominator, "reference": reference, "order": order}


def preview_trace(x, y, *, label, role, ident, limit=2400):
    # Keep extrema in each bucket so a narrow detector spike is visible.
    # Arithmetic and validation always run over every source point first.
    if len(x) <= limit:
        indices = np.arange(len(x))
    else:
        edges = np.linspace(1, len(x) - 1, (limit - 2) // 2 + 1, dtype=int)
        selected = [0, len(x) - 1]
        for lo, hi in zip(edges[:-1], edges[1:]):
            if hi > lo:
                selected.extend([lo + int(np.argmin(y[lo:hi])), lo + int(np.argmax(y[lo:hi]))])
        indices = np.unique(selected)
    return {"id": ident, "label": label, "role": role, "x": x[indices].tolist(), "y": y[indices].tolist()}
