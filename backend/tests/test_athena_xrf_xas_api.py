"""HTTP tests for the scan-resolved XRF-to-XAS routes.

Each test is named for one failure in the API table at the end of
docs/athena-xrf-xas-reference.md, which was written before any of them. The
scan file is synthesised from Larch's own XRF model and written to HDF5 in
the layout the beamline uses, so nothing here depends on measured data.
"""
import copy
import io
import math

import numpy as np
import pytest
from fastapi.testclient import TestClient

from xraylarch_web import athena_xrf_xas as engine
from xraylarch_web.athena import AthenaStore
from xraylarch_web.config import Settings
from xraylarch_web.main import create_app

from test_athena_xrf_xas import small_scan
from xrf_xas_scan_fixture import DETECTOR_CHANNELS, scan_file

pytestmark = pytest.mark.xrf_slow


@pytest.fixture(scope='module')
def synthetic():
    scan, counts, options, _ = small_scan(points=24)
    return scan_file(scan, counts), options


@pytest.fixture(scope='module')
def dense():
    """Finely enough sampled for AUTOBK to place distinct spline knots, so
    exported groups process the way a real scan's would. Below about 120
    points over this range Larch refuses the background, which is a property
    of the grid and not of the extraction."""
    scan, counts, options, _ = small_scan(points=120)
    return scan_file(scan, counts), options


def workspace(tmp_path, **overrides):
    settings = Settings(data_root=tmp_path, **overrides)
    store = AthenaStore(settings)
    return settings, store, store.create()['id']


def uploaded(client, ident, data):
    response = client.post(f'/api/athena/projects/{ident}/xrf-xas/inspect',
                           files={'file': ('synthetic.h5', data)})
    assert response.status_code == 200, response.text
    return response.json()


def payload(options, upload, **overrides):
    request = options.model_dump()
    request.update(version=0, scan_id=upload['upload_id'])
    request.update(overrides)
    return request


def every_number(value, path='response'):
    """Yield (path, number) for every number anywhere in a JSON response."""
    if isinstance(value, dict):
        for key, child in value.items():
            yield from every_number(child, f'{path}.{key}')
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from every_number(child, f'{path}[{index}]')
    elif isinstance(value, float) or isinstance(value, int):
        yield path, value


def test_the_scan_file_is_read_back_with_its_detector_and_channels(tmp_path, synthetic):
    """If the reader misses the detector array or the scalar channels, the
    panel has nothing to offer and every later request names a channel that
    does not exist."""
    data, _ = synthetic
    _, _, ident = workspace(tmp_path)
    with TestClient(create_app(Settings(data_root=tmp_path))) as client:
        inspection = uploaded(client, ident, data)
    assert inspection['points'] == 24
    assert inspection['detectors'] == [dict(name='ge', elements=2,
                                            channels=DETECTOR_CHANNELS,
                                            unusable_elements=[])]
    assert inspection['channels'] == ['i0']


def test_stale_version_is_rejected_before_and_after_the_solve(tmp_path, synthetic, monkeypatch):
    """The solve runs unlocked because it takes seconds to minutes, so a
    concurrent edit can land while it runs. Checking the version only on the
    way in would let the fit overwrite that edit."""
    data, options = synthetic
    settings, _, ident = workspace(tmp_path)
    with TestClient(create_app(settings)) as client:
        upload = uploaded(client, ident, data)
        base = f'/api/athena/projects/{ident}/xrf-xas'

        early = client.post(base + '/make', json=payload(options, upload, version=7))
        assert early.status_code == 409

        # A second store on the same data root is a genuine concurrent writer:
        # it bumps the project version while the fit is still running.
        racer = AthenaStore(settings)
        solve = engine.extract

        def racing(scan, counts, request, *rest, **kwargs):
            current = racer.load(ident)
            racer.save(copy.deepcopy(current), current, 'concurrent edit')
            return solve(scan, counts, request, *rest, **kwargs)

        monkeypatch.setattr(engine, 'extract', racing)
        late = client.post(base + '/make', json=payload(options, upload))
        assert late.status_code == 409
        monkeypatch.undo()

        assert client.get(f'/api/athena/projects/{ident}').json()['groups'] == []


def test_preview_does_not_mutate_the_project(tmp_path, synthetic):
    """A preview is refitted on every settings change. If it wrote anything,
    dragging a slider would fill the project with abandoned groups."""
    data, options = synthetic
    settings, _, ident = workspace(tmp_path)
    with TestClient(create_app(settings)) as client:
        upload = uploaded(client, ident, data)
        before = client.get(f'/api/athena/projects/{ident}').json()
        preview = client.post(f'/api/athena/projects/{ident}/xrf-xas/preview',
                              json=payload(options, upload))
        assert preview.status_code == 200, preview.text
        after = client.get(f'/api/athena/projects/{ident}').json()
    assert after == before
    assert preview.json()['version'] == before['version']


def test_response_arrays_are_finite(tmp_path, synthetic):
    """A zero I0 point, an empty fit window or a failed solve puts NaN or inf
    into the response. JSON carries those through and Plotly draws a gap, so
    a silently broken extraction would look like a plausible spectrum."""
    data, options = synthetic
    settings, _, ident = workspace(tmp_path)
    with TestClient(create_app(settings)) as client:
        upload = uploaded(client, ident, data)
        preview = client.post(f'/api/athena/projects/{ident}/xrf-xas/preview',
                              json=payload(options, upload))
    assert preview.status_code == 200, preview.text
    bad = [path for path, number in every_number(preview.json())
           if not math.isfinite(number)]
    assert bad == []


