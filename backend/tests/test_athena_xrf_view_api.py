"""HTTP tests for the raw XRF viewer routes.

Each test is named for one failure in the API table at the end of
docs/athena-xrf-viewer.md. The cubes come from the engine test module, so the
numbers that come back over HTTP have the same arithmetic answer there.
"""
import io

import numpy as np
import pytest
from fastapi.testclient import TestClient

from xraylarch_web.athena import AthenaStore
from xraylarch_web.config import Settings
from xraylarch_web.main import create_app

from test_athena_xrf_view import (CHANNELS, PEAK, cube_file, line_cube,
                                  raster_positions)


def workspace(tmp_path):
    settings = Settings(data_root=tmp_path)
    return settings, AthenaStore(settings).create()['id']


def uploaded(client, ident, data, route='xrf-view'):
    response = client.post(f'/api/athena/projects/{ident}/{route}/inspect',
                           files={'file': ('synthetic.h5', data)})
    assert response.status_code == 200, response.text
    return response.json()


def body(upload, **overrides):
    request = dict(version=0, cube_id=upload['upload_id'], detector='ge',
                   channel_range=[0, CHANNELS], roi_range=[PEAK, PEAK + 1])
    request.update(overrides)
    return request


def test_the_file_is_read_back_with_its_detector_axes_and_shape(tmp_path):
    """Everything the panel offers -- the detector menu, the point slider, the
    axis menu -- comes from this one response; a reader that misses any of
    them leaves the panel asking for something that does not exist."""
    data = cube_file(line_cube(np.arange(12.0)), [('energy', np.linspace(6.4e3, 7.2e3, 12))])
    settings, ident = workspace(tmp_path)
    with TestClient(create_app(settings)) as client:
        inspection = uploaded(client, ident, data)

    assert inspection['kind'] == 'xrf_cube'
    assert inspection['points'] == 12
    assert inspection['detectors'] == [dict(name='ge', elements=2, channels=CHANNELS)]
    assert [axis['name'] for axis in inspection['axes']] == ['energy']
    assert inspection['raster'] is None


def test_a_scan_uploaded_for_the_extraction_can_be_looked_at_without_a_second_upload(tmp_path):
    """The two panels want the same bytes. Refusing the extraction's upload
    here would make the demo -- raw spectrum, then corrected XANES, one file
    -- two uploads of the same ten megabytes."""
    from xrf_xas_scan_fixture import scan_file
    from test_athena_xrf_xas import synthetic_scan

    scan, counts, _, _ = synthetic_scan(points=10, detectors=1)
    settings, ident = workspace(tmp_path)
    with TestClient(create_app(settings)) as client:
        upload = uploaded(client, ident, scan_file(scan, counts), route='xrf-xas')
        assert upload['kind'] == 'xrf_scan'
        response = client.post(f'/api/athena/projects/{ident}/xrf-view/frame',
                               json=body(upload, channel_range=[380, 480],
                                         roi_range=[380, 480]))
    assert response.status_code == 200, response.text
    assert response.json()['points'] == 10


def test_an_upload_that_is_not_a_detector_file_is_refused(tmp_path):
    """Pointing a frame request at an ordinary column file used to read
    whatever bytes were on disk and fail deep inside h5py with a 500."""
    settings, ident = workspace(tmp_path)
    with TestClient(create_app(settings)) as client:
        plain = client.post(f'/api/athena/projects/{ident}/inspect',
                            files={'file': ('two-columns.dat', b'# e mu\n1 2\n3 4\n')})
        assert plain.status_code == 200, plain.text
        response = client.post(f'/api/athena/projects/{ident}/xrf-view/frame',
                               json=body(plain.json()))
    assert response.status_code == 400
    assert 'not a multi-channel detector file' in response.text


def test_a_frame_does_not_mutate_the_project(tmp_path):
    """Every slider move asks for a frame. If one wrote anything, scrubbing
    through a map would fill the project with history."""
    data = cube_file(line_cube(np.arange(8.0)))
    settings, ident = workspace(tmp_path)
    with TestClient(create_app(settings)) as client:
        upload = uploaded(client, ident, data)
        before = client.get(f'/api/athena/projects/{ident}').json()
        frame = client.post(f'/api/athena/projects/{ident}/xrf-view/frame',
                            json=body(upload, point=3))
        assert frame.status_code == 200, frame.text
        assert client.get(f'/api/athena/projects/{ident}').json() == before
    assert frame.json()['total'][PEAK] == pytest.approx(5.0)


def test_a_map_file_comes_back_with_its_image(tmp_path):
    """The map is the whole point of the route for a raster file, and it is
    built from the positions, which only the server has read."""
    rows, columns = 3, 4
    image = np.arange(rows * columns, dtype=float).reshape(rows, columns)
    data = cube_file(line_cube(image.reshape(-1)), raster_positions(rows, columns))
    settings, ident = workspace(tmp_path)
    with TestClient(create_app(settings)) as client:
        upload = uploaded(client, ident, data)
        assert upload['raster']['columns'] == columns
        frame = client.post(f'/api/athena/projects/{ident}/xrf-view/frame',
                            json=body(upload)).json()
    assert np.allclose(frame['map']['values'], image + 2.0)


def test_a_bad_frame_request_is_a_message_and_not_a_server_error(tmp_path):
    """A point past the end, an element that does not exist and a window of
    interest outside the channels read are all things a stale panel sends,
    and every one of them used to raise out of NumPy as a 500."""
    data = cube_file(line_cube(np.ones(6)))
    settings, ident = workspace(tmp_path)
    with TestClient(create_app(settings)) as client:
        upload = uploaded(client, ident, data)
        base = f'/api/athena/projects/{ident}/xrf-view/frame'
        for request, expected in (
                (body(upload, point=99), 'point 99 does not exist'),
                (body(upload, elements=[9]), '2 elements'),
                (body(upload, channel_range=[0, 10], roi_range=[40, 50]),
                 'outside the channels read'),
                (body(upload, detector='nonesuch'), 'no usable detector'),
                (body(upload, axis='nonesuch'), 'no array named nonesuch')):
            response = client.post(base, json=request)
            assert response.status_code == 400, (request, response.text)
            assert expected in response.text, response.text


def test_every_number_in_a_frame_survives_json(tmp_path):
    """A NaN or an infinity in a response is written by Python's json as a
    bare NaN, which no browser can parse: the panel goes blank with no error
    at all. An empty element or a zero-count window is the way in."""
    counts = line_cube(np.zeros(6), elements=2)
    counts[:, 0, :] = 0.0
    data = cube_file(counts)
    settings, ident = workspace(tmp_path)
    with TestClient(create_app(settings)) as client:
        upload = uploaded(client, ident, data)
        response = client.post(f'/api/athena/projects/{ident}/xrf-view/frame',
                               json=body(upload))
    assert response.status_code == 200, response.text
    assert 'NaN' not in response.text and 'Infinity' not in response.text
