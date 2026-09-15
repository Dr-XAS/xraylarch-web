"""Column previews must represent the same full-data arithmetic as import."""
from io import StringIO

import numpy as np
import pytest
from fastapi.testclient import TestClient

from xraylarch_web.athena import AthenaStore, ImportRequest
from xraylarch_web.athena_columns import preview_trace
from xraylarch_web.config import Settings
from xraylarch_web.main import create_app


@pytest.fixture
def store(tmp_path):
    return AthenaStore(Settings(data_root=tmp_path))


def upload(store, project, energy, **columns):
    text = StringIO()
    np.savetxt(text, np.column_stack([energy, *columns.values()]), header="energy " + " ".join(columns), fmt="%.17g")
    inspected = store.inspect(project["id"], text.getvalue().encode(), "detectors.dat")
    ids = {c["name"]: c["column_id"] for c in inspected["columns"]}
    return inspected, ids


@pytest.mark.parametrize("mode", ["mu", "transmission", "fluorescence"])
@pytest.mark.parametrize("individual", [False, True])
@pytest.mark.parametrize("reverse", [False, True])
def test_preview_equals_import_for_all_detector_modes_and_sorted_kev(store, xas_arrays, mode, individual, reverse):
    x, mu = xas_arrays
    take = slice(None, None, -1) if reverse else slice(None)
    first, second = mu + 2, mu + 4
    p = store.create()
    inspected, ids = upload(store, p, x[take] / 1000, a=first[take], b=second[take], i0=np.full(len(x), 2.))
    request = ImportRequest(version=0, upload_id=inspected["upload_id"], energy_column=ids["energy"],
        numerator=[ids["a"], ids["b"]], denominator=ids["i0"], mode=mode, units="keV", sort=reverse,
        individual_channels=individual)
    preview = store.preview_columns(p["id"], request)
    assert store.load(p["id"]) == p
    assert preview["x_label"] == "Energy (eV)"
    signals = [first, second] if individual else [first + second]
    assert len(preview["traces"]) == len(signals)
    imported = store.import_data(p["id"], request)
    assert imported["version"] == 1
    for trace, g, signal in zip(preview["traces"], imported["groups"], signals, strict=True):
        expected = signal if mode == "mu" else np.log(signal / 2) if mode == "transmission" else signal / 2
        np.testing.assert_allclose(trace["x"], x, atol=1e-12)
        np.testing.assert_allclose(trace["y"], expected, atol=1e-14)
        assert trace["x"] == g["energy"] and trace["y"] == g["mu"]
    assert len({g["label"] for g in imported["groups"]}) == len(signals)


@pytest.mark.parametrize("log", [False, True])
def test_reference_preview_natural_log_and_saved_order_and_links(store, xas_arrays, log):
    x, mu = xas_arrays
    p = store.create()
    inspected, ids = upload(store, p, x, sample=mu, numerator=np.exp(mu), denominator=np.ones(len(x)))
    request = ImportRequest(version=0, upload_id=inspected["upload_id"], energy_column=ids["energy"],
        numerator=[ids["sample"]], reference_numerator=ids["numerator"], reference_denominator=ids["denominator"], reference_log=log)
    preview = store.preview_columns(p["id"], request)
    imported = store.import_data(p["id"], request)
    sample, reference = imported["groups"]
    assert sample["reference_id"] == reference["id"] and not reference["marked"]
    expected = mu if log else np.exp(mu)
    np.testing.assert_allclose(preview["traces"][1]["y"], expected, atol=1e-14)
    assert preview["traces"][1]["y"] == reference["mu"]
    assert reference["source"]["mapping"]["mode"] == ("transmission" if log else "fluorescence")
    np.testing.assert_allclose(reference["source"]["raw_arrays"]["i0"], np.exp(mu) if log else 1)


def test_chi_preview_keeps_k_units_and_unweighted_data(store):
    k = np.arange(0, 15, .05)
    chi = np.sin(k)
    p = store.create()
    inspected, ids = upload(store, p, k, chi=chi)
    request = ImportRequest(version=0, upload_id=inspected["upload_id"], energy_column=ids["energy"],
        numerator=[ids["chi"]], units="keV", data_type="chi")
    preview = store.preview_columns(p["id"], request)
    assert preview["x_label"] == "k (Å⁻¹)" and preview["y_label"] == "χ(k)"
    assert preview["traces"][0]["x"] == k.tolist()
    assert preview["traces"][0]["y"] == chi.tolist()


