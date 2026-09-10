"""Real FEFF output, pinned Athena normalized-type rules and direct Larch."""
import copy
import gzip
import hashlib
import json
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient
from larch import Group
from larch.xafs import autobk, xftf, xftr

from xraylarch_web.athena import AthenaStore, Command, ImportRequest
from xraylarch_web.athena_columns import suggest_columns
from xraylarch_web.athena_e0 import atomic_edge, compute_e0
from xraylarch_web.athena_import_policy import initialize_import
from xraylarch_web.athena_science import AthenaParameters, process_spectrum
from xraylarch_web.config import Settings
from xraylarch_web.main import create_app
from xraylarch_web.parsing import parse_upload


FIXTURES = Path(__file__).parent / 'fixtures'


@pytest.fixture(params=['feff-copper-xmu.dat', 'feff-nio-xmu.dat'])
def feff(request):
    path = FIXTURES / request.param
    return path, np.loadtxt(path)


@pytest.fixture
def store(tmp_path):
    return AthenaStore(Settings(data_root=tmp_path))


def imported(store, path, **choices):
    project = store.create()
    inspection = store.inspect(project['id'], path.read_bytes(), 'xmu.dat')
    request = ImportRequest(version=project['version'], upload_id=inspection['upload_id'],
                           **(inspection['athena_suggestion'] | choices))
    return store.import_data(project['id'], request), inspection, request


def test_fixtures_match_recorded_public_sources():
    manifest = json.loads((FIXTURES / 'athena-feff-fixtures.json').read_text())
    for entry in manifest['fixtures']:
        data = (FIXTURES / entry['file']).read_bytes()
        assert len(data) == entry['bytes']
        assert hashlib.sha256(data).hexdigest() == entry['sha256']
        assert hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest() == entry['git_blob_sha1']


def test_feff_signature_selects_absolute_photon_energy_and_mu_before_generic_chi(feff):
    path, raw = feff
    parsed = parse_upload(path.read_bytes(), 'renamed-simulation.dat')
    inspection = parsed.inspection().model_dump()
    suggestion, units = suggest_columns(inspection['columns'], 'renamed-simulation.dat')
    assert [c['name'] for c in inspection['columns']] == ['omega', 'e', 'k', 'mu', 'mu0', 'chi']
    assert suggestion == dict(energy_column='column_0001', numerator=['column_0004'],
                             denominator=None, mode='mu', units='eV', data_type='xmudat')
    for i, column in enumerate(inspection['columns']):
        np.testing.assert_array_equal(parsed.arrays[column['column_id']], raw[:, i])
    assert parsed.source_bytes == path.read_bytes() and units['column_0001'] == 'eV'
    # The low-energy FEFF case must not inherit the generic <100 -> keV guess.
    low = copy.deepcopy(inspection['columns']); low[0]['preview'] = [20, 21, 22, 23, 24]
    assert suggest_columns(low, 'xmu.dat')[0]['units'] == 'eV'
    # A file called xmu.dat alone does not make an ordinary table FEFF output.
    ordinary = parse_upload(b'# energy mu\n1000 0\n1001 1\n1002 2\n', 'xmu.dat')
    assert suggest_columns(ordinary.inspection().model_dump()['columns'], 'xmu.dat')[0]['data_type'] == 'mu'


def test_real_preview_import_and_restart_keep_feff_type_and_all_source_columns(store, feff):
    path, raw = feff
    p = store.create(); inspection = store.inspect(p['id'], path.read_bytes(), path.name)
    req = ImportRequest(version=p['version'], upload_id=inspection['upload_id'], **inspection['athena_suggestion'])
    preview = store.preview_columns(p['id'], req)
    assert store.load(p['id']) == p
    assert preview['x_label'] == 'Energy (eV)' and preview['y_label'] == 'μ(E)'
    np.testing.assert_array_equal(preview['traces'][0]['x'], raw[:, 0])
    np.testing.assert_array_equal(preview['traces'][0]['y'], raw[:, 3])
    p = store.import_data(p['id'], req); g = p['groups'][0]
    assert g['data_type'] == 'xmudat' and g['processing_error'] is None
    for name in ('mu', 'norm', 'flat'):
        np.testing.assert_array_equal(g['result']['arrays'][name], raw[:, 3])
    assert g['result']['effective']['edge_step'] == 1 and g['result']['effective']['data_type'] == 'xmudat'
    for i in range(6):
        np.testing.assert_array_equal(g['source']['column_arrays'][f'column_{i + 1:04d}'], raw[:, i])
    restart = AthenaStore(store.settings)
    assert restart.load(p['id'])['groups'] == p['groups']
    again = restart.inspect(p['id'], path.read_bytes(), 'another-name.dat')
    assert again['remembered_columns']['mapping']['data_type'] == 'xmudat'
    assert again['remembered_columns']['mapping']['energy_column'] == 'column_0001'


