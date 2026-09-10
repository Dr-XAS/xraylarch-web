"""Real Demeter projects, including legacy metadata and numerical settings."""
import ast
from collections import Counter
import gzip
import hashlib
import json
from pathlib import Path
import re

from larch import Group
from larch.xafs import pre_edge, xftf, xftr
import numpy as np
import pytest

from xraylarch_web.athena import AthenaStore, RestoreUploadRequest, _project_literal
from xraylarch_web.config import Settings
from xraylarch_web.athena_science import process_spectrum

ROOT = Path(__file__).parents[2]
MANIFEST = json.loads((Path(__file__).parent / "fixtures/athena-official-manifest.json").read_text())
CORPUS = sorted((ROOT / "examples").rglob("*.prj"))


@pytest.fixture
def store(tmp_path):
    return AthenaStore(Settings(data_root=tmp_path))


def unpack(data):
    return (gzip.decompress(data) if data[:2] == b"\x1f\x8b" else data).decode("utf-8-sig")


def raw_arrays(data):
    """Independent decoder for only the numerical arrays in the actual files."""
    text = unpack(data)
    if text.lstrip().startswith("{"):
        document = json.loads(text)
        return [(document[key]["x"], document[key]["y"]) for key in document["_____order"]]
    xs = re.findall(r"^@x\s*=\s*(.*);\s*$", text, re.M)
    ys = re.findall(r"^@y\s*=\s*(.*);\s*$", text, re.M)
    return [(ast.literal_eval(x), ast.literal_eval(y)) for x, y in zip(xs, ys, strict=True)]


@pytest.mark.parametrize("path", CORPUS, ids=lambda p: str(p.relative_to(ROOT / "examples")))
def test_bundled_native_corpus_parses_without_executing_project_code(store, path):
    if path.name == "danger.prj":
        # This upstream fixture calls system("hephaestus") in @journal.
        with pytest.raises(ValueError, match="not executable"):
            store._parse_project(path.read_bytes(), path.name)
        return
    result = store._parse_project(path.read_bytes(), path.name)
    original = raw_arrays(path.read_bytes())
    assert len(result["groups"]) == len(original) > 0
    assert len({g["old_id"] for g in result["groups"]}) == len(original)
    for group, (x, y) in zip(result["groups"], original, strict=True):
        np.testing.assert_array_equal(group["energy"], np.asarray(x, dtype=float))
        np.testing.assert_array_equal(group["mu"], np.asarray(y, dtype=float))


@pytest.mark.parametrize("record", MANIFEST, ids=lambda r: Path(r["source"]).name)
def test_downloaded_official_projects_preview_process_export_and_reload(store, record):
    data = (ROOT / record["file"]).read_bytes()
    assert hashlib.sha256(data).hexdigest() == record["sha256"]
    p = store.create()
    staged = store.preview_project(p["id"], data, Path(record["file"]).name)
    assert store.load(p["id"]) == p
    normalized = store.preview_project_group(p["id"], staged["upload_id"], staged["groups"][0]["id"], "norm")
    assert not normalized.get("processing_error") and normalized["x"]
    p = store.restore_upload(p["id"], RestoreUploadRequest(version=0, upload_id=staged["upload_id"]))
    originals = raw_arrays(data)
    assert len(p["groups"]) == len(originals)
    for group, (x, y) in zip(p["groups"], originals, strict=True):
        assert group["processing_error"] is None, (group["label"], group["processing_error"])
        np.testing.assert_array_equal(group["energy"], np.asarray(x, dtype=float))
        np.testing.assert_array_equal(group["mu"], np.asarray(y, dtype=float))
        arrays = group["result"]["arrays"]
        for key in ("norm", "flat", "chi", "chir_mag", "chiq_re"):
            assert arrays[key] and np.isfinite(arrays[key]).all(), (group["label"], key)
    first = p["groups"][0]
    params = first["parameters"]
    reference = Group()
    pre_edge(np.asarray(first["energy"]) + params["energy_shift"], np.asarray(first["mu"]), group=reference,
             e0=params["e0"], step=params["step"], pre1=params["pre1"], pre2=params["pre2"],
             norm1=params["norm1"], norm2=params["norm2"], nnorm=params["nnorm"], make_flat=params["flatten"])
    np.testing.assert_allclose(first["result"]["arrays"]["norm"], reference.norm, rtol=1e-12, atol=1e-12)
    for format in ("json", "prj"):
        target = store.create()
        reread = store.restore(target["id"], 0, store.export_project(p["id"], format), "roundtrip." + format)
        for actual, expected in zip(reread["groups"], p["groups"], strict=True):
            assert actual["parameters"] == expected["parameters"]
            assert actual["source"] == expected["source"]
            assert actual["result"]["arrays"] == expected["result"]["arrays"]


def test_perl_strings_nested_hashes_and_blessed_metadata_are_literal():
    value = _project_literal(r'''({'notes' => "caf\x{e9}\nline", 'path' => 'C:\new\test',
        'items' => [undef, {'a=>b' => 'kept'}], 'xdi' => bless({'ok' => 0}, 'Xray::XDI')},)''')
    assert value == ({"notes": "café\nline", "path": r"C:\new\test", "items": [None, {"a=>b": "kept"}],
                      "xdi": {"__perl_class__": "Xray::XDI", "__perl_value__": {"ok": 0}}},)
    assert _project_literal("'first\nsecond'") == "first\nsecond"
    assert _project_literal(r"'first\nsecond'", legacy_strings=True) == "first\nsecond"
    assert _project_literal(r"'first\nsecond'") == r"first\nsecond"