def test_large_preview_preserves_single_point_glitches_and_endpoints():
    x = np.arange(100_000.)
    y = np.ones(len(x)); y[12345] = 500; y[87654] = -200
    trace = preview_trace(x, y, label="glitches", role="sample", ident="sample")
    assert len(trace["x"]) <= 2400
    assert trace["x"][0] == 0 and trace["x"][-1] == x[-1]
    assert trace["y"][trace["x"].index(12345)] == 500
    assert trace["y"][trace["x"].index(87654)] == -200


@pytest.mark.parametrize("bad", ["zero", "zero_numerator", "unknown", "reference", "duplicate", "overflow"])
def test_preview_and_import_reject_bad_arithmetic_even_at_unsampled_rows(store, bad):
    x = np.linspace(8900, 9400, 10_000)
    a, b = np.full(len(x), 2.), np.ones(len(x))
    if bad == "zero": b[4567] = 0
    if bad == "zero_numerator": a[4567] = 0
    if bad == "overflow": a[4567], b[4567] = 1e300, 1e-300
    p = store.create()
    inspected, ids = upload(store, p, x, a=a, b=b)
    request = ImportRequest(version=0, upload_id=inspected["upload_id"], energy_column=ids["energy"],
        numerator=[ids["a"]], denominator=ids["b"], mode="transmission")
    if bad == "unknown": request.numerator = ["not-this-file"]
    if bad == "duplicate": request.numerator *= 2
    if bad == "reference": request.reference_numerator = "missing-reference-column"
    for method in (store.preview_columns, store.import_data):
        with pytest.raises(ValueError): method(p["id"], request)
    assert store.load(p["id"]) == p


def test_preview_http_does_not_create_groups_history_or_undo(tmp_path, xas_arrays):
    settings = Settings(data_root=tmp_path)
    store = AthenaStore(settings); p = store.create()
    inspected, ids = upload(store, p, xas_arrays[0], mu=xas_arrays[1])
    before = {str(path): path.read_bytes() for path in tmp_path.rglob('*') if path.is_file()}
    body = dict(version=0, upload_id=inspected["upload_id"], energy_column=ids["energy"], numerator=[ids["mu"]])
    with TestClient(create_app(settings)) as client:
        endpoint = f"/api/athena/projects/{p['id']}/preview-columns"
        response = client.post(endpoint, json=body)
        assert response.status_code == 200, response.text
        assert response.json()["traces"][0]["y"] == xas_arrays[1].tolist()
        assert client.post(endpoint, json={**body, "version": 99}).status_code == 409
        assert client.post(endpoint, json={**body, "individual_channels": "yes"}).status_code == 422
    after = {str(path): path.read_bytes() for path in tmp_path.rglob('*') if path.is_file()}
    assert before == after

@pytest.mark.parametrize('data_type', ['mu', 'xanes', 'norm'])
@pytest.mark.parametrize('shift', [12., 80.])
def test_same_element_reference_keeps_type_identity_and_corrects_distant_e0(store, xas_arrays, data_type, shift):
    from xraylarch_web.athena_e0 import compute_e0, atomic_edge
    from xraylarch_web.athena_science import AthenaParameters
    x, sample_mu = xas_arrays
    reference_mu = .2 + 1 / (1 + np.exp(-(x - 8980 - shift) / 2.5))
    if shift == 80:
        # A real same-element edge plus a sharp detector glitch that fools
        # derivative edge finding; the native safeguard should recover it.
        reference_mu = sample_mu + 2 * np.exp(-((x - 9060) / 3) ** 2)
    p = store.create()
    inspected, ids = upload(store, p, x, sample=sample_mu, ref=np.exp(reference_mu), one=np.ones(len(x)))
    request = ImportRequest(version=0, upload_id=inspected['upload_id'], energy_column=ids['energy'],
        numerator=[ids['sample']], data_type=data_type, reference_numerator=ids['ref'], reference_denominator=ids['one'])
    imported = store.import_data(p['id'], request)
    sample, ref = imported['groups']
    assert ref['data_type'] == data_type
    assert ref['source']['mapping']['data_type'] == data_type
    assert ref['source']['edge_identity']['element'] == sample['source']['edge_identity']['element']
    assert ref['source']['edge_identity']['edge'] == sample['source']['edge_identity']['edge']
    assert ref['source']['edge_identity']['origin'] == 'reference_sample'
    assert ref['processing_error'] is None
    if shift == 12:
        assert ref['parameters']['e0'] == compute_e0(x, reference_mu, AthenaParameters())['e0']
        assert ref['source']['e0_selection']['method'] == 'derivative'
    else:
        identity = sample['source']['edge_identity']
        assert ref['parameters']['e0'] == atomic_edge(identity['element'], identity['edge'])['energy']
        assert ref['source']['e0_selection']['method'] == 'atomic'
        assert any('more than 25 eV' in w for w in ref['result']['warnings'])


