# XrayLarch Web V1 Implementation Plan

> For agentic workers: REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Build and qualify a browser-based XAS workbench that uploads one spectrum, maps its columns, previews/applies Larch processing, preserves recipe revisions, and can run as an isolated app on the Dr.XAS workstation.

**Architecture:** Add a FastAPI backend under backend/ that owns parsing, validation, Larch processing, and private workspace revisions. Add a Next.js 14 frontend under frontend/ that proxies same-origin API calls, manages draft/applied state, and renders server-produced Plotly-compatible traces. Deploy the two services manually under /local/apps/xraylarch-web on ports 3004 and 8006, without using Dr.XAS data or services.

**Tech Stack:** Python 3.11+, existing xraylarch package, FastAPI 0.116.1, Uvicorn 0.35.0, Pydantic 2.11.7, pytest 8.4.1, Next.js 14.2.30, React 18, TypeScript 5.5, Tailwind CSS 3.4, Plotly/react-plotly.js, Vitest 3.2, and Playwright 1.58.

**Spec:** docs/superpowers/specs/2026-08-17-xraylarch-web-v1-design.md

## Global Constraints

- “Larch performs all numerical work. The browser only supplies validated inputs and renders server-produced data.”
- “Preview is never an implicit mutation.”
- “Existing Larch scientific defaults and calculations are not changed by the web layer.”
- V1 is a trusted-network, single-user application; it is not public or multi-tenant software.
- Uploaded content is data only; no pickle, executable upload, arbitrary path, or arbitrary proxy URL is permitted.
- Frontend listens on 0.0.0.0:3004; backend listens on 127.0.0.1:8006.
- Deployment state lives under /local/apps/xraylarch-web; existing Dr.XAS ports, screens, watchers, cron, firewall, reverse proxy, databases, secrets, and shared stores remain untouched.
- Every preview and apply creates a fresh Larch Group; raw arrays remain unchanged.
- Browser qualification uses domcontentloaded plus explicit readiness checks, never networkidle.
- Every task ends with focused verification and an intentional commit; no push, merge, or production promotion is implicit.

---

## File and responsibility map

Backend:
- backend/requirements.txt — release-local backend/runtime/test dependencies.
- backend/xraylarch_web/contracts.py — Pydantic request/response models and typed domain values.
- backend/xraylarch_web/errors.py — stable error codes, field issues, and FastAPI exception conversion.
- backend/xraylarch_web/parsing.py — bounded upload parsing, column inspection, filename sanitization, and mapping validation.
- backend/xraylarch_web/processing.py — recipe validation, Larch processing, effective-value capture, and Plotly-compatible trace serialization.
- backend/xraylarch_web/storage.py — safe workspace paths, atomic JSON/NPZ persistence, and revision file I/O.
- backend/xraylarch_web/workspace.py — workspace lifecycle, source mapping, revision history, stale-parent checks, and snapshots.
- backend/xraylarch_web/config.py — environment-backed data-root and limit settings with safe defaults.
- backend/xraylarch_web/routes.py — HTTP routes and request-to-domain orchestration.
- backend/xraylarch_web/main.py — FastAPI application factory, health route, and error handlers.
- backend/tests/ — backend fixtures and unit/API tests.

Frontend:
- frontend/package.json and frontend/package-lock.json — pinned web runtime and verification scripts.
- frontend/next.config.mjs, frontend/tsconfig.json, frontend/vitest.config.ts, frontend/playwright.config.ts — build/test configuration.
- frontend/app/layout.tsx, frontend/app/page.tsx, frontend/app/globals.css — app shell and page entrypoint.
- frontend/app/api/backend/[...path]/route.ts — allowlisted same-origin backend proxy.
- frontend/lib/contracts.ts — frontend mirrors of backend JSON contracts.
- frontend/lib/backend-client.ts — typed HTTP client and API error decoding.
- frontend/lib/workbench-state.ts — pure reducer/state transitions for draft/applied/revision state.
- frontend/components/ — workbench shell, import, plots, processing controls, history, and status UI.
- frontend/tests/ — reducer/component/e2e tests and the small XAS fixture.

