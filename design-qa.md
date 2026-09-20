# Design QA: Search menu navigation label

## Visual truth and capture conditions

- Source visual truth: `/var/folders/pc/t6fzh36n1rx2d5m1wlmxq8gr0000gq/T/codex-clipboard-c95c1be3-b40c-47de-b40c-866a20150378.png` (226 x 96 px, treated as a 2x crop and normalized to 113 x 48 CSS px).
- Requested delta: replace the visible `Help` label with `Search menu` while preserving the existing header control and search behavior.
- Implementation route: `http://localhost:3004/` in the Codex in-app Browser.
- Browser-rendered implementation screenshot: inline Codex in-app Browser capture; the browser integration did not expose a filesystem path.
- Observed viewport: 1280 x 720 CSS px, device scale 1.
- Focused measurements: normalized source crop 113 x 48 CSS px; implementation button 122.61 x 34.20 CSS px; focused comparison crop 154.61 x 58.20 CSS px.
- State: light theme, saved copper-foil project loaded, command-search trigger closed and focused.

## Findings

- No remaining P0, P1, or P2 findings.
- The visible label is exactly `Search menu`.
- The existing background, corner radius, typography, padding, chevron, and control height remain unchanged.
- The wider button is the expected consequence of the longer requested label and does not disturb the desktop header layout.

## Required fidelity surfaces

- Fonts and typography: the existing header button font, weight, line height, and text color are unchanged.
- Spacing and layout rhythm: existing padding, gap, alignment, and rounded container are unchanged; only intrinsic width grows for the new copy.
- Colors and visual tokens: the existing light-theme control background, foreground, focus, and hover tokens are unchanged.
- Image quality and asset fidelity: the control contains no raster asset; it retains the existing Lucide `ChevronDown` icon.
- Copy and content: visible `Help` is replaced by `Search menu`; the search dialog's existing labels and command paths remain intact.

## Interaction evidence

- Clicking `Search menu` opened the `Search menu commands` dialog and set `aria-expanded` to `true`.
- The search field received focus automatically.
- Entering `smooth` displayed the enabled `Process › Smooth data` command.
- Pressing Escape closed the dialog and restored focus to the `Search menu` trigger.
- No browser console warnings or errors were observed during the interaction check.

## Full-view and focused comparison evidence

- Full-view evidence: the live Athena workspace at 1280 x 720 shows the renamed control in the unchanged top navigation.
- Focused evidence: the normalized source crop and the final browser-rendered button were emitted together in one comparison view.
- The only intentional visual differences are the requested text and its resulting intrinsic width.
- Existing responsive flex-wrap rules are unchanged. A 390 px in-app Browser viewport override did not take effect, so a separate mobile visual capture remains a low-risk test gap for this copy-only change.

## Comparison history

- Pass 1: no actionable P0, P1, or P2 visual difference was found.

## Regression checks

- `components/athena-workbench.test.tsx`: 273 tests passed.
- The focused tests cover dialog opening, menu-path filtering, Escape handling, and trigger focus restoration under the new accessible name.
- `npm run typecheck`: passed.
- `git diff --check`: passed.

final result: passed

# Design QA: top-loaded copper examples

## Visual truth and capture conditions

- Source visual truth: `/var/folders/pc/t6fzh36n1rx2d5m1wlmxq8gr0000gq/T/codex-clipboard-a71ba503-c4b1-4617-823b-6119de40318c.png` (542 x 214 px), used for the dashed example action, purple waveform icon, copy hierarchy, and compact caption treatment.
- Requested delta: move the example action to the top of the Data groups panel, add the supplied room-temperature Cu₂O spectrum, and organize the example spectra into collapsible `Temperature series` and `reference` folders.
- Implementation route: `http://localhost:3004/` in the Codex in-app Browser, starting from a fresh empty project.
- Browser-rendered implementation screenshots: inline Codex in-app Browser captures; the browser integration did not expose filesystem paths.
- Viewports: 1440 x 900 CSS px for desktop and 390 x 844 CSS px for the responsive check.
- State: light theme; four example spectra loaded; both folders expanded, then the `reference` folder collapsed and expanded again.

