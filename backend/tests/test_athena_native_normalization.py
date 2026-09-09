"""Native term counts versus web/Larch polynomial degrees on real store paths.

Reference: Demeter 06afc8da08a5a7d5a26ee14992170fcf5dc67406,
templates/process/larch/normalize.tmpl passes bkg_nnorm - 1; Data.pm defaults
to bkg.nnorm || 3. NumTypes.pm requires PosInt; Main.pm offers 1, 2, 3.
Data/Prj.pm loads the attribute unchanged and Data/Athena.pm writes it unchanged.
The config's description calling three terms "cubic" contradicts the template
and the manual, which correctly describes a quadratic.

Native 4 <-> web degree 3 is a Larch encoding extension, NOT tested Ifeffit
compatibility. Ifeffit 1.2.11d iff_pre_edge.f allocates cnorm(3), while preedg.f
passes order 4 to polyft and only adds the quadratic step term for order == 3.
Ifeffit also lowers >=3 terms to 2 when its fitted interval is <=100 eV.
These tests follow the selected Demeter Larch template without reproducing
Ifeffit's numerical reductions. Local read_athena is used only for raw arrays
and native arguments: its do_preedge path incorrectly passes the count directly.

Missing native preferences use three terms. Web None remains automatic degree
selection, including in historical sidecars whose native arguments were wrong.
Data/Prj.pm and Data/JSON.pm both skip legacy bkg_fnorm; active bkg_funnorm
is a separate attribute. Neither loader applies the XANES reset preference.
No science functions or processing outputs are mocked.
"""

import ast
from copy import deepcopy
import gzip
import json
from pathlib import Path

from larch import Group
from larch.io import read_athena
from larch.xafs import pre_edge
import numpy as np
from pydantic import ValidationError
import pytest
from scipy.special import expit

from xraylarch_web.athena import AthenaStore, Command, RestoreUploadRequest
from xraylarch_web.athena_science import AthenaParameters, process_spectrum
from xraylarch_web.config import Settings


MISSING = object()
NORMALIZATION = ("e0", "step", "energy_shift", "pre1", "pre2", "norm1", "norm2", "nnorm", "flatten")


@pytest.fixture
def store(tmp_path):
    return AthenaStore(Settings(data_root=tmp_path))


@pytest.fixture
def native_document():
    x = np.linspace(8700., 9500., 801)
    d = x - 8980.
    mu = .2 + 1e-4 * d + expit(d / 2.5) * (1 + 2e-4 * d + 5e-7 * d**2 + 1e-9 * d**3)
    mu += .002 * np.sin(d / 7.)
    return {"_____header1": "# Athena project file -- Demeter version 0.9.26",
            "_____order": ["sample"], "sample": {"x": x.tolist(), "y": mu.tolist(),
            "args": {"label": "Curved post-edge", "is_xmu": 1, "bkg_nnorm": 3,
                     "bkg_e0": 8982.5, "bkg_eshift": 2.5, "bkg_pre1": -150., "bkg_pre2": -30.,
                     "bkg_nor1": 50., "bkg_nor2": 400., "bkg_fixstep": 0, "bkg_flatten": 1,
                     "bkg_spl1": 0., "bkg_spl2": 8., "bkg_kwindow": "hanning", "bkg_dk": 1.,
                     "fft_kmin": 2., "fft_kmax": 7.5, "bkg_z": "Cu", "fft_edge": "K"}}}


def payload(document, dialect="json"):
    if dialect == "json":
        return json.dumps(document, allow_nan=False).encode()
    lines = [document["_____header1"]]
    for ident in document["_____order"]:
        record = document[ident]
        literal = lambda value: "undef" if value is None else repr(value)
        args = ", ".join(literal(value) for pair in record["args"].items() for value in pair)
        lines.extend([f"$old_group = {ident!r};", f"@args = ({args});",
                      "@x = (" + ",".join(map(repr, record["x"])) + ");",
                      "@y = (" + ",".join(map(repr, record["y"])) + ");", "[record]"])
    return gzip.compress(("\n".join(lines) + "\n1;\n").encode())


