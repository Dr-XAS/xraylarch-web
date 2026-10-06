"""Which measurement a 20-BM LabVIEW scan is imported as, decided from its data.

The labels of an APS 20-BM scan are the same whatever was measured: I0, It,
Iref, the dead-time-scaled I0 and the detector's K-alpha and K-beta windows.
Synthetic scans below put the copper edge in one signal at a time. Each test
names the wrong import the old label-only choice produced.
"""

import numpy as np
import pytest

from xraylarch_web.athena import AthenaStore, ImportRequest
from xraylarch_web.config import Settings

LABELS = ["Mono Energy (alt) *", "Scaler preset time *", "Ipreslit", "I0", "It", "Iref",
          "XMAP12B:DT Corr I0", "XMAP12B:CuKb_Sum", "XMAP12B:CuKa_Sum", "XMAP12B:Total_Sum"]


def labview(columns, labels=LABELS, e0=8980.48):
    width = len(labels)
    legend = ["#  " + "    ".join(f"{i + 1}) {labels[i]}" for i in range(row, width, 10)) for row in range(min(10, width))]
    header = "\n".join(["# 1-D Scan File created by LabVIEW Control Panel  1/1/2026  1:00:00 PM; Scan time 0 hrs 12 min 0 sec.",
                        "#", "# Beamline 20 BM", "#", "# Scan config: ", f"#                 E0: {e0} eV   400 points",
                        "# Here is a readable list of column headings:", *legend, "#", "# Column Headings:",
                        "#" + "  ".join(labels)])
    rows = "\n".join(" ".join(f"{value:.8g}" for value in row) for row in np.column_stack(columns))
    return (header + "\n" + rows + "\n").encode()


def edge(energy, at=8979.0, width=1.5):
    return 1 / (1 + np.exp(-(energy - at) / width))


@pytest.fixture
def energy():
    return np.linspace(8830., 9600., 400)


def scan(energy, *, sample=0., fluorescence=0., foil=0., noise=1e-4, kbeta_scatter=5.):
    rng = np.random.default_rng(7)
    n = len(energy)
    i0 = 1e6 * (1 + noise * rng.standard_normal(n))
    it = i0 * np.exp(-(0.5 + sample * edge(energy))) * (1 + noise * rng.standard_normal(n))
    iref = it * np.exp(-(0.3 + foil * edge(energy))) * (1 + noise * rng.standard_normal(n))
    dt_i0 = i0 * 0.9
    ka = i0 * 1e-3 * (0.02 + fluorescence * edge(energy)) * (1 + noise * rng.standard_normal(n))
    kb = i0 * 1e-3 * (kbeta_scatter * 0.02 + 0.13 * fluorescence * edge(energy))
    return [energy, np.ones(n), i0 * 1.1, i0, it, iref, dt_i0, kb, ka, ka + kb]


def inspect(tmp_path, data, name="sample_Cu_EXAFS.0003"):
    store = AthenaStore(Settings(data_root=tmp_path))
    project = store.create()
    inspected = store.inspect(project["id"], data, name)
    names = {c["column_id"]: c["name"] for c in inspected["columns"]}
    return store, project, inspected, names


def spell(names, value):
    return [names[v] for v in value] if isinstance(value, list) else names.get(value)


def test_a_sample_with_a_transmission_edge_imports_in_transmission_with_its_foil_reference(tmp_path, energy):
    # The registry offered It/Iref, but the browser cleared it; the reference
    # suggestion must now reach the inspection as the import default.
    data = labview(scan(energy, sample=1., fluorescence=1., foil=1.5))
    _, _, inspected, names = inspect(tmp_path, data)
    chosen, reader = inspected["athena_suggestion"], inspected["beamline_reader"]
    assert (chosen["mode"], spell(names, chosen["numerator"]), spell(names, chosen["denominator"])) == ("transmission", ["I0"], "It")
    assert spell(names, reader["reference"]["numerator"]) == "It" and spell(names, reader["reference"]["denominator"]) == "Iref"
    assert reader["reference"]["default"] is True
    assert reader["measurement"]["mode"] == "transmission" and reader["measurement"]["edge_energy"] == 8980.48


