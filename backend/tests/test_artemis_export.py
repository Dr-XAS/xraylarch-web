"""Native Larix session round trips, portable FEFF cache, and export guards."""
import copy
import gzip
import json
from pathlib import Path

import numpy as np
import pytest
from larch import Group
from larch.fitting import param, param_group
from larch.io import load_session, read_session
from larch.xafs import feffit_dataset, feffpath, ff2chi, use_feffpath

from test_artemis import model, spectrum
from test_artemis_persistence import draft, post, workspace
from xraylarch_web import artemis
from xraylarch_web.artemis_export import export_larix


def exported(workspace, model, tmp_path):
    store, client, project, group_id = workspace
    project = post(client, project, group_id, "model", model=draft(model))
    response = client.get(f"/api/artemis/projects/{project['id']}/groups/{group_id}/export",
                          params={"format": "larix", "version": project["version"]})
    assert response.status_code == 200, response.text
    assert response.headers["content-disposition"].endswith('.larix"')
    assert response.headers["cache-control"] == "no-store"
    assert store.load(project["id"]) == project
    output = tmp_path / "portable.larix"
    output.write_bytes(response.content)
    return project, response, output, read_session(str(output))


def test_native_roundtrip_keeps_source_model_transform_and_portable_feff(workspace, model, tmp_path, monkeypatch):
    model["parameters"] += [dict(name="half", kind="set", value=0.5),
                             dict(name="amplitude", kind="def", expression="amp * half")]
    model["paths"][0].update(s02="amplitude * degen / 12", deltar="del_r + 0.001 * reff / nleg")
    model["paths"].append(model["paths"][0] | {"id": "disabled", "enabled": False, "s02": "10 * amp"})
    model["transform"].update(kweight=[0, 3, 1], window="parzen", fitspace="k", dr=0.2)

    # Export is a serializer, never a fit, model evaluation, or reprocessing.
    def forbidden(*args, **kwargs):
        raise AssertionError("Export must not run science calculations")
    monkeypatch.setattr(artemis, "fit_group", forbidden)
    import larch.xafs
    monkeypatch.setattr(larch.xafs, "feffit", forbidden)
    monkeypatch.setattr(larch.xafs, "autobk", forbidden)
    monkeypatch.setattr(larch.xafs, "ff2chi", forbidden)
    project, response, output, session = exported(workspace, model, tmp_path)

    assert session.command_history == []
    assert set(session.symbols) == {"_xasgroups", "_feffcache", "_feffpaths", next(iter(session.symbols["_xasgroups"].values()))}
    assert not any(key.startswith(("Machine", "Python")) for key in session.config)
    text = gzip.decompress(response.content).decode()
    assert "artemis-export-" not in text
    assert "feffit_history" not in text
    group = project["groups"][0]
    data = session.symbols[next(iter(session.symbols["_xasgroups"].values()))]
    np.testing.assert_array_equal(data.k, group["result"]["arrays"]["k"])
    np.testing.assert_array_equal(data.chi, group["result"]["arrays"]["chi"])
    np.testing.assert_array_equal(data.raw.k, group["energy"])
    np.testing.assert_array_equal(data.raw.chi, group["mu"])
    assert not hasattr(data, "energy") and not hasattr(data, "mu")
    assert data.datatype == "xydata" and data.raw.data_type == "chi"
    assert data.artemis_export["model"] == group["artemis"]["model"]
    assert json.loads(response.headers["x-artemis-export-warnings"]) == data.artemis_export["warnings"]
    assert any("disabled paths" in warning for warning in data.artemis_export["warnings"])
    assert any("Def constraints" in warning for warning in data.artemis_export["warnings"])

    paths, parameters, transform = data.feffit_model
    assert [path.use for path in paths.values()] == [True, False]
    assert transform.kweight == [0, 3, 1]
    for name in ("kmin", "kmax", "rmin", "rmax", "dk", "dr", "window", "fitspace"):
        assert getattr(transform, name) == model["transform"][name]
    assert data.config.feffit["fit_kwstring"] == "[0, 3, 1]"
    assert data.config.feffit["fit_kwindow"] == "Parzen"
    assert parameters.amp.vary is True
    assert parameters.amp.min == 0 and parameters.amp.max == 2
    assert parameters.half.vary is False
    assert parameters.amplitude.expr == "amp * half"
    assert parameters.amplitude.value == pytest.approx(0.5)
    assert all(path.degen == 1 for path in paths.values())
    assert all(not Path(path.filename).exists() for path in paths.values())

    # Evaluate the reloaded native model without any exported FEFF files.
    # A direct native reference uses the original degeneracy convention.
    reference_parameters = param_group(amp=param(1), half=param(0.5),
        amplitude=param(0.5, expr="amp * half"), del_e0=param(0), del_r=param(0), sig2=param(0.008))
    reference_path = feffpath(str(artemis._EXAMPLE), s02="amplitude * degen / 12",
                             e0="del_e0", deltar="del_r + 0.001 * reff / nleg", sigma2="sig2")
    expected, actual = Group(), Group()
    ff2chi([reference_path], paramgroup=reference_parameters, k=data.k, group=expected)
    ff2chi(list(paths.values()), paramgroup=parameters, k=data.k, group=actual)
    np.testing.assert_allclose(actual.chi, expected.chi, rtol=1e-12, atol=1e-14)

    # Larix fill_form consumes exactly this tuple and constructs a dataset.
    native_dataset = feffit_dataset(data=data, paths=list(paths.values()), transform=transform)
    assert len(native_dataset.paths) == 2
    # Fresh-session loader merges the portable FEFF cache, with no interpreter
    # symbol leakage and no access to the deleted temporary FEFF files.
    restored = load_session(str(output))
    assert len(restored._feffcache["paths"]) == 2
    np.testing.assert_array_equal(getattr(restored, data.groupname).chi, data.chi)