## Findings

- No remaining P0, P1, or P2 visual or interaction findings.
- `Load copper examples` is the first control under the Data groups heading, ahead of Open project and search.
- The action retains the source's dashed outline, purple icon and text, rounded corners, and muted explanatory caption while using copy that now covers both foil and Cu₂O examples.
- The three temperature foils appear in `Temperature series`; `Cu₂O · room temperature` appears in lowercase `reference` with 445 points and the existing `trans` and `ref` tags.
- The initial active spectrum remains `Cu foil · 10 K`, so grouping order does not accidentally switch processing to the reference spectrum.
- At 390 x 844 the action remains first, occupies the available width, and introduces no horizontal document overflow.

## Required fidelity surfaces

- Fonts and typography: existing Athena sidebar heading, action, folder, row, and caption tokens are reused.
- Spacing and layout rhythm: the example action moves above project controls without changing the surrounding panel rhythm; the longer caption wraps naturally at desktop sidebar width and hides at the existing narrow breakpoint.
- Colors and visual tokens: the existing purple action, neutral border, folder accent, active row, and metadata colors are retained.
- Image quality and asset fidelity: no raster UI asset was introduced; the action and folders continue to use the existing Lucide icon language.
- Copy and content: the title reflects the expanded example set, the caption names all temperatures and Cu₂O, and folder names match the requested organization.

## Interaction evidence

- From an empty project, the action loaded exactly four spectra and renamed the project `Copper examples · foils and reference`.
- `Temperature series` rendered with three foil members; `reference` rendered with the supplied Cu₂O spectrum as its sole member.
- Collapsing and re-expanding `reference` hid and restored the Cu₂O row without changing the active foil.
- The Cu₂O row reported 445 points and the transmission/reference flags; its backend source mapping uses energy, I₀, and Iₜ from the supplied 47-column scan.
- Browser console warnings/errors during fresh load, grouping, responsive inspection, and collapse/expand checks: none.

## Full-view and focused comparison evidence

- The 542 x 214 source crop and the final desktop sidebar were reviewed in the same QA pass, followed by the 390 x 844 responsive pass.
- The source action's visual language is preserved; the intentional differences are its top placement, broader example copy, and the folder hierarchy below it.
- The final desktop view shows the action, caption, project controls, mark toolbar, `Temperature series`, and `reference` within the unchanged three-column workspace.

## Comparison history

- Pass 1: the fresh-project desktop view, folder hierarchy, active-spectrum behavior, collapse/expand interaction, and responsive layout passed without an actionable mismatch.

## Regression checks

- Full frontend Vitest suite: 64 files and 1,175 tests passed.
- Focused example-loader and folder tests: 7 passed; 273 unrelated tests skipped by the name filter.
- Athena project and API backend tests: 126 passed.
- LabVIEW parsing tests: 59 passed.
- Smoothing-preference tests: 31 passed after running with the repository backend on `PYTHONPATH`.
- Detector-behavior tests: 29 passed after replacing the last-item assumption with the intended 300 K foil identity.
- Focused convolution ordering test: passed.
- `npm run typecheck`: passed.
- Next.js production build using `.next-verify`: passed.
- `git diff --check`: passed after the final code and documentation updates.

final result: passed

# Design QA: collapsible data group folders

## Visual truth and capture conditions

- Source visual truth: `/var/folders/pc/t6fzh36n1rx2d5m1wlmxq8gr0000gq/T/codex-clipboard-cf8733e7-aa10-4356-ac9f-6074936fc817.png` (580 x 1472 px), used for the existing left-panel typography, spacing, row treatment, marks, and measurement tags.
- Requested delta: let users collect spectra into named groups in the left data-file list and collapse or expand each group without redesigning the surrounding Athena workspace.
- Implementation route: `http://localhost:3004/` in the Codex in-app Browser, using the saved three-spectrum copper-foil project.
- Browser-rendered implementation screenshots: inline Codex in-app Browser captures; the browser integration did not expose filesystem paths.
- Viewports: 1440 x 1000 CSS px for the desktop comparison and 390 x 844 CSS px for the narrow responsive check.
- State: light theme; `Temperature series` contains the 10 K, 50 K, and 300 K copper-foil spectra; both expanded and collapsed states were inspected.

