# XAS-QA-007: Retrying an import after its response is lost creates a duplicate spectrum

Priority: P2. Confirmed on releases 881d526f62d72f05f6fdaa8bfb879baee89acd55 and 18c6a8dd03502e15c0bba88490c88f966ad70ffe.

Status: fixed by PR #10 (`f8ae23fd3`), merged October 5, 2026, and live on port 3004 in release `dd47cdfd` (October 6). A retried import with the same idempotency key returns the first import's result.

Target: http://drxas.xray.aps.anl.gov:3004. Isolated QA project: `tmbFP_rsf5S6U3MH3ysAtV71`.

Browser loses the response after the server accepts an import. No live-server outage or restart was induced.

## Reproduce

1. In an empty QA project upload QA-recovery-Cu.dat and review its columns.
2. Intercept POST /api/athena/projects/{id}/import in the local browser, call route.fetch() so the server processes it, then abort the browser response.
3. The project on the server now contains one spectrum, while the import dialog reports Failed to fetch. Restore normal networking.
4. Click Import spectrum. The stale version returns 409; the app loads the latest project and says to review it and retry. The import dialog remains on the accepted file.
5. Follow that instruction and click Import spectrum again.

## Expected

Reconcile the original import with the committed project and do not submit it as a second import. At minimum, explain that the original import succeeded and close or advance the accepted file before permitting another import.

## Observed and impact

The final project contains two groups from the single file. Both energy/mu array hashes are 1932761b9fa1b170c15435319b79c500e4e1b35c5a8b7e4632a832a4d870fb5f. The first retry correctly rejects 409 and does not duplicate; duplication happens on the following retry explicitly suggested by the UI.

A single scan can enter a merge or fit twice, falsely increasing its statistical weight. The two spectra retain identical measurement values; this is duplication, not corruption or data loss.

## Recovery and evidence

After an import network error, reload the project and inspect its groups before retrying. If the scan is already present, dismiss the import dialog. Undo removes the additional group if duplication has occurred.

Evidence root: `/tmp/xas-qa-20261002/recovery`.

- `import-recovery.mjs`
- `imports-rerun.log`
- `imports/lost-response-committed.json`
- `imports/lost-response-first-error.png`
- `imports/lost-response-stale-reloaded.png`
- `imports/lost-response-after-guided-retry.png`
- `imports/checks.json`
- `imports/network-events.json`

Source hint: frontend/components/athena-workbench.tsx importCurrent advances files only after receiving a response; task reloads the project on stale_revision but leaves the accepted upload selected and suggests retry.

Current-release reproduction: project `PjlqHqb-NnPS10298_Key1bS`, evidence `recovery/current-release-import/`, `recheck-duplicate.mjs`, and `recheck-duplicate.log`. It again ends with two identical groups.

[Screenshot after the guided retry](../screenshots/duplicate-after-guided-retry.png).
