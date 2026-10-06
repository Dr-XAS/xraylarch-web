"""Preflight untrusted HDF5 metadata before any reader accesses values."""
from __future__ import annotations

import io
import math
import zlib

import h5py
import numpy as np

from .config import Settings
from .errors import WebInputError


MAX_TEXT_BYTES = 65536
# Also count float64 conversion when bounding expansion from stored bytes.
MAX_DETECTOR_EXPANSION = 100


def refuse(message):
    raise WebInputError('upload_hdf5_unsafe', message, ('file',),
                        'Export a self-contained file within the configured upload limits.')


def validate_handle(handle, settings: Settings | None = None):
    """Inspect hard-linked objects only; never resolve a link to another file.

    Internal soft links are safe after every hard-linked object is checked.
    Object addresses prevent group cycles and aliases from repeating the walk.
    Numeric storage is budgeted at at least float64, as used by the readers.
    Scalar variable-length strings are read separately with a fixed-size buffer.
    """
    settings = settings or Settings.from_environment()
    if handle.id.get_filesize() > settings.max_upload_bytes:
        refuse('HDF5 file bytes exceed the configured upload byte limit.')
    seen, pending, soft_links, text_nodes, compressed = set(), [handle], [], [], []
    detector_objects = set()
    chunk_objects = set()
    attributes = []
    datasets = links = decoded = detector_decoded = attribute_count = chunk_count = 0
    object_limit = max(settings.max_columns, settings.max_detector_datasets) * 8

    def check_attributes(node):
        nonlocal decoded, attribute_count
        for name in node.attrs:
            attribute_count += 1
            if attribute_count > settings.max_columns * 8:
                refuse('HDF5 attribute count exceeds the configured column limit.')
            attr = node.attrs.get_id(name)
            shape, dtype = attr.shape, attr.dtype
            if shape is None:
                continue
            if len(shape) > 3 or any(n > settings.max_points for n in shape):
                refuse('HDF5 attribute shape exceeds the configured point limit.')
            string = h5py.check_string_dtype(dtype)
            variable_text = string is not None and string.length is None
            if not variable_text and (dtype.kind not in 'biufS' or dtype.hasobject):
                refuse('Unsupported HDF5 attribute dtype.')
            if variable_text:
                if math.prod(shape) * MAX_TEXT_BYTES > settings.max_upload_bytes:
                    refuse('HDF5 attribute text buffer exceeds the configured upload byte limit.')
            else:
                decoded += math.prod(shape) * max(8, dtype.itemsize)
            if decoded > settings.max_upload_bytes:
                refuse('HDF5 decoded attribute bytes exceed the configured upload byte limit.')
            if variable_text or name == 'NMCAS':
                attributes.append((attr, variable_text, name))

    def check_dataset(node):
        nonlocal datasets, decoded, detector_decoded, chunk_count
        datasets += 1
        if datasets > max(settings.max_columns, settings.max_detector_datasets):
            refuse('HDF5 dataset count exceeds the configured column limit.')
        properties = node.id.get_create_plist()
        if properties.get_external_count():
            refuse('HDF5 external raw storage is not allowed.')
        if node.is_virtual:
            refuse('HDF5 virtual datasets are not allowed.')
        check_attributes(node)
        filters = [properties.get_filter(i)[0] for i in range(properties.get_nfilters())]
        if any(f not in (h5py.h5z.FILTER_DEFLATE, h5py.h5z.FILTER_SHUFFLE,
                         h5py.h5z.FILTER_FLETCHER32) for f in filters):
            refuse('Unsupported HDF5 compression filter; export using gzip or no compression.')
        shape, dtype = node.shape, node.dtype
        if shape is None:
            return
        if len(shape) > 3 or any(n > settings.max_points for n in shape):
            refuse('HDF5 dataset shape exceeds the configured point limit.')
        string = h5py.check_string_dtype(dtype)
        if string is not None and string.length is None and shape == ():
            size = MAX_TEXT_BYTES
            text_nodes.append(node)
        elif dtype.kind in 'biufS' and not dtype.hasobject:
            size = math.prod(shape) * max(8, dtype.itemsize)
        else:
            refuse('HDF5 datasets must use fixed-size real numeric or string types (or scalar text).')
        # A compressed chunk can exceed even the whole logical array.
        chunk_bytes = math.prod(node.chunks or ()) * max(8, dtype.itemsize)
        if node.chunks:
            cells = math.prod((n + c - 1) // c for n, c in zip(shape, node.chunks))
            size = max(size, cells * chunk_bytes)
            address = h5py.h5o.get_info(node.id).addr
            if address not in chunk_objects:
                chunk_count += node.id.get_num_chunks()
                if chunk_count > settings.max_points:
                    refuse('HDF5 chunk count exceeds the configured point limit.')
                chunk_objects.add(address)
                compressed.append((node, filters))
        # NeXus: (points, elements, channels); 20-BM: (1, points, channels).
        # Only bounded real detector-shaped arrays receive the separate budget.
        detector = (len(shape) == 3 and dtype.kind in 'biuf' and all(shape)
                    and shape[2] <= 8192
                    and (shape[1] <= 64 or shape[0] == 1))
        if detector:
            address = h5py.h5o.get_info(node.id).addr
            # Beamline files alias one cube from data and instrument groups.
            # XRF readers materialize one selected cube/window, not all aliases.
            if address not in detector_objects:
                detector_decoded += size
                detector_objects.add(address)
            if detector_decoded > settings.max_detector_bytes:
                refuse('HDF5 decoded detector bytes exceed the configured detector limit.')
            if size > max(settings.max_upload_bytes,
                          MAX_DETECTOR_EXPANSION * node.id.get_storage_size()):
                refuse('HDF5 detector expansion exceeds the stored-data budget.')
        else:
            decoded += size
        if decoded > settings.max_upload_bytes or chunk_bytes > settings.max_upload_bytes:
            refuse('HDF5 decoded bytes exceed the configured upload byte limit.')

    while pending:
        group = pending.pop()
        address = h5py.h5o.get_info(group.id).addr
        if address in seen:
            continue
        seen.add(address)
        check_attributes(group)
        for name in group:
            links += 1
            if links > object_limit:
                refuse('HDF5 object count exceeds the configured column limit.')
            link = group.get(name, getlink=True)
            if isinstance(link, h5py.ExternalLink):
                refuse('HDF5 external links are not allowed.')
            if isinstance(link, h5py.SoftLink):
                soft_links.append((group, name))
                continue
            if not isinstance(link, h5py.HardLink):
                refuse('Unsupported HDF5 link type.')
            node = group[name]
            if isinstance(node, h5py.Group):
                pending.append(node)
                continue
            if not isinstance(node, h5py.Dataset):
                refuse('Unsupported HDF5 object type.')
            check_dataset(node)
    # External links have now been ruled out everywhere, including soft targets.
    # Scalar aliases are charged too; readers may materialize every channel.
    for group, name in soft_links:
        node = group.get(name)
        if isinstance(node, h5py.Dataset):
            check_dataset(node)
    dataset_limit = settings.max_detector_datasets if detector_decoded else settings.max_columns
    if datasets > dataset_limit:
        refuse('HDF5 dataset count exceeds the configured column limit.')
    if links > dataset_limit * 8:
        refuse('HDF5 object count exceeds the configured column limit.')
    # No values are accessed until every dataset has passed the metadata checks.
    for node, filters in compressed:
        _check_chunks(node, filters)
    for node in text_nodes:
        read_text(node)
    for attr, variable_text, name in attributes:
        dtype = f'S{MAX_TEXT_BYTES}' if variable_text else attr.dtype
        values = np.empty(attr.shape, dtype=dtype)
        attr.read(values)
        if variable_text and np.any(np.char.str_len(values) >= MAX_TEXT_BYTES):
            refuse('HDF5 attribute text exceeds the metadata limit.')
        if variable_text:
            # The fixed-size read bounds allocation; charge actual text rather
            # than 64 KiB for every short beamline metadata attribute.
            decoded += int(np.char.str_len(values).sum()) + values.size * 8
            if decoded > settings.max_upload_bytes:
                refuse('HDF5 decoded attribute bytes exceed the configured upload byte limit.')
        if name == 'NMCAS':
            if values.size != 1:
                refuse('HDF5 NMCAS must be a bounded scalar detector count.')
            try:
                count = int(values.item())
            except (ValueError, TypeError, OverflowError):
                refuse('HDF5 NMCAS must be a bounded scalar detector count.')
            if not 1 <= count <= settings.max_columns:
                refuse('HDF5 NMCAS exceeds the configured column limit.')


def _check_chunks(node, filters):
    """Check actual filter output, not just the logical chunk declaration."""
    expected = math.prod(node.chunks) * node.dtype.itemsize
    file_bytes = node.file.id.get_filesize()
    offsets = set()
    chunks = []
    node.id.chunk_iter(chunks.append)
    for info in chunks:
        if info.size > file_bytes or info.byte_offset + info.size > file_bytes:
            refuse('HDF5 chunk storage lies outside the uploaded file.')
        if info.byte_offset in offsets:
            refuse('HDF5 chunks must not alias the same stored block.')
        offsets.add(info.byte_offset)
        mask, raw = node.id.read_direct_chunk(info.chunk_offset)
        # Reverse the pipeline. Shuffle preserves size and needs no decoding
        # here, but must precede compression when writing the file.
        active = [f for i, f in enumerate(filters) if not mask & (1 << i)]
        order = [h5py.h5z.FILTER_SHUFFLE, h5py.h5z.FILTER_DEFLATE, h5py.h5z.FILTER_FLETCHER32]
        if active != [f for f in order if f in active]:
            refuse('Unsupported HDF5 filter order.')
        for f in reversed(active):
            if f == h5py.h5z.FILTER_FLETCHER32:
                raw = raw[:-4]
            elif f == h5py.h5z.FILTER_DEFLATE:
                decoder = zlib.decompressobj()
                try:
                    raw = decoder.decompress(raw, expected + 1)
                except zlib.error:
                    refuse('Invalid HDF5 compressed chunk.')
                if not decoder.eof or decoder.unused_data or len(raw) > expected:
                    refuse('HDF5 compressed chunk expands beyond its declared size.')
        if len(raw) != expected:
            refuse('HDF5 chunk size does not match its declaration.')


def validate_bytes(data: bytes, settings: Settings | None = None):
    with h5py.File(io.BytesIO(data), 'r') as handle:
        validate_handle(handle, settings)


def read_text(node):
    """Bound scalar heap strings too, whose dtype itemsize is only a pointer."""
    string = h5py.check_string_dtype(node.dtype)
    if string is not None and string.length is None:
        value = node.astype(f'S{MAX_TEXT_BYTES}')[()]
        if len(value) >= MAX_TEXT_BYTES:
            refuse('HDF5 scalar text exceeds the metadata limit.')
        return value
    return node[()]