def test_feff_skips_normalization_and_matches_direct_larch_background_and_transforms(feff, monkeypatch):
    path, raw = feff
    x, y = raw[:, 0], raw[:, 3]
    p = AthenaParameters(e0=float(x[30]), rbkg=1.1, bkg_kmax=14, kmin=3, kmax=12,
                         pre1=-150, pre2=-50, norm1=150, norm2=1000)
    def forbidden(*args, **kwargs):
        pytest.fail('FEFF normalized input must not refit pre_edge')
    monkeypatch.setattr('xraylarch_web.athena_science.pre_edge', forbidden)
    result = process_spectrum(x, y, p, data_type='xmudat')
    direct = Group(energy=x.copy(), mu=y.copy(), norm=y.copy(), e0=p.e0, edge_step=1.)
    autobk(x, y, group=direct, ek0=p.e0, edge_step=1., rbkg=p.rbkg,
           kmin=p.bkg_kmin, kmax=p.bkg_kmax, kweight=p.bkg_kweight, dk=p.bkg_dk,
           win=p.bkg_window, nclamp=p.nclamp, clamp_lo=p.clamp_lo, clamp_hi=p.clamp_hi,
           nfft=p.nfft, kstep=p.kstep, calc_uncertainties=False)
    xftf(direct.k, direct.chi, group=direct, kmin=p.kmin, kmax=p.kmax,
         kweight=p.kweight, dk=p.dk, window=p.window, nfft=p.nfft, kstep=p.kstep)
    xftr(direct.r, direct.chir, group=direct, rmin=p.rmin, rmax=p.rmax, dr=p.dr,
         window=p.rwindow, nfft=p.nfft, kstep=p.kstep, qmax_out=14)
    for name in ('energy', 'mu', 'norm', 'bkg', 'k', 'chi', 'r', 'chir_mag', 'chir_re', 'q', 'chiq_re'):
        np.testing.assert_allclose(result['arrays'][name], getattr(direct, name), atol=1e-12, rtol=1e-12)
    assert result['effective']['pre1'] is None and result['effective']['flatten'] is None


@pytest.mark.parametrize('format', ['json', 'prj', 'bare-prj'])
def test_feff_roundtrip_keeps_native_flag_and_never_downgrades_to_norm(store, feff, format):
    path, raw = feff; p, _, _ = imported(store, path)
    data = store.export_project(p['id'], format='json' if format == 'json' else 'prj')
    if format != 'json':
        text = gzip.decompress(data).decode()
        for flag in ('is_xmudat', 'is_xmu', 'is_nor'): assert f"'{flag}', 1" in text
        if format == 'bare-prj':
            data = '\n'.join(line for line in text.splitlines() if not line.startswith('# Athena-Web ')).encode()
    other = store.create(); restored = store.restore(other['id'], other['version'], data, 'saved.' + format)
    g = restored['groups'][0]
    assert g['data_type'] == 'xmudat' and g['processing_error'] is None
    np.testing.assert_allclose(g['energy'], raw[:, 0], atol=1e-9, rtol=0)
    np.testing.assert_allclose(g['mu'], raw[:, 3], atol=1e-12, rtol=0)
    np.testing.assert_array_equal(g['result']['arrays']['norm'], g['mu'])


def test_feff_e0_fraction_and_enforced_policy_use_supplied_normalization(feff):
    path, raw = feff; x, y = raw[:, 0], raw[:, 3]
    selection = compute_e0(x, y, {}, method='fraction', data_type='xmudat')
    index = np.flatnonzero(y >= .5)[0]
    expected = x[index - 1] + (.5 - y[index - 1]) * (x[index] - x[index - 1]) / (y[index] - y[index - 1])
    assert selection['e0'] == pytest.approx(expected, abs=1e-9)
    symbol = 'Cu' if 'copper' in path.name else 'Ni'
    policy = {'element': symbol, 'edge': 'K', 'fraction': .5}
    # These real FEFF grids begin above the tabulated atomic edge. Keep the
    # domain error explicit, then check a known calibration of that same scan.
    with pytest.raises(ValueError, match='both sides'):
        initialize_import(x, y, policy=policy, data_type='xmudat')
    shift = atomic_edge(symbol, 'K')['energy'] - expected
    initialized = initialize_import(x, y, {'energy_shift': shift}, policy=policy, data_type='xmudat')
    assert initialized['data_type'] == 'xmudat'
    assert initialized['parameters']['e0'] == pytest.approx(expected + shift, abs=1e-9)


@pytest.mark.parametrize('flags', [
    {'is_xmudat': 1, 'is_nor': 1, 'is_xmu': 1},
    {'datatype': 'xmudat', 'is_nor': 1, 'is_xmu': 1},
    {'datatype': 'xmudat'},
])
def test_native_json_specific_feff_type_takes_precedence_over_generic_normalized_flag(store, feff, flags):
    path, raw = feff
    document = {'_____header': '# Athena project file -- Demeter version 0.9.26',
                '_____order': ['feff'], 'feff': {'args': {'label': path.name, **flags},
                                               'x': raw[:, 0].tolist(), 'y': raw[:, 3].tolist()}}
    p = store.create()
    restored = store.restore(p['id'], p['version'], json.dumps(document).encode(), 'native-json.prj')
    group = restored['groups'][0]
    assert group['data_type'] == 'xmudat' and group['processing_error'] is None
    np.testing.assert_array_equal(group['result']['arrays']['norm'], raw[:, 3])