Deployment:
- deploy/xraylarch-web.manifest.md — exact app identity, ports, paths, state, and rollback contract.
- scripts/deploy-xraylarch-web.sh — namespaced immutable-release deployer.
- scripts/check-xraylarch-web.sh — read-only health checks.
- README.md — local development, verification, trusted-network boundary, and deployment handoff.
- .gitignore — web build, virtualenv, runtime state, and test-output exclusions.

---

### Task 1: Backend contracts and upload inspection

Files:
- Create backend/requirements.txt
- Create backend/xraylarch_web/__init__.py
- Create backend/xraylarch_web/contracts.py
- Create backend/xraylarch_web/errors.py
- Create backend/xraylarch_web/parsing.py
- Create backend/tests/conftest.py
- Create backend/tests/fixtures/cu_rt01.xmu
- Create backend/tests/test_parsing.py
- Modify .gitignore

Interfaces:
- Produce ColumnInfo, UploadInspection, FieldIssue, ErrorEnvelope, and parse_upload(data: bytes, filename: str, max_bytes: int = 50_000_000) -> ParsedUpload.
- ParsedUpload exposes display_name, row_count, columns, arrays, warnings, issues, and source_bytes.
- ColumnInfo exposes name, index, numeric, unit, role_hint, and a finite five-value preview.
- Later tasks consume these contracts without importing FastAPI from parser/processing code.

- [ ] Step 1: Create the backend environment and dependency manifest.

Add these exact requirements:

    -e ..
    fastapi==0.116.1
    uvicorn==0.35.0
    python-multipart==0.0.20
    httpx==0.28.1
    pydantic==2.11.7
    pytest==8.4.1

