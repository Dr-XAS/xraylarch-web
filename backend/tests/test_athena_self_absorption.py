"""Self-absorption correction through the project store and over HTTP.

The physics of the FLUO and Booth inversions is checked in
``test_athena_operations``. What matters here is that the panel's preview shows
the operator exactly the spectrum saving would produce, that looking does not
change the project, and that bad geometry comes back as a refusal rather than a
server error.
"""
from io import StringIO

from fastapi.testclient import TestClient
import numpy as np
import pytest

from xraylarch_web.athena import AthenaStore, Command, ImportRequest
from xraylarch_web.config import Settings
from xraylarch_web.errors import WebInputError
from xraylarch_web.main import create_app

FLUO = {'formula': 'CuO', 'element': 'Cu'}
BOOTH = dict(FLUO, algorithm='booth', density=6.31, thickness=3.0)


@pytest.fixture
def store(tmp_path):
    return AthenaStore(Settings(data_root=tmp_path))


@pytest.fixture
def project(store, xas_arrays):
    x, y = xas_arrays
    project = store.create()
    table = StringIO()
    np.savetxt(table, np.column_stack((x, y, np.linspace(1e6, 2e6, len(x)))),
               header='energy mu i0', fmt='%.17g')
    inspected = store.inspect(project['id'], table.getvalue().encode(), 'scan.dat')
    columns = {item['name']: item['column_id'] for item in inspected['columns']}
    return store.import_data(project['id'], ImportRequest(
        version=project['version'], upload_id=inspected['upload_id'],
        energy_column=columns['energy'], numerator=[columns['mu']], data_type='mu'))


def request(project, **options):
    return Command(version=project['version'], action='self_absorption',
                   group_ids=[project['groups'][0]['id']], options=options)


@pytest.mark.parametrize('options', [FLUO, dict(FLUO, density=6.31), BOOTH],
                         ids=['fluo', 'fluo-with-depth', 'booth'])
def test_preview_shows_the_spectrum_saving_produces_and_saves_nothing(store, project, options):
    """A preview that drifts from the save would mislead whoever reads the plot."""
    command = request(project, **options)
    preview = store.preview_self_absorption(project['id'], command)
    assert store.load(project['id']) == project
    row = preview['results'][0]
    assert row['label'] == project['groups'][0]['label']
    saved = store.command(project['id'], command)
    child = next(g for g in saved['groups'] if g['id'] != project['groups'][0]['id'])
    np.testing.assert_array_equal(row['corrected'], child['result']['arrays']['norm'])
    np.testing.assert_array_equal(row['energy'], child['result']['arrays']['energy'])
    assert preview['options'] == options and preview['version'] == project['version']


def test_the_correction_starts_from_the_groups_own_normalized_curve(store, project):
    """Preview and save forwarded only the composition and geometry, so the
    inversion renormalized the raw signal with its own defaults -- tabulated
    E0, its own pre- and post-edge ranges, a linear post-edge -- and the
    'Measured' curve it corrected was not the normalized curve the user had
    approved in the main view. Both paths now inherit the group's effective
    normalization, report it, and record it with the saved group."""
    group = project['groups'][0]
    effective = group['result']['effective']
    preview = store.preview_self_absorption(project['id'], request(project, **FLUO))
    row = preview['results'][0]
    np.testing.assert_allclose(row['measured'], group['result']['arrays']['norm'], atol=1e-9)
    for key in ('e0', 'pre1', 'pre2', 'norm1', 'norm2', 'nnorm'):
        assert row['normalization'][key] == pytest.approx(effective[key])

    saved = store.command(project['id'], request(project, **FLUO))
    child = next(g for g in saved['groups'] if g['id'] != group['id'])
    np.testing.assert_array_equal(row['corrected'], child['result']['arrays']['norm'])
    assert child['source']['options']['e0'] == pytest.approx(effective['e0'])
    # An explicit choice in the request still wins over the inherited one.
    moved = store.preview_self_absorption(
        project['id'], request(saved, **dict(FLUO, pre2=-60.0)))['results'][0]
    assert moved['normalization']['pre2'] == -60.0


