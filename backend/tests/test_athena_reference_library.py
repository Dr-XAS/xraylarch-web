"""The bundled XANES standards, and suggesting them for an unknown spectrum.

The library is a manifest over records inside the example Athena projects
rather than a copy of them, so the check that matters is that a standard added
from the library is the same spectrum, processed the same way, as the group you
get by importing that project file yourself. Everything else here is about the
suggestion step refusing what it cannot answer instead of guessing.
"""

from collections import defaultdict
from pathlib import Path

import numpy as np
import pytest

from xraylarch_web.athena import AthenaStore, Command
from xraylarch_web.athena_reference_library import (
    REFERENCES, catalogue, families, find, rank_references, reference_spectrum)
from xraylarch_web.athena_science import ScientificError
from xraylarch_web.config import Settings
from xraylarch_web.errors import WebInputError

EXAMPLES = Path(__file__).parents[2] / "examples"
BY_FILE = defaultdict(list)
for _entry in REFERENCES:
    BY_FILE[_entry["file"]].append(_entry)


@pytest.fixture
def store(tmp_path):
    return AthenaStore(Settings(data_root=tmp_path))


def restored(store, filename):
    path = EXAMPLES / filename
    project = store.create()
    return store.restore(project["id"], 0, path.read_bytes(), path.name)


def command(store, project, action, groups=(), **options):
    return store.command(project["id"], Command(
        version=project["version"], action=action, group_ids=list(groups), options=options))


def analyze(store, project, action, groups=(), **options):
    return store.analyze(project["id"], Command(
        version=project["version"], action=action, group_ids=list(groups), options=options))


@pytest.mark.parametrize("filename", sorted(BY_FILE), ids=lambda name: Path(name).stem)
def test_bundled_standards_reproduce_the_imported_project_group(store, filename):
    """A library standard must be the imported group, not a reprocessing of it.

    The recipe saved in a native project cannot be read without knowing which
    program wrote the file: Larch's writer stores the normalization order as a
    polynomial degree where Demeter stores degree plus one. Reading it the wrong
    way shifts the edge step by several per cent and quietly biases every weight
    a fit against these standards reports.
    """
    entries = BY_FILE[filename]
    project = restored(store, filename)
    imported = {(g["source"].get("native") or {}).get("id"): g for g in project["groups"]}
    project = command(store, project, "add_references", library_ids=[e["id"] for e in entries])
    added = {g["source"]["reference_library"]["group"]: g
             for g in project["groups"] if g["source"].get("reference_library")}

    for entry in entries:
        want, got = imported[entry["group"]], added[entry["group"]]
        assert got["parameters"] == want["parameters"], entry["id"]
        assert got["result"]["effective"]["step"] == want["result"]["effective"]["step"], entry["id"]
        for field in ("energy", "norm", "flat"):
            np.testing.assert_array_equal(got["result"]["arrays"][field],
                                          want["result"]["arrays"][field], err_msg=entry["id"])


def test_manifest_entries_are_unique_and_describe_a_real_record():
    """A typo in the manifest must fail here, not at the end of a user's fit."""
    assert len({entry["id"] for entry in REFERENCES}) == len(REFERENCES)
    assert sum(family["count"] for family in families()) == len(REFERENCES)
    for entry in REFERENCES:
        spectrum = reference_spectrum(entry)
        assert spectrum["energy"].shape == spectrum["mu"].shape
        assert spectrum["energy"].size > 50
        assert np.all(np.diff(spectrum["energy"]) > 0), entry["id"]


def test_catalogue_selects_one_family_and_find_rejects_an_unknown_id():
    assert find("no-such-standard") is None
    arsenic = catalogue("as", "k")
    assert arsenic and all(e["element"] == "As" and e["edge"] == "K" for e in arsenic)
    assert len(arsenic) < len(catalogue())


