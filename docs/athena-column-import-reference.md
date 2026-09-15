# Athena column import and live preview

This checkpoint covers part of the full Athena duplication goal. It does not
include Artemis. The remaining requirements retain their original IDs in the
[parity matrix](athena-parity.md).

## Primary-source contract

The reference is Demeter revision
`06afc8da08a5a7d5a26ee14992170fcf5dc67406`. Source bytes were verified against
the pinned Git tree; SHA-256 hashes are in [the source manifest](athena-primary-sources.json).

- [Column-selection manual](https://bruceravel.github.io/demeter/documents/Athena/import/columns.html): inspect file contents, select energy and detector columns, see the resulting equation and spectrum, choose energy units and input type, sum MED channels or save them separately, select column ranges, clear numerators, and pause plotting.
- [Reference-channel manual](https://bruceravel.github.io/demeter/documents/Athena/import/ref.html): shared energy column, reference plot, natural-log and Same element choices, reference below its sample, and tied energy shifts.
- [ColumnSelection.pm](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/UI/Athena/ColumnSelection.pm): range selection checks numerator buttons, accepts reversed endpoints, skips the energy column, and pause suppresses automatic redraws.
- [IO.pm](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/UI/Athena/IO.pm), reference import: copy the sample data type; when Same element is enabled, copy element/edge identity. Initialize the reference independently. If its E0 is too far from the sample, use the shared identity's atomic edge. A different-element reference uses its own derivative E0. The sample's fractional-E0 policy is not applied to the foil.
- [process.demeter_conf](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/configuration/process.demeter_conf): `rebin.use_atomic` defaults to 25 eV.

## Implemented flow

`AthenaColumnSelection` displays the original file header and initial rows,
column numbers, the selected expression, and a live Plotly figure. Each change
requests `/preview-columns` after a 180 ms debounce. Cancelled or superseded
responses cannot replace the current selection's plot. During automatic
refresh the previous curve is hidden. Pausing preserves the previous curve
with an explicit stale-selection caption; Replot updates once. Reference
visibility can be toggled without repeating the calculation.

`athena_columns.map_columns` is shared by preview and import. It evaluates
every point for direct signal, logarithmic transmission, and fluorescence or
yield division. keV conversion, stable row sorting and summed/individual MED
channels follow the same path. Zero divisors, zero logarithm arguments, duplicate channel IDs and nonfinite
results are reported. Empty operand selections use constant 1, as in Athena. Errors at
points omitted from display sampling still prevent import. A preview can show
an unordered axis with a warning so column selection remains inspectable;
actual import requires a strictly increasing axis.

Preview changes neither project version, groups, history nor undo. Display
sampling keeps bucket minima/maxima and endpoints with at most 2,400 points
per curve, preserving single-point detector glitches. Import retains every
source point. Original input columns and their units are preserved for project exchange.
The selected signal array follows native sign/scale adjustments; the saved
mu array includes those adjustments independently of later plot scaling.

Separate-channel import creates a sample per numerator. If a reference is
selected, each sample receives its own unmarked reference immediately below
it. The entire import has one saved revision and one undo step. References
keep the sample's input type, independently determined E0, and optionally its
identity. A reference with a distant derivative E0 is reset to the tabulated
edge with a visible warning. Raw, finite reference data remain inspectable
with an explicit processing error when normalization cannot run. Invalid
arithmetic still rejects the entire import. If the same-element tabulated
edge lies outside the scan, a warning retains the measured derivative choice
rather than inventing an out-of-range E0.

## Evidence and limits

- `backend/tests/test_athena_columns.py`: direct/ratio/log arithmetic, summed
  and individual channels, reverse-order keV, raw chi axes, reference formulas,
  native reference type/identity/E0 behavior, separate reference pairs, undo,
  invalid late detector channels, bounded original-file text, extrema
  preservation, and HTTP immutability/version conflicts.
- `frontend/components/athena-import-preview.test.tsx`: debouncing, stale
  success/failure replies, cancellation, retry, pause/replot, upload/version
  isolation, plot data/axes, references and display-sampling warnings. Plotly
  is mocked here; these are component contracts rather than browser evidence.
- `frontend/components/athena-column-selection.test.tsx`: range parsing,
  additive selection, clear, invalid-range recovery, individual channels,
  reference options, chi eligibility, file contents and busy controls.
- `frontend/tests/e2e/athena-columns.spec.ts`: the repository's measured
  `examples/xafsdata/cu_10k.xmu` is transformed into deterministic detector
  counts whose inverse formulas recover the original mu. This fixture is
  explicitly a transformation of measured data, not an independently measured
  detector record. Chromium tests compare actual Plotly data, preview results
  and persisted groups, and capture desktop/mobile views.

Passing counts and actual browser results are recorded in the
[verification log](athena-verification.md). These checks use the Larch backend
and pinned source contracts; they are not a replay in the native wx Athena UI.

## Native arithmetic and suggestion extension, 2026-09-10

Further review of `Data/Mu.pm::put_data` established three behaviors that the
older implementation missed: the denominator can be a sum, logarithmic input
uses the absolute detector ratio, and sign/scale controls alter the imported
signal. The UI now provides the native combinations:

- Numerator and denominator checkbox sums, with 1 for an empty selection.
  The existing single-column denominator API remains compatible; multiple
  columns are sent as an array. Clear controls update the live expression and
  preview, including a valid constant curve.
- Natural log evaluates `ln(abs(numerator / denominator))`. Negative ratios
  produce a polarity notice; zero or nonfinite results are rejected over the
  entire input before any group is saved. The earlier tests that rejected
  negative ratios were corrected against the pinned source and replaced with
  independent absolute-log oracles plus zero-ratio rejection cases.
- Invert applies -1 and the multiplicative constant scales the imported mu.
  Native selected signal arrays receive the same factor; i0 and original
  uploaded columns remain unchanged. Retained mu standard deviations receive
  its absolute value. Reference data use their own expression without the
  sample's scale or inversion. The group plot multiplier stays 1.
- Reference selections may use a single column or constant 1 for either
  operand. Both empty selections disable reference import; choosing the
  explicit Constant 1 option permits a constant-only reference.
- Switching to chi(k) disables/reset units, division, natural log, inversion,
  scale and reference controls while retaining the numerator. The backend also
  ignores inactive absorption transforms for chi and canonicalizes its saved
  mapping, matching the native direct chi-column path.

`Data/Mu.pm::guess_units` examines the first five values. An increasing
sequence is eV if its first value exceeds 100, otherwise keV. This rule is now
used for inspected energy-column suggestions and when choosing another energy
column. Explicit eV/keV column metadata takes precedence. Other sequences yield
no guess and the UI asks the user to inspect and select units; it does not
reproduce the native out-of-range `lambda` selection index in a two-item menu.
Full wavelength support remains open.

Detector suggestions use the pinned `file.demeter_conf` defaults: incident
`i(0$|o)`, transmission `^i($|1$|t)`, fluorescence/yield `i[fy]`. Transmission
is preferred to fluorescence when recognized. A named existing mu column is
used directly, and k/chi labels or a .chi extension identify extracted chi.
Unknown multi-column tables initially select their second column; a single
energy column uses constant 1. The live equation/figure lets the user correct
these suggestions. Explicit choices persist for compatible files in the same
batch, even when later files carry different recommendations. Successful imports
also [remember choices across sessions](athena-column-memory-reference.md),
including references, preprocessing and matching-layout rebin activation. Native editable
preference expressions and the complete beamline plugin registry remain open.

The column dialog's native expression fields are read-only in
`ColumnSelection.pm`; earlier notes incorrectly implied a general expression
editor in this dialog. Its native checkbox sums and constants are now exposed.
General scientific engine command/expression input remains part of UI-12 in
the unchanged full parity matrix.

`test_athena_column_arithmetic.py` independently checks all three measurement
forms with multiple scales/signs, summed denominators, negative count polarity,
constant operands, independent reference scaling, chi behavior, strict field
validation, source-column preservation, and JSON/PRJ round trips. It also
covers detector aliases, unit-heuristic boundaries and single-column files.
Additional frontend tests cover emitted expressions/payloads, invalid scalar
editing, resets and batch reuse; real Chromium checks suggestions, denominator
sums, scaling/inversion and type switching. The validation log records actual
run counts, not native wx execution.

A deliberate numerical difference from the native text widget: zero is a
valid explicit multiplier and gives a zero signal; nonnumeric/nonfinite values
are rejected rather than silently replaced with 1. Constant or inverted data
can remain inspectable with a processing error if no positive edge can be
normalized. The original table is retained for correction/reimport.

Still open: full type-conversion/eligibility, other FEFF layouts, full source-text inspection,
detector corrections, wavelength handling,
user-configurable import preferences, the beamline file-plugin registry, and
general engine commands. File/column/group resource limits and complete native
UI replay also require review. No full import row is promoted to Verified here.

Import-time three-region rebinning and marking/standard copying/alignment are
now covered by the [rebin](athena-import-rebin-reference.md) and
[preprocessing](athena-import-preprocessing-reference.md) extensions.

FEFF xmu.dat import, normalized processing, live column alternatives and native
project flags are now covered by the [FEFF extension](athena-feff-import-reference.md).
