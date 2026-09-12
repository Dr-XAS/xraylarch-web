import copy
import io
import json
from pathlib import Path
import zipfile

from fastapi.testclient import TestClient
from larch.math import deriv
import numpy as np
import pytest

from xraylarch_web.athena import AthenaStore, Command, ImportRequest
from xraylarch_web.athena_export import DataExport, MARKED, prepare, encode, _energy, _phase_derivative
from xraylarch_web.athena_science import AthenaParameters
from xraylarch_web.config import Settings
from xraylarch_web.errors import WebInputError
from xraylarch_web.main import create_app

FIXTURES = Path(__file__).parent/'fixtures'
NATIVE = {row['id']: row for row in json.loads((FIXTURES/'athena-export-templates-native.json').read_text())['cases']}


@pytest.fixture
def store(tmp_path):
    return AthenaStore(Settings(data_root=tmp_path))


def imported(store, name='xdi-official-cu_metal_rt.xdi', **overrides):
    p = store.create(); i = store.inspect(p['id'], (FIXTURES/name).read_bytes(), name)
    return store.import_data(p['id'], ImportRequest(version=0, upload_id=i['upload_id'], **(i['athena_suggestion'] | overrides)))


def choice(p, form='xmu', **kw):
    return DataExport(version=p['version'], group_id=p['groups'][0]['id'], form=form, **kw)


def native_group(row, which='g'):
    a = copy.deepcopy(row['inputs'][which]); p = AthenaParameters(energy_shift=2.25, e0=8980.5).model_dump()
    a.update(mu=a['xmu'], energy=(np.asarray(a['energy'])+2.25).tolist())
    if 'flat' in row.get('products', {}):
        a['flat'] = row['products']['flat']
    return dict(id=which, label=which, data_type='mu', marked=True, frozen=False, multiplier=1., offset=.35,
                source={}, notes='', parameters=p, energy=row['inputs'][which]['energy'], mu=a['mu'],
                result=dict(arrays=a, effective={'e0': 8980.5, 'edge_step': 3.2}, warnings=[]))


@pytest.mark.parametrize('form', ['der', 'sec', 'nder', 'nsec'])
def test_export_derivatives_match_executed_native_larch(form):
    row = NATIVE['products-derivatives']; g = native_group(row)
    np.testing.assert_allclose(_energy(g, form)[1], row['products'][form], rtol=0, atol=1e-14)


def test_phase_and_background_columns_match_executed_native_larch():
    row = NATIVE['products-phase']; g = native_group(row)
    np.testing.assert_allclose(_phase_derivative(g['result']['arrays']), row['products']['dph'])
    for case, field, column in [('products-background', 'nbkg', 2), ('products-flatten', 'fbkg', 4)]:
        row = NATIVE[case]; g = native_group(row)
        table = prepare({'groups': [g]}, DataExport(version=0, group_id=g['id'], form='norm'))[0]
        np.testing.assert_allclose(table.arrays[column], row['products'][field], atol=1e-13)


def test_combined_interpolation_matches_executed_native_including_extrapolation():
    row = NATIVE['products-interpolation']; donor, reference = native_group(row), native_group(row, 'h')
    table = prepare({'groups': [reference, donor]}, DataExport(version=0, scope='marked', form='xmu'))[0]
    np.testing.assert_allclose(table.arrays[2], row['products']['int'], rtol=1e-12, atol=1e-10)
    assert any('extrapolated' in message for message in table.warnings)
    assert table.groups == [reference, donor]


