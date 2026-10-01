"""The command line, exercised against the real app rather than a mock.

TestClient is an httpx.Client bound to the ASGI app, so these run the actual
routes without a listening port. Mocking the HTTP layer here would test only
that the CLI can format a dict it was handed, which is not the part that breaks.
"""
import json
import re

import pytest
from fastapi.testclient import TestClient

from xraylarch_web import larchctl
from xraylarch_web.config import Settings
from xraylarch_web.main import create_app
from tests.test_agent_views import numeric_runs


@pytest.fixture
def http(tmp_path):
    with TestClient(create_app(Settings(data_root=tmp_path))) as client:
        yield client


@pytest.fixture
def run(http, capsys):
    """Run one command; return its stdout, and fail the test on a nonzero exit."""
    def invoke(*argv, expect=0):
        capsys.readouterr()
        code = larchctl.main(list(argv), http=http)
        captured = capsys.readouterr()
        assert code == expect, f"exit {code}: {captured.err or captured.out}"
        return captured.err if expect else captured.out
    return invoke


@pytest.fixture
def project(run):
    """A project holding the copper series, named by id."""
    return run("new", "--name", "Copper").splitlines()[0]


def test_a_whole_session_runs_from_the_command_line(run, project):
    run("--project", project, "do", "example")

    summary = run("--project", project, "summary")
    assert "Copper" in summary
    assert summary.count("Cu foil") == 3
    assert "Cu₂O" in summary
    assert "4 groups · 4 processed · 0 failed" in summary

    digest = run("--project", project, "digest", "10 K")
    assert "Cu K" in digest
    assert "|chi(R)| peaks" in digest
    assert "Not bond lengths" in digest


def test_a_group_is_named_by_label_and_ambiguity_is_refused(run, project):
    run("--project", project, "do", "example")

    assert "10 K" in run("--project", project, "digest", "10 K")

    ambiguous = run("--project", project, "digest", "Cu foil", expect=1)
    assert "matches several groups" in ambiguous
    assert "Use an id" in ambiguous

    missing = run("--project", project, "digest", "Nickel", expect=1)
    assert "No group matches" in missing
    assert "Cu foil" in missing, "say what is there, not only what is not"


def test_a_preview_reports_its_shape_instead_of_its_curves(run, project):
    """The whole point of this layer is not to paste arrays into a context."""
    run("--project", project, "do", "example")
    output = run("--project", project, "do", "merge", "10 K", "50 K",
                 "-o", "method=demeter-larch", "--preview")

    assert len(output) < 10_000, "a preview must not cost what the arrays cost"
    assert "numbers," in output, "the elision has to be visible"
    assert not [path for path, length in numeric_runs(json.loads(output)) if length > 8]

    # The project must be untouched: preview means preview.
    assert "4 groups" in run("--project", project, "summary")


def test_the_project_is_changed_and_the_change_is_reported(run, project):
    run("--project", project, "do", "example")
    output = run("--project", project, "do", "parameters", "10 K",
                 "-o", "kmax=12", "-o", "kweight=3")
    before, after = re.search(r"version (\d+) -> (\d+)", output).groups()
    assert int(after) == int(before) + 1

    digest = run("--project", project, "digest", "10 K")
    assert "kmax=12.000" in digest
    assert "kweight=3.000" in digest


def test_a_resolved_value_is_distinguished_from_a_requested_one(run, project):
    """auto->x and x are different facts and must not read the same."""
    run("--project", project, "do", "example")
    digest = run("--project", project, "digest", "10 K")
    assert "bkg_kmax=auto->" in digest, "nothing was asked for; Larch chose"
    assert "kmin=3.000" in digest, "this one was asked for and honoured"


def test_a_misremembered_action_is_named_as_the_problem(run, project):
    """/command blames the selection first, which sends a caller the wrong way."""
    run("--project", project, "do", "example")
    message = run("--project", project, "do", "sharpen", "10 K", expect=1)
    assert "no 'sharpen' action" in message
    assert "larchctl describe" in message


def test_describe_lists_actions_then_explains_one(run):
    listing = run("describe")
    assert "merge" in listing and "set_e0" in listing
    assert len(listing) < 6_000

    detail = run("describe", "merge")
    assert "two or more" in detail.casefold()
    assert "weightby" in detail
    assert "preview" in detail


