# Repeated native/app comparison

Three fixed attempts per task and arm produced 28 completed and 2 failed attempts out of 30. Every launched attempt is retained. These are observed counts for this copper fixture and these configured agent systems; three attempts do not establish population reliability or a general model ranking.

The explicit model alias was `gpt56luna`; recorded served identity: `gpt-5.6-luna-2026-07-09`. Native Dr.XAS source is `19a0dfc90ff1a843f1b35c60a2cc3f1c574689ff`; app source is `7f82058f312d2e7f48df64a0f38dfdcfc0c7cbe7`. The frozen measured fixture, prompts, guides and scientific tolerances were not revised after answers were seen.

The failed repeat-1 app T5 attempt requested `/api/artemis/examples/cuprite`, which its guide advertised but the frozen evaluator boundary did not allow. The tool raised `ValueError`, ending the SDK attempt with `UserError` before a fit or final answer. Its 4,317 input and 152 output tokens remain in the metrics. This is an interface/evaluator failure; it supplies no wrong fitted distance. There was no replacement attempt.

Repeat-3 app T5 failed for a different reason: the model put the label `10 K` into a digest route that requires a group ID, before reading its project response. The boundary rejected that path and the evaluator ended the attempt. Its 4,314 input and 179 output tokens remain in the metrics. Both failures happened before any fit or final answer.

Repeat-3 native T4 also failed its answer rubric: it said a prior cut was needed, although its direct merge correctly included all three scans and ended at 10134.32 eV. Its state and scientific checks pass; the incorrect explanation remains an answer failure.

## Observed task outcomes

Each entry is passes out of three. Full state adds T3's unchanged kmin and other-spectrum parameters to the frozen checker. Science uses absolute task bounds, separately from cross-arm agreement. Answer grades are an independent read-only review against the literal rubric. Combined requires all three; unchanged state alone cannot pass a fit task. The frozen checker passes all 30 attempts, full state/science pass 28, and combined success is 27.

| Task | Arm | Frozen state | Full state | Science | Answer | Combined |
|---|---|---:|---:|---:|---:|---:|
| T1 | native | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| T1 | app | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| T2 | native | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| T2 | app | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| T3 | native | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| T3 | app | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| T4 | native | 3/3 | 3/3 | 3/3 | 2/3 | 2/3 |
| T4 | app | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| T5 | native | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| T5 | app | 3/3 | 1/3 | 1/3 | 1/3 | 1/3 |

## Numerical observations

Ranges below cover observed values only; missing fit evidence is excluded and its task failure remains in the table above. Different valid kmax choices are recorded without treating them as scientific failures. Fit recipes, uncertainties and all later fits remain in `results.json`; the selected fit is the first chronological qualifying request, never whichever result agrees best.

| Task / quantity | Native observed range | App observed range |
|---|---|---|
| T2: 50 K alignment (eV) | -0.00745527–-0.00745527 (n=3) | -0.018–-0.018 (n=3) |
| T2: 300 K alignment (eV) | -2.97728–-2.97728 (n=3) | -2.959–-2.959 (n=3) |
| T3: kmin (Å⁻¹) | 3–3 (n=3) | 3–3 (n=3) |
| T3: kmax (Å⁻¹) | 14.6–14.6 (n=3) | 18–18 (n=3) |
| T3: uncorrected peak (Å) | 2.27029–2.27029 (n=3) | 2.27–2.27 (n=3) |
| T4: merged end (eV) | 10134.3–10134.3 (n=3) | 10139.2–10139.2 (n=3) |
| T5: first fitted Cu–Cu distance (Å) | 2.55208–2.55208 (n=3) | 2.549–2.549 (n=1) |
| T5: selected fit stderr (Å) | 0.00131062–0.00131062 (n=3) | 0.00149496–0.00149496 (n=1) |
| T5: selected fit sigma2 (Å²) | 0.00428952–0.00428952 (n=3) | 0.00359697–0.00359697 (n=1) |

## Actual usage and time