@pytest.mark.parametrize('options', [FLUO, BOOTH], ids=['fluo', 'booth'])
@pytest.mark.parametrize('fixed', [dict(step=2.0), dict(nvict=2)], ids=['fixed-step', 'nvict'])
def test_a_fixed_edge_step_or_nvict_reaches_the_curve_the_correction_starts_from(store, project, options, fixed):
    """Only E0, the ranges and the post-edge degree were inherited. With the
    edge step fixed at twice its fitted value the main view showed a curve
    half as tall, and the panel's 'Measured' curve was renormalized on the
    fitted step instead: a factor of two between the approved curve and the
    one the inversion corrected (found on a real fluorescence scan)."""
    group = project['groups'][0]
    if 'step' in fixed:
        fixed = dict(step=fixed['step'] * group['result']['effective']['edge_step'])
    changed = store.command(project['id'], Command(version=project['version'], action='parameters',
                                                   group_ids=[group['id']], options=fixed))
    approved = changed['groups'][0]['result']['arrays']['norm']
    row = store.preview_self_absorption(project['id'], request(changed, **options))['results'][0]
    np.testing.assert_allclose(row['measured'], approved, atol=1e-9)
    saved = store.command(project['id'], request(changed, **options))
    child = next(g for g in saved['groups'] if g['id'] != group['id'])
    np.testing.assert_array_equal(row['corrected'], child['result']['arrays']['norm'])


def test_an_already_normalized_group_is_refused_rather_than_renormalized(store, project):
    """A normalized group has no raw signal or edge step; renormalizing it
    corrects a curve nobody approved."""
    group = project['groups'][0]
    norm = store.command(project['id'], request(project, **FLUO))
    child = next(g for g in norm['groups'] if g['id'] != group['id'])
    assert child['data_type'] == 'norm'
    with pytest.raises(WebInputError, match='already normalized'):
        store.preview_self_absorption(project['id'], Command(version=norm['version'], action='self_absorption',
                                                             group_ids=[child['id']], options=FLUO))


def test_density_only_reports_the_depth_and_leaves_the_fluo_correction_alone(store, project):
    """Telling the app the density must not quietly change the correction."""
    plain = store.preview_self_absorption(project['id'], request(project, **FLUO))['results'][0]
    with_density = store.preview_self_absorption(
        project['id'], request(project, **dict(FLUO, density=6.31)))['results'][0]
    np.testing.assert_array_equal(plain['corrected'], with_density['corrected'])
    assert plain['information_depth_um'] is None and plain['attenuation_length_um'] is None
    assert plain['thickness_over_attenuation_length'] is None
    depth = np.array(with_density['information_depth_um'])
    assert np.all(depth > 0) and depth[0] > depth.min()
    assert with_density['sampled_fraction'] is None  # No thickness, so nothing to sample.
    assert with_density['reference_sampled_fraction'] is None


def test_a_thickness_entered_under_fluo_still_reaches_the_applicability_numbers(store, project):
    """Only the slab correction records the thickness in its details, so under
    FLUO the thickness-to-depth ratio came back empty and the panel asked for
    a thickness that had already been entered."""
    row = store.preview_self_absorption(
        project['id'], request(project, **dict(FLUO, density=6.31, thickness=3.0)))['results'][0]
    assert row['thickness_over_attenuation_length'] == pytest.approx(3.0 / row['attenuation_length_um'])
    assert row['reference_sampled_fraction'] is not None