def restore(store, data):
    empty = store.create()
    return store.restore(empty["id"], 0, data, "normalization.prj")


def without_sidecar(data):
    return b"\n".join(line for line in gzip.decompress(data).splitlines()
                      if not line.startswith(b"# Athena-Web "))


def read_native(data, tmp_path):
    path = tmp_path / "independent-native.prj"
    path.write_bytes(data)
    native = read_athena(str(path), do_preedge=False, do_bkg=False, do_fft=False, use_hashkey=True)
    return list(native.groups.values())


def native_arguments(data, tmp_path):
    return [g.athena_params.bkg.nnorm for g in read_native(data, tmp_path)]


def change_native_args(data, changes, remove=()):
    """Modify only literal @args, leaving historical web comments intact."""
    lines = gzip.decompress(data).decode().splitlines()
    for i, line in enumerate(lines):
        if line.startswith("@args = "):
            values = ast.literal_eval(line[len("@args = "):-1])
            args = dict(zip(values[::2], values[1::2], strict=True))
            for key in remove:
                args.pop(key, None)
            args.update(changes)
            lines[i] = "@args = (" + ", ".join(repr(v) for pair in args.items() for v in pair) + ");"
    return gzip.compress("\n".join(lines).encode())


def assert_normalization(group, degree):
    assert group["processing_error"] is None, group["processing_error"]
    p = group["parameters"]
    reference = Group()
    pre_edge(np.asarray(group["energy"]) + p["energy_shift"], np.asarray(group["mu"]), group=reference,
             e0=p["e0"], step=p["step"], pre1=p["pre1"], pre2=p["pre2"], norm1=p["norm1"],
             norm2=p["norm2"], nnorm=degree, make_flat=p["flatten"])
    assert group["result"]["effective"]["nnorm"] == degree
    assert group["result"]["effective"]["edge_step"] == pytest.approx(reference.edge_step, rel=1e-12)
    for field in ("norm", "flat", "pre_edge", "post_edge"):
        np.testing.assert_allclose(group["result"]["arrays"][field], getattr(reference, field), rtol=1e-12, atol=1e-12)
    return reference


@pytest.mark.parametrize("dialect", ["json", "perl"])
@pytest.mark.parametrize("raw,degree", [(1, 0), (2, 1), (3, 2), (4, 3),
    ("1", 0), ("2.0", 1), ("3e0", 2), ("4", 3),
    (MISSING, 2), (None, 2), ("", 2), ("None", 2)])
def test_native_terms_map_once_in_preview_restore_and_native_only_roundtrip(store, native_document, tmp_path, dialect, raw, degree):
    args = native_document["sample"]["args"]
    if raw is MISSING:
        args.pop("bkg_nnorm")
    else:
        args["bkg_nnorm"] = raw
    data = payload(native_document, dialect)
    empty = store.create()
    staged = store.preview_project(empty["id"], data, "terms.prj")
    assert staged["groups"][0]["parameters"]["nnorm"] == degree
    assert store.load(empty["id"]) == empty
    lazy = store.preview_project_group(empty["id"], staged["upload_id"], "sample", "norm")
    assert not lazy.get("processing_error")
    project = store.restore_upload(empty["id"], RestoreUploadRequest(version=0, upload_id=staged["upload_id"]))
    group = project["groups"][0]
    assert group["parameters"]["nnorm"] == degree
    reference = assert_normalization(group, degree)
    indices = np.linspace(0, len(group["energy"]) - 1, min(len(group["energy"]), 800), dtype=int)
    np.testing.assert_allclose(lazy["y"], reference.norm[indices], rtol=1e-12, atol=1e-12)
    np.testing.assert_array_equal(group["energy"], native_document["sample"]["x"])
    np.testing.assert_array_equal(group["mu"], native_document["sample"]["y"])
    native = group["source"]["native"]["args"]
    if raw is MISSING:
        assert "bkg_nnorm" not in native
    else:
        assert native["bkg_nnorm"] == raw
    exported = store.export_project(project["id"], "prj")
    assert native_arguments(exported, tmp_path) == [degree + 1]
    reread = restore(store, without_sidecar(exported))["groups"][0]
    assert reread["parameters"]["nnorm"] == degree
    assert_normalization(reread, degree)
    assert reread["result"]["arrays"] == group["result"]["arrays"]


