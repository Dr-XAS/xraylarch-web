# Artemis rejects valid decimal fitting windows at the documented minimum width

Severity: low. Confirmed on deployed revision 881d526f62d72f05f6fdaa8bfb879baee89acd55 through port 3004.

Status: fixed by PR #11 (`f486d70a6`), merged October 5, 2026; not yet deployed. Windows exactly at the minimum width are accepted.

Artemis rejects k = 3.1–4.1 Å⁻¹ and R = 1.1–1.2 Å or 2.7–2.8 Å, although they meet the stated minimum widths of 1 Å⁻¹ and 0.1 Å. Users receive HTTP 422 instructing them to use exactly the minimum widths they already supplied. A 1.1–1.200000000000001 Å range succeeds with the same model, which confirms a floating-point boundary error.

Reproduce against QA project `2ft4lY2wBWhn0dhEYWCnbta2`, Cu foil 10 K group `jNHGUlIPEUVos6_6GlEe2Nrp`:

1. Read the project's current version through `/api/athena/projects/{id}?view=summary`.
2. POST the saved request `fit_decimal_k_min_span.request.json` to `/api/artemis/projects/{id}/groups/{gid}/fit?view=summary`, updating its version.
3. Observe HTTP 422 with `Use a k interval of at least 1 inverse angstrom and an R interval of at least 0.1 angstrom.`
4. Compare `fit_integer_k_min_span.request.json`, which uses k = 3–4 and returns HTTP 200. The requests use one varying parameter, so underdetermination does not cause this rejection.
5. Repeat with `fit_decimal_r_min_span.request.json` and compare `fit_decimal_r_epsilon.request.json`.

Expected: mathematically valid minimum intervals pass validation. Ordinary decimal input should not require machine-precision adjustments.

Actual: direct subtraction falls just below the threshold. Deployed `backend/xraylarch_web/artemis.py`, `FitTransform.ordered_ranges`, compares `self.kmax - self.kmin < 1` and `self.rmax - self.rmin < 0.1` without a numerical tolerance.

Evidence: all five request/response pairs are in `/tmp/xas-qa-20261001/artemis/`, with request status and timing in `requests.jsonl`. The corresponding script is `run_boundary_plot.py`.

Suggested correction: compare interval widths with a small absolute numerical tolerance and add tests for decimal endpoints at both minimum widths. This is a validation defect, not a recommendation to use such narrow scientific fitting windows.