def test_json_gives_the_untouched_response(run, project):
    run("--project", project, "do", "example")
    payload = json.loads(run("--project", project, "--json", "summary"))
    assert payload["counts"]["groups"] == 4
    assert "groups" in payload


@pytest.mark.parametrize("text,expected", [
    ("kmax=12", ("kmax", 12)),
    ("kmax=12.5", ("kmax", 12.5)),
    ("flatten=true", ("flatten", True)),
    ("e0=null", ("e0", None)),
    ("window=hanning", ("window", "hanning")),
    ("ids=[\"a\",\"b\"]", ("ids", ["a", "b"])),
    ("label=Cu foil = merged", ("label", "Cu foil = merged")),
])
def test_options_are_typed_so_strict_validators_accept_them(text, expected):
    """Pydantic runs strict here, so '12' and 12 are not interchangeable."""
    assert larchctl.parse_option(text) == expected


def test_an_option_without_a_value_says_so():
    with pytest.raises(larchctl.Failed, match="key=value"):
        larchctl.parse_option("kmax")


@pytest.mark.parametrize("value,kept", [
    ([1, 2, 3], True),
    (["a"] * 20, True),
    ([1.0] * 20, False),
    ([1, 2, "x"] * 20, True),
    ([True] * 20, True),
])
def test_elision_only_removes_runs_of_numbers(value, kept):
    """Booleans and strings are settings; only measured runs are dropped."""
    result = larchctl.elide_arrays({"v": value})["v"]
    assert (result == value) is kept


def test_a_project_is_required_before_anything_reads_one(run):
    message = run("summary", expect=1)
    assert "--project" in message and "larchctl new" in message


def test_an_unreachable_backend_is_reported_as_one(capsys):
    """The default base is a loopback port that is usually not listening."""
    code = larchctl.main(["--base", "http://127.0.0.1:1", "projects"])
    assert code == 1
    assert "Could not reach the backend" in capsys.readouterr().err


def test_the_log_shows_what_was_tried_including_what_failed(run, project):
    run("--project", project, "do", "example")
    run("--project", project, "do", "merge", "10 K", "50 K")
    run("--project", project, "do", "sharpen", "10 K", expect=1)
    run("--project", project, "do", "parameters", "10 K", "-o", "kmax=12")

    log = run("--project", project, "log")
    # Five, not four: `larchctl new --name` names the project with a command
    # of its own, and the transcript records that as faithfully as the rest.
    assert "5 records" in log
    assert "merge [Cu foil · 10 K, Cu foil · 50 K]" in log
    assert "+Merge · 2 groups" in log
    # The failure is the line worth keeping: a caller reading this back is
    # trying to remember what did not work.
    assert "FAILED athena_invalid: Unknown processing operation." in log
    assert "parameters [Cu foil · 10 K]  kmax=12" in log


def test_a_keyed_retry_reports_that_nothing_ran_again(run, project):
    run("--project", project, "do", "example")
    run("--project", project, "do", "parameters", "10 K", "-o", "kmax=12", "--key", "t1")
    again = run("--project", project, "do", "parameters", "10 K", "-o", "kmax=12", "--key", "t1")
    assert "already ran under this key" in again
    assert "not run again" in run("--project", project, "log")


def test_since_asks_only_for_the_part_not_already_read(run, project):
    run("--project", project, "do", "example")
    run("--project", project, "do", "merge", "10 K", "50 K")
    assert "1 records" in run("--project", project, "log", "--since", "2")


def test_json_does_not_undo_the_elision_a_preview_depends_on(run, project):
    """--json used to be the one way to get 170 KB of curves by accident."""
    run("--project", project, "do", "example")
    argv = ("--project", project, "do", "merge", "10 K", "50 K",
            "-o", "method=demeter-larch", "--preview")

    elided = run(*argv, "--json")
    assert len(elided) < 10_000
    assert "numbers," in elided
    assert not [path for path, length in numeric_runs(json.loads(elided)) if length > 8]

    # The arrays are still reachable, but only by asking for them.
    whole = run(*argv, "--json", "--arrays")
    assert len(whole) > 10 * len(elided)
    assert [path for path, length in numeric_runs(json.loads(whole)) if length > 8]


