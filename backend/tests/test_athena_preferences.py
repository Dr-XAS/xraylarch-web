import copy
import json
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from xraylarch_web.athena import AthenaStore
from xraylarch_web.athena_preferences import AthenaPreferences, RebinDefaults, RebinGrid
from xraylarch_web.athena_rebin import ImportRebin
from xraylarch_web.config import Settings
from xraylarch_web.errors import WebInputError
from xraylarch_web.main import create_app


def test_defaults_match_science_and_persist_outside_project_history(tmp_path):
    settings = Settings(data_root=tmp_path)
    preferences = AthenaPreferences(settings)
    default = preferences.read()
    assert default == {'version': 0, 'grid': ImportRebin().model_dump(exclude={'e0'})}
    store = AthenaStore(settings); project = store.create()
    before = copy.deepcopy(project)
    grid = dict(default['grid'], emin=-20, pre=5, exafs=.08, width=4)
    assert preferences.save(RebinDefaults(version=0, grid=grid)) == {'version': 1, 'grid': grid}
    assert AthenaPreferences(settings).read() == {'version': 1, 'grid': grid}
    assert store.load(project['id']) == before
    assert store.list()[0]['id'] == project['id'] and len(store.list()) == 1
    assert AthenaPreferences(Settings(data_root=tmp_path / 'other')).read() == default
    assert 'grid' not in json.loads(store.export_project(project['id'], format='json'))


@pytest.mark.parametrize('field,value', [
    ('width', 0), ('width', 12), ('width', 2.5), ('width', True),
    ('pre', 0), ('xanes', -1), ('exafs', float('inf')), ('emin', float('nan')),
    ('emin', '0'), ('emax', -40), ('emin', 50), ('e0', 8980), ('enabled', True),
])
def test_invalid_defaults_cannot_be_saved(tmp_path, field, value):
    prefs = AthenaPreferences(Settings(data_root=tmp_path))
    original = prefs.read()
    with pytest.raises(ValidationError):
        prefs.save(RebinDefaults(version=0, grid={**original['grid'], field: value}))
    assert prefs.read() == original


def test_reversed_boundaries_and_zero_start_remain_valid():
    assert RebinGrid(emin=50, emax=-20).emin == 50
    assert RebinGrid(emin=0).emin == 0


def test_two_windows_cannot_overwrite_each_others_defaults(tmp_path):
    settings = Settings(data_root=tmp_path)
    prefs = AthenaPreferences(settings)
    def save(pre):
        try:
            return AthenaPreferences(settings).save(RebinDefaults(version=0, grid=RebinGrid(pre=pre)))
        except WebInputError as error:
            return error.code
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(save, [5, 7]))
    assert results.count('stale_revision') == 1
    assert prefs.read() == next(result for result in results if isinstance(result, dict))


def test_io_failure_and_malformed_storage_are_not_silently_overwritten(tmp_path, monkeypatch):
    prefs = AthenaPreferences(Settings(data_root=tmp_path))
    saved = prefs.save(RebinDefaults(grid=RebinGrid(pre=5)))
    def broken(*args): raise OSError('disk full')
    with monkeypatch.context() as patch:
        patch.setattr('xraylarch_web.storage.os.replace', broken)
        with pytest.raises(OSError, match='disk full'):
            prefs.save(RebinDefaults(version=1, grid=RebinGrid(pre=7)))
    assert prefs.read() == saved
    prefs.storage.path(prefs.ident, 'rebin.json').write_text('{broken')
    with pytest.raises(ValueError): prefs.read()
    with pytest.raises(ValueError): prefs.save(RebinDefaults(version=0))


def test_real_api_read_save_conflict_reload_reset_and_validation(tmp_path):
    settings = Settings(data_root=tmp_path)
    with TestClient(create_app(settings)) as client:
        url = '/api/athena/preferences/rebin'
        original = client.get(url).json()
        changed = {**original, 'grid': {**original['grid'], 'xanes': .2}}
        saved = client.put(url, json=changed)
        assert saved.status_code == 200 and saved.json()['version'] == 1
        assert client.put(url, json=changed).status_code == 409
        assert client.put(url, json={**changed, 'version': 1, 'grid': {'pre': 0}}).status_code == 422
        assert client.get(url).json() == saved.json()
    with TestClient(create_app(settings)) as client:
        assert client.get(url).json() == saved.json()
        reset = client.put(url, json={**original, 'version': 1})
        assert reset.status_code == 200 and reset.json() == {**original, 'version': 2}
