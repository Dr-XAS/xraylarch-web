# FEFF and fit replay verification

This directory retains numerical replay checks for the saved native/app comparison
evidence. The implementation is `ee1dde1cd`; its independent regression run passed
73 tests across HTTP replay, command replay, final-state comparison and the task
suite.

All 15 repeated app attempts are covered. Thirteen replay successfully; two failed
source attempts retain their missing fit evidence. All 15 command replays match
their recorded final summaries and effective parameters. Across the two historical
distance-task recordings and the successful repeated distance task, 21 fits and
three fresh FEFF calculations match the recorded scientific quantities.

The first-repeat app distance attempt requested an advertised example route that
the evaluator did not allow. The third-repeat attempt put the label `10 K` in a
digest URL that required a group ID. Both stopped before fitting. Their unchanged
projects replay successfully, but neither is counted as a validated fit.

Run this command from the repository to regenerate `results.json` and the per-run
reports:

```sh
PYTHONPATH=backend backend/.venv/bin/python \
  docs/agent-runs/2026-10-05-artemis-replay/verify.py --refresh
```

It exits 1 because the two source failures remain in the record. The report's
`complete: true` means every source outcome was checked. It uses private temporary
stores, reruns FEFF and fits, and
compares the final Athena summary and effective parameters with the saved state.
The original evidence remains unchanged. Omit `--refresh` to reuse reports whose
source and implementation hashes still match.

`results.json` distinguishes successful fit comparisons, runs without fit evidence,
and incomplete or failed source attempts. A failed agent attempt is retained even
when its unchanged Athena project replays successfully. The negative control
deliberately alters a saved distance by 0.001 Å and doubles a parameter uncertainty;
both differences must be rejected.

Replay supports the recorded example setup, bundled AMCSD FEFF calculations and
complete fit requests. It compares scientific summaries, including uncertainties,
settings and concerns. It does not establish array equality or validate the
agent's prose. The [task guide](../../agent-task-suite.md#replaying-feff-calculations-and-fits)
defines the supported evidence and numerical tolerances.
