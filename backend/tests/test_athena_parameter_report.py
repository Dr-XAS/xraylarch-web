import copy
import json
from pathlib import Path

from fastapi.testclient import TestClient
import pytest
import xlrd

from xraylarch_web.athena import AthenaStore, Command, ImportRequest
from xraylarch_web.athena_report import ParameterReport, COLUMNS, _clamp, _element_name, prepare_report, encode_report
from xraylarch_web.athena_science import AthenaParameters
from xraylarch_web.config import Settings
from xraylarch_web.main import create_app

FIXTURES = Path(__file__).parent / 'fixtures'
NATIVE = json.loads((FIXTURES / 'athena-parameter-report-native.json').read_text())


def test_all_element_names_match_the_native_report_library():
    for z, name in NATIVE['elements']:
        assert _element_name(z) == name


def reference_project():
    groups = []
    for index, n in enumerate(NATIVE['inputs']):
        p = AthenaParameters(e0=n['bkg_e0'], energy_shift=n['bkg_eshift'], rbkg=n['bkg_rbkg'],
            bkg_kweight=n['bkg_kw'], nnorm=n['bkg_nnorm']-1, pre1=n['bkg_pre1'], pre2=n['bkg_pre2'],
            norm1=n['bkg_nor1'], norm2=n['bkg_nor2'], bkg_kmin=n['bkg_spl1'], bkg_kmax=n['bkg_spl2'],
            clamp_lo=n['bkg_clamp1'], clamp_hi=n['bkg_clamp2'], kmin=n['fft_kmin'], kmax=n['fft_kmax'],
            dk=n['fft_dk'], window=n['fft_kwindow'], rmin=n['bft_rmin'], rmax=n['bft_rmax'],
            dr=n['bft_dr'], rwindow=n['bft_rwindow']).model_dump()
        groups.append(dict(id=str(index), label=n['name'], marked=n['marked'], frozen=n['frozen'],
            data_type='mu', is_normalized=False, multiplier=n['plot_multiplier'], offset=n['y_offset'], notes='',
            background_standard_id='0' if index == 1 else None, parameters=p,
            source={'native': {'args': n}, 'edge_identity': {'element': ['Cu','Fe','Cu'][index], 'edge':n['fft_edge'].upper(), 'origin':'explicit'}},
            result={'effective': dict(p, edge_step=n['bkg_step'], exafs=True), 'arrays':{}, 'warnings':[]}))
    return dict(id='constructed', name='Native report comparison', version=7, groups=groups)


@pytest.mark.parametrize('scope', ['all', 'marked'])
def test_all_parameter_cells_match_executed_native_workbooks(scope):
    p = reference_project(); before=copy.deepcopy(p)
    report = prepare_report(p, ParameterReport(version=7, scope=scope))
    filename, mime, raw = encode_report(report)
    assert raw[:8] == bytes.fromhex('d0cf11e0a1b11ae1')
    book = xlrd.open_workbook(file_contents=raw, formatting_info=True); sheet=book.sheet_by_index(0)
    assert book.nsheets == 1 and sheet.name == 'Parameters'
    assert sheet.row_values(6) == NATIVE[scope]['labels']
    for index, expected in enumerate(NATIVE[scope]['rows'], start=7):
        for column in COLUMNS:
            c=column['index']; cell=sheet.cell(index,c)
            value=expected[c].lstrip() if c == 0 else expected[c]
            assert cell.value == value, (index,c,cell.value,value)
            assert cell.ctype == NATIVE[scope]['types'][index-7][c]
            fmt=book.format_map[book.xf_list[cell.xf_index].format_key].format_str
            assert fmt == NATIVE[scope]['formats'][c]
    assert all(tuple(v) in sheet.merged_cells for v in NATIVE[scope]['merged'])
    assert p == before
    assert 'XrayLarch/' in sheet.cell_value(3,0) and 'Athena/0.9' not in sheet.cell_value(3,0)
    assert sheet.has_pane_record and sheet.horz_split_pos == 7 and sheet.vert_split_pos == 1
    assert [row['group_id'] for row in report['rows']] == [g['id'] for g in p['groups'] if scope == 'all' or g['marked']]


@pytest.mark.parametrize('value,label', NATIVE['clamps'])
def test_clamp_names_follow_executed_native_conversion_without_losing_custom_values(value, label):
    text=_clamp(value)
    assert text.split(' (')[0] == label.capitalize()
    if value not in (0,3,6,12,24,96):assert text.endswith(f'({value:g})')


@pytest.fixture
def store(tmp_path):
    return AthenaStore(Settings(data_root=tmp_path))


def measured(store, data_type='mu'):
    p=store.create();name='xdi-official-cu_metal_rt.xdi'
    inspected=store.inspect(p['id'], (FIXTURES/name).read_bytes(), name)
    return store.import_data(p['id'],ImportRequest(version=0,upload_id=inspected['upload_id'],**dict(inspected['athena_suggestion'],data_type=data_type)))