@pytest.mark.parametrize("raw", [0, -2, 1.5, 5, True, False, "0", "invalid", "NaN", "inf", "1e999"])
def test_invalid_native_order_stays_visible_raw_and_repairable(store, native_document, raw):
    native_document["sample"]["args"]["bkg_nnorm"] = raw
    empty = store.create()
    staged = store.preview_project(empty["id"], payload(native_document), "invalid-order.prj")
    assert any("nnorm" in warning for warning in staged["warnings"])
    raw_curve = store.preview_project_group(empty["id"], staged["upload_id"], "sample", "mu")
    assert raw_curve["x"] and raw_curve["y"] and not raw_curve.get("processing_error")
    normalized = store.preview_project_group(empty["id"], staged["upload_id"], "sample", "norm")
    assert "nnorm" in normalized["processing_error"] and normalized["x"] == normalized["y"] == []
    project = store.restore_upload(empty["id"], RestoreUploadRequest(version=0, upload_id=staged["upload_id"]))
    group = project["groups"][0]
    assert group["result"] is None and "nnorm" in group["processing_error"]
    assert group["source"]["native"]["args"]["bkg_nnorm"] == raw
    assert group["energy"] == native_document["sample"]["x"] and group["mu"] == native_document["sample"]["y"]
    with pytest.raises(ValidationError):
        AthenaParameters.model_validate(group["parameters"])
    assert store.load(project["id"]) == project
    exported = store.export_project(project["id"], "prj")
    exports = [store.export_project(project["id"], "json"), exported]
    if not isinstance(raw, bool):
        # Perl scalar 0/1 cannot preserve a JSON boolean's distinct type;
        # exact boolean error state is asserted only via web/sidecar recipes.
        exports.append(without_sidecar(exported))
    for data in exports:
        reread = restore(store, data)["groups"][0]
        assert reread["parameters"] == group["parameters"]
        assert reread["result"] is None and "nnorm" in reread["processing_error"]
    repaired = store.command(project["id"], Command(version=project["version"], action="parameters",
        group_ids=[group["id"]], options={"nnorm": 1}))
    assert_normalization(repaired["groups"][0], 1)
    assert repaired["groups"][0]["source"] == group["source"]
    undone = store.command(project["id"], Command(version=repaired["version"], action="undo"))
    assert undone["groups"] == project["groups"]


@pytest.mark.parametrize("degree", [0, 1, 2, 3, None])
@pytest.mark.parametrize("dialect", ["web_json", "current_sidecar", "historical_sidecar"])
def test_web_recipes_always_remain_degrees_even_when_native_args_disagree(store, native_document, degree, dialect, tmp_path):
    project = restore(store, payload(native_document))
    group = project["groups"][0]
    project = store.command(project["id"], Command(version=project["version"], action="parameters",
        group_ids=[group["id"]], options={"nnorm": degree}))
    original = deepcopy(project["groups"][0])
    if dialect == "web_json":
        data = store.export_project(project["id"], "json")
    else:
        data = store.export_project(project["id"], "prj")
        text = gzip.decompress(data).decode()
        meta = json.loads(next(line[len("# Athena-Web "):] for line in text.splitlines() if line.startswith("# Athena-Web ")))
        assert meta["groups"][0]["parameters"]["nnorm"] == degree
        assert native_arguments(data, tmp_path) == [original["result"]["effective"]["nnorm"] + 1]
        if dialect == "historical_sidecar":
            # Historical exports incorrectly emitted degree as term count.
            # Leave the genuine sidecar recipe intact and alter only @args.
            old_degree = original["result"]["effective"]["nnorm"]
            data = change_native_args(data, {"bkg_nnorm": old_degree})
    reread = restore(store, data)["groups"][0]
    assert reread["parameters"] == original["parameters"]
    assert reread["parameters"]["nnorm"] == degree
    assert reread["result"]["arrays"] == original["result"]["arrays"]
    assert reread["source"] == original["source"]