@pytest.mark.parametrize("literal", [
    "bless(__import__('os').system('echo bad'), 'Xray::XDI')",
    "bless({'x': open('/tmp/must-not-open', 'w')}, 'Xray::XDI')",
    "bless({}, system('bad'))", "{'a' => 1, 'a' => 2}",
    "{'x': object.__class__}", "[x for x in ()]", "(" * 33 + "0" + ")" * 33,
])
def test_unsupported_native_expressions_remain_rejected(literal):
    with pytest.raises(ValueError):
        _project_literal(literal)


def test_legacy_id_collisions_preserve_all_spectra_and_origin(store):
    path = ROOT / "examples/xafsdata/AthenaProjectFiles/CuHERFD_samples.prj"
    result = store._parse_project(path.read_bytes(), path.name)
    counts = Counter(g["source"]["native"]["id"] for g in result["groups"])
    assert counts["cuher0009"] == counts["cuher0002"] == counts["cuher0007"] == 2
    assert len(result["groups"]) == 94
    assert any("Repeated native group ID" in message for message in result["warnings"])


def test_larch_writer_degree_zero_and_native_chi_placeholders(store):
    path = ROOT / "examples/xafsdata/AthenaProjectFiles/CuHERFD_samples.prj"
    parsed = store._parse_project(path.read_bytes(), path.name)
    constant = next(g for g in parsed["groups"] if float(g["source"]["native"]["args"]["bkg_nnorm"]) == 0)
    assert constant["parameters"]["nnorm"] == 0
    assert constant["source"]["native"]["producer"] == "larch"
    path = ROOT / "examples/xafsdata/AthenaProjectFiles/MoO3-tutorial.prj"
    p = store.create()
    restored = store.restore(p["id"], 0, path.read_bytes(), path.name)
    chi = next(g for g in restored["groups"] if g["data_type"] == "chi")
    assert chi["processing_error"] is None
    assert chi["parameters"]["e0"] is None
    assert float(chi["source"]["native"]["args"]["bkg_e0"]) == 0
    assert chi["result"]["arrays"]["chir_mag"]


@pytest.mark.parametrize("field", ["bkg_e0", "bkg_pre1", "bkg_nor2", "bkg_spl2", "fft_kmax", "bkg_eshift"])
def test_bad_native_limits_keep_raw_spectra_with_editable_errors(store, field):
    document = json.loads((ROOT / "backend/tests/fixtures/demeter-athena-json.prj").read_bytes())
    first = document["_____order"][0]
    document["_____order"] = [first]
    document[first]["args"][field] = "invalid-limit"
    # Remove out-of-project relations so this specifically checks the recipe.
    document[first]["args"]["bkg_stan"] = "None"
    p = store.create()
    restored = store.restore(p["id"], 0, json.dumps(document).encode(), "malformed.prj")
    assert len(restored["groups"]) == 1
    g = restored["groups"][0]
    np.testing.assert_array_equal(g["energy"], np.asarray(document[first]["x"], dtype=float))
    np.testing.assert_array_equal(g["mu"], np.asarray(document[first]["y"], dtype=float))
    assert g["processing_error"]
    assert g["source"]["native"]["args"][field] == "invalid-limit"


def test_real_missing_covariance_does_not_discard_fitted_curves(store):
    path = ROOT / "examples/xafsdata/AthenaProjectFiles/AgL3_CAMD.prj"
    p = store.create()
    restored = store.restore(p["id"], 0, path.read_bytes(), path.name)
    assert all(g["processing_error"] is None for g in restored["groups"])
    groups = [g for g in restored["groups"] if g["result"]["effective"].get("background_covariance_available") is False]
    assert groups
    assert all(any("covariance is unavailable" in w for w in g["result"]["warnings"]) for g in groups)


@pytest.mark.parametrize("window,width", [("kaiser", 0), ("kaiser", 12), ("gaussian", 12)])
def test_legacy_zero_and_wide_shape_parameters_match_larch_transforms(window, width):
    k = np.arange(0, 15.01, 0.05)
    chi = np.sin(2 * k) * np.exp(-k / 8)
    result = process_spectrum(k, chi, {"kmin": 3, "kmax": 6, "window": window, "dk": width,
                                     "rwindow": window, "dr": width}, data_type="chi")
    direct = Group()
    larch_window = "bessel" if window == "kaiser" and width == 0 else window
    xftf(k, chi * k**2, group=direct, kweight=0, kmin=3, kmax=6, dk=width, window=larch_window)
    xftr(direct.r, direct.chir, group=direct, rmin=1, rmax=3, dr=width, window=larch_window, qmax_out=15)
    for actual, expected in [(result["arrays"]["chir_mag"], direct.chir_mag),
                             (result["arrays"]["chiq_re"], direct.chiq.real)]:
        np.testing.assert_allclose(actual, expected, rtol=1e-12, atol=1e-12)
        assert np.max(np.abs(actual)) > 0


def test_native_zero_width_reverse_kaiser_keeps_yb_iron_spectra_and_real_errors(store):
    path = ROOT / "examples/xafsdata/AthenaProjectFiles/yb_iron.prj"
    p = store.create()
    restored = store.restore(p["id"], 0, path.read_bytes(), path.name)
    assert len(restored["groups"]) == 13
    processed = [g for g in restored["groups"] if g["processing_error"] is None]
    assert len(processed) == 12
    failed = [g for g in restored["groups"] if g["processing_error"] is not None]
    assert failed[0]["label"] == "yb_iron_yb_l2_xafs.003"
    assert "fitted edge step is not positive" in failed[0]["processing_error"]
    for g in processed:
        assert np.max(np.abs(g["result"]["arrays"]["chiq_re"])) > 0
