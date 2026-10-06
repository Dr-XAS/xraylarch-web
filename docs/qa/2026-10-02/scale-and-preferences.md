# Scale, preferences, and file-reader follow-up

Target: deployed standalone app at `http://drxas.xray.aps.anl.gov:3004`. Shared preference mutations ran only on an isolated local backend at port 18017, using the copied deployed backend and a separate temporary data directory. The local process was stopped after verification.

The live release changed from `881d526f62d72f05f6fdaa8bfb879baee89acd55` to `18c6a8dd03502e15c0bba88490c88f966ad70ffe` during the campaign. SSH comparison confirms no backend files changed between them. Local reader results still depend on the local Python/Larch environment and do not substitute for testing production configuration.

## Large projects

All 13 API checks and seven Chromium browser checks pass. Project `3TMBehaa96TTFyiKGti04x-9` contains copies of the five measured examples, grown to 50 then 100 groups. These are scale-test copies, not independent measurements.

- All 100 groups remain processed. The 101st is refused without changing the project version or count.
- JSON exports preserve all 50/100 groups and are about 10/20 MB. The 100-group parameter report succeeds.
- Chromium loads the 100-group project in 6.1 seconds, draws 100 energy curves, switches to 100 k curves in 6.1 seconds, searches the group list, switches spectra, and reloads in 7.2 seconds. Timings are observations from this machine and network, not performance guarantees.
- The 390 px mobile layout has no page-level horizontal overflow. Desktop and mobile screenshots were visually inspected.
- The first browser run showed “Failed to fetch” during the deployment cutover. A fresh run on the new release passed all checks with no page errors. This transient was not counted as a reproducible scale defect.

Evidence: `large-projects/run.py`, `checks.json`, `browser.mjs`, `browser-results.json`, and `100-*.png` in the evidence archive.

## Preferences and plugins

All 70 lifecycle checks pass: 56 before restart and 14 after restart.

- Rebin, beamline identification, dispersive calibration, merge, smoothing, and plugin settings save and read back correctly.
- Stale revisions and invalid values are rejected atomically. Duplicate YAML keys are rejected; valid calibration and plugin-registry files round-trip.
- Smoothing and all four configurable readers distinguish session Apply from Save. Saved settings survive restart; unsaved changes are discarded; old session tokens cannot overwrite the restarted state.
- The catalog exposes 22 readers. X10C and Lytle enable/disable flows work, staged imports remain usable after disabling, and project Undo leaves preferences unchanged.

Sixteen measured fixture files were inspected: X10C, Lytle, CMC, PFBL12C, SSRLmicro, LNLS, X15B, SSRLA, SSRLB, HXMA, X23A2MED, DUBBLE, SRS9, SRS32, SRSC, and SNBL. The SNBL file opens a scan chooser; this pass did not import its selected scans. Fifteen single-table measurements were imported with appropriate detector choices. Nineteen detector-ratio and recovery assertions pass.

CMC and SSRLmicro fixtures contain zero transmission counts, so the default transmission import correctly rejects. Choosing fluorescence succeeds; CMC requires its appropriate XANES data type. SRSC's default transmission recipe gives an explicit non-positive-edge-step error; selecting SIGNAL1 / REFER as fluorescence processes successfully. These are measurement-selection cases, not confirmed parser defects.

Evidence: `preferences/run.py`, `restart-check.py`, `readers.py`, `reader-followup.py`, their JSON results, and the captured request/response files. Early harness errors used the wrong JSON keys (`catalog` instead of `plugins`, and top-level `code` instead of `error.code`); corrected reruns pass. They are not product failures.

No public preference settings were explicitly edited. Normal imports can update the app's remembered column mapping. Existing user projects, application source, and deployment state were not changed by these tests.