Medians use provider SDK usage, including repeated context. API response bytes are a separate interface measure. Agent time is available only for completed attempts; process time includes startup and retained failure time from original coordinator timestamps. App T5 token/time medians include two early failures and must not be interpreted as successful-fit efficiency. Each cell shows its observed sample count. Host/provider load and the recovery order affect timing.

| Task | Arm | Input tokens | Output tokens | Agent seconds | Process seconds |
|---|---|---:|---:|---:|---:|
| T1 | native | 42,220.0 (n=3) | 764.0 (n=3) | 8.2 (n=3) | 20.9 (n=3) |
| T1 | app | 16,737.0 (n=3) | 844.0 (n=3) | 9.2 (n=3) | 19.8 (n=3) |
| T2 | native | 66,715.0 (n=3) | 1,096.0 (n=3) | 10.0 (n=3) | 21.6 (n=3) |
| T2 | app | 117,383.0 (n=3) | 1,890.0 (n=3) | 20.6 (n=3) | 30.8 (n=3) |
| T3 | native | 62,372.0 (n=3) | 419.0 (n=3) | 7.0 (n=3) | 20.1 (n=3) |
| T3 | app | 51,645.0 (n=3) | 781.0 (n=3) | 10.9 (n=3) | 21.7 (n=3) |
| T4 | native | 40,700.0 (n=3) | 333.0 (n=3) | 4.6 (n=3) | 17.1 (n=3) |
| T4 | app | 29,474.0 (n=3) | 840.0 (n=3) | 9.1 (n=3) | 19.4 (n=3) |
| T5 | native | 42,212.0 (n=3) | 701.0 (n=3) | 10.2 (n=3) | 21.9 (n=3) |
| T5 | app | 4,317.0 (n=3) | 179.0 (n=3) | 21.3 (n=1) | 13.3 (n=3) |

## Execution and interpretation limits

The preregistered order alternated the first arm across repeats and tasks. The initial app archive lacked generated `larch/_version.py`, so app setup stopped before model calls. Six native attempts had already run. They were retained; setuptools_scm generated metadata for the exact app source pin, and a zero-model-call preflight confirmed all five measurements. Only unstarted arms resumed. A later coordinator `KeyError` occurred after app T2 had finished; its answer and timestamps were retained, with the frozen state result recovered from its exact report header. `source-verification.json` checks all 3,232 native and 2,230 app archived files byte-for-byte; the sole non-bytecode app addition is generated `_version.py`. These interruptions broke the intended ordering balance. `schedule.json`, nested `recovery.json`, `preflight.json`, and `runtime-provenance.json` preserve the history. The shipped runners now stop on setup failure and handle the missing manifest key; regression tests cover both failures and retaining completed/failed attempts.

`parallel_tool_calls=false` was the requested SDK setting, but 13 attempts have overlapping recorded tool calls. Aggregation joins `tool_result.call_seq` to `tool_call.seq`, retaining request-start order, rather than pairing adjacent HTTP events. A regression test reverses result order. The earlier comparison files remain unchanged.

Literal answer passes can still contain unsupported claims. Recurring caveats include treating a suggested kmax as a hard usable-data cutoff, attributing temperature/unaligned differences to defective scans, and presenting practical uncertainty judgements as if measured. Two app T4 answers overstated shared-range behavior at the lower endpoint; the third explicitly disclosed one-point extrapolation. The per-answer reasons and caveats are preserved in `answer-grades.json`; numerical tolerances do not grade those extra claims.

## Reproduce the aggregation

```sh
python aggregate.py
python render_report.py
python -m unittest discover -s . -p 'test_*.py'
```

Run those commands from this directory with Python and httpx available. Source runs use `run_repeats.py`; `recover_setup.py` resumes only unstarted arms. `export_evidence.py` copies named evidence files, excluding databases, payload stores, sessions, raw logs and credentials. Fresh model runs require the same pinned source archives, frozen fixture, generated app version metadata, private Python environment and configured provider credentials. Scientific HTTP replay validation is reported separately in `../2026-10-05-artemis-replay/`.
