"""Upload boundary for the XRF extraction engine's HDF5 readers.

Keep security and allocation checks outside the numerical reduction module.
Also check persisted uploads, which may predate the upload validation.
"""
from .hdf5_safety import validate_bytes
from . import athena_xrf_xas
from .athena_science import ScientificError


def read_scan(data, filename, *, settings=None):
    try:
        validate_bytes(data, settings)
    except OSError as exc:
        raise ScientificError('This file is not readable as HDF5. Select the original scan file.') from exc
    return athena_xrf_xas.read_scan(data, filename)


def load_counts(data, detector, channel_range, *, settings=None, **kwargs):
    validate_bytes(data, settings)
    return athena_xrf_xas.load_counts(data, detector, channel_range, **kwargs)
