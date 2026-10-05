# Ninth agent-interface run, October 5, 2026

All ten arms passed their project-state checks. All ten command transcripts replayed
onto fresh projects and reproduced the final summary and effective parameters within
the comparison tolerances. No API request failed and no command was rejected.

The strict answer grade is nine of ten. CLI T1 correctly described the 300 K scan's
differences, but supplied an alignment correction and k endpoints instead of the
E0 difference or energy endpoints named in the published rubric. Its answer contains
no identified false statement. We kept the omission as a failure without changing
the rubric, editing the answer, or rerunning the arm.

| Arm | State | Answer | Requests | Response bytes | Wall seconds |
|---|---|---|---:|---:|---:|
| CLI T1 | pass | fail | 9 | 28,074 | 33.8 |
| HTTP T1 | pass | pass | 5 | 15,546 | 31.9 |
| CLI T2 | pass | pass | 17 | 53,555 | 48.2 |
| HTTP T2 | pass | pass | 10 | 32,658 | 39.0 |
| CLI T3 | pass | pass | 26 | 65,716 | 41.4 |
| HTTP T3 | pass | pass | 16 | 52,183 | 64.1 |
| CLI T4 | pass | pass | 7 | 23,150 | 29.0 |
| HTTP T4 | pass | pass | 5 | 18,552 | 24.8 |
| CLI T5 | pass | pass | 20 | 51,382 | 45.3 |
| HTTP T5 | pass | pass | 16 | 47,090 | 55.1 |

Both T2 arms unlinked, aligned and merged all three foils, reporting the original
edge-step spread of 0.439816. Both T3 arms saved kmax 18 and distinguished the
uncorrected 2.27 Å peak from a fitted bond distance. They again performed FEFF fits
beyond the requested transform change. Both T4 arms merged all three as μ without
truncation or alignment and reported the actual endpoint, 10134.32 eV. Both T5 arms
fitted 2.5489 Å and used energy-offset sensitivity to support a practical ±0.02 Å
estimate rather than treating the formal standard error as absolute accuracy.

## Protocol and limits

Code revision: `2569bd0d9`, branch `fix/flaky-frontend-tests`. The relevant agent
regression set passed 133 tests before capture.

Each arm used a fresh Codex subagent with no conversation fork, an isolated backend
and data root, and a new five-group example project. Its task-specific context was
only the task prompt, operating guide, connection and interface restrictions. CLI
arms used `larchctl`; HTTP arms used direct HTTP. Agents could recover from errors,
but could not inspect source, tests, other arms, grading rules or prior results.
They wrote `started.json` before API use and `answer.md` as their last action.

The model and agent protocol differ from run eight's Claude CLI setup. The
collaboration tool did not expose an exact model identifier, token totals or cost;
none are inferred. This is a new baseline, not a controlled model comparison.
Wall time includes the arm's work after its start marker and at most the capture
polling delay before its finish stamp. Setup, final snapshots and verification
requests are excluded from request and byte totals.

Replay reproduces successful project commands. It does not rerun read-only FEFF
calculations or fits, and the final-state comparison does not compare arrays.
`evidence.jsonl` retains the fit request bodies and replies for answer review.
Backend data roots remain local; captured connection URLs are historical, and the
capture script stopped its backend processes after verification.

## Saved artifacts

Each arm directory holds its original prompt, operating guide, answer, command
transcript, request meter, API evidence, final `run.json`, replay snapshot and check
reports. API evidence includes bodies but no request headers. `answer-grades.json`
records coordinator and independent-reviewer grading; `integrity.json` records the
artifact checks. `manifest.json` records the code revision and protocol.

To compare the saved snapshots without a running backend, from the repository root:

```sh
PYTHONPATH=backend backend/.venv/bin/python -m xraylarch_web.agent_suite diff \
  docs/agent-runs/2026-10-05/cli-t2/run.json \
  docs/agent-runs/2026-10-05/cli-t2/replay.json
```

To replay on a running scratch backend, use a new output file outside this baseline:

```sh
PYTHONPATH=backend backend/.venv/bin/python -m xraylarch_web.agent_suite \
  --url http://127.0.0.1:8006 replay \
  docs/agent-runs/2026-10-05/cli-t2/transcript.jsonl --out /tmp/replayed-t2.json
```

`capture.py` records a new pair of arms when copied to a new run directory. It
prints their connection details and waits for the coordinator to launch fresh
agents. It refuses existing arm directories, preserving the original evidence.