def test_different_element_reference_uses_own_derivative_despite_sample_enforcement(store):
    x = np.arange(8100., 9800.)
    sample_mu = .2 + 1 / (1 + np.exp(-(x - 8979) / 2.5))
    reference_mu = .2 + 1 / (1 + np.exp(-(x - 8333) / 2.5))
    p = store.create()
    inspected, ids = upload(store, p, x, sample=sample_mu, ref=np.exp(reference_mu), one=np.ones(len(x)))
    request = ImportRequest(version=0, upload_id=inspected['upload_id'], energy_column=ids['energy'],
        numerator=[ids['sample']], data_type='xanes', reference_numerator=ids['ref'], reference_denominator=ids['one'],
        reference_same_element=False, edge_policy={'element': 'Cu', 'edge': 'K'})
    sample, ref = store.import_data(p['id'], request)['groups']
    assert sample['source']['edge_policy']['element'] == 'Cu'
    assert 'edge_policy' not in ref['source']
    assert ref['source']['edge_identity']['element'] == 'Ni'
    assert ref['source']['e0_selection']['method'] == 'derivative'
    assert abs(ref['parameters']['e0'] - 8333) < 2
    assert sample['reference_id'] == ref['id']


def test_separate_channels_keep_separate_reference_pairs_and_undo_as_one_import(store, xas_arrays):
    from xraylarch_web.athena import Command
    x, mu = xas_arrays
    p = store.create()
    inspected, ids = upload(store, p, x, a=mu, b=mu * 2, ref=np.exp(mu), one=np.ones(len(x)))
    request = ImportRequest(version=0, upload_id=inspected['upload_id'], energy_column=ids['energy'],
        numerator=[ids['a'], ids['b']], individual_channels=True, reference_numerator=ids['ref'], reference_denominator=ids['one'])
    imported = store.import_data(p['id'], request)
    a, ar, b, br = imported['groups']
    assert a['reference_id'] == ar['id'] and b['reference_id'] == br['id']
    assert [g['marked'] for g in imported['groups']] == [True, False, True, False]
    assert ar['mu'] == br['mu'] and ar['id'] != br['id']
    undone = store.command(p['id'], Command(version=imported['version'], action='undo'))
    assert undone['groups'] == []


def test_invalid_later_detector_leaves_all_groups_unimported(store, xas_arrays):
    x, mu = xas_arrays
    bad = np.ones(len(x)); bad[100] = 0
    p = store.create()
    inspected, ids = upload(store, p, x, a=np.exp(mu), b=bad, one=np.ones(len(x)))
    request = ImportRequest(version=0, upload_id=inspected['upload_id'], energy_column=ids['energy'],
        numerator=[ids['a'], ids['b']], denominator=ids['one'], mode='transmission', individual_channels=True)
    with pytest.raises(ValueError, match='nonzero'):
        store.import_data(p['id'], request)
    assert store.load(p['id']) == p


def test_inspection_includes_bounded_original_file_contents(store, synthetic_xmu_bytes):
    p = store.create()
    full = b'# Beamline log: inspect these detector names\n' + synthetic_xmu_bytes
    result = store.inspect(p['id'], full, 'raw.dat')
    assert result['source_preview'].startswith('# Beamline log: inspect these detector names\n# energy mu')
    assert result['source_preview_truncated'] is True
    assert len(result['source_preview'].splitlines()) == 120
    assert store.load(p['id']) == p