def test_unreadable_scan_is_rejected_with_a_recovery_message(tmp_path, synthetic):
    """Users select the wrong file often. A bare stack trace or a generic
    500 leaves them no idea which file to pick instead."""
    settings, _, ident = workspace(tmp_path)
    with TestClient(create_app(settings)) as client:
        route = f'/api/athena/projects/{ident}/xrf-xas/inspect'
        refused = client.post(route, files={'file': ('notes.txt', b'not an HDF5 file')})
        assert refused.status_code == 400
        assert 'Select the original scan file' in refused.text

        empty = io.BytesIO()
        import h5py
        with h5py.File(empty, 'w') as handle:
            handle.create_group('entry').create_group('data')['counts'] = np.zeros(4)
        blank = client.post(route, files={'file': ('empty.h5', empty.getvalue())})
        assert blank.status_code == 400
        assert 'no energy array' in blank.text


def test_exported_groups_are_normalizable_and_carry_provenance(tmp_path, dense):
    """The point of the panel is an Athena group. A group Larch cannot
    normalize, or one that does not say how it was made, is not a result."""
    data, options = dense
    settings, _, ident = workspace(tmp_path)
    with TestClient(create_app(settings)) as client:
        upload = uploaded(client, ident, data)
        made = client.post(f'/api/athena/projects/{ident}/xrf-xas/make',
                           json=payload(options, upload, include_window_sum=True))
    assert made.status_code == 200, made.text
    groups = made.json()['groups']
    assert [group['source']['role'] for group in groups] == ['fit', 'roi']
    for group in groups:
        assert group['processing_error'] is None
        assert group['result']['effective']['edge_step'] > 0
        source = group['source']
        assert source['kind'] == 'xrf_xas'
        assert source['extraction']['target'] == options.target
        assert source['quality']['fit']['null_test']['mean_frac_of_jump'] is not None
        process = source['xdi_metadata']['attributes']['scan']['process']
        assert process == 'Extracted fluorescence XAS by fitting the XRF spectrum'
    # The window sum is kept for comparison only, and has to say so.
    assert groups[0]['source']['warnings'] == []
    assert 'sweep' in groups[1]['source']['warnings'][0]


def test_oversized_scan_is_refused(tmp_path, synthetic):
    """Starlette spools a whole multipart body to disk before the route runs.
    A scan route missing from the body-limit table fills the disk whatever the
    configured upload limit says."""
    data, _ = synthetic
    settings, _, ident = workspace(tmp_path, max_upload_bytes=10_000)
    assert len(data) > 10_000
    with TestClient(create_app(settings)) as client:
        refused = client.post(f'/api/athena/projects/{ident}/xrf-xas/inspect',
                              files={'file': ('synthetic.h5', data)})
    assert refused.status_code == 400
    assert refused.json()['error']['code'] == 'upload_too_large'


def test_the_inspection_offers_only_the_engines_this_server_has(tmp_path, synthetic,
                                                                monkeypatch):
    """MapsTorch is optional and not in the server's requirements. A panel
    told it is there when it is not offers a fit that can only fail, and one
    told it is absent when it is there hides the second model entirely."""
    from xraylarch_web import athena_xrf_mapstorch

    data, _ = synthetic
    _, _, ident = workspace(tmp_path)
    with TestClient(create_app(Settings(data_root=tmp_path))) as client:
        monkeypatch.setattr(athena_xrf_mapstorch, 'available', lambda: False)
        assert uploaded(client, ident, data)['engines'] == ['larch']
        monkeypatch.setattr(athena_xrf_mapstorch, 'available', lambda: True)
        assert uploaded(client, ident, data)['engines'] == ['larch', 'mapstorch']


def test_an_engine_the_server_does_not_have_is_refused_by_the_schema(tmp_path, synthetic):
    """The engine name selects an import. Accepted unchecked, a typo would
    reach the model table as a silent fall-through to the default, and the
    result would claim to have been fitted with something it was not."""
    data, options = synthetic
    _, _, ident = workspace(tmp_path)
    with TestClient(create_app(Settings(data_root=tmp_path))) as client:
        upload = uploaded(client, ident, data)
        refused = client.post(f'/api/athena/projects/{ident}/xrf-xas/preview',
                              json=payload(options, upload, engine='maps_torch'))
    assert refused.status_code == 422


@pytest.mark.skipif('mapstorch' not in engine.available_engines(),
                    reason='the optional mapstorch package is not installed')
def test_the_engine_the_request_names_is_the_one_that_made_the_result(tmp_path, synthetic):
    """Dropped between the request and the fitter, the setting would leave
    every fit Larch's while the panel reported a comparison between two
    models."""
    data, options = synthetic
    _, _, ident = workspace(tmp_path)
    with TestClient(create_app(Settings(data_root=tmp_path))) as client:
        upload = uploaded(client, ident, data)
        preview = client.post(f'/api/athena/projects/{ident}/xrf-xas/preview',
                              json=payload(options, upload, engine='mapstorch'))
    assert preview.status_code == 200, preview.text
    metadata = preview.json()['metadata']
    assert metadata['engine'] == 'mapstorch'
    # The Ge detector of this fixture puts the escape energy above the window,
    # so the engine has nothing to declare and must not invent a caveat.
    assert metadata['engine_notes'] == []
