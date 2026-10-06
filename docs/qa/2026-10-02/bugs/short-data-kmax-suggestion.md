# XAS-QA-008: Suggested kmax cannot be applied to a short processed spectrum

Priority: P3. Confirmed on deployed release `18c6a8dd03502e15c0bba88490c88f966ad70ffe` at port 3004.

Status: fixed by PR #11 (`df636f1f5`), merged October 5, 2026, and live on port 3004 in release `dd47cdfd` (October 6). The report still shows Larch's suggestion, says whether it can be applied, and explains why not; the action no longer submits an invalid range.

Project: `i4i4j1xDXYLugONRhtuReO70`. Group: `vqR1QIqaDOH3woUY4W3gAA10`, `short-xanes-25eV.dat`.

## Reproduce

1. Import the short-range test spectrum and process it with the default requested kmin of 3 Å⁻¹. Processing automatically uses an effective kmin of 1.25 Å⁻¹.
2. Open its measurement report. It recommends kmax = 2.6 Å⁻¹.
3. Choose “Set kmax to Larch’s suggestion.”

Expected: reconcile the recommendation with the effective minimum and measured support, or explain why no usable recommendation is available before offering the action.

Observed: the UI submits only kmax = 2.6 and receives HTTP 400, “kmax must be greater than kmin.” Supplying the effective kmin manually still fails: physical support ends at 2.544156796 Å⁻¹ and the chi grid ends at 2.5 Å⁻¹, below the recommendation. The offered action cannot succeed for this spectrum.

Impact: a built-in processing recommendation leads directly to a validation error. The short measurement range itself is not an application defect; the recommendation and action need to respect it.

Evidence root: `/tmp/xas-qa-20261002/science`.

- `suggestion-browser-responses.json` records the current-release version-13 request and failure.
- `suggestion-browser-body.txt` and `suggested-kmax-browser-error.png` capture the UI.
- `short-apply-suggestion-effective-kmin.response.json` records the support-bound rejection after correcting kmin.
- `reproduce-suggestion.mjs` replays the browser action.

Source hint from inspected earlier source: `recommendedKmax()` copies `kmax_suggest` directly into the processing command. Current-release behavior was reproduced in the browser.

[Recommendation and spectrum](../screenshots/short-spectrum-recommendation.png) · [Displayed error](../screenshots/invalid-kmax-recommendation.png). The action was reproduced again at project version 14 on the same release.
