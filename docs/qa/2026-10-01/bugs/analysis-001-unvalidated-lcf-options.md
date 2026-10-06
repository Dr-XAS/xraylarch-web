# LCF accepts malformed constraints and silently fits a different model

Severity: P3, API correctness. Confirmed on the deployed app. Normal UI requests with proper boolean values pass.

Status: fixed by PR #12 (`726a0fb25`), merged October 5, 2026; not yet deployed. LCF, PCA and peak fitting refuse unknown option names, and the LCF constraints must be JSON booleans.

Target: http://drxas.xray.aps.anl.gov:3004
Deployed revision: 881d526f62d72f05f6fdaa8bfb879baee89acd55
Test date: 2026-10-01
Project: `1b6vtAzlPvUJK02WCxzoBmpI`, `QA 2026-10-01 Analyses controlled mixtures`, version 10.

A linear combination request accepts `"sum_to_one": "false"` as HTTP 200 but applies the sum-to-one constraint. It also accepts `"nonnegative": "false"` and applies nonnegativity. Unknown constraint names such as `sum_to_1` are silently ignored. The saved analysis records the submitted option next to a scientifically different effective model.

## Reproduction

1. Import two normalized logistic reference spectra A and B and a target with `target = 0.6*A + 1.4*B`. The `.dat` fixtures are saved beside this report's parent directory. The API accepts these as `data_type: "norm"`.
2. POST `/api/backend/api/athena/projects/1b6vtAzlPvUJK02WCxzoBmpI/analyze` with this body:

```json
{
  "version": 10,
  "action": "lcf",
  "group_ids": ["nM6gt4VMNod-4yGQErYqp12o", "rC7hSDtxA-7-YG15w1T6tlIC", "Q-1ie0yUYZwpJqvJt6ufgXFD"],
  "options": {
    "array": "norm", "xmin": 8960, "xmax": 9020,
    "sum_to_one": "false"
  }
}
```

The exact executable request including the target ID is in `lcf-string-false-sum.request.json`. Its response is in the matching `.response.json` file.

Expected: reject the string with an actionable 400/422 validation error, or explicitly normalize a supported string representation to the intended false value. Reject unrecognized option keys.

Observed: HTTP 200; `result.sum_to_one` is true, weights are approximately `[1.0, 0.0]`, R-factor `0.2100429343`. Repeating with JSON boolean `false` returns `[0.6, 1.4]` and R-factor `2.51e-30`.

The signed target `1.2*A - 0.2*B` behaves similarly. With `nonnegative: "false"`, it returns `[1.0, 0.0]`; with `nonnegative: false`, it returns `[1.2, -0.2]`. `sum_to_1: false` is accepted and produces the default constrained result.

## Cause and scope

Deployed `backend/xraylarch_web/athena.py`, `ProjectStore.analyze`, coerces these options through `bool(o.get(...))`. A nonempty string therefore becomes true. The `Command.options` dictionary has no action-specific schema, and the analysis handler does not reject unknown keys.

This is an input-validation defect, not a numerical LCF solver defect. All valid boolean combinations recovered the exact known input weights in this test. Use strict per-analysis schemas and retain requested/effective values consistently.

## Evidence

- `lcf-string-false-sum.request.json` and `.response.json`
- `lcf-boolean-false-sum.request.json` and `.response.json`
- `lcf-string-false-nonnegative.request.json` and `.response.json`
- `lcf-boolean-false-nonnegative.request.json` and `.response.json`
- `lcf-unknown-option.request.json` and `.response.json`
- Replay setup: `run_analyses.py`, then `extend_analyses.py`
