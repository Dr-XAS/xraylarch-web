"""Wide detector tables must survive inspection, processing and project reopen."""
from io import StringIO

import numpy as np
import pytest
from fastapi.testclient import TestClient

from xraylarch_web.config import Settings
from xraylarch_web.main import create_app
from xraylarch_web.parsing import parse_upload
from xraylarch_web.errors import WebInputError


def wide_table(energy, mu, width=72):
    columns = [energy, mu, *(np.full_like(energy, i) for i in range(3, width + 1))]
    out = StringIO()
    np.savetxt(out, np.column_stack(columns),
               header="energy mu " + " ".join(f"detector_{i}" for i in range(3, width + 1)))
    return out.getvalue().encode(), columns


def test_wide_table_http_import_and_reopen(tmp_path, xas_arrays):
    raw, expected = wide_table(*xas_arrays)
    with TestClient(create_app(Settings(data_root=tmp_path))) as client:
        project = client.post('/api/athena/projects').json()
        base = f"/api/athena/projects/{project['id']}"
        response = client.post(base + '/inspect', files={'file': ('wide.0002', raw)})
        assert response.status_code == 200, response.text
        inspected = response.json()
        assert len(inspected['columns']) == 72
        assert inspected['columns'][-1]['name'] == 'detector_72'
        response = client.post(base + '/import', json={
            'version': project['version'], 'upload_id': inspected['upload_id'],
            **inspected['athena_suggestion'],
        })
        assert response.status_code == 200, response.text
        group = response.json()['groups'][0]
        assert group['processing_error'] is None
        retained = group['source']['column_arrays']
        assert len(retained) == 72
        for i, column in enumerate(expected, 1):
            np.testing.assert_array_equal(retained[f'column_{i:04d}'], column)
        exported = client.get(base + '/export', params={'format': 'json'})
        assert exported.status_code == 200, exported.text
        saved = exported.content

    # Recreate the application and restore the exported source arrays too.
    with TestClient(create_app(Settings(data_root=tmp_path))) as client:
        reopened = client.get(base).json()['groups'][0]
        assert reopened['source']['column_arrays'] == retained
        fresh = client.post('/api/athena/projects').json()
        response = client.post(f"/api/athena/projects/{fresh['id']}/restore",
                               params={'version': fresh['version']},
                               files={'file': ('wide.json', saved)})
        assert response.status_code == 200, response.text
        assert response.json()['groups'][0]['source']['column_arrays'] == retained


def test_default_column_boundary_and_environment_override(tmp_path, monkeypatch):
    energy, mu = np.array([1., 2.]), np.array([3., 4.])
    accepted, _ = wide_table(energy, mu, 256)
    rejected, _ = wide_table(energy, mu, 257)
    assert len(parse_upload(accepted, 'wide.dat').columns) == 256
    with pytest.raises(WebInputError) as error:
        parse_upload(rejected, 'wide.dat')
    assert error.value.code == 'upload_too_many_columns'

    monkeypatch.setenv('XRAYLARCH_DATA_ROOT', str(tmp_path))
    monkeypatch.setenv('XRAYLARCH_MAX_COLUMNS', '64')
    raw, _ = wide_table(energy, mu)
    with TestClient(create_app(Settings.from_environment())) as client:
        project = client.post('/api/athena/projects').json()
        response = client.post(f"/api/athena/projects/{project['id']}/inspect",
                               files={'file': ('wide.dat', raw)})
    assert response.status_code == 400
    assert response.json()['error']['code'] == 'upload_too_many_columns'
    assert '64 column limit' in response.json()['error']['message']