## Findings

- No remaining P0, P1, or P2 visual or interaction findings.
- The folder header uses the existing neutral row surface, purple accent, Lucide icon language, typography, and compact count treatment; the spectrum rows keep their existing marks, swatches, labels, metadata, and active-state styling.
- The new `Group` action fits beside `Drag to reorder` without obscuring the marked count or search field.
- The expanded desktop state keeps all three members legible and visually nested. The collapsed state retains an active-child indicator without changing the active spectrum or plot.
- At 390 x 844, the action row and folder header remain readable without horizontal overflow; the existing mobile list remains vertically scrollable. The edit modal stacks the destructive action above Cancel and Save so every action remains reachable.

## Required fidelity surfaces

- Fonts and typography: existing Athena heading, label, body, and caption tokens are reused; no new font or arbitrary type scale was introduced.
- Spacing and layout rhythm: the source panel's heading, project action, search, mark toolbar, and spectrum-row rhythm remain intact. The folder header is intentionally shorter than a spectrum row so hierarchy is clear.
- Colors and visual tokens: folder, active, border, muted-surface, and focus colors all use existing Athena variables.
- Image quality and asset fidelity: no raster artwork was added; folder, disclosure, edit, and group actions use the existing Lucide icon set.
- Copy and content: `Group`, the folder name, the member count, and edit affordance are concise; existing spectrum labels and scientific metadata are unchanged.

## Interaction evidence

- Creating a group from three marked spectra saved one project-backed folder and rendered all three members beneath it.
- Collapsing removed the member rows while the current `Cu foil · 10 K` spectrum and its plot remained active.
- Searching `50 K` while the folder was collapsed temporarily revealed only the matching member and changed the count to `1/3`; its disclosure control was disabled during search, and clearing the search restored the prior collapsed state.
- Reloading the page preserved the group membership and the local collapsed preference.
- Editing the group reopened the membership choices. Undo removed the folder and Redo restored the folder with all three members.
- Browser console warnings/errors during create, expand, collapse, search, reload, edit, undo, and redo checks: none.

## Full-view and focused comparison evidence

- The 580 x 1472 source panel and final browser-rendered left panel were reviewed in the same QA pass, followed by a full 1440 x 1000 workspace capture.
- The surrounding Data groups layout, row content, selection colors, and scientific plot remained unchanged; the named folder header and `Group` action are the only intentional structural additions.
- A focused 390 x 844 pass confirmed the folder controls and action toolbar wrap within the existing mobile layout.

## Comparison history

- Pass 1 exposed a stale backend process: the project command completed but an old server ignored `group_folders`, so no folder header rendered.
- Pass 2 restarted the local backend from the current checkout. The folder hierarchy, persistence, search reveal, undo/redo, and responsive states then passed without an actionable visual mismatch.
- Pass 3 fixed review findings: modal errors are visible, search-time disclosure is disabled, narrow actions wrap, and reorder scope uses tagged values. The 390 x 844 edit modal and final browser console check passed.

## Regression checks

- Full frontend Vitest suite: 64 files and 1,174 tests passed.
- Focused folder and reorder tests: 11 passed; 268 unrelated tests skipped by the name filter.
- Athena project backend tests: 98 passed.
- Related backend selection, integration-v2, and project-preview tests: 125 passed.
- `npm run typecheck`: passed.
- Next.js production build: passed.
- `git diff --check`: passed after the final code and documentation updates.

final result: passed

# Design QA: Plot shortcuts menu migration

## Visual truth and capture conditions