def test_fluorescence_uses_k_alpha_only_over_the_dead_time_scaled_i0(tmp_path, energy):
    # The old suggestion summed K-alpha and K-beta windows (K-beta below the
    # edge is scatter) over plain I0, excluding the corrected I0 as 'derived'.
    data = labview(scan(energy, sample=0., fluorescence=1., foil=0.))
    store, project, inspected, names = inspect(tmp_path, data, "insitu_Cu.0001")
    chosen = inspected["athena_suggestion"]
    assert chosen["mode"] == "fluorescence"
    assert spell(names, chosen["numerator"]) == ["XMAP12B:CuKa_Sum"]
    assert spell(names, chosen["denominator"]) == "XMAP12B:DT Corr I0"
    # No edge in It/Iref here: offered, but not imported by default.
    assert inspected["beamline_reader"]["reference"]["default"] is False
    group = store.import_data(project["id"], ImportRequest(version=0, upload_id=inspected["upload_id"], **chosen))["groups"][0]
    assert group["processing_error"] is None and group["result"]["effective"]["edge_step"] > 0


def test_a_foil_in_the_reference_position_is_offered_as_it_over_iref(tmp_path, energy):
    # Foil scans put the edge behind It; ln(I0/It) is flat, and the old
    # default imported that flat line as the spectrum.
    labels = LABELS[:7]
    data = labview(scan(energy, foil=1.5)[:7], labels)
    _, _, inspected, names = inspect(tmp_path, data, "Cu_foil.0001")
    chosen = inspected["athena_suggestion"]
    assert (chosen["mode"], spell(names, chosen["numerator"]), spell(names, chosen["denominator"])) == ("transmission", ["It"], "Iref")
    assert "reference" not in inspected["beamline_reader"]
    assert any("reference position" in note for note in inspected["beamline_reader"]["measurement"]["notes"])


def test_a_weak_sample_edge_beside_a_strong_foil_is_not_replaced_by_the_foil(tmp_path, energy):
    # A 3% transmission step (contrast in the hundreds) behind which sits a
    # foil 60 times stronger: the old share rule imported It/Iref, the foil, as
    # the sample, dropped the reference and said the sample had no edge.
    data = labview(scan(energy, sample=.03, foil=2.)[:7], LABELS[:7])
    _, _, inspected, names = inspect(tmp_path, data)
    chosen, reader = inspected["athena_suggestion"], inspected["beamline_reader"]
    assert (chosen["mode"], spell(names, chosen["numerator"]), spell(names, chosen["denominator"])) == ("transmission", ["I0"], "It")
    assert spell(names, reader["reference"]["numerator"]) == "It" and reader["reference"]["default"] is True
    assert reader["measurement"]["contrast"]["reference"] > 10 * reader["measurement"]["contrast"]["transmission"]
    assert not any("reference position" in note for note in reader["measurement"]["notes"])


@pytest.mark.parametrize("sample, foil", [(.003, .03), (.03, 2.)])
def test_a_small_but_clear_sample_edge_keeps_the_sample_and_its_reference(tmp_path, energy, sample, foil):
    # A 0.3% step (contrast in the hundreds, quiet chambers) beside a 0.03 foil
    # fell under the old absolute 0.5% floor: It/Iref was imported as the
    # sample, its reference dropped, and the note said nothing absorbing was in
    # the sample position. A step that far above its noise is imported as the
    # sample by default; its size alone does not prove the geometry.
    data = labview(scan(energy, sample=sample, foil=foil, noise=1e-5)[:7], LABELS[:7])
    _, _, inspected, names = inspect(tmp_path, data)
    chosen, reader = inspected["athena_suggestion"], inspected["beamline_reader"]
    assert (spell(names, chosen["numerator"]), spell(names, chosen["denominator"])) == (["I0"], "It")
    assert reader["reference"]["default"] is True and not reader["measurement"]["ambiguous"]
    assert not any("sample position" in note for note in reader["measurement"]["notes"])


def test_the_original_quiet_trace_fixture_imports_as_sample_with_a_note_naming_the_foil_choice(tmp_path, energy):
    # The round-2 fixture (0.13% step, quiet chambers) asserted a foil import
    # under the removed absolute floor. Its step is about 144 times its noise,
    # past the ask boundary, so I0/It is the default; the note must still say
    # how to take It/Iref, since the step's size does not identify a foil scan.
    data = labview(scan(energy, sample=.0013, foil=1.5, noise=1e-5)[:7], LABELS[:7])
    _, _, inspected, names = inspect(tmp_path, data, "Cu_foil.0001")
    chosen, reader = inspected["athena_suggestion"], inspected["beamline_reader"]
    measurement = reader["measurement"]
    assert 100 < measurement["contrast"]["transmission"] < 200
    assert (spell(names, chosen["numerator"]), spell(names, chosen["denominator"])) == (["I0"], "It")
    assert reader["reference"]["default"] is True and not measurement["ambiguous"]
    assert any("If this was a foil scan, choose It as numerator and Iref" in note for note in measurement["notes"])


