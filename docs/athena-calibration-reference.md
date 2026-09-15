# Athena energy calibration

The calibration panel implements the four display choices, selectable reference,
editable target, display smoothing, second-derivative zero search, and cumulative
energy-shift rule from Athena. It is available at **Process → Calibrate energy**.
This is evidence for PR-01, not a claim that all Athena processing is equivalent.

Follow-up: [normalization outer limits](athena-normalization-limits-reference.md)
now preserve requested endpoints, resolve actual fit support at each E0, and
refit the calibrated normalization overlay after total-shift rounding.

## Primary source and numerical contract

The reference is Demeter revision
`06afc8da08a5a7d5a26ee14992170fcf5dc67406`. Source hashes are in
[the primary catalog](athena-primary-sources.json) and the
[calibration manifest](../backend/tests/fixtures/athena-calibration-fixtures.json).

- [Calibration manual](https://bruceravel.github.io/demeter/documents/Athena/process/cal.html)
  and [Calibrate.pm](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/UI/Athena/Calibrate.pm)
  specify the controls, initial first-derivative view, point selection and target.
- `Data/E0.pm::e0_zero_crossing` supplies the alternating sample search and
  five-decimal result. `Data/Plot.pm::suffix` selects the displayed array.
- `templates/process/larch/deriv.tmpl` computes the raw derivatives:
  `deriv(mu)/deriv(energy)`, followed by the derivative of that result divided
  by `deriv(energy)`. These are ratios of differences, including on nonuniform
  grids; normalization is not applied before these calibration derivatives.
- The Ifeffit and Larch `smoothed.tmpl` files supply different display filters.
  The Ifeffit filter repeats its native three-point opcode 0–10 times. A positive
  Larch smoothing value enables one Savitzky–Golay pass; its magnitude is not
  a repetition count. The web offers both explicitly. Larch SG uses the
  [shared preferences](athena-smoothing-preferences-reference.md), including the
  effective window 31 / order 9 defaults. Preview captures both values so a
  concurrent preference edit does not alter the settings sent to save.

The measured energy axis is raw energy plus the existing energy shift. The
reference and target are in eV on that displayed axis. Given reference `r`,
target `t`, and previous shift `s`, native `OnCalibrate` sets:

```text
new_shift = round_to_3_decimal_places(t - r + s)
new_E0 = t
actual_reference = r + new_shift - s
```

It rounds the total shift, not its increment. The chosen point consequently
lands within 0.0005 eV of the requested target; the panel reports the actual
landing energy. Linked reference groups receive the same total shift once.
An explicitly set, distinct E0 in a tied group moves by the shift delta.

The plot initially spans reference −30 to reference +50 eV. Its orange marker
uses the displayed curve at the reference, with interpolation between samples.
The normalized display uses flattened normalization when flattening is enabled;
supplied normalized input retains its supplied values. Smoothing operates on
the chosen display array. **Find zero crossing** always searches the unsmoothed
raw second derivative, even when the visible curve is smoothed.

## Web interaction and persistence

Changing controls requests a read-only preview, including the current curve,
shifted overlay, reference marker, proposed parameter changes and processing
errors. The current curve supports Plotly point selection; the shifted overlay
cannot inadvertently be selected as an observed reference. Arbitrary reference
coordinates can be entered numerically. Escape cancels point selection.
Changing the group or settings invalidates old previews and old pick handlers.
View and smoothing choices survive closing and reopening the panel in the same
workbench. Changing groups resets the reference and target to that group's values.

`POST /api/athena/projects/{id}/calibration/preview` and `/calibration/zero`
require a current project version and one group. Save uses the same canonical
options through the existing command endpoint. Explicit coordinate modes other
than `displayed` are rejected. The older command without a coordinate field
retains its legacy raw-coordinate API contract; the panel never uses it.

Preview and zero search stage changes on a deep copy. Cancel leaves the saved
project unchanged. Save keeps the existing group, original raw energy/signal
arrays and source detector columns, updates E0 and energy shift, and recomputes
transitive background-standard consumers in dependency order. Frozen groups,
tied references and frozen background consumers prevent affected changes.
Independent groups remain unchanged. Version conflicts cannot save over another
window's work. Undo/Redo restores the complete group state; energy shift and E0
survive both web-sidecar and bare native `.prj` export/reimport.

## Executed evidence

The [native driver](../backend/tests/reference/calibration_native_reference.py)
extracts and executes unchanged `plot`, `Pluck`, `OnCalibrate`,
`OnFindZeroCrossing`, `e0_zero_crossing` and `suffix` methods. Explicit bridges
provide widget values, Data/Plot fields and cursor input. Original templates
are rendered by Perl `Text::Template`; Larch executes the derivative and SG
commands. The compiled Ifeffit 1.2.11d `f1mth` smoothing opcode supplies the
three-point results. Normalized and flattened arrays come from an independent
Larch `pre_edge` call with recorded fit parameters, not from the web processor.

The [compressed reference](../backend/tests/fixtures/athena-calibration-native.json.gz)
records **68 cases** on the unchanged official XDI Cu metal (408 observations)
and Fe2O3 (348 observations) fixtures:

| Native exercise | Cases |
| --- | ---: |
| Four views × smoothing 0/1/10 × Ifeffit/Larch × two measured inputs | 48 |
| Unsmoothed zero search under three display-smoothing choices | 6 |
| Three prior shifts × two targets × two measured inputs | 12 |
| Cursor reference assignment on both inputs | 2 |

Both recording and a fresh replay passed. All displayed values are compared,
including array endpoints, with `rtol=2e-12`, `atol=2e-13`. E0 and rounded shifts
are compared to the original Perl results. The manifest fixes source, harness,
oracle, measured input, Larch kernel and compiled smoothing-library hashes.
See the [XDI reference](athena-xdi-reference.md) for the measured file provenance.

Backend integration exercises Cu/Fe with positive, negative and zero existing
shifts, read-only preview, exact save, tied groups, captured SG preferences,
normalized reference changes, processing failures, strict inputs, detector
calibration, stale HTTP requests, Undo/Redo and both project encodings. Separate
background tests independently recalculate a two-hop dependency chain in both
project orders and check frozen transitive consumers. Component tests cover
asynchronous/reverted requests, plot coordinates, zero search, errors after busy
actions, retained controls and avoiding shifted-overlay point picks.

Two Chromium workflows passed on isolated 13004/18006 services. Desktop testing
imports real Cu data and compares every plotted import coordinate while selecting
columns, then exercises all four calibration displays, both smoothing methods,
zero search, exact save, Undo/Redo and a downloaded PRJ with its sidecar removed.
Mobile testing at 390 × 844 uses an actual Plotly point click, verifies no
horizontal overflow, cancels without mutation, reopens retained controls and
recovers from a two-window stale save. Desktop/mobile plots and actions were
visually inspected. Final suite totals are in [verification](athena-verification.md).

## Remaining fidelity limits

- This runs original methods/templates with explicit bridges, not the entire
  Demeter wx application or its complete normalization/AUTOBK dispatch. Matching
  the explicit Larch normalization inputs does not prove all native polynomial,
  flattening, automatic-default or backend-version combinations.
- Outer normalization endpoints now follow the executed native Larch clipping
  reference while retaining requested values. Inner-endpoint and sparse-window
  repairs, degree reduction and complete native normalization/flattening
  dispatch remain open. Invalid recalculation still clears processed results
  and reports an error rather than retaining an old curve.
- Atomic targets use XrayDB/Elam. Native Athena uses its configurable
  `Xray::Absorption` resource; other table selections are not reproduced here.
- The native zero search has boundary/zero-plateau quirks. The web uses the
  bounded [E0 implementation](../backend/xraylarch_web/athena_e0.py); the measured cases agree,
  but this is not blanket equivalence for pathological derivative arrays.
- Native preview writes `bkg_e0` immediately; web preview stages it until save.
  Native cursor picking can return coordinates between observations. Web curve
  clicks select measured points, and typed input supports intermediate energies.
- Native's documented frozen-control TODO is not reproduced: the web protects
  frozen data and dependent scientific results.

PR-01 remains Partial. The original full-Athena scope is unchanged and Artemis
is outside this implementation.