def test_larix_gui_cache_reconstruction_keeps_degeneracy(workspace, model, tmp_path):
    model["transform"]["kweight"] = [2]
    _, response, _, session = exported(workspace, model, tmp_path)
    assert "x-artemis-export-warnings" not in response.headers
    data = session.symbols[next(iter(session.symbols["_xasgroups"].values()))]
    paths, parameters, _ = data.feffit_model
    cache = session.symbols["_feffcache"]["paths"]
    rebuilt = []
    for title, path in paths.items():
        # Mirrors FeffitPanel.add_path -> COMMANDS['use_path'] after read_session.
        rebuilt.append(use_feffpath(cache, title, s02=path.s02, e0=path.e0,
                                    deltar=path.deltar, sigma2=path.sigma2,
                                    third=path.third, ei=path.ei, use=True))
    expected, actual = Group(), Group()
    ff2chi([feffpath(str(artemis._EXAMPLE), s02=1, e0=0, deltar=0, sigma2=0.008)], k=data.k, group=expected)
    ff2chi(rebuilt, paramgroup=parameters, k=data.k, group=actual)
    np.testing.assert_allclose(actual.chi, expected.chi, rtol=1e-12, atol=1e-14)


@pytest.mark.parametrize("damage", ["missing-model", "incomplete-number", "no-paths", "no-active-paths", "invalid-expression", "unprocessed"])
def test_export_rejects_incomplete_models_without_mutating(workspace, model, damage):
    store, client, project, group_id = workspace
    if damage != "missing-model":
        value = draft(model)
        if damage == "incomplete-number":
            value["parameters"][0]["value"] = "-"
        if damage == "no-paths":
            value["paths"] = []
        if damage == "no-active-paths":
            value["paths"][0]["enabled"] = False
        if damage == "invalid-expression":
            value["paths"][0]["s02"] = "amp + missing"
        project = post(client, project, group_id, "model", model=value)
        if damage == "unprocessed":
            project["groups"][0]["processing_error"] = "Missing background standard"
            store.storage.write_json(project["id"], "project.json", project)
    before = store.load(project["id"])
    response = client.get(f"/api/artemis/projects/{project['id']}/groups/{group_id}/export")
    assert response.status_code == 400, response.text
    assert store.load(project["id"]) == before


def test_export_checks_version_format_and_integration_scope(workspace, model):
    store, client, project, group_id = workspace
    original = project
    project = post(client, project, group_id, "model", model=draft(model))
    url = f"/api/artemis/projects/{project['id']}/groups/{group_id}/export"
    assert client.get(url, params={"version": original["version"]}).status_code == 409
    assert client.get(url, params={"format": "fpj"}).status_code == 422
    assert store.load(project["id"]) == project
    project["integration"] = True
    store.storage.write_json(project["id"], "project.json", project)
    assert client.get(url).status_code in (400, 403, 404)


def test_energy_export_preserves_measured_and_processed_arrays(workspace, model, xas_arrays, tmp_path):
    store, _, _, _ = workspace
    energy, mu = xas_arrays
    source = {"raw_arrays": {"i0": np.full(len(energy), 1234).tolist()}}
    group = store.make_group("Cu measured", energy, mu, source=source,
                             parameters={"energy_shift": 1.2})
    assert group["processing_error"] is None
    group["artemis"] = {"model": draft(model)}
    before = copy.deepcopy(group)
    content, warnings = export_larix(group, 1)
    assert group == before
    output = tmp_path / "mu.larix"
    output.write_bytes(content)
    session = read_session(str(output))
    data = session.symbols[next(iter(session.symbols["_xasgroups"].values()))]
    assert data.datatype == "xas"
    np.testing.assert_array_equal(data.raw.energy, energy)
    np.testing.assert_array_equal(data.raw.mu, mu)
    np.testing.assert_array_equal(data.raw.i0, source["raw_arrays"]["i0"])
    np.testing.assert_array_equal(data.energy, group["result"]["arrays"]["energy"])
    np.testing.assert_array_equal(data.k, group["result"]["arrays"]["k"])
    np.testing.assert_array_equal(data.chi, group["result"]["arrays"]["chi"])
    assert data.e0 == group["result"]["effective"]["e0"]
    assert data.is_frozen
    assert any("snapshot" in warning for warning in warnings)
