import copy
import hashlib
import json
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from xraylarch_web.athena import AthenaStore, Command, ImportRequest
from xraylarch_web.athena_file_plugins import plugin_catalog, prepare_file
from xraylarch_web.athena_plugin_registry import PluginRegistry, decode_registry, encode_registry
from xraylarch_web.athena_preferences import AthenaPreferences
from xraylarch_web.config import Settings
from xraylarch_web.errors import WebInputError
from xraylarch_web.main import create_app

X10C = 'Demeter::Plugins::X10C'
LYTLE = 'Demeter::Plugins::Lytle'
FIXTURES = Path(__file__).parent / 'fixtures'


def test_native_default_off_catalog_order_and_project_independence(tmp_path):
    prefs = AthenaPreferences(Settings(data_root=tmp_path))
    assert prefs.read_plugins() == {'version': 0, 'enabled': {}}
    assert [p['name'] for p in plugin_catalog()] == ['10BMMultiChannel', 'B18', 'BL8Ar', 'BM23', 'CMC', 'DUBBLE', 'HXMA', 'LNLS', 'Lytle', 'PFBL12C', 'SLRIBL4', 'SPEC', 'SRS', 'SSRLA', 'SSRLB', 'SSRLmicro', 'SpecFileLongLine', 'X10C', 'X15B', 'X23A2MED', 'X23A2MultiChannel', 'Zip']
    assert all(p['documentation'] and p['documentation_url'].endswith(p['name'] + '.pm') for p in plugin_catalog())
    store = AthenaStore(prefs_settings := Settings(data_root=tmp_path)); p = store.create()
    grid = prefs.read(); memory = prefs.read_columns()
    saved = prefs.save_plugins(PluginRegistry(enabled={X10C: True}))
    assert saved == {'version': 1, 'enabled': {X10C: True}}
    assert AthenaPreferences(prefs_settings).read_plugins() == saved
    assert store.load(p['id']) == p
    assert prefs.read() == grid and prefs.read_columns() == memory
    assert AthenaPreferences(Settings(data_root=tmp_path / 'other')).read_plugins()['enabled'] == {}


@pytest.mark.parametrize('name,ident', [('x10c', X10C), ('lytle', LYTLE)])
def test_enabled_reader_controls_inspection_but_not_already_staged_or_imported_data(tmp_path, name, ident):
    settings=Settings(data_root=tmp_path); prefs=AthenaPreferences(settings); store=AthenaStore(settings)
    p=store.create(); data=(FIXTURES / f'demeter-{name}.dat').read_bytes()
    before=sorted(store.storage.workspace_dir(p['id']).iterdir())
    with pytest.raises(WebInputError) as error: store.inspect(p['id'],data,'source.dat')
    assert error.value.code=='file_plugin_disabled' and 'Plugin registry' in error.value.recovery
    assert sorted(store.storage.workspace_dir(p['id']).iterdir())==before
    prefs.save_plugins(PluginRegistry(enabled={ident: True}))
    inspected=store.inspect(p['id'],data,'source.dat')
    request=ImportRequest(version=0,upload_id=inspected['upload_id'],**inspected['athena_suggestion'])
    prefs.save_plugins(PluginRegistry(version=1,enabled={ident: False}))
    preview=store.preview_columns(p['id'],request)
    imported=store.import_data(p['id'],request); original=copy.deepcopy(imported)
    assert imported['groups'][0]['energy']==preview['traces'][0]['x']
    assert imported['groups'][0]['processing_error'] is None
    with pytest.raises(WebInputError): store.inspect(p['id'],data,'next.dat')
    assert store.load(p['id'])==original
    exported=store.export_project(p['id'],'prj')
    undone=store.command(p['id'],Command(version=imported['version'],action='undo'))
    assert undone['groups']==[] and not prefs.read_plugins()['enabled'][ident]
    restored=store.restore(store.create()['id'],0,exported,'p.prj')
    assert restored['groups'][0]['energy']==imported['groups'][0]['energy']
    assert restored['groups'][0]['source']==imported['groups'][0]['source']
    assert not prefs.read_plugins()['enabled'][ident]


def test_disabled_converters_are_never_called_and_later_enabled_match_can_run(monkeypatch):
    from xraylarch_web import athena_file_plugins as module
    calls=[]; first=next(p for p in module._PLUGINS if p.name=='X10C')
    second=replace(first,name='Later',transform=lambda *args: calls.append('later') or 'converted')
    first=replace(first,transform=lambda *args: pytest.fail('Disabled converter ran'))
    monkeypatch.setattr(module,'_PLUGINS',(first,second))
    result=prepare_file(b'EXAFS\n DATA START\n',max_bytes=100,max_points=100,max_columns=8,
                        enabled={second.ident: True})
    assert result=='converted' and calls==['later']


def test_generic_files_need_no_plugin_enablement(tmp_path):
    s=AthenaStore(Settings(data_root=tmp_path));p=s.create()
    assert s.inspect(p['id'],b'# energy mu\n1000 1\n1001 2\n','simple.dat')['row_count']==2