def test_the_ask_note_quotes_the_reference_contrast_instead_of_calling_a_weak_one_clear(tmp_path, energy):
    # A reference edge only 5-20 times its noise also triggers the question;
    # the note called it "a clear one" whatever its size.
    data = labview(scan(energy, sample=.0013, foil=.001, noise=1e-4)[:7], LABELS[:7])
    _, _, inspected, _ = inspect(tmp_path, data, "Cu_foil.0001")
    measurement = inspected["beamline_reader"]["measurement"]
    assert measurement["ambiguous"] is True and 5 <= measurement["contrast"]["reference"] < 20
    note = next(note for note in measurement["notes"] if "choose which" in note)
    assert "clear" not in note
    assert f'It/Iref one {measurement["contrast"]["reference"]:.0f} times its noise' in note


def test_a_marginal_i0_over_it_edge_beside_a_clear_foil_asks_which_was_scanned(tmp_path, energy):
    # A tenth-of-a-percent step a few times its noise could be a dilute sample
    # or a foil's trace reaching It; the old floor declared the sample position
    # empty. Neither guess is imported silently: both are offered as a choice.
    data = labview(scan(energy, sample=.0013, foil=1.5, noise=1e-4)[:7], LABELS[:7])
    _, _, inspected, names = inspect(tmp_path, data, "Cu_foil.0001")
    reader = inspected["beamline_reader"]
    measurement = reader["measurement"]
    assert 5 <= measurement["contrast"]["transmission"] < 20
    assert measurement["ambiguous"] is True
    foil = reader["suggestions"]["foil"]
    assert (spell(names, foil["numerator"]), spell(names, foil["denominator"])) == (["It"], "Iref")
    sample = reader["suggestions"]["transmission"]
    assert (spell(names, sample["numerator"]), spell(names, sample["denominator"])) == (["I0"], "It")
    assert not any("sample position" in note for note in measurement["notes"])


def test_a_scan_whose_axis_misses_its_named_and_stated_edge_is_flagged(tmp_path):
    # series_Ni.0007 is named Ni and states a Ni E0, but runs over the Mn edge.
    energy = np.linspace(6337., 6797., 300)
    data = labview(scan(energy), e0=8333.0)
    _, _, inspected, _ = inspect(tmp_path, data, "series_Ni.0007")
    warnings = " ".join(inspected["warnings"])
    assert "E0 = 8333 eV" in warnings and "file name names Ni" in warnings


def test_scan_conditions_travel_with_the_group_through_save_and_reopen(tmp_path, energy):
    # An operando series is read against temperature; the header and the
    # controller column were read for display only and then dropped.
    labels = [*LABELS, "s20ptc10:tc1:2A:tempe"]
    data = labview([*scan(energy, sample=1.), np.linspace(25., 31., len(energy))], labels)
    store, project, inspected, _ = inspect(tmp_path, data)
    request = ImportRequest(version=0, upload_id=inspected["upload_id"], **inspected["athena_suggestion"])
    saved = store.import_data(project["id"], request)
    header = saved["groups"][0]["source"]["scan_header"]
    assert header["scan_e0"] == 8980.48
    assert header["temperature"] == {"column": "s20ptc10:tc1:2A:tempe", "mean": pytest.approx(28.), "min": 25., "max": 31.}
    for fmt in ("json", "prj"):
        other = store.create()
        restored = store.restore(other["id"], 0, store.export_project(project["id"], fmt), "series." + fmt)
        assert restored["groups"][0]["source"]["scan_header"] == header


def test_a_six_point_scan_and_a_last_counter_are_flagged_at_inspection(tmp_path, energy):
    short = labview([column[:6] for column in scan(energy)])
    assert any("only 6 points" in w or "6 data rows" in w for w in inspect(tmp_path, short, "series_Ni.0003")[2]["warnings"])
    store, project, last, _ = inspect(tmp_path / "last", b"24\t0\n", "sample_Cu_EXAFS.last")
    assert any("scan counter" in w for w in last["warnings"])
    with pytest.raises(ValueError, match="holds 1 data row; a spectrum needs at least 8"):
        store.import_data(project["id"], ImportRequest(version=0, upload_id=last["upload_id"], **last["athena_suggestion"]))
