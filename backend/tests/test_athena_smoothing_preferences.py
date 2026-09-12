"""Native effective preferences, session/persisted state and scientific binding."""
import copy
import gzip
import hashlib
import json
import subprocess
import sys
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from xraylarch_web.athena import AthenaStore, Command
from xraylarch_web.athena_smoothing import SmoothOptions, smooth
from xraylarch_web.athena_smoothing_preferences import SmoothingPreferences, SGValues, SGPreferenceRequest
from xraylarch_web.config import Settings
from xraylarch_web.errors import WebInputError
from xraylarch_web.main import create_app

FIXTURES = Path(__file__).parent/'fixtures'
NATIVE = json.loads(gzip.decompress((FIXTURES/'athena-smoothing-preferences-native.json.gz').read_bytes()))


def request(state, values=None, save=False):
    return SGPreferenceRequest(version=state['version'],session_id=state['session_id'],values=values or state['values'],save=save)


@pytest.mark.parametrize('row', NATIVE['rows'], ids=lambda r:r['name'])
def test_native_preference_values_feed_identical_larch_template_output(row):
    assert row['bounds'] == {'sg_size':[0,39], 'sg_order':[9,39]}
    assert row['declared'] == {'sg_size':31,'sg_order':4}
    choice = SmoothOptions(method='savitzky_golay',**row['values'])
    if row.get('error_type'):
        assert row['error_type'] == 'UFuncTypeError'
        with pytest.raises(ValueError,match='reduce the polynomial order'):
            smooth(np.arange(len(NATIVE['input_mu'])), NATIVE['input_mu'], choice)
        return
    actual = smooth(np.arange(len(NATIVE['input_mu'])), NATIVE['input_mu'], choice)
    np.testing.assert_allclose(actual['mu'], row['smoothed_mu'], atol=2e-14, rtol=2e-14)


def test_factory_effective_default_is_nine_despite_literal_four():
    factory = NATIVE['rows'][0]
    assert SGValues().model_dump() == factory['values'] == {'window':31,'order':9}
    assert factory['saved']['sg_order'] == '4'
    assert SmoothOptions(method='savitzky_golay').order == 9


def test_apply_save_and_restart_follow_native_observations(tmp_path):
    settings = Settings(data_root=tmp_path); prefs = SmoothingPreferences(settings)
    native = {r['name']:r for r in NATIVE['rows']}
    state = prefs.read(); state = prefs.apply(request(state,dict(window=13,order=9)))
    assert state['values'] == native['apply-window']['values'] and state['unsaved']
    state = prefs.apply(request(state,dict(window=13,order=11)))
    assert state['values'] == native['apply-order']['values']
    restarted = SmoothingPreferences(settings); fresh = restarted.read()
    assert fresh['session_id'] != state['session_id']
    assert fresh['values'] == native['restart-discards-applied']['values']
    fresh = restarted.apply(request(fresh,dict(window=12,order=9)))
    fresh = restarted.apply(request(fresh,dict(window=12,order=11),save=True))
    assert fresh['values'] == fresh['saved'] == native['save-includes-earlier-window']['values']
    assert not fresh['unsaved']
    assert SmoothingPreferences(settings).read()['values'] == native['restart-loads-saved']['values']
    script = 'import json,sys; from xraylarch_web.config import Settings; from xraylarch_web.athena_smoothing_preferences import SmoothingPreferences; print(json.dumps(SmoothingPreferences(Settings(data_root=sys.argv[1])).read()))'
    independent = json.loads(subprocess.check_output([sys.executable,'-c',script,str(tmp_path)],text=True))
    assert independent['values'] == native['restart-loads-saved']['values']
    assert independent['session_id'] != fresh['session_id']
    with pytest.raises(WebInputError,match='server restarted'):
        restarted.apply(request(state))


def test_concurrent_windows_and_external_disk_updates_cannot_overwrite_unreviewed_state(tmp_path):
    settings = Settings(data_root=tmp_path); prefs = SmoothingPreferences(settings); state = prefs.read()
    def apply(window):
        try:return prefs.apply(request(state,dict(window=window,order=9)))
        except WebInputError as e:return e.code
    with ThreadPoolExecutor(max_workers=2) as pool: results = list(pool.map(apply,[15,17]))
    assert results.count('stale_revision') == 1
    accepted = next(v for v in results if isinstance(v,dict))
    other = SmoothingPreferences(settings); view = other.read()
    other.apply(request(view,dict(window=21,order=11),save=True))
    with pytest.raises(WebInputError,match='preferences changed'):
        prefs.apply(request(accepted,save=True))
    refreshed = prefs.read()
    assert refreshed['values'] == accepted['values']  # Explicit local session Apply remains active.
    assert refreshed['saved'] == dict(window=21,order=11)