@pytest.mark.parametrize("span,degree", [(20., 0), (150., 1), (350., 2)])
def test_automatic_web_order_exports_effective_terms_but_preserves_auto_sidecar(store, native_document, span, degree, tmp_path):
    project = restore(store, payload(native_document))
    ident = project["groups"][0]["id"]
    project = store.command(project["id"], Command(version=project["version"], action="parameters",
        group_ids=[ident], options={"nnorm": None, "norm1": 50., "norm2": 50. + span}))
    group = project["groups"][0]
    assert group["parameters"]["nnorm"] is None
    assert_normalization(group, degree)
    data = store.export_project(project["id"], "prj")
    assert native_arguments(data, tmp_path) == [degree + 1]
    web = restore(store, data)["groups"][0]
    native = restore(store, without_sidecar(data))["groups"][0]
    assert web["parameters"]["nnorm"] is None
    assert native["parameters"]["nnorm"] == degree
    assert web["result"]["arrays"] == native["result"]["arrays"] == group["result"]["arrays"]


@pytest.mark.parametrize("dialect", ["json", "perl"])
def test_missing_native_xanes_order_uses_data_default_not_xanes_reset_preference(store, native_document, dialect):
    args = native_document["sample"]["args"]
    args.pop("bkg_nnorm")
    args.update(is_xanes=1, bkg_nor1=50., bkg_nor2=70.)
    group = restore(store, payload(native_document, dialect))["groups"][0]
    assert group["data_type"] == "xanes" and group["parameters"]["nnorm"] == 2
    assert_normalization(group, 2)


@pytest.mark.parametrize("dialect", ["json", "perl"])
@pytest.mark.parametrize("canonical,legacy,expected", [
    (MISSING, MISSING, False), (MISSING, 0, False), (MISSING, 1, False),
    (0, MISSING, False), (1, MISSING, True), (0, 1, False), (1, 0, True)])
def test_only_canonical_native_funnorm_controls_processing(store, native_document, tmp_path, dialect, canonical, legacy, expected):
    args = native_document["sample"]["args"]
    if canonical is not MISSING:
        args["bkg_funnorm"] = canonical
    if legacy is not MISSING:
        args["bkg_fnorm"] = legacy
    project = restore(store, payload(native_document, dialect))
    group = project["groups"][0]
    assert group["processing_error"] is None, group["processing_error"]
    assert group["parameters"]["fnorm"] is expected
    assert group["result"]["effective"]["fnorm"] is expected
    reference = process_spectrum(group["energy"], group["mu"], group["parameters"] | {"fnorm": expected})
    assert group["result"]["arrays"] == reference["arrays"]
    opposite = process_spectrum(group["energy"], group["mu"], group["parameters"] | {"fnorm": not expected})
    assert not np.allclose(reference["arrays"]["chi"], opposite["arrays"]["chi"], atol=1e-9, rtol=1e-5)
    np.testing.assert_array_equal(reference["arrays"]["norm"], opposite["arrays"]["norm"])
    native = group["source"]["native"]
    if legacy is not MISSING:
        assert native["args"]["bkg_fnorm"] == legacy
        assert "bkg_fnorm" in native["unapplied_args"]
    data = store.export_project(project["id"], "prj")
    exported = read_native(data, tmp_path)[0].athena_params.bkg
    assert int(exported.funnorm) == int(expected)
    if legacy is MISSING:
        assert not hasattr(exported, "fnorm")
    else:
        assert exported.fnorm == legacy
    reread = restore(store, without_sidecar(data))["groups"][0]
    assert reread["parameters"]["fnorm"] is expected
    assert reread["result"]["arrays"] == group["result"]["arrays"]


