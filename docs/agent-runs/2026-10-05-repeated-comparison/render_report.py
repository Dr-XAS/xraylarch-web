"""Render the observed counts and metrics without converting n=3 into reliability claims."""
import json
from pathlib import Path

BASE = Path(__file__).resolve().parent
result = json.loads((BASE / "results.json").read_text())
rows = result["runs"]
summary = result["summaries"]
completed = sum(r["status"] == "completed" for r in rows)
failed = sum(r["status"] == "failed" for r in rows)
served = sorted({r["provider_metadata"]["provider_model_id"] for r in rows if r.get("provider_metadata")})
lines = ["# Repeated native/app comparison", "",
    f"Three fixed attempts per task and arm produced {completed} completed and {failed} failed attempts out of 30. "
    "Every launched attempt is retained. These are observed counts for this copper fixture and these configured agent systems; three attempts do not establish population reliability or a general model ranking.", "",
    "The explicit model alias was `gpt56luna`; recorded served identity: " + ", ".join(f"`{s}`" for s in served) + ". "
    "Native Dr.XAS source is `19a0dfc90ff1a843f1b35c60a2cc3f1c574689ff`; app source is `7f82058f312d2e7f48df64a0f38dfdcfc0c7cbe7`. "
    "The frozen measured fixture, prompts, guides and scientific tolerances were not revised after answers were seen.", "",
    "The failed repeat-1 app T5 attempt requested `/api/artemis/examples/cuprite`, which its guide advertised but the frozen evaluator boundary did not allow. "
    "The tool raised `ValueError`, ending the SDK attempt with `UserError` before a fit or final answer. Its 4,317 input and 152 output tokens remain in the metrics. "
    "This is an interface/evaluator failure; it supplies no wrong fitted distance. There was no replacement attempt.", "",
    "Repeat-3 app T5 failed for a different reason: the model put the label `10 K` into a digest route that requires a group ID, before reading its project response. "
    "The boundary rejected that path and the evaluator ended the attempt. Its 4,314 input and 179 output tokens remain in the metrics. "
    "Both failures happened before any fit or final answer.", "",
    "Repeat-3 native T4 also failed its answer rubric: it said a prior cut was needed, although its direct merge correctly included all three scans and ended at 10134.32 eV. "
    "Its state and scientific checks pass; the incorrect explanation remains an answer failure.", "",
    "## Observed task outcomes", "",
    "Each entry is passes out of three. Full state adds T3's unchanged kmin and other-spectrum parameters to the frozen checker. "
    "Science uses absolute task bounds, separately from cross-arm agreement. Answer grades are an independent read-only review against the literal rubric. "
    "Combined requires all three; unchanged state alone cannot pass a fit task. The frozen checker passes all 30 attempts, full state/science pass 28, and combined success is 27.", "",
    "| Task | Arm | Frozen state | Full state | Science | Answer | Combined |",
    "|---|---|---:|---:|---:|---:|---:|"]
for row in summary:
    lines.append(f"| {row['task']} | {row['arm']} | {row['frozen_state_passes']}/3 | {row['task_state']['pass']}/3 | {row['scientific']['pass']}/3 | {row['answer']['pass']}/3 | {row['combined']['pass']}/3 |")
lines += ["", "## Numerical observations", "",
    "Ranges below cover observed values only; missing fit evidence is excluded and its task failure remains in the table above. "
    "Different valid kmax choices are recorded without treating them as scientific failures. Fit recipes, uncertainties and all later fits remain in `results.json`; "
    "the selected fit is the first chronological qualifying request, never whichever result agrees best.", "",
    "| Task / quantity | Native observed range | App observed range |", "|---|---|---|"]
quantities = [("T2", "Cu foil · 50 K.alignment_shift_ev", "50 K alignment (eV)"),
              ("T2", "Cu foil · 300 K.alignment_shift_ev", "300 K alignment (eV)"),
              ("T3", "kmin", "kmin (Å⁻¹)"), ("T3", "kmax", "kmax (Å⁻¹)"),
              ("T3", "r_peak", "uncorrected peak (Å)"), ("T4", "merged_energy_max_ev", "merged end (eV)"),
              ("T5", "r", "first fitted Cu–Cu distance (Å)"), ("T5", "stderr", "selected fit stderr (Å)"),
              ("T5", "sigma2", "selected fit sigma2 (Å²)")]