- Source visual truth: `/var/folders/pc/t6fzh36n1rx2d5m1wlmxq8gr0000gq/T/codex-clipboard-e575f9b6-f633-4f50-a1cf-00fd7ffe5edd.png` (320 x 128 px), used to identify the existing `Plot shortcuts…` viewer-widget action that should move into the application menu.
- Requested delta: remove the standalone viewer action and expose the same feature as `Plot` → `Plot shortcuts…`, without redesigning the shortcut dialog or changing its scientific behavior.
- Implementation route: `http://localhost:3004/` in the Codex in-app Browser, using the saved four-spectrum copper example project.
- Browser-rendered implementation screenshots: inline Codex in-app Browser captures; the browser integration did not expose filesystem paths.
- Viewports: the default 1280 x 720 CSS px desktop viewport and 390 x 844 CSS px for the responsive check.
- State: light theme; four marked copper spectra; `Plot` menu expanded; `Normalized μ(E) + derivative` shortcut dialog opened and rendered with two curves.

## Findings

- No remaining P0, P1, or P2 visual or interaction findings.
- `Plot shortcuts…` is the first command in the top-level `Plot` menu, ahead of the existing diagnostic and saved-merge commands.
- The standalone action is absent from the spectrum-viewer tab row, leaving the established E, k, R, and q navigation uninterrupted.
- The command retains the existing permission, active-spectrum, busy-state, and parameter-update gates.
- The existing shortcut selector, replot action, SVG export, curve legend, plot rendering, and E/k/R/q right-click accelerators are unchanged.
- At 390 x 844, the Plot command remains reachable, the shortcut dialog fits the viewport, and the document width remains exactly 390 px with no horizontal overflow.

## Required fidelity surfaces

- Fonts and typography: the command reuses the existing Athena menu typography; the dialog keeps its established heading, selector, status, action, and legend type treatments.
- Spacing and layout rhythm: the new command follows the existing Plot-menu row rhythm, while removal of the old viewer action restores an uncluttered tab row without introducing a gap.
- Colors and visual tokens: menu hover, disabled, border, modal, plot, and focus colors all continue to use existing Athena tokens.
- Image quality and asset fidelity: no raster UI artwork or replacement icon was introduced; the Plotly shortcut figure is rendered by the existing plot implementation.
- Copy and content: the exact `Plot shortcuts…` label is preserved, and all nine shortcut choices and scientific explanatory copy remain unchanged.

## Interaction evidence

- Opening `Plot` exposed `Plot shortcuts…`, `Diagnostic plots…`, and the gated `Saved merge spread…` command in the expected order.
- Selecting `Plot shortcuts…` closed the menu and opened the existing `Athena plot shortcuts` dialog.
- The default shortcut rendered two curves for `Cu foil · 10 K`, with both `Replot shortcut` and `Download shortcut SVG` available.
- The responsive pass repeated the menu-to-dialog path at 390 x 844 and confirmed the modal remained readable and operable.
- Browser console warnings/errors during desktop and responsive inspection: none.

## Full-view and focused comparison evidence

- The 320 x 128 source crop and the live desktop implementation were reviewed together on one comparison canvas: the former identifies the removed standalone action, while the latter shows the Plot menu in the unchanged Athena header.
- The final desktop full view confirms that the spectrum viewer contains only its plot-space tabs and controls, while the top application menu owns the migrated command.
- The focused responsive modal capture confirms that the migration did not change shortcut content, Plotly rendering, or action availability.

## Comparison history

- Pass 1: desktop menu placement, original dialog behavior, and console state passed.
- Pass 2: the 390 x 844 menu, modal, and horizontal-overflow checks passed without an actionable mismatch.

## Regression checks

- Focused workbench tests: 4 passed; 278 unrelated tests skipped by the name filter.
- Full workbench and special-plot component tests: 297 passed.
- `npm run typecheck` with an isolated Next output directory: passed.
- Next.js production build with an isolated output directory: passed.
- `git diff --check`: passed after the final code and documentation updates.

final result: passed

# Design QA: data group sorting

## Visual truth and capture conditions