@pytest.mark.parametrize("enabled", [False, True])
@pytest.mark.parametrize("dialect", ["web_json", "current_sidecar", "historical_sidecar"])
def test_explicit_web_fnorm_survives_canonical_native_flag_change(store, native_document, enabled, dialect):
    project = restore(store, payload(native_document))
    project = store.command(project["id"], Command(version=project["version"], action="parameters",
        group_ids=[project["groups"][0]["id"]], options={"fnorm": enabled}))
    original = deepcopy(project["groups"][0])
    data = store.export_project(project["id"], "json" if dialect == "web_json" else "prj")
    if dialect == "historical_sidecar":
        data = change_native_args(data, {"bkg_fnorm": int(not enabled)}, remove=("bkg_funnorm",))
    actual = restore(store, data)["groups"][0]
    assert actual["parameters"] == original["parameters"]
    assert actual["parameters"]["fnorm"] is enabled
    assert actual["result"]["arrays"] == original["result"]["arrays"]
    assert actual["source"] == original["source"]


def test_measured_pt_native_mapping_and_quadratic_reference_with_explicit_exafs_repair(store, tmp_path):
    path = Path(__file__).parent / "fixtures" / "demeter-diff.prj"
    originals = read_athena(str(path), do_preedge=False, do_bkg=False, do_fft=False, use_hashkey=True)
    records = list(originals.groups.items())
    assert len(records) == 21
    chosen = [records[i] for i in (0, 5, 11, 20)]
    empty = store.create()
    staged = store.preview_project(empty["id"], path.read_bytes(), path.name)
    assert all(g["parameters"]["nnorm"] == 2 for g in staged["groups"])
    project = store.restore_upload(empty["id"], RestoreUploadRequest(version=0,
        upload_id=staged["upload_id"], group_ids=[key for key, _ in chosen]))
    before = deepcopy(project["groups"])
    for group, (_, raw) in zip(before, chosen, strict=True):
        assert raw.athena_params.bkg.nnorm == 3 and group["parameters"]["nnorm"] == 2
        assert raw.athena_params.bkg.fnorm == 1 and group["parameters"]["fnorm"] is False
        assert group["source"]["native"]["args"]["bkg_fnorm"] == "1"
        assert len(group["energy"]) == 161
        np.testing.assert_array_equal(group["energy"], raw.energy)
        np.testing.assert_array_equal(group["mu"], raw.mu)
    # Isolate normalization from known zero-taper and spline endpoint issues.
    project = store.command(project["id"], Command(version=project["version"], action="parameters",
        group_ids=[g["id"] for g in before], options={"bkg_window": "hanning", "bkg_dk": 1., "bkg_kmax": 4., "kmax": 4.}))
    differences = []
    for group, prior, (_, raw) in zip(project["groups"], before, chosen, strict=True):
        assert {k: group["parameters"][k] for k in NORMALIZATION} == {k: prior["parameters"][k] for k in NORMALIZATION}
        expected = assert_normalization(group, 2)
        bkg = raw.athena_params.bkg
        independent = Group()
        pre_edge(raw.energy + float(bkg.eshift), raw.mu, group=independent,
                 e0=float(bkg.e0), pre1=float(bkg.pre1), pre2=float(bkg.pre2),
                 norm1=float(bkg.nor1), norm2=float(bkg.nor2), nnorm=2, make_flat=bool(bkg.flatten))
        np.testing.assert_allclose(expected.norm, independent.norm, rtol=1e-12, atol=1e-12)
        cubic = Group()
        pre_edge(raw.energy + float(bkg.eshift), raw.mu, group=cubic,
                 e0=float(bkg.e0), pre1=float(bkg.pre1), pre2=float(bkg.pre2),
                 norm1=float(bkg.nor1), norm2=float(bkg.nor2), nnorm=3, make_flat=bool(bkg.flatten))
        differences.append(np.max(np.abs(expected.norm - cubic.norm)))
    assert min(differences) > 1e-4  # The former off-by-one changed measured data.
    exported = store.export_project(project["id"], "prj")
    assert native_arguments(exported, tmp_path) == [3] * len(chosen)
    reread = restore(store, without_sidecar(exported))
    for actual, expected in zip(reread["groups"], project["groups"], strict=True):
        assert actual["parameters"]["nnorm"] == 2
        assert actual["result"]["arrays"] == expected["result"]["arrays"]
