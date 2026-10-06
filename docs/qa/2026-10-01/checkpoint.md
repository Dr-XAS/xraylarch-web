# Beamline QA completion checkpoint

Completed October 2, 2026, after starting October 1. The public deployment at http://drxas.xray.aps.anl.gov:3004 stayed healthy on release `881d526f62d72f05f6fdaa8bfb879baee89acd55` through final verification.

All 36 Athena commands have successful live cases. Main API scripts recorded 724 requests; desktop/mobile browser work covered import, processing, analyses, saved projects, structures, FEFF, fitting and plots. Final EXAFS viewer-weight and 3D wavelet resize/camera checks both passed with WebGL enabled. See [the audit report](audit.md) for coverage, limitations and all six confirmed issues. All six were fixed on October 5, 2026; the audit lists the PRs.

Shared memory is now registered for this repository as `xraylarch-web`. Setup diagnostics pass without warnings/errors. The setup and QA topics were published through `memoryctl`; no direct canonical topic writes or memory-mirror pushes were used. The abandoned Dr.XAS transaction was aborted, so these findings did not go into that project's memory. The canonical QA topic is `beamline-qa-2026-10-01`.

Durable evidence: `/Users/huang.jeffrey/.local/share/xraylarch-web-qa/2026-10-01/evidence.tar.gz`. SHA-256: `8a19a8d9ef4c6dc4b0ad26a3b0bb5871e7d32d33967d26748ccab92985ab5925`. Working files remain in `/tmp/xas-qa-20261001/`. The archive includes exact requests, responses, fixtures, scripts, screenshots and traces. Reports and selected screenshots are retained beside this file.

No product fixes, commits, pushes or deployments were performed. The local branch is `fix/flaky-frontend-tests`; preserve the pre-existing deployment-manifest edit. Audit documents and requested memory guides/adapters are uncommitted. QA projects remain available for reproduction; existing user projects were not edited. Normal imports may update remembered column mappings.