@pytest.mark.parametrize('value', [0,1,'true',None,[],{}])
def test_api_flags_are_actual_booleans(value):
    with pytest.raises(ValidationError): PluginRegistry(enabled={X10C:value})


@pytest.mark.parametrize('name', ['X10C','../../file','Demeter::Plugins::FileType','Demeter::Plugins::bad-name','Demeter::Plugins::'])
def test_registry_keys_are_native_plugin_names(name):
    with pytest.raises(ValidationError): PluginRegistry(enabled={name:True})


def test_stale_window_and_failed_write_do_not_replace_registry(tmp_path, monkeypatch):
    settings=Settings(data_root=tmp_path);prefs=AthenaPreferences(settings)
    def save(ident):
        try:return AthenaPreferences(settings).save_plugins(PluginRegistry(enabled={ident:True}))
        except WebInputError as e:return e.code
    with ThreadPoolExecutor(max_workers=2) as pool: results=list(pool.map(save,[X10C,LYTLE]))
    assert results.count('stale_revision')==1
    saved=prefs.read_plugins(); assert saved in results
    with monkeypatch.context() as patch:
        patch.setattr('xraylarch_web.storage.os.replace',lambda *args: (_ for _ in ()).throw(OSError('disk full')))
        with pytest.raises(OSError):prefs.save_plugins(PluginRegistry(version=1,enabled={}))
    assert prefs.read_plugins()==saved
    prefs.storage.path(prefs.ident,'plugins.json').write_text('{broken')
    with pytest.raises(ValueError):prefs.read_plugins()
    with pytest.raises(ValueError):prefs.save_plugins(PluginRegistry())


def test_native_yaml_flags_and_unknown_entries_roundtrip():
    data=b'---\nDemeter::Plugins::X10C: 1\nDemeter::Plugins::Lytle: false\nDemeter::Plugins::SSRLA: true\n'
    flags=decode_registry(data)
    assert flags=={X10C:True,LYTLE:False,'Demeter::Plugins::SSRLA':True}
    exported=encode_registry({'enabled':flags})
    assert decode_registry(exported)=={p['id']:False for p in plugin_catalog()} | flags
    unknown={**flags, 'Demeter::Plugins::B18':True}
    assert decode_registry(encode_registry({'enabled':unknown}))['Demeter::Plugins::B18']
    assert exported.startswith(b'---\n') and b'"' not in exported
    assert b'Demeter::Plugins::Lytle: 0' in exported
    manifest=json.loads((FIXTURES/'athena-plugin-registry-native.json').read_text())
    native=(FIXTURES/manifest['file']).read_bytes()
    assert len(native)==manifest['bytes'] and hashlib.sha256(native).hexdigest()==manifest['sha256']
    assert decode_registry(native)==manifest['expected']==flags


@pytest.mark.parametrize('data', [b'',b'[]',b'---\n- plugin',b'X10C: 1',b'Demeter::Plugins::X10C: maybe',
    b'Demeter::Plugins::X10C: 1\nDemeter::Plugins::X10C: 0',
    b'Demeter::Plugins::X10C: {nested: true}',b'Demeter::Plugins::X10C: &a true\nDemeter::Plugins::Lytle: *a',
    b'!!python/object:danger {}',b'---\n{}\n---\n{}',b'\xff',b'x'*64001])
def test_invalid_yaml_does_not_have_an_ambiguous_enabled_state(data):
    with pytest.raises(WebInputError):decode_registry(data)


def test_real_http_native_registry_import_export_validation_and_conflicts(tmp_path):
    settings=Settings(data_root=tmp_path)
    with TestClient(create_app(settings)) as client:
        url='/api/athena/preferences/plugins'; r=client.get(url); assert r.status_code==200
        state=r.json(); assert state['enabled']=={} and state['version']==0
        saved=client.put(url,json={'version':0,'enabled':{X10C:True}})
        assert saved.status_code==200 and saved.json()['enabled']=={X10C:True}
        assert client.put(url,json={'version':0,'enabled':{}}).status_code==409
        assert client.put(url,json={'version':1,'enabled':{X10C:1}}).status_code==422
        download=client.get(url+'/export')
        assert download.status_code==200 and 'athena.plugin_registry' in download.headers['content-disposition']
        assert decode_registry(download.content)[X10C]
        yaml_file=b'---\nDemeter::Plugins::X10C: 0\nDemeter::Plugins::SSRLA: 1\n'
        imported=client.post(url+'/import?version=1',files={'file':('athena.plugin_registry',yaml_file)})
        assert imported.status_code==200 and imported.json()['version']==2
        assert imported.json()['enabled']=={X10C:False,'Demeter::Plugins::SSRLA':True}
        assert client.post(url+'/import?version=1',files={'file':('registry',yaml_file)}).status_code==409
        assert client.post(url+'/import?version=2',files={'file':('registry',b'bad: value')}).status_code==400
        assert client.get(url).json()==imported.json()
    with TestClient(create_app(settings)) as client:
        assert client.get(url).json()==imported.json()
