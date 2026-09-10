# Athena full functional parity matrix

Research baseline: 2026-09-07, Athena 0.9.26 manual, shared branch Athena. See [research notes](athena-research.md) for tutorial sequences, screenshot observations, source verification, and video-access limitations.

The objective remains duplicating Athena into the webapp using tutorial and primary-documentation research. This matrix covers the full documented functional surface and retains requested features whose reference behavior is unresolved. It is not a first-release scope, a claim that the repository lacks every feature, or a claim that duplication is finished.

## Status and evidence rules

**Every implementation status began Pending.** The 2026-09-07 follow-up below records evidence-backed subsets as **Partial**; no row is Verified. The parent owns the separate verification record and subsequent status updates. “Documented,” “upstream TODO,” and “reference gap” describe source evidence; they do not describe implementation progress.

A row can be verified only with concrete implementation paths, relevant passing test/check identifiers, the fixture and reference configuration, and the observed result. A library routine, menu label, screenshot, placeholder response, or pre-existing test filename is insufficient. If only some options work, record the implemented subset and keep the rest open.

The full-row acceptance checks remain proposed work. The original documentation task executed none; the follow-up executed the frontend checks recorded below. “—” means no implementation evidence has been recorded for that row, not that its implementation is necessarily absent. Browser-specific verification requirements are identified as proposed, rather than attributed to desktop Athena.

### Follow-up evidence reviewed on 2026-09-07

The working tree is shared and evolving. These are observations of the current files, not a pinned release or desktop-equivalence certificate. Frontend tests mock both `athenaApi` and `AthenaPlot`, use synthetic three-point arrays and jsdom dialog stubs, and exercise user interactions and request/state contracts. They do not establish numerical accuracy, actual file parsing, Plotly rendering, or live backend integration.

- **F-state:** [workbench tests](../frontend/components/athena-workbench.test.tsx), project-loading, group-selection/draft and single-parameter patch cases, against [AthenaWorkbench](../frontend/components/athena-workbench.tsx) and the [service contract](../frontend/lib/athena.ts). Covers initial creation, saved/recent loading, saved-load retry, independent active/marked state, per-group drafts and failed apply preservation/retry. Single-group `parameters` submits only values differing from accepted parameters: a shift-only edit omits unchanged explicit E0 and accepts the backend-adjusted E0; a changed E0 is included with the shift; unchanged Apply sends an empty patch. Marked `copy_parameters` continues to send full source/draft values. Native-project scientific E0 behavior remains backend verification work.
- **F-import:** Same test file, `AthenaWorkbench batch import`: **seven passing cases**. Compatible files preserve the custom fluorescence/reference mapping and advance accepted versions; reordered columns, different column counts and disabled mapping reuse pause for review; second-file import failure retains the first accepted group and earlier drafts. The previously failing `retries only the failed import with the chosen mapping and resumes the remaining batch` now passes: `inspectFile` preserves mapping for compatible reuse, and retry submits only the failed upload before continuing remaining files. Failed inspection clears the preceding upload from the import action; reselecting the failed file recovers without importing the accepted file again. Live parsing/numerics remain outside these mocks.
- **F-parameters:** Same test file, `AthenaWorkbench parameter copy and reset`, plus the marked-apply case. The compact dialog offers all/normalization/background/forward/reverse/grid or a named parameter, with marked/all/current destinations. Tests exercise background copy to all, explicit energy-shift copy to marked, all-default reset on current, single-Rbkg reset on marked, and failed normalization reset/retry to all. Requests use source ID plus draft values for copy and no source/values for reset. Responses preserve destination shifts for all/section operations, unrelated draft fields and skipped groups' drafts; explicit single-field shift copying updates only that field in drafts. Frozen/empty destination sets disable actions. Backend `last_operation.skipped_group_ids` supplies the displayed skipped count, including groups skipped because of frozen references. These checks verify the UI contract with mocked responses; backend reference/parameter semantics and every section/target combination require separate evidence.
- **F-tools:** Same test file, processing/analysis cases: calibration cancel/submit, marked merge ordering, LCF active target plus explicit standards and exact range/constraint payload, PCA selection independent of marks, multi-peak add/edit/remove and submitted model, and preservation of previous analysis after failure.
- **F-combine:** Same test file, `AthenaWorkbench weighted combinations`, plus the default-merge case. Per-group controls start at one and pair weights with marked IDs in list order. Merge sends relative weights for backend normalization; sum sends signed coefficients unchanged. The default original-data selection omits `array`; explicit choices send `mu`, `norm` or `chi`. Tests cover normalized merge ordering, signed/zero sum coefficients, default/reopened controls, negative/all-zero merge weights rejected visibly by the backend mock with editable retry, and an empty coefficient rejected without a request. χ(k) is enabled for marked processed EXAFS with overlapping k ranges, including mixed input types; missing χ, disjoint ranges and XANES disable it. Difference keeps its existing ordered subtraction payload and receives no weight/array options. Arithmetic, uncertainty products and real rendered plots remain outside these mocks.
- **F-reference:** Same test file, `AthenaWorkbench reference ties`: Group-menu tie submits exactly two marked IDs in list order (sample first), independent of the active group; untie submits the active ID, including an active reference whose sample holds the directional link. Both send empty options. Tests cover zero/one/three marked groups being disabled, accepted shift/link state and the next revision, visible tie errors with drafts preserved, and help explaining bidirectional linked shifts. Actual backend synchronization across edits/reloads still needs separate evidence.
- **F-pick:** [workbench tests](../frontend/components/athena-workbench.test.tsx), `AthenaWorkbench plot picking`, cover draft-only absolute E0, pre/post limits relative to draft or effective E0, direct k/R bounds, reciprocal spline energy/k edits, below-edge rejection, typed fallback, frozen controls, cancellation and stale callback rejection. [plot tests](../frontend/components/athena-plot.test.tsx), `AthenaPlot coordinate picking`, exercise the real wrapper with mocked Plotly: finite numeric x callbacks retain their space and ignore display offsets, missing/nonfinite values, unarmed clicks, q and analysis plots. The [pluck guide][pluck] specifies x-value insertion; the [spline-range guide][range] specifies reciprocal energy/k controls. Live Plotly mouse/focus behavior and desktop scientific comparisons remain open.
- **F-selection:** Workbench `bulk marking and freezing` tests cover ordered all/none metadata payloads, one atomic `selection` invert command, frozen and search-hidden IDs, frontend JavaScript regex matching and case choice, invalid-pattern recovery, empty-target suppression, and freeze/unfreeze for current/marked/all/matching scopes. Mock responses preserve the active group, scientific state and drafts; command errors retain flags and retry the accepted revision. JavaScript syntax is explicitly labelled; Perl-specific regex syntax is not implemented. Backend flag semantics and browser interaction require independent verification.
- **F-background-controls:** Workbench `background science controls` tests exercise the optional, initially false `fnorm` flag as an Apply-only change for raw mu groups. Standard selection excludes self and sources without processed chi, retains separate group drafts, and sends explicit `background_standard` requests or null for None. Failure, retry and backend-reported frozen skips preserve drafts. This is UI-contract evidence; the standard's numerical effect, live dependency updates, cycle rejection, fnorm scientific outputs and persistence require backend/reference evidence.
- **F-project-panel:** Workbench `project import integration` tests mock the standalone panel and check its live accepted-project getter, busy close/Escape guard, accepted groups, last-imported focus and completion callback. Marked-only export uses `marked_only=true` and has no enabled link when marks are empty. Actual preview/restore transactions belong to the standalone panel and backend tests, not these host-contract assertions.
- **B-import (reviewed, not executed here):** [AthenaStore](../backend/xraylarch_web/athena.py), `import_data`, and [project tests](../backend/tests/test_athena_project.py): `test_create_inspect_and_import_persist_across_store_instances`, `test_transmission_reference_kev_sorting_and_multiple_imports`, `test_fluorescence_sums_selected_detector_channels_before_division`, and `test_invalid_detector_mapping_leaves_project_unchanged`. Assertions cover arithmetic, ordering/units, references, persistence, and rejected mappings; their presence is not a passing-run claim.
- **B-project (reviewed, not executed here):** `AthenaStore.restore`/`export_prj` and the project tests `test_project_round_trip_preserves_groups_recipes_references_notes_and_journal`, `test_prj_export_is_readable_by_local_larch`, and `test_native_demeter_project_import_matches_independent_larch_reader`. Includes JSON/compressed/uncompressed exchange and a native project fixture. Desktop Athena round trips and full optional-field preservation remain open.
- **B-peaks (reviewed, not executed here):** [fit_peaks](../backend/xraylarch_web/athena_operations.py) and [operation tests](../backend/tests/test_athena_operations.py), `test_peak_fit_recovers_known_area_center_width_and_background`, `test_two_peak_recovery_with_noise_and_cropped_fit`, and `test_voigt_with_independently_fitted_gamma`. Synthetic fixtures assert parameter recovery, component sums, residuals, and gamma behavior; no scientific execution result is claimed here.