- Existing visual truth: the established Athena Data groups sidebar and `/var/folders/pc/t6fzh36n1rx2d5m1wlmxq8gr0000gq/T/codex-clipboard-cf8733e7-aa10-4356-ac9f-6074936fc817.png`, preserving the compact search, mark toolbar, file rows, badges, and folder hierarchy.
- Requested delta: let the left data-file list switch among Added order, natural Name A–Z, and Tag type ordering for `trans`, `fluo`, and `ref`, while retaining the existing drag-to-reorder workflow.
- Implementation route: `http://localhost:3004/` in the Codex in-app Browser with the four-spectrum copper example project.
- Browser-rendered implementation screenshots: inline Codex in-app Browser captures; the browser integration did not expose filesystem paths.
- Viewports: 1440 x 900 CSS px for desktop and 390 x 844 CSS px for the responsive check.

## Findings

- No remaining P0, P1, or P2 visual or interaction findings.
- A visible `Sort` label and native select sit between search and the mark toolbar without changing the existing file-row treatment.
- `Manual order` preserves the saved project order and is the only mode that enables pointer/keyboard reordering.
- `Added order` uses a project-backed immutable ordinal, so a manual drag never changes when a spectrum was added to or created in the project.
- `Name A–Z` uses case-insensitive natural ordering, so numbered scan names sort numerically.
- `Tag type` orders transmission, fluorescence, reference, then untagged spectra. A spectrum with both measurement and reference badges is classified as `ref` once rather than duplicated.
- Folder blocks remain in their saved positions. Members within each folder and ungrouped spectra are sorted independently, so sorting never breaks the hierarchy.
- Added, Name, and Tag views show `Sorted view`, disable reorder handles, and explain how to restore manual reordering.

## Required fidelity surfaces

- Fonts and typography: the control reuses the existing sidebar label and native select tokens.
- Spacing and layout rhythm: the compact sort row aligns with search and toolbar padding; file rows, folder headers, and badge placement are unchanged.
- Colors and visual tokens: icon, label, select, border, focus, and disabled states use existing Athena variables.
- Image quality and asset fidelity: no raster asset was introduced; `ArrowUpDown` comes from the existing Lucide icon set.
- Copy and content: the options are `Manual order`, `Added order`, `Name A–Z`, and `Tag type`; accessible help states the stable added-order meaning, tag order, folder behavior, and view-only behavior.

## Interaction evidence

- Switching to Name sorted the visible rows without changing the active spectrum, marks, project version, or backend order.
- Switching to Tag retained the Cu₂O `trans` and `ref` badges while classifying the row as a reference for sorting.
- In the updated backend, a keyboard move changed Manual order to 50 K, 10 K, 300 K; switching to Added restored 10 K, 50 K, 300 K without another API mutation.
- All four reorder handles were disabled in Added/Name/Tag views; Manual restored the three valid handles inside `Temperature series` while the single-member reference handle remained disabled.
- A browser reload restored the selected Name view preference, and the deliverable tab was returned to Manual order afterward.
- At 390 x 844, the document stayed exactly 390 px wide, the sidebar measured about 392 px high, the scrollable file list retained 135 px, and file rows remained visible with no horizontal overflow.
- Browser console warnings/errors during Manual, Added, Name, Tag, reload, desktop, and mobile checks: none.

## Comparison history

- Pass 1: desktop placement, all four modes, drag gating, and tag badges passed.
- Pass 2: semantic audit separated mutable Manual order from immutable Added order and added project-backed ordinals.
- Pass 3: live-backend keyboard reorder confirmed Manual and Added remain distinct; reload confirmed Name preference persistence.
- Pass 4: the initial 310 px mobile cap hid file rows; increasing the bounded data panel to 430 px restored a 135 px scrollable list with zero overflow.

## Regression checks

- Focused sorting and reorder tests: 10 passed; 277 unrelated tests skipped by the name filter.
- Focused sorting, folder, and reorder tests: 17 passed.
- Full frontend Vitest suite: 67 files and 1,212 tests passed.
- `npm run typecheck`: passed.
- Next.js production build using `.next-sort-final`: passed; generated TypeScript include entries were removed afterward.
- Backend project tests: 100 passed; Athena API/selection tests: 39 passed; integration v2 tests: 58 passed; integration API tests: 21 passed.
- `git diff --check`: passed after the final code and documentation updates.

final result: passed