def test_suggestions_rank_the_arsenate_standard_first_for_an_arsenate_sample(store):
    """The science check: a known As(V)-bearing sample must pick the As(V) standard.

    YLO2_a_1 is a weathered mine-tailing sample whose arsenic is overwhelmingly
    arsenate. If the ranking were driven by normalization or by the window
    rather than by XANES shape, the reduced standards would not be left an order
    of magnitude behind.
    """
    project = restored(store, "xafsdata/AthenaProjectFiles/AsKa.prj")
    unknown = next(g for g in project["groups"] if g["label"] == "YLO2_a_1_AsKa.mrg")
    result = store.analyze(project["id"], Command(
        version=project["version"], action="lcf_suggest",
        group_ids=[unknown["id"]], options={"array": "norm"}))["result"]

    assert (result["element"], result["edge"]) == ("As", "K")
    assert result["unusable"] == [] and result["skipped"] == []
    assert [s["oxidation_state"] for s in result["suggestions"]][0] == "As(V)"
    best, *rest = result["suggestions"]
    assert best["rfactor"] < 0.02
    assert min(s["rfactor"] for s in rest) > 10 * best["rfactor"]
    # Athena's XANES default window, not the full EXAFS range of the unknown.
    assert (result["xmin"], result["xmax"]) == pytest.approx((11851.5, 11951.5))


def test_suggested_standards_can_be_added_and_fitted_as_a_combination(store):
    """The demo path end to end: suggest, add, then search combinations."""
    project = restored(store, "xafsdata/AthenaProjectFiles/AsKa.prj")
    unknown = next(g for g in project["groups"] if g["label"] == "YLO2_a_1_AsKa.mrg")
    suggestions = analyze(store, project, "lcf_suggest", [unknown["id"]], array="norm")["result"]

    project = command(store, project, "add_references",
                      library_ids=[s["id"] for s in suggestions["suggestions"]])
    standards = [g for g in project["groups"] if g["source"].get("reference_library")]
    assert len(standards) == 3
    folder = next(f for f in project["group_folders"] if f["name"] == "Reference library")
    assert folder["group_ids"] == [g["id"] for g in standards]

    search = analyze(store, project, "lcf_search", [unknown["id"], *[g["id"] for g in standards]],
                     array="norm", xmin=suggestions["xmin"], xmax=suggestions["xmax"],
                     max_components=3)["result"]
    best = search["combinations"][0]
    assert best["rfactor"] < 0.01
    assert search["labels"][best["indices"][np.argmax(best["weights"])]] == "Kankite"
    assert sum(best["weights"]) == pytest.approx(1.0)


def test_adding_the_same_standard_twice_is_refused_rather_than_duplicated(store):
    """Two copies of one standard make the combination fit singular."""
    project = restored(store, "xafsdata/AthenaProjectFiles/AsKa.prj")
    project = command(store, project, "add_references", library_ids=["as-k-kankite"])
    with pytest.raises(WebInputError):
        command(store, project, "add_references", library_ids=["as-k-kankite"])
    with pytest.raises(WebInputError):
        command(store, project, "add_references", library_ids=["as-k-tungstate"])


def test_suggestions_refuse_a_question_the_library_cannot_answer(store):
    """Each refusal says which input was wrong, instead of ranking nothing."""
    project = restored(store, "xafsdata/AthenaProjectFiles/Mn_all.prj")
    unknown = project["groups"][0]
    with pytest.raises(WebInputError, match="no Fe K-edge standards"):
        analyze(store, project, "lcf_suggest", [unknown["id"]], array="norm",
                element="Fe", edge="K")
    with pytest.raises(WebInputError, match="exactly one group"):
        analyze(store, project, "lcf_suggest", [g["id"] for g in project["groups"][:2]])
    with pytest.raises(WebInputError, match="XANES against energy"):
        analyze(store, project, "lcf_suggest", [unknown["id"]], array="chi")


def test_a_standard_outside_the_window_is_skipped_rather_than_failing_the_ranking():
    """One XANES-only standard must not sink a ranking over an EXAFS window."""
    energy = np.linspace(11850.0, 12400.0, 551)
    target = (energy, np.tanh((energy - 11870.0) / 5.0))
    short = energy[:120]
    candidates = [(dict(find("as-k-kankite")), short, np.tanh((short - 11870.0) / 5.0)),
                  (dict(find("as-k-elemental")), energy, target[1])]
    ranked = rank_references(target, candidates, 11860.0, 12300.0)
    assert [s["id"] for s in ranked["suggestions"]] == ["as-k-elemental"]
    assert [s["id"] for s in ranked["skipped"]] == ["as-k-kankite"]
    assert ranked["considered"] == 2


def test_a_manifest_entry_naming_a_missing_record_fails_loudly():
    broken = {**find("as-k-kankite"), "group": "nope"}
    with pytest.raises(ScientificError, match="does not contain"):
        reference_spectrum(broken)
    with pytest.raises(ScientificError, match="not in this installation"):
        reference_spectrum({**broken, "file": "nowhere.prj", "group": "wrha"})