Earlier weighted-combination, reference-tie and changed-parameter patch checkpoint, commands run from `frontend`: `npx vitest run components/athena-workbench.test.tsx` → **47 passed (47)**; `npx vitest run` → **75 passed (75), seven files**; `npx tsc --noEmit --incremental false` → **passed**. Saved-project retry and batch mapping retry also pass. Historical note: during the preceding parameter-controls pass, a full run had 56 passes and one failure in the unchanged classic `WorkbenchShell` test `keeps the last applied plot visible after an invalid preview`; its isolated eight-test file and a full rerun then passed without code changes. Numerical tolerances and pinned backend/reference configurations belong in the parent's verification record; these frontend mocks do not supply them.

Initial picking/selection/background-controls and project-panel wiring checkpoint: `npx vitest run components/athena-workbench.test.tsx components/athena-plot.test.tsx` → **127 passed (127)** (78 workbench and 49 plot cases); `npx vitest run --fileParallelism=false` → **169 passed (169), nine files**, including the separately owned import-panel tests; `npx tsc --noEmit --incremental false` → **passed**; `npm run build` → **passed**, with TypeScript and four static pages generated. The first sandbox build compiled but received empty captured stdout from Next's TypeScript configuration subprocess; the same production build succeeded outside that sandbox. Long workbench flows initially exceeded five seconds on the shared host; that test file now allows 15 seconds per test while individual wait assertions remain bounded. No browser or desktop verification is claimed by this checkpoint, and no row is promoted to Verified.

### Integrated backend and browser evidence

**B-native-normalization (2026-09-09):** [76 regression cases](../backend/tests/test_athena_native_normalization.py) pass for native term-count conversion, JSON/Perl previews and restore, native-only export, historical web sidecars, malformed-order repair/undo, canonical `bkg_funnorm`, and measured Pt normalization with explicit EXAFS repairs. The [pinned-source reference](athena-native-normalization-reference.md) records the contract and Ifeffit limits. Full-suite results are in [verification notes](athena-verification.md). This corrects the earlier native `bkg_fnorm` mapping claim; no requirement is promoted to Verified.

**At the earlier checkpoint, B-core** referred to the 232 passing tests in `test_athena_science.py`, using direct local Larch comparisons and analytical fixtures. **B-constraints/B-exchange** refer to 110 passing tests across `test_athena_project.py` and `test_athena_constraints.py`, with warnings treated as errors. **B-API** refers to 14 passing real FastAPI tests. Commands, fixture identities, runtime versions and live-browser observations are in [athena-verification.md](athena-verification.md). These results establish the stated subsets, not complete desktop parity.

The earlier combined checkpoint passed **565 backend and 119 frontend tests**, plus the production build. **F-plot** adds 44 trace-contract tests with Plotly mocked: correct background display transforms and plotted-group ownership, mixed-weight labels, raw-chi fallback units, weighted-chi fit axes, and forward-window interpolation onto q. Browser checks confirm second derivatives, phase, q-window legend, weighted merge, parameter copy with preserved calibration, and two-file import. Full-parity obligations below remain open.

The subsequent background/project checkpoint adds **B-background** (56 passing real-store tests), **B-preview** (`test_athena_project_preview.py`, run with project exchange tests: 141 passed with warnings treated as errors), and **F-project-import** (15 import-panel tests, including mismatched-mode rejection). **B-core** now has 274 passing science tests and **B-constraints** has 33. These targeted counts overlap the later combined regression totals in the verification record and must not be added to them. Live checks 10–13 in that record cover marking/freezing, native subset preview/import, actual plot picking, reciprocal limits, and a standard-backed k plot. The final integrated check passed **727 backend and 185 frontend tests**, plus TypeScript and the production build. All 107 requirement rows remain intact. The final frontend run includes the captured-pick timing regression, semantic-draft comparisons, signal-mode guard, proxy query forwarding, and readiness-correct legacy preview tests. Live proxy tests exposed and then verified the fix for dropped preview/export query parameters; verification step 15 records the actual returned arrays and formats. Full native/desktop comparisons remain open.

**B-E0**: [E0 science](../backend/xraylarch_web/athena_e0.py) and
[96 numerical cases](../backend/tests/test_athena_e0_science.py) cover analytical
edge fractions, the fraction=1 boundary, source-ordered zero crossings,
first-turnover white-line refinement against independently solved natural
splines, Elam lookup/remappings, calibrated axes, measured copper, and explicit
failure cases. [E0 command tests](../backend/tests/test_athena_e0_commands.py)
exercise atomic recalculation, frozen and nonabsorption skips, reference-shift
preservation, background consumers, rollback, undo and exchange. **F-E0**:
workbench `E₀ selection` cases cover method payloads, current/marked/all scopes,
reports, retry, busy guards and preservation of unrelated drafts. Live checks
in the verification notes cover all six methods on measured copper. These do
not establish native default preferences or a Demeter runtime comparison.

**B-import-policy**: [import initialization](../backend/xraylarch_web/athena_import_policy.py)
has 61 passing science cases for table-seeded range resolution and fraction
refinement, including measured Cu/Fe, misleading pre-edge noise, calibrated
axes, short scans, explicit limits and invalid coverage. The
[25 store cases](../backend/tests/test_athena_import_policy_store.py) check
sample/reference independence, atomic failure and retry, subsequent imports
with enforcement off, chi bypass, frozen existing groups, undo, saved recipes,
preview and independent Larch reading of native identity/fraction/E0 fields.
**F-import-policy**: [policy tests](../frontend/components/athena-edge-policy.test.tsx)
and workbench import-policy cases exercise catalog validation, tab storage,
stale lookups, cancel/stop, immutable batch snapshots and retry. The combined
workbench/policy run passed 130 cases. These are focused counts, overlapping
the subsequent regression totals in the verification record. A browser-tab
preference is a web adaptation of Athena's runtime state. Personal INI
preferences, every scalar default, reference same/different-edge options and
actual desktop execution remain open.