def test_booth_reports_how_much_of_the_slab_the_measurement_saw(store, project):
    """The applicability numbers the panel puts in front of the operator."""
    row = store.preview_self_absorption(project['id'], request(project, **BOOTH))['results'][0]
    depth = np.array(row['information_depth_um'])
    sampled = np.array(row['sampled_fraction'])
    length = row['attenuation_length_um']
    # Whether the thick-sample correction applies is decided by the reference
    # yield the normalized measurement divides by, so the comparison is against
    # the attenuation length at the edge step. The shortest length in the scan
    # belongs to the white line and sits below it, which is why using that one
    # would call a slab effectively infinite that emits far less than one.
    assert depth.min() < length < depth.max()
    assert row['thickness_over_attenuation_length'] == pytest.approx(BOOTH['thickness'] / length)
    assert row['reference_sampled_fraction'] == pytest.approx(-np.expm1(-BOOTH['thickness'] / length))
    # The slab keeps most of its signal exactly where it absorbs most strongly,
    # because that is where the fluorescence comes from closest to the surface.
    assert np.argmax(sampled) == np.argmin(depth)
    # It is thinner than the attenuation length, so even where it emits most,
    # over half of what an infinite sample would emit is simply missing, and
    # FLUO, which blames that on absorption instead, must over-correct.
    assert row['thickness_over_attenuation_length'] < 1 and sampled.max() < 0.6
    assert row['reference_sampled_fraction'] < 0.99
    fluo = store.preview_self_absorption(project['id'], request(project, **FLUO))['results'][0]
    assert max(fluo['corrected']) > max(row['corrected']) > max(row['measured'])
    assert row['details']['method'] == 'booth.finite_thickness_slab'
    assert 'Booth' in row['details']['reference']


def test_preview_rechecks_the_revision_after_the_calculation(store, project, monkeypatch):
    """A long correction must not return a view of a project someone else edited."""
    import xraylarch_web.athena_operations as operations
    real = operations.transform_spectrum

    def concurrent(*args, **kwargs):
        output = real(*args, **kwargs)
        store.command(project['id'], Command(version=store.load(project['id'])['version'],
                                             action='project', options={'name': 'Another tab'}))
        return output

    monkeypatch.setattr(operations, 'transform_spectrum', concurrent)
    with pytest.raises(WebInputError, match='changed in another tab'):
        store.preview_self_absorption(project['id'], request(project, **FLUO))
    assert store.load(project['id'])['groups'] == project['groups']


@pytest.mark.parametrize('options, message', [
    ({}, 'formula'),
    (dict(FLUO, algorithm='troger'), 'one of: fluo, booth'),
    (dict(FLUO, algorithm='booth', density=6.31), 'thickness in micrometres and the density'),
    (dict(FLUO, algorithm='booth', thickness=3.0), 'thickness in micrometres and the density'),
    (dict(BOOTH, density=99), '0.001–30'),
    (dict(BOOTH, thickness=0), 'thickness must be greater than zero'),
    (dict(FLUO, angle_in=0), 'angle_in'),
])
def test_unusable_geometry_is_refused_without_touching_the_project(store, project, options, message):
    with pytest.raises((ValueError, WebInputError), match=message):
        store.preview_self_absorption(project['id'], request(project, **options))
    assert store.load(project['id']) == project


def test_preview_refuses_a_repeated_group_and_the_wrong_action(store, project):
    gid = project['groups'][0]['id']
    for command in (Command(version=project['version'], action='self_absorption', group_ids=[gid, gid]),
                    Command(version=project['version'], action='self_absorption', group_ids=[]),
                    Command(version=project['version'], action='smooth', group_ids=[gid])):
        with pytest.raises(WebInputError, match='self-absorption correction and distinct'):
            store.preview_self_absorption(project['id'], command)


def test_http_preview_conflicts_refuses_bad_controls_and_then_saves(store, project):
    with TestClient(create_app(store.settings)) as client:
        base = f'/api/athena/projects/{project["id"]}'
        payload = request(project, **BOOTH).model_dump()
        response = client.post(base + '/self-absorption/preview', json=payload)
        assert response.status_code == 200, response.text
        assert len(response.json()['results'][0]['information_depth_um']) == len(project['groups'][0]['energy'])
        assert client.get(base).json() == project
        for options in ({}, dict(BOOTH, thickness='thick'), dict(BOOTH, algorithm='booth', density=None),
                        dict(FLUO, formula='not an element'), dict(BOOTH, angle_out=181)):
            broken = client.post(base + '/self-absorption/preview', json=dict(payload, options=options))
            assert broken.status_code == 400, (options, broken.text)
        saved = client.post(base + '/command', json=payload)
        assert saved.status_code == 200, saved.text
        assert client.post(base + '/self-absorption/preview', json=payload).status_code == 409
        assert len(client.get(base).json()['groups']) == 2
