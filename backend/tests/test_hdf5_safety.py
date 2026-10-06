"""Untrusted storage and oversized declarations must fail before payload reads."""
import io
import zlib

import h5py
import numpy as np
import pytest

from xraylarch_web.athena import AthenaStore
from xraylarch_web.config import Settings
from xraylarch_web.errors import WebInputError
from xraylarch_web.hdf5_readers import read_hdf5, unreadable_hdf5_message
from xraylarch_web.athena_xrf_view import read_cube, load_window
from xraylarch_web.xrf_hdf5 import read_scan, load_counts


def uploaded(build):
    buffer = io.BytesIO()
    with h5py.File(buffer, 'w') as handle:
        data = handle.create_group('entry/data')
        data.attrs['NX_class'] = np.bytes_('NXdata')
        data['energy'] = np.arange(8) + 9000.
        data['i0'] = np.ones(8)
        build(handle, data)
    return buffer.getvalue()


READERS = [
    lambda data: read_hdf5(data),
    lambda data: unreadable_hdf5_message(data, 'scan.h5'),
    lambda data: read_scan(data, 'scan.h5'),
    lambda data: read_cube(data, 'scan.h5'),
    lambda data: load_counts(data, 'detector', [0, 2]),
    lambda data: load_window(data, 'detector', [0, 2], allowed={'detector': (8, 1, 2)}),
]


@pytest.mark.parametrize('storage', ['external_link', 'external_raw', 'virtual'])
@pytest.mark.parametrize('reader', READERS)
def test_server_file_references_are_rejected_before_any_payload_read(tmp_path, monkeypatch, storage, reader):
    raw = tmp_path / 'harmless.bin'
    raw.write_bytes(np.arange(8, dtype='f8').tobytes())
    source = tmp_path / 'harmless.h5'
    with h5py.File(source, 'w') as handle:
        handle['values'] = np.arange(8, dtype='f8')

    def build(handle, data):
        if storage == 'external_link':
            # Hidden outside the selected entry, including through a soft alias.
            handle['other'] = h5py.ExternalLink(str(source), '/values')
            data['intensity'] = h5py.SoftLink('/other')
        elif storage == 'external_raw':
            data.create_dataset('intensity', (8,), dtype='f8', external=[(str(raw), 0, 64)])
        else:
            layout = h5py.VirtualLayout((8,), dtype='f8')
            layout[:] = h5py.VirtualSource(str(source), 'values', shape=(8,))
            data.create_virtual_dataset('intensity', layout)
    data = uploaded(build)

    def no_read(*args, **kwargs):
        pytest.fail('An unvalidated HDF5 payload was read')
    monkeypatch.setattr(h5py.Dataset, '__getitem__', no_read)
    with pytest.raises(WebInputError, match='external|virtual'):
        reader(data)


@pytest.mark.parametrize('case', ['shape', 'bytes', 'count', 'dtype', 'chunk'])
@pytest.mark.parametrize('entrypoint', ['inspect', 'inspect_xrf_scan', 'inspect_xrf_cube'])
def test_configured_limits_reject_tiny_oversized_files_before_read(tmp_path, monkeypatch, case, entrypoint):
    settings = Settings(data_root=tmp_path, max_upload_bytes=16384, max_points=100, max_columns=8)
    def build(handle, data):
        if case == 'shape':
            # Unallocated fill-only dataset: the file is tiny, declared array is 8 GB.
            data.create_dataset('oversized', (10**9,), dtype='f8')
        elif case == 'bytes':
            data.create_dataset('ancillary', (100, 24), dtype='f8')
        elif case == 'count':
            for index in range(8):
                data.create_dataset(f'extra{index}', (1,), dtype='f8')
        elif case == 'dtype':
            data.create_dataset('ancillary', (8,), dtype=h5py.vlen_dtype(np.dtype('f8')))
        else:
            data.create_dataset('ancillary', (8,), maxshape=(None,), chunks=(10000,), dtype='f8')
    data = uploaded(build)
    assert len(data) < settings.max_upload_bytes
    store = AthenaStore(settings)
    project = store.create()
    def no_read(*args, **kwargs):
        pytest.fail('An oversized HDF5 payload was read')
    monkeypatch.setattr(h5py.Dataset, '__getitem__', no_read)
    with pytest.raises(WebInputError, match='HDF5'):
        getattr(store, entrypoint)(project['id'], data, 'scan.h5')


def test_internal_links_and_cycles_do_not_hide_or_duplicate_a_valid_scan():
    def build(handle, data):
        data['it'] = np.full(8, 0.5)
        handle['alias'] = data
        data['cycle'] = handle
        data['soft_i0'] = h5py.SoftLink('/entry/data/i0')
    _, scan = read_hdf5(uploaded(build))
    np.testing.assert_array_equal(scan.channels['it'], np.full(8, 0.5))