def test_feff_rebin_reference_keV_and_undo_keep_original_arrays(store, feff):
    path, raw = feff
    p = store.create()
    kev = raw.copy(); kev[:, 0] /= 1000
    data = ('# omega e k mu mu0 chi\n' + '\n'.join(' '.join(map(str, row)) for row in kev)).encode()
    inspection = store.inspect(p['id'], data, 'kev.dat')
    choices = inspection['athena_suggestion'] | {'units': 'keV', 'reference_numerator': 'column_0005',
        'reference_denominator': '1', 'reference_log': False, 'reference_same_element': False,
        'preprocessing': {'mark': True}, 'rebin': {'width': 2, 'emin': 0}}
    req = ImportRequest(version=p['version'], upload_id=inspection['upload_id'], **choices)
    preview = store.preview_columns(p['id'], req)
    accepted = store.import_data(p['id'], req)
    assert len(accepted['groups']) == 2
    for group in accepted['groups']:
        assert group['data_type'] == 'xmudat'
        assert group['source']['mapping']['data_type'] == 'xmudat'
        np.testing.assert_allclose(group['source']['rebin_original']['energy'], raw[:, 0], atol=1e-10)
    for group, trace in zip(accepted['groups'], [t for t in preview['traces'] if t.get('stage') == 'rebinned'], strict=True):
        np.testing.assert_allclose(group['mu'], trace['y'], atol=1e-13)
    undone = store.command(p['id'], Command(version=accepted['version'], action='undo'))
    assert undone['groups'] == []


def test_feff_background_standard_and_difference_use_energy_normalized_arrays(store, feff):
    path, raw = feff; p, _, _ = imported(store, path)
    standard = copy.deepcopy(p['groups'][0])
    sample = store.make_group('scaled FEFF', raw[:, 0], raw[:, 3] * 1.25, data_type='xmudat')
    p['groups'].append(sample); p = store.save(p, store.load(p['id']), 'add scaled simulation')
    linked = store.command(p['id'], Command(version=p['version'], action='background_standard',
        group_ids=[sample['id']], options={'standard_id': standard['id']}))
    assert linked['groups'][0] == standard
    result = linked['groups'][1]
    assert result['background_standard_id'] == standard['id'] and result['processing_error'] is None
    assert result['result']['effective']['background_standard']
    np.testing.assert_array_equal(result['result']['arrays']['norm'], raw[:, 3] * 1.25)
    req = Command(version=linked['version'], action='difference', group_ids=[sample['id']],
                  options={'standard_id': standard['id'], 'form': 'norm', 'integrate': False})
    preview = store.preview_difference(p['id'], req)
    np.testing.assert_allclose(preview['results'][0]['difference'], raw[:, 3] * .25, atol=1e-13)
    assert store.load(p['id']) == linked
    with pytest.raises(ValueError, match='fnorm requires raw mu'):
        process_spectrum(raw[:, 0], raw[:, 3], {'fnorm': True}, data_type='xmudat')


@pytest.mark.parametrize('row', [0, 150, -1])
def test_malformed_feff_observations_are_not_discarded_as_headers(feff, row):
    path, raw = feff; lines = path.read_text().splitlines()
    indices = [i for i, line in enumerate(lines) if line.strip() and not line.startswith('#')]
    line = lines[indices[row]].split(); line[3] = 'broken'
    lines[indices[row]] = ' '.join(line)
    with pytest.raises(ValueError, match='malformed'):
        parse_upload('\n'.join(lines).encode(), 'xmu.dat')


def test_http_feff_inspect_preview_import_and_processed_plot_arrays(tmp_path):
    settings = Settings(data_root=tmp_path)
    path = FIXTURES / 'feff-copper-xmu.dat'
    with TestClient(create_app(settings)) as client:
        project = client.post('/api/athena/projects').json(); base = f"/api/athena/projects/{project['id']}"
        inspected = client.post(base + '/inspect', files={'file': ('xmu.dat', path.read_bytes())}).json()
        req = {'version': project['version'], 'upload_id': inspected['upload_id'], **inspected['athena_suggestion']}
        preview = client.post(base + '/preview-columns', json=req)
        assert preview.status_code == 200
        response = client.post(base + '/import', json=req); assert response.status_code == 200
        group = response.json()['groups'][0]
        assert group['data_type'] == 'xmudat' and group['processing_error'] is None
        assert all(group['result']['arrays'][key] for key in ('energy', 'norm', 'k', 'chi', 'r', 'chir_mag', 'q', 'chiq_re'))