**B-identity / B-derived-identity**: the metadata-only command and persistent
difference flag are covered by 55 identity and 49 derived-group store tests;
the final run with HTTP regressions passed 130 cases. Identity edits preserve
numerical results and recipes, reject frozen/invalid edits atomically, and
survive undo and native/web exchange. Difference copies and transforms retain
their signed energy mode; chi differences retain real Fourier products.
**F-identity**: catalog, save/retry, frozen/busy guards and draft-preservation
cases cover the editor; plot tests distinguish difference and absorption
signals. Live measured-copper checks preserved arrays exactly across identity
edits, difference copies and reprocessing. Counts, scope and open requirements
are recorded in [the checkpoint](athena-verification.md#absorber-identity-and-derived-signals-checkpoint-2026-09-07).

**B-difference / F-difference**: the dedicated difference workflow now supports
all six desktop energy forms, independent DATA/STANDARD selection, scaling,
inversion, per-group flatten choices, source-based Romberg integration, naming
tokens, marked area sequences, optional renormalization and E/k previews.
Preview is read-only and save is atomic. Numeric tests include the original
measured Pt recipe with an explicitly specified Larch normalization oracle;
store and browser evidence distinguish this from native Demeter execution.
See [difference source contract](athena-difference-reference.md) and the
[verification checkpoint](athena-verification.md#difference-tool-checkpoint-2026-09-07).

### Real-project compatibility checkpoint, 2026-09-09

The [project compatibility report](athena-prj-compatibility.md) now records eight
fresh official downloads (57 spectra), source hashes, actual browser upload and
save/reload checks, and the complete retained corpus. All 82 normal projects
import; 1,015 of 1,067 spectra process with saved recipes, while 52 retain
explicit processing errors. The deliberately executable fixture is rejected.
This supplements earlier evidence; it does not verify all native analysis state
or full desktop behavior. All 107 requirement IDs and their order are retained.

## Workspace, groups, and shared parameters

| ID | Required coverage and primary reference | Proposed acceptance check | Implementation | Evidence |
| --- | --- | --- | --- | --- |
| UI-01 | Main tool pane, group pane, project/save controls, and status area. [First look][intro] | Review populated and empty states against the inspected layout. | Pending | — |
| UI-02 | Active group is independent of marked groups; each has its own plot action. [Group list][glist] | Change active group without changing marks; compare both plotting targets. | Partial | F-state: selection, marks, and current/marked plot props pass. Actual plot rendering and desktop interaction comparison remain open. |
| UI-03 | Copy arrays/parameters, rename, reorder, navigate, remove current/marked groups, and close project. [Group list][glist] | Exercise lifecycle operations; preserve stable identity despite duplicate labels. | Pending | — |
| UI-04 | Group context menu, data-type correction, optional selection replot, expandable list, and parameter/array inspection. [Group list][glist] | Check every operation after switching groups. | Pending | — |
| UI-05 | Mark all, none, invert, and regex-matching labels; report invalid patterns. [Marking][mark] | Verify exact resulting membership for each selection action. | Partial | F-selection and 33 B-constraints tests cover all/none/invert flags, regex matching/error recovery, ordered targets and undo. Live copper checks marked only the matching 50 K scan. Perl regex compatibility and exhaustive desktop comparisons remain open. |
| UI-06 | Freeze/unfreeze current, all, marked, or matching groups; communicate frozen state. [Frozen groups][frozen] | Mixed-state batch actions target the intended subset. | Partial | F-selection covers all four scopes and empty targets; B-constraints verifies flag-only persistence and undo. Live marked-only freeze preserved the active 10 K group and froze 50 K. Exhaustive scope combinations in the real browser remain open. |
| UI-07 | Frozen groups reject parameter edits and are skipped by global parameter/alignment operations; removal remains possible. [Frozen groups][frozen] | Verify unchanged scientific parameters after attempted edits. | Partial | B-constraints: direct frozen edits reject; mixed parameter copies, reset and alignment skip frozen groups/reference pairs; source groups stay unchanged when merged. 33 constraint and 85 project tests pass; B-background adds transitive frozen-consumer guards. Full menu scopes and manual mixed-state workflow remain open. |
| UI-08 | Apply one parameter, a section, or all parameters to marked/all groups; restore defaults. All-parameter copy excludes filename/energy shift. [Constraints][constrain] | Compare destination parameters and preserved exceptions. | Partial | F-state/F-parameters: marked Apply uses copy_parameters with source ID, all section and full draft values; single Apply sends only changed fields, preserving explicit E0 patch semantics for shift edits. Dialog supports section/single copy and reset with marked/all/current targets. Shift preservation, defaults, skips, drafts and retry pass with mocks; all combinations and real scientific/desktop behavior remain open. |
| UI-09 | Parameter context actions: shift/step reports, importance reset, edge-step uncertainty exploration, suggested FT upper bound. [Constraints][constrain] | Check each report/action against a reference run. | Pending | — |
| UI-10 | Plot plucking inserts the appropriate x value into a parameter field. [Pluck][pluck] | Test absolute/relative energy and k/R coordinates. | Partial | F-pick covers absolute/relative energy, spline energy, k/R limits, cancellation and typed fallback. Live Plotly click inserted E0=8990.698 without saving it; reciprocal spline input also passed. Processing/analysis-dialog picking and exhaustive live keyboard/focus checks remain open. |
| UI-11 | Preference precedence, per-dataset defaults, and ranges relative to measured extent. [Defaults][defaults] | Import short/long scans under different saved preferences. | Pending | — |
| UI-12 | Processing/plot command buffers, status history, engine command input, and inspectable diagnostics. [Monitor][monitor] | Record browser equivalents and any unresolved engine-console differences. | Pending | — |
| UI-13 | Contextual documentation access and useful error/operation messages. [Introduction][intro] | Reach relevant help from scientific controls; retain actionable failure details. | Partial | F-state/F-tools/F-import/F-parameters: visible service errors preserve accepted state; batch mapping retry passes and skipped-group counts appear in command status. Contextual help coverage and all recovery paths remain open. |

## Import and detector interpretation

| ID | Required coverage and primary reference | Proposed acceptance check | Implementation | Evidence |
| --- | --- | --- | --- | --- |
| IM-01 | File preview, energy/detector mapping, expression and plot preview: transmission ln(I0/It), fluorescence/yield signal/I0. [Columns][columns] | Compare imported arrays to explicit detector arithmetic. | Partial | F-import: preview column controls and custom fluorescence payload pass; B-import contains arithmetic assertions. Editable general expressions and a live spectrum preview are not supplied by this import dialog; live parsing/numeric verification remains open. |
| IM-02 | eV/keV selection; μ(E), XANES, normalized, χ(k), FEFF xmu.dat types; restricted type conversion. [Columns][columns] | Verify units and processing eligibility. | Partial | F-import exercises keV and XANES mapping payloads; B-import contains keV conversion assertions. Remaining type/conversion combinations and FEFF-specific eligibility need evidence. |
| IM-03 | Multi-element detector sum or individual groups; range selection, clear numerator, pause preview. [Columns][columns] | Match each retained channel and summed result. | Partial | F-import submits two selected numerator channels; B-import tests their sum before division. Per-detector group creation, detector range/clear controls, and pause-preview behavior remain open. |
| IM-04 | Multi-file import reuses mapping for matching column labels/count; prompts again on format change. [Multiple import][multiple] | Mix compatible and incompatible file layouts. | Partial | F-import: matching batches, reordered/count-mismatched layouts and opting out of reuse pass. Fixed retry preserves detector/reference mapping for the failed and remaining compatible files without reimporting accepted uploads. Live two-file copper import passed with one mapping and two version advances (verification step 9). Long queues, live induced-failure retry and inspection retry without reselection remain open. |
| IM-05 | Reference detector expression uses shared energy; supports log toggle, preview, and different reference element. [Reference][ref] | Import sample/reference with distinct detector mappings. | Partial | F-import tests distinct reference-channel payloads; B-import contains linked reference arithmetic assertions. This dialog uses a fixed logarithmic reference expression; log toggle, reference spectrum preview and element controls remain open. |
| IM-06 | Sample/reference groups share energy shift bidirectionally; tie two existing groups. [Reference][ref] | Edit either shift and verify its partner, including after reload. | Partial | B-constraints: one-way native links propagate energy shifts bidirectionally, moving explicit E0 by the same delta unless explicitly overridden. Native/sidecar/web round trips, shared topology on notes edits, frozen pairs, retying, untying and undo pass. F-tools covers tie/untie menu requests; a complete live reference workflow remains open. |
| IM-07 | Import-time mark, align, copy standard parameters excluding shift, and three-region rebinning. [Preprocessing][preproc] | Compare automatic processing with equivalent explicit operations. | Pending | — |
| IM-08 | Project preview includes group plots, titles, journal; subset/all/none/invert, periodic and pattern selection. [Project selection][projsel] | Check selected imports and the documented empty-selection-imports-all behavior. | Partial | B-preview and F-project-import verify sampled/full-data previews, journal/notes, stable-ID subset selection, all/none/invert, periodic/regex/shift selection, computed-mode failures and retries. Live native-file preview and alternating-group import passed. Exhaustive native-format and browser selection combinations remain open. B-PRJ and real Chromium tests now open ordinary file-picker projects, render normalized previews and all four plot spaces for cu, zirconolite and athena_json. Multiline Perl/XDI metadata, native JSON and gzip formats are covered by the retained corpus. |
| IM-09 | Batch project import follows whole-project versus subset selection rules. [Multiple import][multiple] | Import several projects and track which prompts recur. | Partial | F-project-import verifies whole-project automatic continuation, subset pauses, accepted revisions and retry without replay. B-preview verifies staged upload reuse and conflicts. Live subset import, initial-preview retry, and two-file whole-project automatic continuation passed. Mid-batch live failure and desktop replay remain open. Real Chromium raw → PRJ → raw batch ordering passes, with both panel handoffs releasing the previous busy state. File-picker and drag/drop dispatch are covered by frontend regressions. |
| IM-10 | Extensible file recognition, transformation, binary/text handling, mapping suggestions, metadata, and plugin registry information. [File plugins][plugin] | Import representative beamline formats without altering originals. | Partial | XDAC V1.2/V1.4 recognition now accepts their metadata headers while strictly validating every data row. 59 new XDAC and 25 existing parsing tests pass; original bytes, labels, roles and arrays match local Larch. Live fe.060 inspection/retry and transmission import passed with all 511 points. General plugin registry, other beamline formats and binary conversion remain open. |
| IM-11 | Detector-type eligibility and unsupported combinations remain explicit. [Columns][columns] | Reject invalid log/division inputs with recoverable feedback. | Partial | B-import contains rejected denominator/log/reference mapping checks without project mutation. F-import covers visible service failures and retained mapping on retry; actual numeric validation and all detector/type combinations remain open. |

## Normalization, AUTOBK, forward FT, and backward FT

Separate scientific stages are required. Shared screen placement must not collapse their parameters or outputs.

| ID | Required coverage and primary reference | Proposed acceptance check | Implementation | Evidence |
| --- | --- | --- | --- | --- |
| SC-01 | Pre-edge regression, post-edge polynomial/order selector, E0-relative ranges, edge-step calculation/fixing, and normalized μ(E). [Normalization][norm] | Compare coefficients, step, and normalized arrays. | Partial | B-core compares normalization with local Larch on measured and synthetic inputs. E0-relative ranges, automatic/fixed step and polynomial degree are available. B-import-policy uses pinned configuration order 3 as Larch degree 2. B-native-normalization now converts native term counts to Larch degrees and back, preserving explicit web recipes and automatic settings. Desktop numerical equivalence and all preference/default variants remain open. B-PRJ also distinguishes Larch-writer degree zero from Demeter term counts and resolves native outer limits to measured support while retaining original arguments. |
| SC-02 | Flattening is selectable and distinct from normalization; it does not change extracted χ(k). [Normalization][norm] | Toggle flattening and compare energy plots and χ(k). | Partial | B-core: flattening is independently tested against normalized arrays and does not change chi. Browser E-mode switching renders separate raw/normalized/flat products. Full desktop/reference configuration comparison remains open. |
| SC-03 | Show pre/post-edge curves and selected ranges; handle limited-range XANES with explicit normalization settings. [Normalization][norm], [Short scans][short] | Exercise insufficient and usable fit ranges. | Pending | — |
| SC-04 | E0 methods: derivative peak, atomic table, edge fraction, second-derivative crossing, white-line peak, manual input; batch application. [E0][e0] | Compare all methods on representative edges. | Partial | B-E0/F-E0: six methods, current/marked/all application, bounded interpolation/iteration, atomic lookup, saved results and skip reports. Live Cu K checks pass. Initial finding and normalization use local Larch; selectable native preferences, full representative-edge coverage and direct Demeter runtime comparisons remain open. |
| SC-05 | Enforce and stop enforcing absorber/edge during import and default determination. [E0][e0] | Switch to a different element after disabling enforcement. | Partial | B-import-policy and F-import-policy implement tab-scoped enable/stop and request-scoped table → resolved defaults → fraction initialization, separate from group identity and saved recipes. Tests cover Cu then Fe with policy off, independent references, failure/retry, chi bypass and inert project provenance. Live Cu K import followed by Stop and actual fe.060 transmission import passed; original groups were unchanged and QA imports undone. [Pinned source contract and limits](athena-edge-enforcement-reference.md). Complete desktop/default-preference and reference-option comparisons remain open. |
| SC-06 | AUTOBK removes background using Rbkg; retain μ0(E) and χ(k) products. [AUTOBK][rbkg] | Replay T3 and compare numerical output across Rbkg choices. | Partial | B-core: AUTOBK Rbkg processing retains bkg and chi arrays and compares to direct Larch calculations. Measured copper processing is exercised in service/API and browser checks. T3 desktop tutorial replay remains open. |
| SC-07 | Independent background k-weight and low/high spline clamps: none/slight/weak/medium/strong/rigid; configurable clamp values/point count. [Clamps][bkgkw] | Vary these independently of plot/FT weight. | Partial | B-core: independent bkg_kweight, bkg_dk, bkg_window and nclamp controls, numeric clamp strengths, and direct AUTOBK comparisons pass. Named clamp presets and all native preference conventions remain open. Native named clamps now follow the pinned Demeter values 0/3/6/12/24/96, including case variations. The preset-selection UI remains open. |
| SC-08 | Spline limits editable in energy or k with reciprocal updates; values outside the spline range handled consistently. [Spline range][range] | Edit/pluck either representation and compare χ(k). | Partial | F-pick covers reciprocal draft controls with E − E0 = 3.8099821109685847 k², automatic upper-bound clearing and recoverable below-edge input. End-to-end chi, endpoint/out-of-range conventions and native-default equivalence remain open. |
| SC-09 | Background-removal standard selection. [Project attributes][project] | Verify standard semantics and numerical effect. | Partial | B-background (56 tests) covers actual Larch standard effects, live chains, topology, cycles, coverage, freeze guards, copy/reset, deletion repair and undo. B-preview remaps bkg_stan independently of reference_id. Live standard assignment rendered chi. Ifeffit automatic amplitude adjustment and desktop equivalence remain open; current amplitude is fixed. |
| SC-10 | Optional energy-dependent normalization, preference visibility, persisted flag, and distinct energy versus χ outputs. [Energy dependence][ednorm] | Compare enabled/disabled processing on a suitable reference fixture. | Partial | B-core now includes 274 science tests: source-grounded fnorm sequence, independent corrected-mu processing, unchanged E arrays, strict flags and invalid-fit rejection. B-background/B-preview verify persistence; B-native-normalization corrects native exchange to bkg_funnorm and preserves obsolete bkg_fnorm as unapplied metadata. F-background-controls checks eligibility/drafts. Preference visibility and exact Ifeffit scientific equivalence remain open. |
| SC-11 | Forward FT: k limits, dk, window, complex output. [Project attributes][project] | Compare grids, windows and components. | Partial | B-core: independent k limits, dk/window, FFT grid, real/imaginary/magnitude/phase arrays and direct FFT comparisons pass. R-space rendering is checked with measured copper. Complete pinned Demeter comparison remains open. B-PRJ compares wide Kaiser/Gaussian shape parameters and the zero-beta legacy limit to direct Larch transforms, and permits physical support beyond the last full AUTOBK grid step. |
| SC-12 | Plot/FT k-weight selector supports 0/1/2/3 and per-group arbitrary values. [k-weights][plotkw] | Confirm selected weight affects the FT and is not applied twice. | Partial | B-core: fractional weights are preserved through recipes and tested against low-level FFT weighting without the integer-cast loss; independent background weight is tested. Browser applied 1.5 and copied it while preserving energy shifts. Full native plot/FT selector behavior remains open. |
| SC-13 | Backward FT: independent R limits, dR, window, χ(q). [Project attributes][project] | Compare filtered and original χ(k). | Partial | B-core: separate R limits/dR/window produce complex q arrays; signs and phases reconstruct the complex back-transform. Browser renders q magnitude/phase. Desktop/reference-window equivalence remains open. The zero-beta native reverse Kaiser window now processes through Larch’s legacy Bessel formula; twelve yb_iron groups pass and one retains a real nonpositive-step error. Log-ratio filtering uses the same window convention. |
| SC-14 | Central-atom phase correction propagates through R/q; associated window and original-k limitations remain visible. [Special plots][special] | Compare corrected/unadjusted products. | Pending | — |
| SC-15 | FT k-range affects spectral resolution independently of AUTOBK choices. [Resolution][krange] | Compare copied scans with only FT limits changed. | Partial | B-core: varying forward controls leaves the background solution unchanged in dedicated tests. Quantified desktop resolution/tutorial comparison remains open. |

## Scientific plotting and presentation

| ID | Required coverage and primary reference | Proposed acceptance check | Implementation | Evidence |
| --- | --- | --- | --- | --- |
| PL-01 | E: raw/normalized/derivative views; current-group background and pre/post-edge overlays; separate marked options and E0-relative limits. [Tabs][tabs] | Compare plotted traces and range coordinates. | Partial | F-plot tests raw/normalized/derivative trace selection and background scale/offset/stack consistency. Only the plotted active group supplies overlays. Live E and second-derivative plots pass. Independent marked options and E0-relative plot limits remain open. |
| PL-02 | k in Å⁻¹: weighted χ(k), optional χ(E), transform-window overlay, independent limits. [Tabs][tabs] | Compare window and energy conversion numerically. | Partial | F-plot derives k-weight labels from rendered traces and identifies mixed weights; failed chi processing shows unprocessed chi on a k axis. Forward-window overlay uses actual kwin values. Chi(E), all native marked options and desktop comparison remain open. |
| PL-03 | R in Å: real/imaginary/magnitude/phase, envelope, current-versus-marked selection rules, limits. [Tabs][tabs] | Verify component values and selectable combinations. | Partial | B-core supplies complex R arrays; F-plot verifies components and no second weighting. Actual R magnitude renders in the browser. Simultaneous components, envelope and all native selection rules remain open. |
| PL-04 | q in Å⁻¹: filtered real/imaginary/magnitude/phase, envelope, window, limits. [Tabs][tabs] | Plot actual back-transform products. | Partial | B-core supplies signed complex q and unwrapped phase. F-plot tests actual components and forward kwin interpolation onto q without extrapolation; browser q phase/window checks pass. Envelope and complete native comparison remain open. |
| PL-05 | Second derivatives and kq comparison controls. [Populated screenshot](https://bruceravel.github.io/demeter/documents/Athena/_images/athena_withdata.png) | Verify each control's scientific data source. | Partial | B-core/F-plot and browser checks cover second-derivative arrays and rendering. Combined kq comparison controls remain open. |
| PL-06 | Group plot multiplier and vertical offset. [Plot parameters][plotparams] | Ensure presentation changes do not alter source arrays. | Partial | F-plot verifies multiplier/group offset/stack offset without modifying native arrays; current backgrounds receive the same transforms. Full live metadata-edit and desktop comparison remain open. |
| PL-07 | Stack marked groups from start/increment offsets; title and inside/outside/corner/hidden legend settings. [Other plots][otherplot] | Check reordered group presentation. | Pending | — |
| PL-08 | Zoom and live cursor coordinates; indicators linked across E/k/q, with R-specific indicators. [Other plots][otherplot] | Verify units and mapping after zoom. | Pending | — |
| PL-09 | Four independent plot targets and timed marked-group display. [Other plots][otherplot] | Preserve an earlier plot while updating another. | Pending | — |
| PL-10 | PNG/PDF last-plot export and next-plot column export with applied scale/offset; retain documented multipanel/marker limitations. [Other plots][otherplot] | Compare exports to displayed content. | Pending | — |
| PL-11 | Save, load, delete named plot styles across sessions. [Styles][styles] | Restore different XANES/EXAFS option presets. | Pending | — |
| PL-12 | Quad and two-group bi-quad; normalized+derivative, μ+I0+signal, k123 and R123. [Special plots][special] | Validate panel/group membership and diagnostic scaling. | Pending | — |
| PL-13 | Marked E0-at-zero, I0, edge-step-scaled plots; merge spread plots; optional XKCD style. [Special plots][special] | Verify calculations and documented cosmetic mode. | Pending | — |

## Processing and derived groups

| ID | Required coverage and primary reference | Proposed acceptance check | Implementation | Evidence |
| --- | --- | --- | --- | --- |
| PR-01 | Calibration: selectable point/target, derivative views, smoothing, second-derivative zero crossing; update E0 and energy shift. [Calibration][cal] | Verify selected point lands on target energy. | Partial | F-tools: cancel makes no request; typed observed/target values reach the active-group command. Picking, derivative/smoothing aids and numeric E0/shift equivalence remain open. |
| PR-02 | Alignment: choose fixed standard, manual shifts, automatic shift/scale fitting, fit representation and uncertainty. [Alignment][align] | Compare shifts and alignment diagnostics. | Pending | — |
| PR-03 | Marked-group and reference-channel alignment; preserve distinct E0 handling. [Alignment][align] | Replay T2, including linked sample/reference scans. | Pending | — |
| PR-04 | Merge marked μ(E), normalized μ(E), or χ(k); importance/noise/edge-step weighting, spread arrays and short-scan preferences. [Merge][merge] | Compare weighted mean and uncertainty products. | Partial | F-combine/F-tools: ordered relative-weight and signal payloads, unit defaults, χ eligibility, derived-group selection and backend-error retry pass. Backend numeric normalization, noise/edge-step weighting modes, uncertainty/spread presentation and short-scan preferences remain open in this audit. |
| PR-05 | Merge references when every energy-domain input has one; retain sample/reference linkage. [Merge][merge] | Verify both generated groups and linkage. | Pending | — |
| PR-06 | Rebin: pre-edge/edge energy grids plus uniform-k EXAFS grid, boundaries, boxcar averaging, E/k preview, current/marked derived groups. [Rebin][rebin] | Compare grids and binned values. | Pending | — |
| PR-07 | Deglitch individual points or pre/post-edge tolerance margins; inspect μ(E)/χ(E); remove points without source-file edits. [Deglitch][deg] | Verify exact removed indices and retained originals. | Pending | — |
| PR-08 | Truncate before/after a typed or plucked boundary. [Truncation][deg] | Check boundary inclusion and downstream recomputation. | Pending | — |
| PR-09 | Boxcar, Gaussian, repeated three-point smoothing; Savitzky–Golay when using Larch; preview and derived group. [Smoothing][smooth] | Verify filter parameters and backend eligibility. | Pending | — |
| PR-10 | Gaussian/Lorentzian convolution width, optional edge-step-scaled random noise, preview and derived group. [Convolution][conv] | Check broadening and reproducible noise verification. | Pending | — |
| PR-11 | Deconvolution remains requested; reference page is upstream TODO. [Deconvolution][deconv] | Obtain executable reference/specification before asserting parity. | Pending | — |
| PR-12 | Self-absorption: Fluo, Booth, Tröger, Atoms; composition/geometry, suitable XANES/EXAFS mode, finite-thickness/density controls, corrected group. [Self-absorption][sa] | Compare each applicable algorithm. | Pending | — |
| PR-13 | Information-depth plots and correction applicability; Booth is the documented finite-thickness option. [Self-absorption][sa] | Verify angle/thickness/density units and results. | Pending | — |
| PR-14 | Dispersive/pixel-energy correction remains requested; reference page is upstream TODO. [Dispersive XAS][pixel] | Resolve calibration model, controls, and fixtures. | Pending | — |
| PR-15 | Multi-electron excitation removal: shifted/reflected data or arctangent, energy/amplitude/broadening controls, E/k previews, derived group. [MEE][mee] | Compare both models and parameter limits. | Pending | — |
| PR-16 | Copy series: parameter/start/increment/count; marked copies, suitable plots, edge-step mean/spread where applicable. [Series][series] | Verify copy count and assigned values. | Pending | — |
| PR-17 | User-weighted sums of μ(E), normalized μ(E), or χ(k); signed/unconstrained weights, components/marked overlays, R plot for χ, derived group. [Summation][sum] | Distinguish summation from fitted mixtures and averaging. | Partial | F-combine: signed and zero coefficients retain order and magnitude; defaults/reset, common-signal selector and accepted derived group pass with mocks. Live arithmetic, every signal/type combination, components/marked overlays and χ-to-R visualization remain open. |

## Analysis tools

| ID | Required coverage and primary reference | Proposed acceptance check | Implementation | Evidence |
| --- | --- | --- | --- | --- |
| AN-01 | LCF normalized/flattened, derivative, χ(k); range, interpolation, standards capacity. [LCF][lcf] | Compare supported input forms. | Partial | F-tools: active target is first, standards are explicitly selected, and flattened-array/range payloads pass. Other representations, interpolation, capacity and real calculations require evidence. |
| AN-02 | LCF bounds/sum constraint, independent/shared energy shifts, post-edge linear term, optional noise. [LCF][lcf] | Exercise every toggle and report actual weight sums. | Partial | F-tools checks exact array/xmin/xmax/nonnegative/sum_to_one options without unrelated defaults. Per-standard bounds, energy-shift models, linear term, noise and numerical constraint behavior remain open. |
| AN-03 | LCF components/residuals, statistics and uncertainty limitations, fit/difference groups, reports/reset. [LCF][lcf] | Check exports and derived-group types. | Partial | F-tools: mocked analysis reaches the plot handoff; a failed replacement keeps prior results and edited dialog inputs. Real component/residual rendering, statistics, derived groups and exports remain unverified. |
| AN-04 | LCF marked fits and batch CSV; model changes require rerunning the batch. [LCF][lcf] | Reject stale-result interpretation. | Pending | — |
| AN-05 | LCF combinations, required standards, maximum size, ranked selection and all-fit reports. [LCF][lcf] | Compare combinations and selected result. | Pending | — |
| AN-06 | PCA marked ensemble, analysis range, components and data-stack plots. [PCA][pca] | Compare decomposition products. | Partial | F-tools: PCA dialog membership is independent of project marks and submits the selected IDs/range. Decomposition values, component plots and full data-stack presentation remain open. |
| AN-07 | PCA scree/log-scree, cumulative variance, selected-component reconstruction, target transformation and coefficients. [PCA][pca] | Verify marked/unmarked target eligibility. | Pending | — |
| AN-08 | PCA cluster plot is unimplemented in this reference; chapter incomplete. [PCA][pca] | Resolve remaining behavior explicitly. | Pending | — |
| AN-09 | Peak/step model: arctangent, erf, Gaussian, Lorentzian, pseudo-Voigt; Larch adds logistic, Voigt, Pearson7, Student-t. [Peaks][peak] | Verify shape definitions and backend availability. | Partial | F-tools selects Gaussian/Lorentzian/Voigt; B-peaks contains corresponding recovery assertions. Remaining documented shapes/steps are absent from this peak editor and need implementation/reference comparison. |
| AN-10 | Peak centers/amplitudes/widths/shape parameters, fixed/varied states, add/change functions, pluck initialization, preview/reset. [Peaks][peak] | Compare fitted and fixed parameters. | Partial | F-tools adds, edits and removes multiple peaks, then checks the surviving model for the active group. Fixed/varied controls, additional shape parameters, pluck initialization and full preview/reset remain open. |
| AN-11 | Peak data/fit/components/residual reports; marked sequences, row inspection, parameter evolution, spreadsheet uncertainties. [Peaks][peak] | Compare single and batch results/exports. | Partial | F-tools checks a single-group fit handoff; B-peaks contains component-sum/residual assertions. Marked sequences, parameter-evolution views and spreadsheet uncertainty reports remain open. |
| AN-12 | Log-ratio/phase-difference: standard/unknown, FT/filter/fit ranges, cumulants through fourth order, plots and export. [Log-ratio][lr] | Verify sign conventions and isolated-shell reference outputs. | Pending | — |
| AN-13 | Difference: raw/normalized/first/second derivative, scaled standard, inversion, optional input overlays. [Difference][diff] | Check subtraction direction and scaling. | Partial | B-difference/F-difference implement xmu/norm/der/nder/sec/nsec, per-input flatten resolution, explicit STANDARD, signed multiplier, inversion, full STANDARD grid with reported extrapolation, and DATA/STANDARD overlays. Live scaled/inverted copper E and k previews passed; saved arrays exactly match the Larch-template formula. Actual Demeter/Ifeffit execution, its qinterp alternative and broader native preprocessing equivalence remain open. |
| AN-14 | Difference integration bounds, marked-series area plot, group naming tokens, normalized/renormalize result type. [Difference][diff] | Compare integrals and saved groups. | Partial | B-difference/F-difference implement E0-relative typed/picked bounds, natural-spline Romberg areas with convergence reports, marked-series plots, naming tokens and explicit renormalization. Save is atomic, preserves originals and records correct native type/is_nor/mode flags; live signed batch and processed raw saves plus Undo passed. Real mouse picks updated both bounds, invalidated the old preview and recalculated the area on measured copper. Actual desktop round-trip execution and complete historical native-type semantics remain open. |

## Metadata, persistence, preferences, and export

| ID | Required coverage and primary reference | Proposed acceptance check | Implementation | Evidence |
| --- | --- | --- | --- | --- |
| IO-01 | XDI version/families, acquisition/analysis history, absorber/edge, editable saved comments, beamline metadata extraction. [Metadata][meta] | Compare imported and exported metadata without loss. | Partial | B-identity/F-identity and live Fe L3 selection on a Cu scan verify independent absorber/edge editing with unchanged E0, recipes, arrays and drafts, plus native/web exchange. Full XDI families, comment editing, beamline extraction and lossless metadata round trips remain open. |
| IO-02 | Editable project journal survives saving and importing. [Journal][journal] | Round-trip multiline notes. | Partial | B-project has journal exchange assertions and local Larch reader comparison. Browser journal editing/saving and desktop round-trip checks remain open in this audit. |
| IO-03 | Typed preferences, descriptions, default reset, session application and saving, scientific and appearance settings. [Preferences][prefs] | Verify persistence and intended scope. | Pending | — |
| IO-04 | Save/save-as/marked-only .prj; data, parameters, ordering and analysis state; legacy and JSON/compressed formats. [Projects][project] | Round-trip with desktop Athena. | Partial | B-project covers exchange assertions and local Larch import/export readers; F-state covers saved/recent project loading. Marked-only save, every legacy/analysis field and actual desktop Athena round trips remain open. Eight official downloaded projects pass web JSON/PRJ export/reload with exact raw arrays, recipes, metadata and calculated arrays; three also pass actual browser download/reupload and refresh. |
| IO-05 | Full import restores LCF/PCA/peak state; subset import differs. [Projects][project] | Compare whole/subset round trips. | Partial | B-exchange: saved web LCF/PCA/peak reports survive native-sidecar/web exchange with remapped group IDs and preserved or stale source-version status. Native fit properties are retained as metadata, not executable/restored models; subset selection remains open. |
| IO-06 | Dirty/save reminder and version compatibility. [Projects][project] | Check unsaved changes and format identification. | Pending | — |
| IO-07 | Export μ(E)/normalization/background/derivatives/I0, weighted χ(k), complex R/q, phases, and window arrays. [Columns][columnout] | Compare schema, units, and numeric values. | Partial | B-API: 14 passing HTTP tests cover E/k/R/q CSV exports, complex arrays, distinct population-scatter/measurement-error columns on native grids, and raw export after failed zero-sum normalization. I0 export, XDI headers and all desktop options remain open. |
| IO-08 | Export current, marked-wide-table, or separate marked files in group order with XDI/processing headers. [Columns][columnout] | Verify filenames, labels, ordering and metadata. | Pending | — |
| IO-09 | All/marked parameter spreadsheet; empirical fitting-standard export for ARTEMIS. [Reports][report] | Open reports and validate the empirical-standard consumer. | Pending | — |

## Companion surface retained for scope resolution

Hephaestus is separately identified in the manual. These rows keep its presence explicit; they do not substitute for any Athena row or silently expand the objective to all ARTEMIS functionality.

| ID | Required coverage and primary reference | Proposed acceptance check | Implementation | Evidence |
| --- | --- | --- | --- | --- |
| CP-01 | Hephaestus: absorption/line tables, filter selection, formulas/transmission, ion-chamber absorption/flux. [Companion][hephaestus] | Resolve inclusion and numeric reference fixtures. | Pending | — |
| CP-02 | Elemental/ionic/neutron data, transitions, edge/harmonic and line finders. [Companion][hephaestus] | Record required databases and query behavior. | Pending | — |
| CP-03 | Standards library, normalized/derivative plots, f′/f″ calculations/export, preferences and known limitations. [Companion][hephaestus] | Resolve inclusion and source-data provenance. | Pending | — |

## Cross-cutting evidence and full-parity gaps

These are proposed implementation-verification obligations derived from the coverage above. They are not claims about extra desktop features.

| ID | Gap that must remain open until resolved | Proposed evidence | Implementation | Evidence |
| --- | --- | --- | --- | --- |
| GP-01 | Implementation evidence must cover the complete matrix. | Map each row to UI, API, scientific routines, and passing checks. | Partial | This follow-up maps tested frontend subsets and explicitly labels backend code/test review. Remaining rows and full-row scientific/workflow acceptance still require evidence. |
| GP-02 | Numerical defaults, normalization-order conventions, window choices, interpolation, grids, scaling and phase conventions require a pinned reference. | Versioned configuration and toleranced array comparisons for every scientific stage. | Partial | B-core records Python/scientific-library versions and measured-fixture SHA-256 identities in athena-verification.md. Direct Larch comparisons cover normalization, background, fractional FFT and complex q. A pinned Demeter/Ifeffit reference across every stage remains open. |
| GP-03 | Tutorial paths are read, not replayed. | Browser and desktop runs of T1–T4 with equivalent parameters and outputs. | Pending | — |
| GP-04 | Video playback/transcripts remain unverified. | Access and review the linked videos; add bounded summaries with supported timestamps. | Pending | — |
| GP-05 | Upstream TODO/incomplete features do not define working behavior. | Resolve PR-11, PR-14, AN-08 and companion scope; retain the decision and any added specification. | Pending | — |
| GP-06 | Numerical-library availability does not prove a usable workflow. | User operation reaches validated calculation, plot, persistence and export where applicable. | Pending | — |
| GP-07 | Stateful interactions need end-to-end coverage. | Mixed marked/unmarked/frozen groups, reference ties, reorder/rename, partial import and reload checks. | Partial | F-state/F-import/F-parameters/F-combine/F-reference pass selection, drafts, reload, partial import/retry, skipped groups, weighted-order payloads and tie/untie revisions with mocks. Actual reference/E0 synchronization, reorder/rename combinations and live end-to-end coverage remain open. |
| GP-08 | Derived-product validity and provenance need explicit handling. | Preserve originals; record parents/parameters; invalidate downstream products and obsolete analysis results after upstream changes. | Partial | B-derived-identity retains the persistent difference flag, primary absorber/edge and saved fraction across numeric transforms, combinations and copy series, independently of latest-operation provenance. Original groups remain unchanged and parent IDs are recorded. Complete provenance retention/remapping, mixed-source identity policy, dependency invalidation and native analysis semantics remain open. |
| GP-09 | Browser adaptation needs equivalent usable controls. | Keyboard access, clear units, visible validation, plot picking, reachable dense controls, and recoverable operation failures. | Partial | F-state/F-tools/F-import/F-parameters/F-pick/F-selection/F-background-controls check accessible controls, visible errors, typed input, Escape cancellation, coordinate handoffs, drafts and skipped counts. Dialogs and plotting engines are stubbed; live keyboard/mouse focus, browser accessibility and dense-layout review remain open. |
| GP-10 | Real-world input failures and long batch jobs need verification. | Irregular/duplicate grids, missing/nonfinite values, invalid expressions, insufficient ranges, progress/cancellation, and partial-failure recovery checks. | Partial | F-import covers incompatible layouts, stopping on second-file failure, retaining the first import, mapping-preserving automatic-import retry, and inspection recovery by file reselection. Accepted uploads are removed from the import action before the next inspection. Real malformed inputs, inspection retry without reselection, long queues, cancellation and progress need further evidence. |
| GP-11 | .prj exchange needs field-level preservation and compatible parsing. | Both-direction legacy/JSON fixtures, optional arrays/metadata/state, compression and unsupported-field reporting; never execute imported project code. | Partial | B-project has native-reader and compressed/uncompressed/JSON round-trip assertions. complete optional-state preservation, unsupported-field reporting, safe parsing and desktop compatibility remain verification obligations. B-PRJ now runs safe native parsing across the complete retained corpus. All 82 normal projects import; executable danger.prj is rejected. Official-fixture tests and real browser round trips are documented in athena-prj-compatibility.md. |
| GP-12 | No completion claim is supported by the inventory alone. | Parent retains unresolved rows and documents any approved behavior differences before assessing full parity. | Pending | — |

## Evidence entry format

For each updated row, record:

- Implementation files and relevant symbols/routes.
- Reference version/backend/preferences and fixture identity/checksum.
- Test or manual reproduction identifier, command, date, and result.
- Numerical tolerances where applicable.
- Unimplemented options, differences, and failure conditions.

Do not mark an entire tool verified because its simplest path works. A full-parity assessment must include its batch behavior, saved state, outputs, and the unresolved gaps above.

## Source links

Primary links in the tables resolve directly to the manual. The [source register](athena-research.md#primary-source-register) records the research evidence and the [video section](athena-research.md#youtube-discovery-and-verification-limits) records access limitations.

[index]: https://bruceravel.github.io/demeter/documents/Athena/index.html
[intro]: https://bruceravel.github.io/demeter/documents/Athena/intro.html
[columns]: https://bruceravel.github.io/demeter/documents/Athena/import/columns.html
[projsel]: https://bruceravel.github.io/demeter/documents/Athena/import/projsel.html
[multiple]: https://bruceravel.github.io/demeter/documents/Athena/import/multiple.html
[ref]: https://bruceravel.github.io/demeter/documents/Athena/import/ref.html
[preproc]: https://bruceravel.github.io/demeter/documents/Athena/import/preproc.html
[norm]: https://bruceravel.github.io/demeter/documents/Athena/bkg/norm.html
[rbkg]: https://bruceravel.github.io/demeter/documents/Athena/bkg/rbkg.html
[bkgkw]: https://bruceravel.github.io/demeter/documents/Athena/bkg/kweight.html
[range]: https://bruceravel.github.io/demeter/documents/Athena/bkg/range.html
[ednorm]: https://bruceravel.github.io/demeter/documents/Athena/bkg/ednorm.html
[short]: https://bruceravel.github.io/demeter/documents/Athena/bkg/short.html
[tabs]: https://bruceravel.github.io/demeter/documents/Athena/plot/tabs.html
[krange]: https://bruceravel.github.io/demeter/documents/Athena/plot/krange.html
[otherplot]: https://bruceravel.github.io/demeter/documents/Athena/plot/other.html
[plotparams]: https://bruceravel.github.io/demeter/documents/Athena/plot/params.html
[special]: https://bruceravel.github.io/demeter/documents/Athena/plot/etc.html
[glist]: https://bruceravel.github.io/demeter/documents/Athena/ui/glist.html
[mark]: https://bruceravel.github.io/demeter/documents/Athena/ui/mark.html
[pluck]: https://bruceravel.github.io/demeter/documents/Athena/ui/pluck.html
[styles]: https://bruceravel.github.io/demeter/documents/Athena/ui/styles.html
[plotkw]: https://bruceravel.github.io/demeter/documents/Athena/ui/kweight.html
[frozen]: https://bruceravel.github.io/demeter/documents/Athena/ui/frozen.html
[monitor]: https://bruceravel.github.io/demeter/documents/Athena/ui/monitor.html
[constrain]: https://bruceravel.github.io/demeter/documents/Athena/params/constrain.html
[e0]: https://bruceravel.github.io/demeter/documents/Athena/params/e0.html
[defaults]: https://bruceravel.github.io/demeter/documents/Athena/params/defaults.html
[columnout]: https://bruceravel.github.io/demeter/documents/Athena/output/column.html
[project]: https://bruceravel.github.io/demeter/documents/Athena/output/project.html
[report]: https://bruceravel.github.io/demeter/documents/Athena/output/report.html
[cal]: https://bruceravel.github.io/demeter/documents/Athena/process/cal.html
[align]: https://bruceravel.github.io/demeter/documents/Athena/process/align.html
[merge]: https://bruceravel.github.io/demeter/documents/Athena/process/merge.html
[rebin]: https://bruceravel.github.io/demeter/documents/Athena/process/rebin.html
[deg]: https://bruceravel.github.io/demeter/documents/Athena/process/deg.html
[smooth]: https://bruceravel.github.io/demeter/documents/Athena/process/smooth.html
[conv]: https://bruceravel.github.io/demeter/documents/Athena/process/conv.html
[deconv]: https://bruceravel.github.io/demeter/documents/Athena/process/deconv.html
[sa]: https://bruceravel.github.io/demeter/documents/Athena/process/sa.html
[pixel]: https://bruceravel.github.io/demeter/documents/Athena/process/pixel.html
[mee]: https://bruceravel.github.io/demeter/documents/Athena/process/mee.html
[series]: https://bruceravel.github.io/demeter/documents/Athena/process/series.html
[sum]: https://bruceravel.github.io/demeter/documents/Athena/process/sum.html
[lcf]: https://bruceravel.github.io/demeter/documents/Athena/analysis/lcf.html
[pca]: https://bruceravel.github.io/demeter/documents/Athena/analysis/pca.html
[peak]: https://bruceravel.github.io/demeter/documents/Athena/analysis/peak.html
[lr]: https://bruceravel.github.io/demeter/documents/Athena/analysis/lr.html
[diff]: https://bruceravel.github.io/demeter/documents/Athena/analysis/diff.html
[meta]: https://bruceravel.github.io/demeter/documents/Athena/other/meta.html
[journal]: https://bruceravel.github.io/demeter/documents/Athena/other/journal.html
[plugin]: https://bruceravel.github.io/demeter/documents/Athena/other/plugin.html
[prefs]: https://bruceravel.github.io/demeter/documents/Athena/other/prefs.html
[exampledata]: https://bruceravel.github.io/demeter/documents/Athena/examples/data.html
[examplelcf]: https://bruceravel.github.io/demeter/documents/Athena/examples/aucl.html
[hephaestus]: https://bruceravel.github.io/demeter/documents/Athena/hephaestus.html