@pytest.mark.parametrize('filename', ['demeter-athena-json.prj','demeter-diff.prj','athena-detector-probe.prj'])
def test_native_project_groups_can_be_reported_without_reprocessing_or_losing_rows(store, filename):
    p=store.create();p=store.restore(p['id'],0,(FIXTURES/filename).read_bytes(),filename)
    before=copy.deepcopy(p);request=ParameterReport(version=p['version'])
    report=store.parameter_report(p['id'],request)
    raw=store.parameter_report(p['id'],request,download=True)[2]
    sheet=xlrd.open_workbook(file_contents=raw).sheet_by_index(0)
    assert [sheet.cell_value(7+i,0) for i in range(len(p['groups']))] == [g['label'] for g in p['groups']]
    assert len(report['rows']) == len(p['groups'])
    assert store.load(p['id']) == before


@pytest.mark.parametrize('data_type', ['mu','norm','xanes'])
def test_measured_report_preserves_applied_values_and_labels_unapplied_settings(store, data_type):
    p=measured(store,data_type);g=p['groups'][0];before=copy.deepcopy(p)
    report=store.parameter_report(p['id'],ParameterReport(version=p['version']))
    row=report['rows'][0];e=g['result']['effective']
    assert row['values'][1:3] == ['Copper','K']
    assert row['values'][6] == e['e0'] and row['values'][15] == e['edge_step']
    assert row['values'][10] == (None if e.get('nnorm') is None else e['nnorm']+1)
    if data_type == 'xanes':assert any('were not used' in n for n in row['notes'])
    if data_type == 'norm':assert any('already normalized' in n for n in row['notes'])
    assert store.load(p['id']) == before


def test_report_keeps_zero_importance_unicode_formula_like_text_and_frozen_groups():
    p=reference_project();g=p['groups'][1];g['label']='=1+1 铜 foil';g['frozen']=True
    g['parameters']['e0']=9000.;g['source']['native']['args']['fit_karb_value']=1.375
    report=prepare_report(p,ParameterReport(version=7));row=report['rows'][1]
    assert row['values'][3] == 0 and row['values'][6] == 7112.25 and row['values'][23] == 1.375
    _,_,raw=encode_report(report);sheet=xlrd.open_workbook(file_contents=raw).sheet_by_index(0)
    assert sheet.cell(8,0).ctype == xlrd.XL_CELL_TEXT and sheet.cell_value(8,0) == g['label']


def test_chi_detector_failed_and_missing_native_values_remain_explicit():
    p=reference_project();g=p['groups'][0]
    g.update(data_type='chi', parameters=AthenaParameters().model_dump())
    g['result']['effective']={'exafs':True,'e0':None};g['source']['native']['args']['bkg_e0']=8980.5
    row=prepare_report(p,ParameterReport(version=7))['rows'][0]
    assert row['values'][6] == 8980.5 and row['values'][15] is None
    assert any('energy origin' in n for n in row['notes'])
    g.update(data_type='detector',result=None,processing_error='Invalid normalization')
    g['source']['native']['args'].update(importance='nan',fit_karb_value='not a weight')
    row=prepare_report(p,ParameterReport(version=7))['rows'][0]
    assert row['values'][3] is None and row['values'][23] is None and row['values'][6] is None
    assert any('not confirmed' in n for n in row['notes'])
    raw=encode_report(prepare_report(p,ParameterReport(version=7)))[2]
    assert xlrd.open_workbook(file_contents=raw).sheet_by_index(0).cell_value(7,3) == 'n.a.'
    g['parameters']['step']=2.75
    assert prepare_report(p,ParameterReport(version=7))['rows'][0]['values'][15] == 2.75


def test_http_versions_empty_marks_download_and_post_generation_conflict(store, monkeypatch):
    p=measured(store);route=f"/api/athena/projects/{p['id']}/parameter-report";request={'version':p['version'],'scope':'all'}
    with TestClient(create_app(store.settings)) as client:
        assert client.post(route+'/preview',json={**request,'scope':'current'}).status_code == 422
        assert client.post(route+'/preview',json={**request,'version':False}).status_code == 422
        assert client.post(route,json={**request,'version':0}).status_code == 409
        p=store.command(p['id'],Command(version=p['version'],action='metadata',group_ids=[p['groups'][0]['id']],options={'marked':False}))
        request['version']=p['version']
        assert client.post(route,json={**request,'scope':'marked'}).status_code == 400
        response=client.post(route,json=request);assert response.status_code == 200
        assert response.headers['x-athena-project-version'] == str(p['version'])
        assert response.headers['content-type'] == 'application/vnd.ms-excel'
        assert xlrd.open_workbook(file_contents=response.content).nsheets == 1
        assert store.load(p['id']) == p
        from xraylarch_web import athena_report
        original=athena_report.encode_report
        def changed(report):
            raw=original(report)
            store.command(p['id'],Command(version=p['version'],action='project',options={'name':'Changed during export'}))
            return raw
        monkeypatch.setattr(athena_report,'encode_report',changed)
        assert client.post(route,json=request).status_code == 409