for task, key, label in quantities:
    cells = []
    for arm in ("native", "app"):
        row = next(r for r in summary if r["task"] == task and r["arm"] == arm)
        value = row["numeric_ranges"].get(key, {"n": 0})
        cells.append(f"{value['min']:.6g}–{value['max']:.6g} (n={value['n']})" if value["n"] else "missing (n=0)")
    lines.append(f"| {task}: {label} | {cells[0]} | {cells[1]} |")
lines += ["", "## Actual usage and time", "",
    "Medians use provider SDK usage, including repeated context. API response bytes are a separate interface measure. "
    "Agent time is available only for completed attempts; process time includes startup and retained failure time from original coordinator timestamps. "
    "App T5 token/time medians include two early failures and must not be interpreted as successful-fit efficiency. "
    "Each cell shows its observed sample count. Host/provider load and the recovery order affect timing.", "",
    "| Task | Arm | Input tokens | Output tokens | Agent seconds | Process seconds |",
    "|---|---|---:|---:|---:|---:|"]
for row in summary:
    cells = []
    for key in ("input_tokens", "output_tokens", "agent_wall_seconds", "process_wall_seconds"):
        metric = row["metrics"][key]
        cells.append(f"{metric['median']:,.1f} (n={metric['n']})" if metric["median"] is not None else "missing")
    lines.append(f"| {row['task']} | {row['arm']} | " + " | ".join(cells) + " |")
overlap = sum((r.get("max_outstanding_tool_calls") or 0) > 1 for r in rows)
lines += ["", "## Execution and interpretation limits", "",
    "The preregistered order alternated the first arm across repeats and tasks. The initial app archive lacked generated `larch/_version.py`, so app setup stopped before model calls. "
    "Six native attempts had already run. They were retained; setuptools_scm generated metadata for the exact app source pin, and a zero-model-call preflight confirmed all five measurements. "
    "Only unstarted arms resumed. A later coordinator `KeyError` occurred after app T2 had finished; its answer and timestamps were retained, with the frozen state result recovered from its exact report header. "
    "`source-verification.json` checks all 3,232 native and 2,230 app archived files byte-for-byte; the sole non-bytecode app addition is generated `_version.py`. "
    "These interruptions broke the intended ordering balance. `schedule.json`, nested `recovery.json`, `preflight.json`, and `runtime-provenance.json` preserve the history. "
    "The shipped runners now stop on setup failure and handle the missing manifest key; regression tests cover both failures and retaining completed/failed attempts.", "",
    f"`parallel_tool_calls=false` was the requested SDK setting, but {overlap} attempts have overlapping recorded tool calls. "
    "Aggregation joins `tool_result.call_seq` to `tool_call.seq`, retaining request-start order, rather than pairing adjacent HTTP events. "
    "A regression test reverses result order. The earlier comparison files remain unchanged.", "",
    "Literal answer passes can still contain unsupported claims. Recurring caveats include treating a suggested kmax as a hard usable-data cutoff, "
    "attributing temperature/unaligned differences to defective scans, and presenting practical uncertainty judgements as if measured. "
    "Two app T4 answers overstated shared-range behavior at the lower endpoint; the third explicitly disclosed one-point extrapolation. "
    "The per-answer reasons and caveats are preserved in `answer-grades.json`; numerical tolerances do not grade those extra claims.", "",
    "## Reproduce the aggregation", "", "```sh",
    "python aggregate.py", "python render_report.py",
    "python -m unittest discover -s . -p 'test_*.py'", "```", "",
    "Run those commands from this directory with Python and httpx available. Source runs use `run_repeats.py`; `recover_setup.py` resumes only unstarted arms. "
    "`export_evidence.py` copies named evidence files, excluding databases, payload stores, sessions, raw logs and credentials. "
    "Fresh model runs require the same pinned source archives, frozen fixture, generated app version metadata, private Python environment and configured provider credentials. "
    "Scientific HTTP replay validation is reported separately in `../2026-10-05-artemis-replay/`.", ""]
(BASE / "README.md").write_text("\n".join(lines))