def test_the_summary_table_shows_the_shift_an_alignment_leaves(run, project):
    """E0 does not move on an alignment, so without this the table is unchanged."""
    run("--project", project, "do", "example")
    summary = run("--project", project, "summary")
    assert "SHIFT" in summary

    standard = json.loads(run("--project", project, "--json", "summary"))
    standard_id = next(g["id"] for g in standard["groups"] if "10 K" in g["label"])
    run("--project", project, "do", "align", "300 K", "-o", "method=demeter-larch",
        "-o", f"standard_id={standard_id}", "-o", "operation=auto")

    row = [line for line in run("--project", project, "summary").splitlines()
           if "300 K" in line][0]
    assert "8980.50" in row, "E0 is exactly what an alignment does not move"
    assert "-2.9" in row, "and the shift is the only sign that it happened"


def test_the_digest_says_where_chi_stops_being_signal(run, project):
    run("--project", project, "do", "example")
    digest = run("--project", project, "digest", "10 K")

    assert "chi/noise by k:" in digest
    assert "3-5:" in digest and "23-25:" in digest
    assert "a window near 1 is noise" in digest


def test_export_writes_a_file_rather_than_a_context_window(run, project, tmp_path):
    run("--project", project, "do", "example")
    destination = tmp_path / "chi.csv"

    report = run("--project", project, "export", "10 K",
                 "--space", "k", "--out", str(destination))
    assert f"wrote {destination}" in report
    assert len(report) < 200, "the point is that the numbers do not come back here"

    body = destination.read_text()
    assert body.splitlines()[0].startswith("k,chi")
    assert len(body.splitlines()) > 100

    # The body is still reachable on demand, and --json does not swallow it.
    piped = run("--project", project, "export", "10 K",
                "--space", "k", "--out", "-", "--json")
    assert piped.rstrip().splitlines() == body.rstrip().splitlines()


def test_a_preview_is_recorded_even_when_it_is_refused(run, project):
    """The rejections in the preview path used to leave no trace at all."""
    run("--project", project, "do", "example")
    standard = json.loads(run("--project", project, "--json", "summary"))
    standard_id = next(g["id"] for g in standard["groups"] if "10 K" in g["label"])

    # operation='inspect' refuses a two-group selection; 'auto' takes it.
    run("--project", project, "do", "align", "50 K", "300 K",
        "-o", f"standard_id={standard_id}", "-o", "operation=inspect",
        "--preview", expect=1)
    run("--project", project, "do", "align", "50 K", "300 K",
        "-o", f"standard_id={standard_id}", "-o", "operation=auto", "--preview")

    log = run("--project", project, "log")
    assert log.count("align (preview)") == 2
    assert "FAILED athena_invalid: Inspect or manually shift one current group" in log
    assert "nothing saved" in log
    assert "4 groups" in run("--project", project, "summary"), "a preview saves nothing"


@pytest.fixture
def wire(http):
    """Bytes the backend sent, which is what an arm pays whether or not it prints them."""
    sizes = []

    def measure(response):
        response.read()
        sizes.append(len(response.content))
    http.event_hooks["response"].append(measure)
    return sizes


def test_a_command_does_not_fetch_the_project_it_is_about_to_discard(run, project, wire):
    run("--project", project, "do", "example")
    wire.clear()
    run("--project", project, "do", "parameters", "10 K", "-o", "kmax=18")
    # One summary to learn the version, one summary back from /command.
    assert sum(wire) < 10_000, wire

    wire.clear()
    run("--project", project, "do", "merge", "10 K", "50 K",
        "-o", "method=demeter-larch", "--preview")
    assert sum(wire) < 20_000, wire


def test_a_merge_names_what_it_left_out(run, project):
    run("--project", project, "do", "example")
    result = run("--project", project, "do", "merge", "10 K", "50 K", "300 K",
                 "-o", "method=demeter-larch")
    assert "from Cu foil · 10 K, Cu foil · 50 K" in result
    assert "EXCLUDED Cu foil · 300 K: More than 10 points shorter" in result

    summary = run("--project", project, "summary")
    assert "merge of 2,1 EXCLUDED" in summary
