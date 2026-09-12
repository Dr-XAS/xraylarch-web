from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import json

from fastapi.testclient import TestClient
from pydantic import ValidationError
import pytest

from xraylarch_web.athena_plugin_config import ConfigurationRequest, PluginConfigurations, X15BParameters, X23A2MEDParameters
from xraylarch_web.athena_preferences import AthenaPreferences
from xraylarch_web.config import Settings
from xraylarch_web.errors import WebInputError
from xraylarch_web.main import create_app

FIXTURES = Path(__file__).parent / 'fixtures'


def request(state, values=None, save=False):
    return ConfigurationRequest(version=state['version'], session_id=state['session_id'], values=values or state['values'], save=save)


def test_defaults_match_executed_native_configuration_and_field_contract(tmp_path):
    configs = PluginConfigurations(Settings(data_root=tmp_path))
    for reader, model, file in [('X15B', X15BParameters, 'athena-x15b-fixtures.json'),
                                ('X23A2MED', X23A2MEDParameters, 'athena-x23a2med-fixtures.json')]:
        ref = json.loads((FIXTURES / file).read_text())['references'][0]
        expected = {k: v for k, v in ref['values'].items() if k != 'multiedge_regex'}
        state = configs.read(reader)
        assert state['values'] == state['saved'] == state['defaults'] == expected == model().model_dump()
        assert state['version'] == 0 and not state['unsaved']
        assert [f['name'] for f in state['fields']] == list(expected)
    assert not configs.storage.path(configs.ident, 'plugin-config.json').exists()


def test_apply_is_session_only_and_apply_save_persists_all_applied_readers(tmp_path):
    settings = Settings(data_root=tmp_path); c = PluginConfigurations(settings); prefs = AthenaPreferences(settings)
    before = prefs.read_plugins(), prefs.read(), prefs.read_columns()
    x15 = c.read('X15B'); applied = c.apply('X15B', request(x15, x15['values'] | {'narrow': 9}))
    assert applied['unsaved'] and applied['values']['narrow'] == 9 and applied['saved']['narrow'] == 7
    assert c.read('X15B') == applied
    assert PluginConfigurations(settings).read('X15B')['values']['narrow'] == 7
    x23 = c.read('X23A2MED'); c.apply('X23A2MED', request(x23, x23['values'] | {'dt1': 0}))
    x15 = c.read('X15B'); saved = c.apply('X15B', request(x15, save=True))
    assert not saved['unsaved'] and saved['saved'] == saved['values']
    restarted = PluginConfigurations(settings)
    assert restarted.read('X15B')['values']['narrow'] == 9
    assert restarted.read('X23A2MED')['values']['dt1'] == 0
    assert (prefs.read_plugins(), prefs.read(), prefs.read_columns()) == before


def test_stale_windows_other_writers_and_server_restarts_cannot_overwrite(tmp_path):
    settings = Settings(data_root=tmp_path); a = PluginConfigurations(settings); b = PluginConfigurations(settings)
    window1 = a.read('X15B'); window2 = a.read('X23A2MED'); other = b.read('X15B')
    accepted = a.apply('X15B', request(window1, window1['values'] | {'wide': 10}, save=True))
    for configs, reader, state in [(a, 'X23A2MED', window2), (b, 'X15B', other),
                                   (PluginConfigurations(settings), 'X15B', accepted)]:
        with pytest.raises(WebInputError) as error: configs.apply(reader, request(state))
        assert error.value.code == 'stale_revision'
    assert b.read('X15B')['values']['wide'] == 10


def test_parallel_apply_and_failed_disk_write_keep_confirmed_state(tmp_path, monkeypatch):
    c = PluginConfigurations(Settings(data_root=tmp_path)); state = c.read('X15B')
    def change(value):
        try: return c.apply('X15B', request(state, state['values'] | {'narrow': value}))
        except WebInputError as e: return e.code
    with ThreadPoolExecutor(max_workers=2) as pool: result = list(pool.map(change, [8, 9]))
    assert result.count('stale_revision') == 1
    before = c.read('X15B')
    with monkeypatch.context() as patch:
        patch.setattr('xraylarch_web.storage.os.replace', lambda *args: (_ for _ in ()).throw(OSError('disk full')))
        with pytest.raises(OSError): c.apply('X15B', request(before, before['values'] | {'wide': 12}, save=True))
    assert c.read('X15B') == before
    assert not c.storage.path(c.ident, 'plugin-config.json').exists()


@pytest.mark.parametrize('value', [0, 15, 1.5, 6., '6', True, None])
def test_x15b_columns_are_native_bounded_integers(value):
    with pytest.raises(ValidationError): X15BParameters(i0=value)


@pytest.mark.parametrize('field,value', [('dt1', -1), ('dt2', 10001), ('dt3', 280.), ('dt4', True),
    ('inttime', 0), ('inttime', float('nan')), ('inttime', float('inf')), ('time', 'guess'),
    ('roi1', ''), ('roi2', 'a'*129), ('slow3', 5), ('fast4', None), ('unknown', 5)])
def test_med_parameters_reject_ambiguous_or_nonfinite_values(field, value):
    with pytest.raises(ValidationError): X23A2MEDParameters.model_validate({field: value})


@pytest.mark.parametrize('content', ['{broken', '{"version":0,"values":{"Other":{}}}',
    '{"version":0,"values":{"X15B":{"energy":1000}}}', '{"version":false,"values":{}}'])
def test_damaged_saved_configuration_is_not_replaced(tmp_path, content):
    c = PluginConfigurations(Settings(data_root=tmp_path)); state = c.read('X15B')
    p = c.storage.path(c.ident, 'plugin-config.json'); p.write_text(content)
    with pytest.raises(ValueError): c.read('X15B')
    with pytest.raises(ValueError): c.apply('X15B', request(state, save=True))
    assert p.read_text() == content


def test_real_http_apply_save_restart_conflict_and_registry_independence(tmp_path):
    settings = Settings(data_root=tmp_path); path = '/api/athena/preferences/plugins/X15B/configuration'
    with TestClient(create_app(settings)) as client:
        original = client.get('/api/athena/preferences/plugins').json()
        configured = [p['name'] for p in original['plugins'] if p.get('configurable')]
        assert configured == ['10BMMultiChannel', 'BL8Ar', 'X15B', 'X23A2MED']
        state = client.get(path).json(); body = request(state, state['values'] | {'narrow':9}).model_dump()
        applied = client.put(path, json=body); assert applied.status_code == 200 and applied.json()['unsaved']
        assert client.put(path, json=body).status_code == 409
        assert client.get('/api/athena/preferences/plugins').json() == original
        state = applied.json(); body = request(state, save=True).model_dump()
        saved = client.put(path, json=body); assert saved.status_code == 200 and not saved.json()['unsaved']
        for changes in [{'save':1}, {'version':False}, {'values':[]}, {'session_id':''}]:
            assert client.put(path, json=body | changes).status_code == 422
        assert client.get(path.replace('X15B','X10C')).status_code == 400
    with TestClient(create_app(settings)) as client:
        loaded = client.get(path).json(); assert loaded['values']['narrow'] == 9
        assert loaded['session_id'] != saved.json()['session_id']
        assert client.put(path, json=request(saved.json()).model_dump()).status_code == 409
