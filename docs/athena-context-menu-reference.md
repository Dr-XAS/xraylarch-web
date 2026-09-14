# Athena right-click controls: source contract and implemented subset

Research and implementation date: 2026-09-12. Native behavior was inspected at
official Demeter revision
[`06afc8da08a5a7d5a26ee14992170fcf5dc67406`](https://github.com/bruceravel/demeter/tree/06afc8da08a5a7d5a26ee14992170fcf5dc67406).
The inventory covers all 66 Perl modules under the downloaded Athena/Wx UI
directories. The 18 supporting source files and their verified SHA-256 hashes
are recorded below. This implements a substantial subset of the native custom
right-click surface; it is **not full desktop parity**.

## How to use the web controls

Right-click the group list or a processing label, or use its visible **⋯**
actions button. The group menu acts on the **currently selected group**, even
when another row was right-clicked. A disabled first row names the current
target. This follows the native selection rule rather than silently changing
the active group. Normal text and number inputs retain their browser editing
menus.

Right-click an E/k/R/q plot tab for its native default shortcut. **Plot
shortcuts…** also exposes the alternative energy plots, quad plot and bi-quad
plot. Reader rows in **Plugin registry** offer documentation and, where
available, configuration. XDI metadata field rows offer validation of the saved
field. Peak-shape labels offer swaps among the three peak shapes already
supported by the web fitter.

Menus support arrows, Home/End, Enter/Space, Escape, viewport placement and
focus restoration. Label actions are also reachable with the context-menu key
or Shift+F10. The visible controls provide access without requiring a mouse
right button. These are browser adaptations, not observations of desktop Wx
keyboard behavior.

## Complete native custom-action inventory

Standard operating-system editing menus are outside this inventory. Source
line references below refer to the pinned files in the manifest.

| Native surface and source | Native actions | Web implementation and boundary |
| --- | --- | --- |
| Group list, `UI/Athena.pm` 653–676, 1815, 1932–1942 | Rename; copy; change data type; set all/marked groups' values to current; about; YAML; original data-file text; measurement uncertainties for current/marked/all; remove current/marked; close. The handler uses the current selection, not the pointer's row. The freeze submenu is commented out. | The group menu exposes these actions, with current-target text and existing project commands. About/YAML expose the web group's saved state and arrays, not a Perl object dump. Source text is gated on a retained upload. Existing web duplicate naming/placement and close behavior remain distinct, as described below. |
| Main headings, `UI/Athena/Main.pm` 109, 183, 433, 509, 577, 1110–1182 | Current group, background, FFT, BFT and plotting section labels copy their values to all/marked groups and reset the current section. | Group, combined normalization/background, forward, reverse and plot actions use dedicated native section selections. The web's separate normalization and background headings address the same native combined section. |
| Main parameter labels and checkboxes, `Main.pm` 128–156, 381–409, 475–483, 544–555, 596 | Element, edge, energy shift, importance; E0, Rbkg, background k-weight; pre/normalization/spline ranges; edge step; background standard; clamps; flattening; energy-dependent normalization; fixed step; polynomial terms; FT k-range, dk, arbitrary weight/window; reverse R-range, dR/window; multiplier/offset. Generic actions copy to all/marked or reset current. Edge step, flattening, energy-dependent normalization and fixed step omit reset. | Corresponding supported web controls expose the generic actions and native reset exclusions. Element and edge copy/reset together to retain a valid identity. The web representation uses polynomial degree, one less than native term count. Optional values copy their currently resolved numerical values. |
| Paired range labels, `Main.pm` 1190–1196 | Pre-edge, normalization, spline, k and R start labels include both range endpoints. Native kmax/rmax have no separate right-click binding. | A range action copies/resets both ends atomically. The web additionally makes the same paired action reachable at either endpoint. Spline energy and k controls address the same stored k limits. |
| E0, `Main.pm` 1151–1157, 1224–1234 | Backend default, tabulated edge, fraction of the edge step, second-derivative zero crossing, white-line peak. | Uses the existing versioned E0 commands. The default is labelled Larch's default. Existing E0 method/reference limits still apply; see the E0 and normalization reference documents. |
| Energy shift, `Main.pm` 1142–1150, 1324–1375 | Identify/untie the reference; explain the shift; report current/all/marked shifts. | Uses existing reference links and saved shift reports. The explanation uses the web's additive energy convention, not the native explanatory text's subtraction convention. |
| Edge step, `Main.pm` 1158–1163, 1379–1397 | Report all/marked steps; estimate approximate uncertainty by sampling normalization ranges. | Saved-step reports include available group values. The read-only uncertainty endpoint implements the pinned sampling/outlier procedure with a reproducible seed and explicit unavailable results. |
| FT k-range, `Main.pm` 1127–1129, 1211–1220 | Replace kmax with the backend's suggested upper limit. | Obtains Larch's noise-based `recommended_kmax`, then submits it through the existing parameter validation and frozen/dependency checks. An unusable suggestion is an error, not silently clipped. |
| Importance and plot multiplier, `Main.pm` 1130–1139, 1166–1170, 1268–1289 | Reset all/marked importance to one; set marked importance or multiplier from each group's cached BLA pixel ratio. | Importance is editable and retained in web/native exports and parameter reports. BLA actions require explicit retained `bla.pixel_ratio` metadata; they do not infer ratios from spectra or recreate the desktop process-local `%npix` table. |
| Plot buttons, `UI/Athena.pm` 1827–1867, 2190–2232 | These immediately draw alternate plots rather than opening menus. Current E defaults to data/I0/signal, with normalized/derivative as a preference alternative; current k/R compare weights 1/2/3; current q is ordinary q; current kq is quad. Marked E defaults to I0, with E−E0 and normalized-times-step alternatives; marked k/R are ordinary plots; marked q is bi-quad. | E/k/R/q right-click follows those defaults in a web plot dialog. The visible shortcut selector exposes every listed alternative and quad/bi-quad. The web has no separate kq button or native right-click preference store. Native comparison scaling is implemented; display and phase-correction limits remain below. |
| PeakFit, `UI/Athena/PeakFit.pm` 32–35, 361–370, 837–893 | A hyperlink/right-click menu swaps within the same function family, excluding the current function. Larch peaks: Gaussian, Lorentzian, Voigt, Pseudo-Voigt, Pearson VII, Student's t. Steps: arctangent, error function, logistic. Ifeffit steps toggle arctangent/error function. Numeric values survive swaps. | The current web peak label swaps Gaussian/Lorentzian/Voigt while retaining numeric draft values. Pseudo-Voigt, Pearson VII, Student's t and all step-family swaps are unavailable; this change does not implement those fit models. |
| Plugin registry, `UI/Athena/PluginRegistry.pm` 53, 106–145 | Show reader documentation; configure only when a configuration file exists. Opening the menu is independent of checking/enabling the reader. | Reader-row right-click opens documentation or supported configuration without changing the saved enable flag. Existing visible documentation/configuration controls remain available. |
| XDI, `UI/Athena/XDI.pm` 89–90, 294–337 | Non-Windows field-leaf right-click offers only Validate Family.tag. Family/root nodes do not get this menu. Edit/Add/Delete items are commented out. Validation reads the current value without mutation. | Field-row right-click validates the saved value through the existing versioned XDI endpoint. Draft comments remain unchanged. There are no new metadata editing/deletion actions; the web is not tied to the desktop platform restriction. |
| `UI/Wx/CheckListBook.pm` 334–338 | `OnRightDown` is empty. | No action was invented for this handler. No additional functional custom context surface was found in the inspected column-selection or individual plot-panel modules. |

## Native copy/reset scope

`Main.pm` 1400–1437 defines the section lists below. Its copy loop skips the
source and frozen destinations. Reset is current-group only. The native
current-group reset dispatch has an inconsistent heading name; the web uses an
explicit group selection instead of reproducing that dispatch bug.

| Section | Native keys | Web representation |
| --- | --- | --- |
| Group | `bkg_z`, `fft_edge`, `importance` | Paired absorber/edge identity and `source.importance`. |
| Background | `bkg_e0`, `bkg_rbkg`, `bkg_flatten`, `bkg_kw`, `bkg_fixstep`, `bkg_nnorm`, `bkg_pre1`, `bkg_pre2`, `bkg_nor1`, `bkg_nor2`, `bkg_spl1`, `bkg_spl2`, `bkg_spl1e`, `bkg_spl2e`, `bkg_stan`, `bkg_clamp1`, `bkg_clamp2` | E0, Rbkg, flattening, background weight, fixed/automatic step mode, degree, pre/post/spline ranges, standard and clamps. Spline E/k bounds share one representation. |
| Forward | `fft_kmin`, `fft_kmax`, `fft_dk`, `fft_kwindow`, `fit_karb_value`, `fft_pc` | k-range, taper, window and weight. Phase correction is unsupported. |
| Reverse | `bft_rmin`, `bft_rmax`, `bft_dr`, `bft_rwindow` | R-range, taper and window. |
| Plot | `plot_multiplier`, `y_offset` | Group multiplier and offset. |

Native ALL concatenates those lists. It **does not copy** the source energy
shift, edge-step scalar, energy-dependent normalization flag or normalization
algorithm. The web also leaves its separate FFT-grid controls and extra AUTOBK
taper/window/clamp-point controls alone. Existing broad web batch-copy/reset
commands retain their previous meanings; the context sections use a separate
`context_parameters` command.

Copying fixed-step mode freezes each destination's **own** existing step when
the source is fixed. An automatic source returns each destination to automatic
step calculation. This duplicates the native boolean without substituting the
source's numerical edge step. An explicit edge-step field copy is a separate
action and does copy the scalar.

## Scientific reports and plot calculations

Measurement uncertainty follows `Data.pm` 560–578 and the pinned Larch
`chi_noise.tmpl`: `estimate_noise` receives the processed χ(k), resolved FT
limits, dk/dk2 and selected weight. The native template passes `window` through
Larch's extra keyword arguments; `kwindow` consequently keeps the Larch default
Kaiser window. The implementation deliberately preserves this behavior. εk and
εR are reported to the native four significant figures, suggested kmax to three
decimals, and `Nidp = 2 (kmax − kmin) (Rmax − Rmin) / π`. The noise region is
15–30 Å. Unavailable/nonfinite calculations are reported as unavailable rather
than replaced with the native fallback value of one.

Edge-step uncertainty follows `Data/Mu.pm` 380–472 and the pinned `edgestep`
configuration. It includes the original step and 20 normalizations with
uniformly perturbed pre1/pre2/norm1/norm2 ranges within ±20/10/15/30 eV. It uses
sample standard deviation, an initial outlier margin of 2.5, margin reductions
of 0.2, and the native convergence/stagnation rules. The original normalization
degree and E0 remain in use. Steps are rounded to seven decimals as in
`Data::normalize`. The web uses NumPy RNG seed **0** by default and returns the
seed/report; it is reproducible but does not reproduce Perl's random sequence.
A fixed step has zero sampled uncertainty by construction. This is a
normalization-range sensitivity estimate, not a general experimental error bar.

The k-weight comparison follows `Data/Plot.pm` 296–334 and `k123.tmpl`: signed
full-array maxima determine three-decimal scales for weights 1 and 3 relative to
weight 2; offsets are ±1.2 times the weight-2 maximum. R comparisons follow
`Data/Plot.pm` 337–389: the backend recomputes a forward FT for each weight from
saved unweighted χ(k), using the same resolved range, taper and grid. The frontend
scales by magnitude maxima and offsets by ±the weight-2 maximum. It never
constructs different R-weight curves by multiplying a saved R curve by R.

Data/I0/signal plots use retained, aligned detector arrays and the native maximum
scaling. The normalized-derivative plot uses the saved normalized derivative,
three-decimal `0.5 / max(abs(derivative))` scale and default E0-relative range
−30…70 eV. Missing channels and invalid maxima are explained instead of inventing
signals. Marked E−E0 uses each group's own shifted energy and resolved E0;
normalized-times-step uses each group's own step. Plotting leaves saved arrays
and processing recipes unchanged.

## API contract and safeguards

Paths below have the `/api/athena` prefix. All scientific report/copy requests
use a project revision; stale requests are rejected. Diagnostic calculation
checks the revision again before returning and writes no project, history,
undo/redo or parameter changes.

| Endpoint/command | Input and result |
| --- | --- |
| `POST /projects/{id}/context-report` | `{version, group_ids, kind, seed?}`, where kind is `measurement_uncertainty` or `edge_step_uncertainty`. Returns `{version, kind, results, skipped}`; each unavailable group has an explicit reason. Measurement rows include `epsilon_k`, `epsilon_r`, `nidp`, `recommended_kmax`. Edge-step rows include `edge_step`, `mean`, `standard_deviation`, `samples`, `retained_samples`, `seed`, `report`, `warnings`. |
| `POST /projects/{id}/context-plot` | `{version, group_id, kind:"r123"}`. Returns three `curves`, each with `kweight` and `r/chir_mag/chir_re/chir_im/chir_pha` arrays, plus warnings. It uses temporary Larch groups. |
| `GET /projects/{id}/groups/{group_id}/source-text` | Returns `{filename, text, kind:"original"}` from the group's retained `source.mapping.upload_id`. It never opens an imported filename, `source_file` or native filesystem path. A missing upload or binary source returns a clear error. Restoring a project alone does not restore its original input file. |
| `context_parameters` command | `mode:"copy"|"reset"`, plus either native `section` or single metadata `field`. Copy supplies `source_id` and optional current draft values/metadata; reset supplies neither. Section/field selection is exclusive. Supported fields: element, edge, importance, multiplier, offset, fix_step. |
| `context_parameters`, BLA mode | `{mode:"pixel_ratio", field:"importance"|"multiplier"}` uses each selected group's explicit `source.xdi_metadata.attributes.bla.pixel_ratio`, with `beamline_metadata` fallback. Missing/invalid ratios and frozen groups are skipped and reported. |
| Existing `copy_parameters` / `reset_parameters` | Now accept a nonempty, distinct `parameters:[...]` list, mutually exclusive with `parameter` or `section`. Both endpoints of a range are validated/staged in one operation. |
| Existing `metadata` command | Accepts finite, nonnegative numeric `importance`. Booleans, numeric strings and frozen-group importance edits are rejected. Current importance overrides retained native metadata in reports and native PRJ export. |

Processing changes preserve the web's existing frozen/reference/background
dependency guards, which are stricter than several native menu handlers.
Validation or scientific-processing failure rolls back the entire operation.
Deleting groups continues to use the existing explicit group-removal command;
freeze is not a general prohibition against requested removal.

## Validation evidence and remaining boundaries

Implementation paths:

- [Workbench dispatch](../frontend/components/athena-workbench.tsx), [menu accessibility](../frontend/components/athena-context-menu.tsx), [native mappings/YAML](../frontend/components/athena-native-context.ts), [reports](../frontend/components/athena-context-report.tsx), and [special plots](../frontend/components/athena-special-plot.tsx).
- [Plugin actions](../frontend/components/athena-plugin-registry.tsx) and [XDI actions](../frontend/components/athena-xdi-controls.tsx).
- [Backend context operations](../backend/xraylarch_web/athena_context.py), [HTTP/command dispatch](../backend/xraylarch_web/athena.py), and [parameter reports](../backend/xraylarch_web/athena_report.py).

The [20 backend context tests](../backend/tests/test_athena_context.py) passed
during implementation. They cover atomic paired ranges, native copy exclusions,
raw-null draft resolution, source/frozen/dependency handling, metadata/reset/BLA
validation, native importance export, read-only diagnostics, stale revisions,
known outlier rejection, reproducible sampling, independent weighted FFT
comparisons and rejection of arbitrary source paths. The 189 existing relevant
constraint/background/report/merge/API tests also passed.

These tests execute the local Larch noise and FT routines with the native
template arguments and compare their results with independent calls. They do
**not** constitute an executed Perl/Wx desktop-Athena comparison. Edge-step
sampling is a source-derived port checked with deterministic data and a known
outlier case; there is no cross-runtime random-sequence equivalence claim.

Frontend checks in the [menu](../frontend/components/athena-context-menu.test.tsx),
[special plots](../frontend/components/athena-special-plot.test.tsx),
[plugin registry](../frontend/components/athena-plugin-registry.test.tsx),
[XDI](../frontend/components/athena-xdi-controls.test.tsx), and
[workbench](../frontend/components/athena-workbench.test.tsx) suites exercise
source-derived action dispatch, synthetic plot formulas, keyboard/focus handling,
stale-result rejection and saved/draft boundaries. Their mocked API/Plotly
checks do not establish live rendering or desktop numerical parity. The final
focused component run passed **133 tests**. The full workbench suite passed
**194 tests**; after correcting the reference-identification message, all **29**
context cases passed, including three additional direction/no-mutation cases
(197 workbench cases now exist). TypeScript checking also passed. Live browser
evidence follows rather than being inferred from mocks.

### Local browser verification

The running app at `http://127.0.0.1:3004` was checked with the copper temperature
example at project revision **1**. Right-clicking the 50 K row opened a menu
targeting the selected 10 K group. Escape restored focus to the 50 K row, and
Shift+F10 opened the E0 label menu. The Importance menu also opened inside the
native HTML metadata dialog, remaining visible in its modal top layer.

The 10 K measurement report displayed εk = **0.0004365**, εR = **0.04913** and
Nidp = **26.73803**. Edge-step sensitivity used **21 samples**, retained **12**,
and reported standard deviation **0.0044617099**. The R123 comparison rendered
three traces with scales **8.197 / 1 / 0.105**; its screenshot was inspected.
The saved project remained at revision **1** after these read-only checks.
These observations establish those local browser/report paths, not desktop
Athena equivalence or validation of every menu action.

To reproduce the focused backend checks:

```sh
backend/.venv/bin/python -m pytest backend/tests/test_athena_context.py backend/tests/test_athena_constraints.py backend/tests/test_athena_background.py backend/tests/test_athena_parameter_report.py backend/tests/test_athena_merge.py backend/tests/test_athena_api.py -q
```

Explicit remaining differences:

- Central-atom phase correction (`fft_pc`) is unsupported. Native section copy
  does not claim to reproduce it; an active retained source setting produces an
  operation warning. The web's processing/phase conventions still govern plots.
- The three extra native peak functions and all native step-family swaps are
  unavailable. A menu for supported shapes is not an implementation of the
  missing models or of complete native PeakFit parameter/name behavior.
- Existing web duplicate appends a `· copy` group, clears its links and unfreezes
  it; native Group.pm inserts a `Copy N of…` clone after the source. Close project
  creates an empty project with `POST /api/athena/projects` and switches to it,
  preserving the previous saved project and its groups. It does not issue a
  delete command or reproduce desktop window destruction and its save-prompt
  sequence.
- Native right-click plot preferences are represented by a visible web shortcut
  selector, not imported/persisted native preference settings. Full desktop
  plot layout, quad/bi-quad component preferences and every platform interaction
  remain unverified.
- Native BLA `%npix` is process-local state and is not reconstructed. Only an
  explicit retained ratio enables the corresponding web action.
- Original source text requires the uploaded source to remain in this workspace.
  Native filename metadata alone is insufficient to grant filesystem access.
- Energy shift is **added** to measured energy in Athena Web. This contract
  deliberately describes the web convention rather than copying native text
  that would explain the sign incorrectly.

## SHA-256 and pinned source links

All hashes below were checked against the downloaded pinned source bytes.

- [lib/Demeter/UI/Athena.pm](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/UI/Athena.pm) — `dc5126ed6cd5f40c7104736d68fba42118cab4e272bcca9fc04726f205225de4`
- [lib/Demeter/UI/Athena/Main.pm](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/UI/Athena/Main.pm) — `829a5ee82cd5c6c4447c7274f00fb8c6a0c6aa3f19fac74d8a911ae6fd7ea393`
- [lib/Demeter/UI/Athena/Group.pm](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/UI/Athena/Group.pm) — `3cc70f81c3130d2c069a4c38f483db005cbb091edb90e424c7cce1d36c98f13d`
- [lib/Demeter/UI/Athena/PeakFit.pm](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/UI/Athena/PeakFit.pm) — `d06ebae7dc828c82c7e90f1e27e8496fe4ca475f68415ac30e1dc4bc5c1bcde1`
- [lib/Demeter/UI/Athena/PluginRegistry.pm](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/UI/Athena/PluginRegistry.pm) — `3dc364bf85b33f2f0f455f671322af31a4d1d000fe0caa95c045edc57d5960c6`
- [lib/Demeter/UI/Athena/XDI.pm](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/UI/Athena/XDI.pm) — `49f588367af0f2c8b14c4560e1e0ebfa8eb5b9f7caeb11b37921a5d1fb4576a2`
- [lib/Demeter/UI/Wx/CheckListBook.pm](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/UI/Wx/CheckListBook.pm) — `2b36a66d06cf5e941ca231eb36ce3589bfcd53039a5d851ce717201dad4d8138`
- [lib/Demeter/configuration/athena.demeter_conf](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/configuration/athena.demeter_conf) — `254da368d414b3a9adaa1540872998b6040a5a7d8c00bcb5371194a4f137e1ff`
- [lib/Demeter/Data/Plot.pm](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/Data/Plot.pm) — `f22bd9d5206b179180b4ee6cfd88693a667ca8b1ffba1bc60e9c069cfd9d46eb`
- [lib/Demeter/Data/Mu.pm](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/Data/Mu.pm) — `a3738bd61b41a4dbbca9d10e231b51044642222f148c8c9cba900be662f78f57`
- [lib/Demeter/Data.pm](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/Data.pm) — `265550be8d8d76ab5b114aa98b742e242e6d8561255d1109f2d709a1ee01c216`
- [lib/Demeter/configuration/edgestep.demeter_conf](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/configuration/edgestep.demeter_conf) — `877fedaad8bd7c3b3e405fedc5b7292dfc3236f500c6b99260ff02c807e39c92`
- [lib/Demeter/templates/process/larch/chi_noise.tmpl](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/templates/process/larch/chi_noise.tmpl) — `27e48ee1ed0478d8a13abf709faa708425aacab87b9b0a4cfda85f72aecdf88e`
- [lib/Demeter/templates/process/larch/normalize.tmpl](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/templates/process/larch/normalize.tmpl) — `d82f4fa4c34197deb83437f05e779b4ba7227fbf12b9b1bc44aa116d2ca30d75`
- [lib/Demeter/templates/process/larch/k123.tmpl](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/templates/process/larch/k123.tmpl) — `6dfd435ba031e3d56248162148957357abea83e68ccd63a3086515dd8b6793ce`
- [lib/Demeter/templates/process/larch/columns.tmpl](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/templates/process/larch/columns.tmpl) — `4eb57f0562a496440067afb9b8831ab86ce2ce735b6c7b6a472437b2daec62dc`
- [lib/Demeter/templates/plot/gnuplot/overe.tmpl](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/templates/plot/gnuplot/overe.tmpl) — `7c6115881bdc47a4db26b8a087928841d9dd8a83b94c9bd0cd56682ddc2bc5b8`
- [lib/Demeter/configuration/plot.demeter_conf.in](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/configuration/plot.demeter_conf.in) — `1ec19c44498cdd289d4ba6f14150b2b1ac22fd2d02fb6d3d398271a6330c809c`