@pytest.mark.parametrize('values', [dict(window=40),dict(window=-1),dict(window=True),dict(window=1.5),dict(order=4),dict(order=40),dict(order='9'),dict(extra=1)])
def test_invalid_preference_edits_are_rejected_before_mutation(tmp_path, values):
    prefs = SmoothingPreferences(Settings(data_root=tmp_path)); state = prefs.read()
    with pytest.raises(ValidationError): prefs.apply(request(state,{**state['values'],**values}))
    assert prefs.read() == state


@pytest.mark.parametrize('partial', [{}, {'window':17}, {'order':11}])
def test_partial_requests_cannot_reset_the_other_applied_preference(tmp_path, partial):
    prefs = SmoothingPreferences(Settings(data_root=tmp_path)); state = prefs.read()
    state = prefs.apply(request(state,dict(window=21,order=11)))
    with pytest.raises(ValidationError,match='Supply both'):
        prefs.apply(SGPreferenceRequest(version=state['version'],session_id=state['session_id'],values=partial,save=True))
    assert prefs.read() == state


def test_failed_persistence_keeps_previous_session_and_disk_values(tmp_path, monkeypatch):
    prefs = SmoothingPreferences(Settings(data_root=tmp_path)); state = prefs.read()
    state = prefs.apply(request(state,dict(window=13,order=11)))
    def failed(*args):raise OSError('Disk full')
    monkeypatch.setattr(prefs.storage,'write_json',failed)
    with pytest.raises(OSError,match='Disk full'):prefs.apply(request(state,dict(window=17,order=9),save=True))
    assert prefs.read() == state
    assert SmoothingPreferences(Settings(data_root=tmp_path)).read()['values'] == SGValues().model_dump()


def test_previews_capture_preferences_and_changes_do_not_mutate_spectra_or_saved_choices(tmp_path):
    store = AthenaStore(Settings(data_root=tmp_path)); p = store.create()
    p = store.command(p['id'],Command(version=0,action='example')); before = copy.deepcopy(p)
    prefs = store.smoothing_preferences; state = prefs.read()
    state = prefs.apply(request(state,dict(window=21,order=11)))
    req = Command(version=p['version'],action='smooth',group_ids=[p['groups'][0]['id']],options=dict(method='savitzky_golay'))
    preview = store.preview_smoothing(p['id'],req)
    assert preview['options']['window'] == 21 and preview['options']['order'] == 11
    prefs.apply(request(state,dict(window=31,order=9),save=True))
    assert store.load(p['id']) == before
    req.options = preview['options']; after = store.command(p['id'],req)
    assert after['groups'][1]['mu'] == preview['results'][0]['smoothed_mu']
    assert after['groups'][1]['source']['options']['order'] == 11
    undone = store.command(p['id'],Command(version=after['version'],action='undo'))
    assert undone['groups'] == before['groups']
    assert prefs.read()['values'] == dict(window=31,order=9)
    assert AthenaStore(store.settings).smoothing_preferences.read()['values'] == dict(window=31,order=9)


def test_http_preference_contract_and_restart_session_guard(tmp_path):
    settings = Settings(data_root=tmp_path); client = TestClient(create_app(settings)); path = '/api/athena/preferences/smoothing'
    state = client.get(path).json(); req = request(state,dict(window=15,order=11),save=True).model_dump()
    response = client.put(path,json=req); assert response.status_code == 200 and not response.json()['unsaved']
    assert client.put(path,json=req).status_code == 409
    new_client = TestClient(create_app(settings)); fresh = new_client.get(path).json()
    assert fresh['values'] == dict(window=15,order=11) and fresh['session_id'] != state['session_id']
    assert new_client.put(path,json=request(response.json()).model_dump()).status_code == 409
    bad = request(fresh).model_dump(); bad['values']['order'] = 4
    assert new_client.put(path,json=bad).status_code == 422


def test_native_manifest_and_sources():
    root = Path(__file__).resolve().parents[2]
    manifest = json.loads((FIXTURES/'athena-smoothing-preferences-fixtures.json').read_text())
    catalog = {r['file']:r['sha256'] for r in json.loads((root/'docs/athena-primary-sources.json').read_text())['files']}
    assert manifest['source_sha256'] == NATIVE['sources']
    for path,sha in manifest['sha256'].items():assert hashlib.sha256((root/path).read_bytes()).hexdigest() == sha
    for path,sha in NATIVE['sources'].items():assert catalog['demeter-'+manifest['demeter_revision']+'/'+path] == sha
    assert manifest['native_modules'] == NATIVE['modules']
    assert manifest['case_count'] == len(NATIVE['rows']) == 13