@pytest.mark.parametrize('name', ['xdi-official-cu_metal_rt.xdi', 'xdi-official-fe2o3_rt.xdi', 'demeter-x11a-cu.012'])
@pytest.mark.parametrize('form', ['xmu', 'norm', 'chi', 'r', 'q'])
def test_measured_current_files_have_complete_columns_and_unchanged_state(store, name, form):
    p = imported(store, name); before = copy.deepcopy(p); options = choice(p, form)
    preview = store.preview_data_export(p['id'], options)
    filename, mime, raw = store.export_data(p['id'], options)
    table = np.loadtxt(io.BytesIO(raw)); g = p['groups'][0]; a = g['result']['arrays']
    header = raw.decode().splitlines(); labels = next(line[1:].split() for line in reversed(header) if line.startswith('#'))
    assert table.shape == (preview['files'][0]['rows'], len(labels))
    assert len([line for line in header if line.startswith('# Column.')]) == len(labels)
    assert preview['files'][0]['filename'] == filename
    assert b'XrayLarch/' in raw and b'Athena/0.9' not in raw
    assert b'Athena.eshift:' in raw and b'# ///' in raw
    if form in ('xmu', 'norm'):
        np.testing.assert_allclose(table[:,0], a['energy'], rtol=1e-10)
        np.testing.assert_allclose(table[:,1], a['mu' if form == 'xmu' else 'norm'], rtol=1e-9, atol=1e-10)
        derivative = deriv(np.asarray(a['mu' if form == 'xmu' else 'norm'])) / deriv(np.asarray(a['energy']))
        np.testing.assert_allclose(table[:,5], derivative, rtol=1e-9, atol=1e-10)
        if form == 'xmu':
            assert 'i0' in labels
            np.testing.assert_allclose(table[:,-1], g['source']['raw_arrays']['i0'], rtol=1e-9)
    elif form == 'chi':
        np.testing.assert_allclose(table[:,3], np.asarray(a['k'])**2*a['chi'], rtol=1e-9, atol=1e-10)
    elif form == 'r':
        np.testing.assert_allclose(table[:,1], a['chir_re'], rtol=1e-9, atol=1e-10)
    else:
        np.testing.assert_allclose(table[:,0], a['q'], rtol=1e-10)
        np.testing.assert_allclose(table[:,1], a['chiq_re'], rtol=1e-9, atol=1e-10)
    assert store.load(p['id']) == before


@pytest.mark.parametrize('weight', ['0', '1', '2', '3', 'kw'])
def test_selected_weights_repair_native_syntax_failure_with_correct_two_column_files(store, weight):
    assert NATIVE['save_chikw-'+weight]['errors'] == ['SyntaxError']
    p = imported(store); opt = choice(p, 'chi', kweight=weight, arbitrary_kweight=1.5)
    raw = store.export_data(p['id'], opt)[2]; data = np.loadtxt(io.BytesIO(raw))
    assert data.shape[1] == 2
    a = p['groups'][0]['result']['arrays']; exponent = 1.5 if weight == 'kw' else float(weight)
    np.testing.assert_allclose(data[:,1], np.asarray(a['chi'])*np.asarray(a['k'])**exponent, rtol=1e-9, atol=1e-10)


@pytest.mark.parametrize('form', ['xmu', 'norm', 'chi'])
def test_reopened_column_files_retain_xdi_metadata_and_exact_preview_values(store, form):
    p = imported(store); g = p['groups'][0]
    filename, _, raw = store.export_data(p['id'], choice(p, form))
    inspected = store.inspect(p['id'], raw, filename)
    metadata = inspected['xdi_metadata']
    assert metadata['attributes']['beamline'] == g['source']['xdi_metadata']['attributes']['beamline']
    assert metadata['attributes']['element'] == {'symbol': 'Cu', 'edge': 'K'}
    assert metadata['attributes']['athena']['e0'] == f"{g['result']['effective']['e0']:.14g}"
    assert 'Cu foil Room Temperature' in metadata['comments_text']
    assert metadata['family_names']['gse'] == 'GSE'
    assert store.inspected_file(p['id'], inspected['upload_id'], 'source')[0] == raw
    request = ImportRequest(version=p['version'], upload_id=inspected['upload_id'],
                            **dict(inspected['athena_suggestion'], data_type={'xmu':'mu', 'norm':'norm', 'chi':'chi'}[form]))
    preview = store.preview_columns(p['id'], request)
    table = np.loadtxt(io.BytesIO(raw))
    np.testing.assert_array_equal(preview['traces'][0]['x'], table[:, 0])
    np.testing.assert_array_equal(preview['traces'][0]['y'], table[:, 1])
    restored = store.import_data(p['id'], request)['groups'][-1]
    assert restored['source']['xdi_metadata'] == metadata
    np.testing.assert_array_equal(restored['mu'], table[:, 1])
    if form == 'norm':
        np.testing.assert_array_equal(restored['result']['arrays']['norm'], table[:, 1])


@pytest.mark.parametrize('form', ['xmu', 'norm'])
def test_xanes_uses_zero_background_and_matching_labels(store, form):
    p = imported(store, data_type='xanes'); raw = store.export_data(p['id'], choice(p, form))[2]
    data = np.loadtxt(io.BytesIO(raw)); labels = raw.decode().split('#---------------------------------\n#  ')[1].splitlines()[0].split()
    assert len(labels) == data.shape[1]
    assert not data[:,2].any()
    if form == 'norm': assert not data[:,4].any()