def test_compressed_chunk_cannot_expand_past_its_small_logical_shape():
    def build(handle, data):
        node = data.create_dataset('intensity', (8,), chunks=(8,), dtype='f8', compression='gzip')
        # Harmless 1 MiB expansion declared as just 64 bytes.
        node.id.write_direct_chunk((0,), zlib.compress(bytes(1024 * 1024)))
    data = uploaded(build)
    assert len(data) < 16384
    with pytest.raises(WebInputError, match='expands beyond'):
        read_hdf5(data)


@pytest.mark.parametrize('filters', [{}, {'compression': 'gzip'},
    {'compression': 'gzip', 'shuffle': True, 'fletcher32': True}])
def test_valid_chunk_filters_preserve_scan_values(filters):
    def build(handle, data):
        data.create_dataset('it', data=np.arange(8, dtype='f8'), chunks=(4,), **filters)
    _, scan = read_hdf5(uploaded(build))
    np.testing.assert_array_equal(scan.channels['it'], np.arange(8))


@pytest.mark.parametrize('attribute', ['variable_numeric', 'oversized', 'detector_count'])
def test_ancillary_attributes_cannot_bypass_the_dataset_budget(attribute):
    def build(handle, data):
        if attribute == 'variable_numeric':
            values = np.empty(1, dtype=object)
            values[0] = np.arange(3, dtype='i8')
            data.attrs.create('NX_class', values,
                              dtype=h5py.vlen_dtype(np.dtype('i8')))
        elif attribute == 'oversized':
            data.attrs['units'] = np.zeros((2, 101), dtype='u1')
        else:
            handle.attrs['NMCAS'] = 10**12
    with pytest.raises(WebInputError, match='attribute|NMCAS'):
        read_hdf5(uploaded(build), settings=Settings(data_root='.', max_points=100))


@pytest.mark.parametrize('limit', ['chunk_bytes', 'chunk_count'])
def test_chunk_cost_is_bounded_across_datasets_not_just_per_chunk(limit):
    def build(handle, data):
        for name in ('it', 'extra'):
            node = data.create_dataset(name, (8,), maxshape=(None,), dtype='f8',
                                       chunks=(1024 if limit == 'chunk_bytes' else 1,), compression='gzip')
            node[:] = np.ones(8)
    data = uploaded(build)
    settings = Settings(data_root='.', max_upload_bytes=16384, max_points=10)
    assert len(data) < settings.max_upload_bytes
    with pytest.raises(WebInputError, match='decoded bytes|chunk count'):
        read_hdf5(data, settings=settings)


def test_default_limits_accept_a_full_size_multielement_detector_scan(tmp_path):
    """Scalar-column limits must not reject detector cubes and beamline metadata."""
    buffer = io.BytesIO()
    rng = np.random.default_rng(812)
    with h5py.File(buffer, 'w') as handle:
        data = handle.create_group('entry/data')
        data.attrs['NX_class'] = np.bytes_('NXdata')
        data['energy'] = np.linspace(6300, 7500, 560)
        data['i0'] = np.full(560, 10000.)
        detector = data.create_dataset('detector', (560, 8, 4096), dtype='u2',
                                       chunks=(1, 8, 4096), compression='gzip')
        handle['entry/instrument/detector'] = detector
        # Generate realistic counting data one frame at a time, not a fill-only
        # declaration or a compressed all-zero array that resembles a bomb.
        for point in range(560):
            detector[point] = rng.poisson(5, (8, 4096)).astype('u2')
        metadata = handle.create_group('entry/instrument/metadata')
        for index in range(697):
            metadata[f'field_{index}'] = np.arange(4, dtype='i4')
            metadata[f'field_{index}'].attrs['units'] = 'counts'
            metadata[f'field_{index}'].attrs['description'] = 'Synthetic metadata'
    settings = Settings(data_root=tmp_path)
    payload = buffer.getvalue()
    assert len(payload) < settings.max_upload_bytes
    store = AthenaStore(settings)
    project = store.create()
    inspected = store.inspect_xrf_scan(project['id'], payload, 'synthetic.h5')
    assert inspected['points'] == 560
    window = load_counts(payload, 'detector', [100, 102], settings=settings)
    assert window.shape == (560, 8, 2)
    assert window.mean() == pytest.approx(5, abs=.1)


@pytest.mark.parametrize('storage', ['unallocated', 'compressed', 'oversized'])
def test_detector_budget_does_not_admit_tiny_expansion_bombs(storage):
    def build(handle, data):
        shape = (560 if storage != 'oversized' else 2000, 8, 4096)
        node = data.create_dataset('detector', shape, dtype='u2',
                                   chunks=(1, 8, 4096), compression='gzip')
        if storage == 'compressed':
            for point in range(shape[0]):
                node[point] = np.zeros(shape[1:], dtype='u2')
    payload = uploaded(build)
    assert len(payload) < 1_000_000
    with pytest.raises(WebInputError, match='detector.*(expansion|bytes)|detector expansion'):
        read_scan(payload, 'bomb.h5')
