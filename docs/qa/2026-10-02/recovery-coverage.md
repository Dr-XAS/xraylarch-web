# Interrupted workflows and recovery

Recovery QA completed against the deployed app on port 3004. Of 25 distinct assertions, 24 passed and one confirmed XAS-QA-007: following the import retry guidance after a lost response can add the same measurement twice. The selected runs recorded 186 browser requests, including background reads and intentionally interrupted requests.

Testing began on `881d526f62d72f05f6fdaa8bfb879baee89acd55`. The deployment changed independently during the campaign to `18c6a8dd03502e15c0bba88490c88f966ad70ffe`. XAS-QA-007 reproduced on both releases; later recovery checks used the new release and its separate FEFF dialog.

| Workflow | Observed result |
|---|---|
| Import blocked before reaching the server | No group was added. Retrying imported exactly one valid spectrum. |
| Import committed, response lost | First retry correctly received 409 and loaded the latest project. The dialog retained the accepted file and recommended another retry, which created an identical second group. XAS-QA-007. |
| Refresh during an accepted import | Reload recovered the single committed group with unchanged measured arrays. |
| Three-file batch interrupted before file 2 | File 1 remained saved. Retry resumed files 2 and 3, preserving order, group count and their distinct signal values. |
| Repeated clicks | Real mouse double-clicks on Import, Save and Run fit each submitted one request. |
| Two tabs editing processing parameters | The stale tab received 409, loaded current state and retained its unsaved draft. Retry preserved both independent changes: energy shift 1.25 eV and Rbkg 1.3. |
| Interrupted project download | Retry retained the chosen filename. Refresh during download preserved the project, and a subsequent Save succeeded. |
| Fit request blocked before the server | Saved fit history remained empty. |
| Accepted fit response lost | Reload recovered the saved result without refitting. Refresh during a later fit preserved exactly one additional history record. |
| FEFF status polling interrupted | Check status recovered the completed calculation without another job-creation request. |
| Refresh during FEFF job creation | Repeating the same settings reused the original completed job and identical path IDs. |

Raw energy and mu arrays were compared using SHA-256 before and after recovery. Batch values matched their known signal scales within an absolute tolerance of `1e-14`. Fit success, saved-history identity and FEFF job/path identity were checked separately from HTTP status.

After an ambiguous import network error, reload and inspect the groups before retrying. If the measurement is already present, close the import dialog. Undo removes an accidental second import. The duplicate-import reproductions remain in QA projects `tmbFP_rsf5S6U3MH3ysAtV71` on the first release and `PjlqHqb-NnPS10298_Key1bS` on the later release.

Failures were simulated only in isolated Chromium browser contexts. The server was not restarted or impaired. Refresh tests withheld real server responses after acceptance; they did not simulate a server crash during a write. No existing user projects, shared preference endpoints or application source were changed. Normal imports can update remembered column choices.

Initial runner failures involved changing busy-state button labels, synthetic same-task click events, and FEFF selectors from the previous release. Corrected runs passed; those failures are not additional product defects. Browser screenshots were inspected. Final health returned `status: ok`, and `git diff --check` passed.

Full evidence is in `/tmp/xas-qa-20261002/recovery/`. Its `report.json` indexes the checks, releases and scripts; `issues/import-lost-response-duplicate.json` contains the confirmed report. Each scenario directory retains network records, server responses, screenshots and visible page text. Project-memory publication and the durable archive are handled with the enclosing audit.