@pytest.mark.parametrize('form', MARKED)
def test_every_marked_selector_exports_in_project_order_and_honors_multipliers(store, form):
    p = imported(store); g = p['groups'][0]
    second = copy.deepcopy(g); second.update(id='second', label='second', marked=True, multiplier=3.)
    g.update(marked=True, multiplier=2.); p['groups'] = [second, g]
    opt = DataExport(version=p['version'], scope='marked', form=form)
    tables = prepare(p, opt); original = copy.deepcopy(p)
    data = np.loadtxt(io.BytesIO(encode(tables, 'marked')[2]))
    assert tables[0].groups[0]['id'] == 'second'
    assert data.shape[1] == (4 if form in ('chi', 'chik', 'chik2', 'chik3') else 3)
    if form in ('xmu', 'der', 'sec'):
        scaled = prepare(p, opt.model_copy(update={'with_multipliers': True}))[0]
        np.testing.assert_allclose(scaled.arrays[-2], tables[0].arrays[-2]*3)
        np.testing.assert_allclose(scaled.arrays[-1], tables[0].arrays[-1]*2)
    assert p == original


def test_each_zip_names_are_distinct_and_failed_table_preflight_writes_nothing(store, monkeypatch):
    p = imported(store); g = p['groups'][0]; p['groups'] = []
    for i, label in enumerate(['a/b', 'a:b', 'A_B', '../', 'CON']):
        child = copy.deepcopy(g); child.update(id=str(i), label=label, marked=True, frozen=True); p['groups'].append(child)
    opt = DataExport(version=p['version'], scope='each', form='norm')
    tables = prepare(p, opt); name, mime, raw = encode(tables, 'each')
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        assert archive.namelist() == ['a_b.nor', 'a_b-2.nor', 'A_B-3.nor', '_.nor', 'group_CON.nor']
        assert all(np.loadtxt(io.BytesIO(archive.read(n))).shape[1] == 7 for n in archive.namelist())
    p['groups'][-1]['result']['arrays']['norm'] = [1,2,3]
    monkeypatch.setattr('xraylarch_web.athena_export.write_ascii', lambda *a, **k: pytest.fail('No output before complete validation'))
    with pytest.raises(ValueError): prepare(p, opt)


def test_mismatched_grids_recover_with_separate_files_and_q_keeps_all_filtered_points(store):
    p = imported(store); g = p['groups'][0]; other = copy.deepcopy(g); other['id'] = 'second'
    other['result']['arrays']['k'] = (np.asarray(other['result']['arrays']['k'])+.001).tolist()
    g['marked'] = other['marked'] = True; p['groups'].append(other)
    with pytest.raises(ValueError, match='grids differ'): prepare(p, DataExport(version=p['version'], scope='marked', form='chi'))
    assert len(prepare(p, DataExport(version=p['version'], scope='each', form='chi'))) == 2
    a = g['result']['arrays']; last = len(a['q'])
    a['q'].append(a['q'][-1]+.05)
    for key in ['chiq_re', 'chiq_im', 'chiq_mag', 'chiq_pha']: a[key].append(a[key][-1])
    table = prepare(p, choice(p, 'q'))[0]
    assert len(table.arrays[0]) == last+1 and table.arrays[5][-1] == table.arrays[6][-1] == 0
    assert any('zero-padded' in n for n in table.notes)


def test_saved_comments_metadata_and_equations_match_output_without_overwriting_capture(store):
    p = imported(store); gid=p['groups'][0]['id']
    p = store.command(p['id'], Command(version=p['version'], action='xdi_comments', group_ids=[gid], options={'comments': 'μ 铜\nsecond line'}))
    p = store.command(p['id'], Command(version=p['version'], action='metadata', group_ids=[gid], options={'frozen': True, 'notes':'Independent notes'}))
    before = copy.deepcopy(p)
    raw = store.export_data(p['id'], choice(p))[2].decode()
    assert 'μ 铜\n# second line' in raw and 'Group notes:\n# Independent notes' in raw
    assert '# GSE.' in raw and 'GSE/1.0' in raw
    assert 'Athena.pre_edge_line:' in raw and 'Athena.post_edge_polynomial:' in raw
    assert store.load(p['id']) == before