Add backend/.venv/, backend/data/, backend/.pytest_cache/, and backend/*.egg-info/ to .gitignore. Run:

    python -m venv backend/.venv
    backend/.venv/bin/python -m pip install --upgrade pip
    backend/.venv/bin/python -m pip install -r backend/requirements.txt

- [ ] Step 2: Write the failing parser tests.

Create tests for:

    def test_parse_upload_returns_numeric_columns_and_monotonicity(sample_xmu_bytes):
        parsed = parse_upload(sample_xmu_bytes, "Cu scan 01.xmu")
        assert parsed.display_name == "Cu scan 01.xmu"
        assert parsed.row_count > 10
        assert [column.name for column in parsed.columns[:2]] == ["energy", "mu"]
        assert parsed.columns[0].role_hint == "energy"
        assert parsed.issues == ()

    def test_parse_upload_sanitizes_name_and_rejects_oversize():
        parsed = parse_upload(b"1 2\n2 3\n", "../../unsafe\nname.xmu")
        assert ".." not in parsed.display_name
        with pytest.raises(WebInputError) as exc:
            parse_upload(b"1 2\n", "x.xmu", max_bytes=3)
        assert exc.value.code == "upload_too_large"

    def test_parse_upload_reports_non_monotonic_energy():
        parsed = parse_upload(b"# energy mu\n3 1\n2 2\n4 3\n", "bad.dat")
        assert any(issue.code == "energy_not_monotonic" for issue in parsed.issues)

Use conftest.py to load the checked-in fixture and set the data root to tmp_path; never read an .env file.

- [ ] Step 3: Run the focused test and verify the expected RED failure.

    backend/.venv/bin/python -m pytest backend/tests/test_parsing.py -q

Expected: collection or assertion failure because xraylarch_web.parsing.parse_upload and its contracts do not exist. Fix only test typos before implementation.

- [ ] Step 4: Implement bounded parsing and typed contracts.

Implement:

    def parse_upload(data: bytes, filename: str, max_bytes: int = 50_000_000) -> ParsedUpload:
        """Parse a bounded XAS upload without executing or persisting user paths."""

Use read_xdi(..., use_pyxdi=True) for .xdi, read_csv for .csv, and read_ascii for other supported text suffixes. Reject NUL bytes, oversize files, empty tables, missing numeric arrays, and non-finite selected values. Preserve numeric columns in source order. Infer only display hints from normalized names: energy, mu, i0, it, ifluor. Emit energy_not_monotonic without reordering data. Store a safe basename for display and never return the client path. Serialize errors with the exact ErrorEnvelope fields code, message, fields, and recovery.

- [ ] Step 5: Run parser tests and inspect the diff.

    backend/.venv/bin/python -m pytest backend/tests/test_parsing.py -q
    git diff --check

Expected: all parser tests pass with no new warnings.

- [ ] Step 6: Commit the parser slice.

    git add .gitignore backend/requirements.txt backend/xraylarch_web backend/tests
    git commit -m "feat: inspect xraylarch uploads"

---

### Task 2: Larch processing and immutable workspace revisions

Files:
- Create backend/xraylarch_web/processing.py
- Create backend/xraylarch_web/storage.py
- Create backend/xraylarch_web/workspace.py
- Create backend/tests/test_processing.py
- Create backend/tests/test_workspace.py
- Modify backend/xraylarch_web/contracts.py
- Modify backend/xraylarch_web/errors.py

Interfaces:
- Consume ParsedUpload from Task 1.
- Produce RecipeDraft, EffectiveRecipe, PlotTrace, PlotBundle, ProcessingResult, RevisionSummary, WorkspaceSnapshot, and WorkspaceStore.
- validate_mapping(parsed, energy_column, signal_column) -> tuple[numpy.ndarray, numpy.ndarray].
- validate_recipe(recipe, energy) -> tuple[FieldIssue, ...].
- run_processing(energy, mu, recipe) -> ProcessingResult.
- WorkspaceStore(root: pathlib.Path) exposes create(), load(workspace_id), save_upload(...), confirm_mapping(...), apply_revision(...), and restore_revision(...).

- [ ] Step 1: Write failing processing and workspace tests.

Include:

    def test_run_processing_preserves_raw_arrays_and_effective_values(xas_arrays):
        energy, mu = xas_arrays
        raw_energy = energy.copy()
        raw_mu = mu.copy()
        result = run_processing(energy, mu, RecipeDraft())
        assert numpy.array_equal(energy, raw_energy)
        assert numpy.array_equal(mu, raw_mu)
        assert result.effective.e0 > energy.min()
        assert result.effective.edge_step > 0
        assert all(numpy.isfinite(trace.x).all() for trace in result.plots)
        assert all(numpy.isfinite(trace.y).all() for trace in result.plots)

    def test_validate_recipe_reports_all_invalid_ranges_without_running_larch(xas_arrays):
        energy, _ = xas_arrays
        issues = validate_recipe(RecipeDraft(kmin=10, kmax=5, rbkg=0), energy)
        assert {issue.code for issue in issues} >= {"k_range_invalid", "rbkg_invalid"}

Add workspace tests for apply, restore-as-new-revision, and stale-parent rejection with code stale_revision while preserving the current revision.

- [ ] Step 2: Run focused tests and verify RED.

    backend/.venv/bin/python -m pytest backend/tests/test_processing.py backend/tests/test_workspace.py -q

Expected: missing imports or failing assertions because processing and workspace modules do not exist.

- [ ] Step 3: Implement the recipe models and deterministic Larch pipeline.

Add RecipeDraft with these fields and defaults:

    e0: float | None = None
    step: float | None = None
    nnorm: int | None = None
    pre1: float | None = None
    pre2: float | None = None
    norm1: float | None = None
    norm2: float | None = None
    rbkg: float = 1.0
    kmin: float = 0.0
    kmax: float | None = None
    kweight: int = 1
    dk: float = 0.1
    dk2: float | None = None
    window: str = "hanning"
    nfft: int = 2048
    kstep: float = 0.05
    rmax_out: float = 10.0

Pass the recipe overrides to pre_edge, pass its effective e0/edge_step plus rbkg, k bounds, k-weight, taper, window, nfft, and kstep to autobk, then pass χ(k) and the transform settings to xftf. Preserve None as automatic for Larch. Return Plotly-compatible traces with explicit id, label, x_label, y_label, x_unit, and y_unit for raw_mu, norm_mu, chi_k, and chi_r. Convert NumPy scalars to Python floats and reject non-finite results with processing_nonfinite.

- [ ] Step 4: Implement safe workspace storage and revision semantics.

storage.py must resolve every path beneath the configured root using a validated opaque ID, create mode-0700 directories, use temporary files plus os.replace for JSON/NPZ writes, store arrays without pickle, load with allow_pickle=False, and never accept a request path as a filesystem target.

workspace.py must create IDs with secrets.token_urlsafe(16), record a mapping revision before processing, assign revision IDs monotonically within the workspace, require expected_parent_revision on apply, and make restore_revision create a new revision without deleting history.

- [ ] Step 5: Run processing/storage tests and verify GREEN.

    backend/.venv/bin/python -m pytest backend/tests/test_processing.py backend/tests/test_workspace.py -q

Expected: all pass; raw arrays remain byte-for-byte unchanged.

- [ ] Step 6: Commit the processing/storage slice.

    git add backend/xraylarch_web backend/tests
    git commit -m "feat: add larch processing revisions"

---

### Task 3: FastAPI workspace API

Files:
- Create backend/xraylarch_web/config.py
- Create backend/xraylarch_web/routes.py
- Create backend/xraylarch_web/main.py
- Create backend/tests/test_api.py
- Modify backend/xraylarch_web/contracts.py
- Modify backend/xraylarch_web/errors.py

Interfaces:
- Produce create_app(settings: Settings | None = None) -> FastAPI and module-level app.
- Routes match the approved spec: /health, /api/workspaces, inspect, mapping, preview, apply, restore, hydration, data.csv, and recipe.json.
- InspectionResponse includes upload_id.
- MappingRequest includes upload_id, energy_column, signal_column.
- PreviewRequest includes source_revision_id and recipe.
- ApplyRequest adds expected_parent_revision.
- RestoreRequest includes revision_id and expected_parent_revision.
- Domain errors serialize as ErrorEnvelope; stale revisions return 409 and missing workspace/revision returns 404.

- [ ] Step 1: Write failing API tests.

Use httpx.AsyncClient and create_app with a tmp_path data root. Cover this flow:

    workspace = await client.post("/api/workspaces")
    inspected = await client.post(
        f"/api/workspaces/{workspace_id}/uploads/inspect",
        files={"file": ("cu_rt01.xmu", fixture_file, "text/plain")},
    )
    mapped = await client.post(
        f"/api/workspaces/{workspace_id}/mapping",
        json={"upload_id": upload_id, "energy_column": "energy", "signal_column": "mu"},
    )
    preview = await client.post(
        f"/api/workspaces/{workspace_id}/preview",
        json={"source_revision_id": source_id, "recipe": {}},
    )
    applied = await client.post(
        f"/api/workspaces/{workspace_id}/apply",
        json={"source_revision_id": source_id, "expected_parent_revision": None, "recipe": {}},
    )
    download = await client.get(
        f"/api/workspaces/{workspace_id}/revisions/{revision_id}/data.csv"
    )

Assert 200 for the happy path and a CSV body containing energy. Also test isolation, malformed mapping, stale apply 409, sanitized error bodies, and health metadata.

- [ ] Step 2: Run API tests and verify RED.

    backend/.venv/bin/python -m pytest backend/tests/test_api.py -q

Expected: import/route failures because the FastAPI app does not exist yet.

- [ ] Step 3: Implement settings, app factory, routes, and exception handlers.

config.py reads XRAYLARCH_DATA_ROOT and XRAYLARCH_MAX_UPLOAD_BYTES without reading secrets. Default development data is backend/data/xraylarch-web; deployment overrides it with /local/apps/xraylarch-web/data.

routes.py streams multipart uploads into bounded bytes, saves them before returning upload_id, requires that upload ID during mapping, previews without mutating applied state, applies with the expected parent, and returns safe fixed download filenames. main.py registers the health route, API routes, and ErrorEnvelope handler. Do not add permissive CORS.

- [ ] Step 4: Run API tests and verify GREEN.

    backend/.venv/bin/python -m pytest backend/tests/test_api.py -q

Expected: all API tests pass, including stale-parent and workspace-isolation behavior.

- [ ] Step 5: Commit the HTTP slice.

    git add backend/xraylarch_web backend/tests
    git commit -m "feat: expose xraylarch workspace api"

---

### Task 4: Frontend scaffold, typed client, and state reducer

Files:
- Create frontend/package.json
- Create frontend/package-lock.json through npm install
- Create frontend/next-env.d.ts
- Create frontend/tsconfig.json
- Create frontend/next.config.mjs
- Create frontend/vitest.config.ts
- Create frontend/app/api/backend/[...path]/route.ts
- Create frontend/lib/contracts.ts
- Create frontend/lib/backend-client.ts
- Create frontend/lib/workbench-state.ts
- Create frontend/lib/workbench-state.test.ts
- Modify .gitignore

Interfaces:
- Produce WorkbenchState, WorkbenchAction, workbenchReducer, createInitialState, hasUnappliedChanges, and decodeApiError.
- BackendClient exposes createWorkspace, inspectUpload, confirmMapping, getWorkspace, preview, apply, restore, dataDownloadUrl, and recipeDownloadUrl.
- The proxy allows only /health and /api/workspaces paths, forwards to BACKEND_URL defaulting to http://127.0.0.1:8006, and never accepts an upstream URL from the browser.

- [ ] Step 1: Scaffold and install pinned frontend dependencies.

Create scripts dev, build, start, test, and test:e2e. Install:

    cd frontend
    npm install next@14.2.30 react@18 react-dom@18 react-plotly.js@2.6.0 plotly.js-dist-min@3.1.0 lucide-react@0.396.0
    npm install --save-dev typescript@5.5.4 @types/node@22 @types/react@18 @types/react-dom@18 tailwindcss@3.4.1 postcss@8 autoprefixer@10 vitest@3.2.4 jsdom@26 @testing-library/react@16 @testing-library/jest-dom@6 @playwright/test@1.58.2

Use strict TypeScript with @/* mapped to the frontend root. Ignore node_modules, .next, tsbuildinfo, and Playwright output.

- [ ] Step 2: Write reducer and client tests before implementation.

Cover applied visibility during a pending preview, stale preview response rejection by request ID, preview cancellation, error decoding, and fixed /api/backend URL construction:

    it("keeps the applied revision visible while a preview is pending", () => {
        const state = createInitialState(defaultRecipe)
        const mapped = workbenchReducer(state, { type: "mapping/succeeded", snapshot })
        const previewing = workbenchReducer(mapped, {
            type: "preview/started",
            recipe: { ...defaultRecipe, rbkg: 1.2 },
        })
        expect(previewing.applied?.id).toBe(snapshot.current_revision.id)
        expect(previewing.status).toBe("previewing")
    })

    it("ignores a preview response for an older draft token", () => {
        const state = workbenchReducer(
            createInitialState(defaultRecipe),
            { type: "preview/started", recipe: defaultRecipe },
        )
        const newer = workbenchReducer(state, {
            type: "preview/started",
            recipe: { ...defaultRecipe, kweight: 2 },
        })
        const stale = workbenchReducer(newer, {
            type: "preview/succeeded",
            requestId: state.previewRequestId!,
            result,
        })
        expect(stale.preview).toBeNull()
    })

- [ ] Step 3: Run frontend tests and verify RED.

    cd frontend
    npm test -- --run lib/workbench-state.test.ts

Expected: imports fail because the reducer and typed client do not exist.

- [ ] Step 4: Implement contracts, client, reducer, proxy, and build configuration.

Use discriminated actions for workspace, inspection, mapping, preview, apply, restore, view, and error events. Keep applied, draft, preview, history, and selectedView separate. preview/cancelled clears only draft preview state. The client parses non-2xx responses into ApiRequestError with code, message, fields, recovery, and status. Uploads use FormData; JSON calls set application/json.

The proxy rejects paths outside the allowlist before constructing the upstream URL and copies only content-type, accept, and content-length headers.

- [ ] Step 5: Run tests, TypeScript, and a production build.

    cd frontend
    npm test
    npx tsc --noEmit
    npm run build

Expected: tests pass, TypeScript is clean, and Next produces a production build.

- [ ] Step 6: Commit the frontend foundation.

    git add .gitignore frontend
    git commit -m "feat: add xraylarch web frontend foundation"

---

### Task 5: Browser workbench UI and scientific views

Files:
- Create frontend/app/layout.tsx
- Create frontend/app/page.tsx
- Create frontend/app/globals.css
- Create frontend/components/workbench-shell.tsx
- Create frontend/components/spectrum-tray.tsx
- Create frontend/components/upload-inspector.tsx
- Create frontend/components/plot-canvas.tsx
- Create frontend/components/plotly-viewer.tsx
- Create frontend/components/processing-inspector.tsx
- Create frontend/components/recipe-history.tsx
- Create frontend/components/status-badge.tsx
- Create frontend/components/workbench-shell.test.tsx
- Modify frontend/lib/contracts.ts
- Modify frontend/lib/workbench-state.ts

Interfaces:
- Consume BackendClient, WorkbenchState, workbenchReducer, and Task 4 contracts.
- Produce stable selectors: data-testid workbench-ready, upload-inspector, column-mapping, processing-inspector, preview-button, apply-button, recipe-history, and plot-canvas.
- PlotlyViewer accepts trace: PlotTrace[], title, xLabel, yLabel, and testId; dynamically import react-plotly.js with SSR disabled.

- [ ] Step 1: Write failing component tests.

Cover explicit mapping before processing and last-applied visibility after an invalid preview:

    it("shows explicit mapping before processing", async () => {
        render(<WorkbenchShell client={fakeClient} />)
        await userEvent.upload(
            screen.getByLabelText(/upload spectrum/i),
            fixtureFile,
        )
        expect(await screen.findByTestId("column-mapping")).toBeVisible()
        expect(screen.getByRole("button", { name: /preview/i })).toBeDisabled()
    })

    it("keeps the last applied plot after an invalid preview", async () => {
        render(<WorkbenchShell client={fakeClientWithAppliedRevision} />)
        await userEvent.click(screen.getByTestId("preview-button"))
        expect(await screen.findByText(/energy range is invalid/i)).toBeVisible()
        expect(screen.getByTestId("plot-canvas")).toBeVisible()
        expect(screen.getByText(/not current/i)).toBeVisible()
    })

- [ ] Step 2: Run component tests and verify RED.

    cd frontend
    npm test -- --run components/workbench-shell.test.tsx

Expected: missing component/import failures because the workbench UI does not exist.

- [ ] Step 3: Implement the responsive shell and import flow.

workbench-shell.tsx creates or rehydrates a workspace ID in localStorage and drives upload → inspect → map → preview → apply. It derives all visible status from reducer state. upload-inspector renders numeric columns in source order, shows role hints/warnings, and requires one energy plus one signal selection; it never silently applies a heuristic mapping.

- [ ] Step 4: Implement Plotly views, processing controls, and history.

plot-canvas provides Raw μ(E), Normalized μ(E), χ(k), and χ(R) choices and passes only selected server traces to PlotlyViewer. processing-inspector puts Recommended controls first, Advanced controls behind a disclosure, displays eV/Å/Å⁻¹ units, and exposes an explicit Preview changes action. Apply remains disabled until a successful preview exists.

recipe-history lists revisions newest-first, shows effective values/diffs, restores as a new revision, and builds download links from the typed client. Failed preview state keeps the current plot visible and attaches recovery text to the affected field.

Use keyboard-accessible disclosures, visible focus rings, aria-describedby for units/help, reduced-motion-safe transitions, and a neutral scientific palette. Do not add chat, tours, or desktop-GUI imitation.

- [ ] Step 5: Run UI verification.

    cd frontend
    npm test
    npx tsc --noEmit
    npm run build

Expected: all component/reducer tests pass, TypeScript is clean, and the production build succeeds.

- [ ] Step 6: Commit the functioning UI.

    git add frontend/app frontend/components frontend/lib
    git commit -m "feat: build xraylarch processing workbench"

---

### Task 6: End-to-end qualification and documentation

Files:
- Create frontend/playwright.config.ts
- Create frontend/tests/fixtures/cu_rt01.xmu
- Create frontend/tests/e2e/workbench.spec.ts
- Modify README.md

Interfaces:
- Consume the complete backend/frontend flow from Tasks 1–5.
- Produce cd frontend && npm run test:e2e as the deterministic local browser qualification command.
- Document local startup, all verification commands, trusted-network limitations, and the eventual Dr.XAS URL.

- [ ] Step 1: Configure Playwright with isolated test ports and state.

Start:

    backend/.venv/bin/python -m uvicorn xraylarch_web.main:app --host 127.0.0.1 --port 18006
    npm run dev -- --hostname 127.0.0.1 --port 13004

Set XRAYLARCH_DATA_ROOT to Playwright's temporary test directory, BACKEND_URL to http://127.0.0.1:18006, and baseURL to http://127.0.0.1:13004.

- [ ] Step 2: Write the browser smoke test before documentation.

The test must run create workspace → upload fixture → explicit mapping → preview → apply → restore → download, using page.goto("/", { waitUntil: "domcontentloaded" }). Add a 390×844 test that asserts no document-level horizontal overflow and that the processing inspector remains reachable.

- [ ] Step 3: Run browser qualification.

    cd frontend
    npm run test:e2e

Expected: the complete flow passes at desktop and narrow widths. Any failure requires a focused regression test before production code is changed.

- [ ] Step 4: Update README.md.

Document:

    Backend:  backend/.venv/bin/python -m uvicorn xraylarch_web.main:app --reload --port 8006
    Frontend: cd frontend && npm run dev -- --port 3004
    Checks:   backend/.venv/bin/python -m pytest backend/tests -q
              cd frontend && npm test && npx tsc --noEmit && npm run build && npm run test:e2e
    Local UI: http://localhost:3004

State that V1 is trusted-network/single-user, uses no Dr.XAS auth or shared data, and defers XRF/XRD, fitting, multi-file workflows, chat, and public deployment.

- [ ] Step 5: Run the complete local preflight.

    backend/.venv/bin/python -m pytest backend/tests -q
    cd frontend && npm test
    cd frontend && npx tsc --noEmit
    cd frontend && npm run build
    cd frontend && npm run test:e2e
    git diff --check
    git status --short --branch

Record actual counts and environment substitutions; do not call release green if any command is skipped or red.

- [ ] Step 6: Commit the qualification slice.

    git add README.md frontend/playwright.config.ts frontend/tests
    git commit -m "test: qualify xraylarch web workflow"

---

### Task 7: Isolated Dr.XAS release package and deployment

Files:
- Create deploy/xraylarch-web.manifest.md
- Create scripts/deploy-xraylarch-web.sh
- Create scripts/check-xraylarch-web.sh
- Modify README.md

Interfaces:
- Produce deployer commands deploy <full-sha>, rollback <full-sha>, and health <full-sha>.
- Repository is https://github.com/Dr-XAS/xraylarch-web.git, branch codex/xraylarch-web-v1.
- Frontend is 0.0.0.0:3004; backend is 127.0.0.1:8006.
- Release root is /local/apps/xraylarch-web/releases; current symlink is /local/apps/xraylarch-web/current; data root is /local/apps/xraylarch-web/data.
- Screens are xraylarch-web-frontend and xraylarch-web-backend.
- Backend start is backend/.venv/bin/uvicorn xraylarch_web.main:app --host 127.0.0.1 --port 8006 from the release backend directory.
- Frontend start is the release-local next start -H 0.0.0.0 -p 3004 with BACKEND_URL=http://127.0.0.1:8006.
- check-xraylarch-web.sh performs read-only checks and never stops processes.

- [ ] Step 1: Write the exact deployment manifest.

Document the authorized values above plus:

    No watcher, cron, boot entry, firewall, reverse proxy, database, Dr.XAS shared data root, provider secret, or global process restart is authorized.
    Mutable state is only /local/apps/xraylarch-web/data.
    Rollback authority is Jeffrey Huang.
    V1 is trusted-network/single-user and has no authentication.

Document health expectations: frontend / HTTP 200, backend /health HTTP 200 with status == "ok", same-origin /api/backend/health HTTP 200, exact screens/listeners, release HEAD equal to SHA, and existing Dr.XAS ports/services still healthy.

- [ ] Step 2: Implement immutable release build and namespaced process control.

Implement scripts/deploy-xraylarch-web.sh with set -Eeuo pipefail, umask 077, a per-app flock, exact SHA validation, and no pkill, killall, broad process matching, hard reset, or shared-clone mutation. The deploy path must:

1. Verify the remote branch tip equals the requested SHA.
2. Fetch the branch into a new temporary release checkout and detach at the SHA.
3. Create a release-local Python venv from drxas-deploy, install backend/requirements.txt, run pip check, and record pip freeze.
4. Run npm ci and npm run build in frontend/ through drxas-node20 with BACKEND_URL and NEXT_BACKEND_URL set to loopback 8006.
5. Create only candidate-owned data/cache/runtime directories, make release files read-only, and write integrity metadata.
6. Start the two exact candidate screens while the prior current remains active.
7. Require health and process cwd/port identity checks before atomically replacing current and state/last-successful.
8. On activation failure, stop only the two candidate screens, restore the prior symlink, and health-check only the prior candidate release.

The script must not inherit provider, email, Slack, or Dr.XAS database secrets; it passes only XRAYLARCH_DATA_ROOT, BACKEND_URL, NEXT_BACKEND_URL, and non-secret runtime values.

- [ ] Step 3: Add read-only health checks and shell verification.

Implement check-xraylarch-web.sh and run:

    bash -n scripts/deploy-xraylarch-web.sh scripts/check-xraylarch-web.sh
    scripts/deploy-xraylarch-web.sh --help
    scripts/check-xraylarch-web.sh --help

Expected: syntax passes, help exits without host writes, and invalid commands fail closed.

- [ ] Step 4: Run the final local preflight.

    backend/.venv/bin/python -m pytest backend/tests -q
    cd frontend && npm test
    cd frontend && npx tsc --noEmit
    cd frontend && npm run build
    cd frontend && npm run test:e2e
    cd .. && git diff --check

Do not push or install a host deployer until all outputs are read and recorded.

- [ ] Step 5: Commit the deployment package.

    git add README.md deploy scripts
    git commit -m "ops: package isolated xraylarch web deploy"

- [ ] Step 6: Revalidate the workstation before any host write.

Run:

    ssh drxas 'screen -ls; ss -ltn; df -h /local; crontab -l'

Confirm /local/apps/xraylarch-web is still unused, 3004 and 8006 are still free, and no screen name collides. If either port or namespace changed, stop and amend the manifest/deployer before proceeding.

- [ ] Step 7: Publish the exact branch revision only after the deployment gate is explicit.

The deployer fetches the remote branch, so the final commit must exist remotely. Before the first git push or host write, report the full SHA and scope; do not push any other branch:

    git push origin codex/xraylarch-web-v1
    git rev-parse HEAD

If the GitHub push is not explicitly authorized at execution time, stop before this step and report the exact command instead of substituting an unreviewed transfer mechanism.

- [ ] Step 8: Verify the live candidate and preserve rollback evidence.

Run:

    ssh drxas '/local/apps/xraylarch-web/ops/deploy-xraylarch-web.sh health <FULL_SHA>'
    curl -fsS http://drxas.xray.aps.anl.gov:3004/
    curl -fsS http://drxas.xray.aps.anl.gov:3004/api/backend/health
    ssh drxas 'screen -ls; ss -ltn; readlink -f /local/apps/xraylarch-web/current; cat /local/apps/xraylarch-web/state/last-successful'

Re-probe existing Dr.XAS services on 3000/3001/8000/8001 and known sibling ports. Record deployed SHA, release path, screen names, HTTP status/body, process cwd, state path, and rollback command. A generic deploy banner is not evidence.

- [ ] Step 9: Commit any deployment-only documentation update without changing app code.

If live verification adds exact operator facts to README.md, commit only that documentation change:

    git add README.md
    git commit -m "docs: record xraylarch web deployment verification"

Do not rewrite scientific code, ports, or deployment state after activation without a new reviewed change.

---

## Plan self-review

- Spec coverage: Tasks 1–3 cover bounded uploads, column inspection, mapping, validation, Larch pre_edge/autobk/xftf, Plotly-compatible traces, workspace isolation, immutable revisions, stale-parent conflicts, downloads, and sanitized API errors. Tasks 4–5 cover the Next proxy, typed client, draft/applied reducer, responsive UI, plot views, controls, history, accessibility, and reduced motion. Task 6 covers local browser acceptance, narrow viewport qualification, documentation, and complete preflight. Task 7 covers the exact isolated Dr.XAS manifest, immutable release, namespaced screens, rollback, and live verification.
- Placeholder scan: The plan contains no unfinished placeholders or unspecified error-handling steps. Deferred product features are named in the spec and are not hidden in implementation tasks.
- Type consistency: RecipeDraft, ParsedUpload, ProcessingResult, WorkspaceSnapshot, PlotTrace, WorkbenchState, and request models are introduced before their consumers. API request field names are consistent across backend routes, frontend client calls, and Playwright assertions.
- Risk checks: The plan preserves Larch defaults, blocks non-monotonic energy instead of sorting it, keeps raw arrays immutable, scopes all mutable paths, avoids shared Dr.XAS resources, and treats push/host writes as explicit gates.