def test_api_versions_invalid_requests_and_readonly_export(store, monkeypatch):
    p=imported(store); opt=choice(p); base=f"/api/athena/projects/{p['id']}/export-data"
    with TestClient(create_app(store.settings)) as client:
        preview=client.post(base+'/preview', json=opt.model_dump()); assert preview.status_code==200
        response=client.post(base,json=opt.model_dump()); assert response.status_code==200
        assert response.headers['x-athena-project-version']==str(p['version'])
        assert response.headers['content-disposition'].endswith('.xmu"')
        for patch in ({'scope':'marked'}, {'scope':'current','form':'der'}, {'kweight':'9'}, {'version':True}, {'with_multipliers':True}):
            assert client.post(base,json=opt.model_dump()|patch).status_code==422
        assert client.post(base,json=opt.model_dump()|{'version':0}).status_code==409
    assert store.load(p['id'])==p
    def changed(*args):
        store.command(p['id'], Command(version=p['version'], action='project', options={'name':'Other window'}))
        return 'test.xmu','text/plain',b'test'
    monkeypatch.setattr('xraylarch_web.athena_export.encode', changed)
    with pytest.raises(WebInputError): store.export_data(p['id'], opt)


def test_norm_export_contains_flattened_curve_even_when_display_flattening_is_off(store):
    from larch import Group
    from larch.xafs import pre_edge
    import re
    p=imported(store); gid=p['groups'][0]['id']
    p=store.command(p['id'], Command(version=p['version'], action='parameters', group_ids=[gid], options={'energy_shift':2.5,'flatten':False}))
    g=p['groups'][0]; a=g['result']['arrays']; e=g['result']['effective']; direct=Group()
    pre_edge(a['energy'], a['mu'], group=direct, e0=e['e0'], step=e['edge_step'], make_flat=True,
             **{key:e[key] for key in ('pre1','pre2','norm1','norm2','nnorm')})
    t=prepare(p, choice(p,'norm'))[0]
    np.testing.assert_allclose(t.arrays[3],direct.flat,rtol=1e-10,atol=1e-10)
    assert not np.allclose(t.arrays[3],t.arrays[1])
    for key,field in [('pre_edge','pre_edge_line'),('post_edge','post_edge_polynomial')]:
        line=next(h for h in t.header if h.startswith('Athena.'+field+':'))
        terms=re.findall(r'([-+0-9.e]+)\*\(E-([-+0-9.e]+)\)\^(\d+)',line)
        assert terms
        expected=sum(float(c)*(np.asarray(a['energy'])-float(center))**int(degree) for c,center,degree in terms)
        np.testing.assert_allclose(expected,a[key],rtol=1e-10,atol=1e-9)


@pytest.mark.parametrize('datatype', ['chi','detector'])
def test_nonabsorption_types_do_not_invent_unavailable_columns(store,datatype):
    p=imported(store); original=p['groups'][0]
    x,y=(original['result']['arrays']['k'],original['result']['arrays']['chi']) if datatype=='chi' else (original['energy'],original['mu'])
    g=store.make_group('non absorption',x,y,data_type=datatype); p['groups']=[g]
    table=prepare(p,choice(p,'chi' if datatype=='chi' else 'xmu'))[0]
    if datatype=='chi':
        assert 'energy' not in table.labels and any('no known E0' in note for note in table.notes)
        g['source']['native']={'args':{'bkg_e0':'7112.5'}}
        native=prepare(p,choice(p,'chi'))[0]
        assert native.labels[-1]=='energy'
        np.testing.assert_allclose(native.arrays[-1],7112.5+native.arrays[0]**2/0.2624682917)
        assert any('Athena.e0: 7112.5' in h for h in native.header)
    else:
        assert table.labels==['energy','detector_signal']
    with pytest.raises(ValueError): prepare(p,choice(p,'norm'))


def test_each_arbitrary_weight_uses_native_saved_value_or_current_ft_weight(store):
    p=imported(store); g=p['groups'][0]; g['marked']=True;g['parameters']['kweight']=1.75
    other=copy.deepcopy(g);other.update(id='other',label='Other')
    other['source'].setdefault('native',{}).setdefault('args',{})['fit_karb_value']='2.5'
    p['groups'].append(other); opt=DataExport(version=p['version'],scope='each',form='chi',kweight='kw')
    tables=prepare(p,opt)
    for t,exponent in zip(tables,[1.75,2.5],strict=True):
        a=t.groups[0]['result']['arrays']
        np.testing.assert_allclose(t.arrays[1],np.asarray(a['chi'])*np.asarray(a['k'])**exponent)
    assert p['groups'][1]['source']['native']['args']['fit_karb_value']=='2.5'


def test_invalid_retained_i0_is_not_silently_dropped(store):
    p=imported(store);p['groups'][0]['source']['raw_arrays']['i0']=[1,2,3]
    with pytest.raises(ValueError,match='I0 does not match'): prepare(p,choice(p))
