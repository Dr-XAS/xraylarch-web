# Athena deglitching and truncation reference

This records the implemented PR-07/PR-08 workflow and its evidence. Neither
requirement is promoted to Verified; whole-application Athena equivalence
remains open. Artemis is outside this work.

## Native basis

The [Athena manual](https://bruceravel.github.io/demeter/documents/Athena/process/deg.html)
describes point removal, pre/post-edge tolerance margins, weighted χ(E)
inspection and before/after truncation. Executed sources are pinned to Demeter
revision `06afc8da08a5a7d5a26ee14992170fcf5dc67406`:

- `lib/Demeter/Data/Process.pm`: `deglitch`, `deglitch_margins`, `Truncate`.
- `lib/Demeter/templates/process/larch/`: `deglitch`, `margin`,
  `truncate_before`, `truncate_after`, `trun_signal_before`, `trun_signal_after`.
- Reviewed UI/plot sources: `lib/Demeter/UI/Athena/DeglitchTruncate.pm`,
  `lib/Demeter/Data/Plot.pm`, `lib/Demeter/templates/plot/gnuplot/newchie.tmpl`.

The [native harness](../backend/tests/reference/point_edit_native_reference.py)
executes the unchanged Perl methods, renders the unchanged templates with
Text::Template, and executes the resulting commands with Larch. Data/config
accessors and update callbacks are explicit bridges. Normalization lines are
supplied by an independent Larch `pre_edge` call or a constructed straight
line. This is not a native GUI or full Demeter normalization-pipeline replay.

Two measured files from Demeter's `examples/recipes/Deglitch/` are retained
byte for byte: [ORP5.000](../backend/tests/fixtures/demeter-deglitch-ORP5.000)
and [ZT20.000](../backend/tests/fixtures/demeter-deglitch-ZT20.000), each with
586 observations and twelve original CSV columns. Their feedback energy is
column 3; the measured transmission signal is `ln(abs(column 6 / column 7))`.
The ZT20 file's comment says ZT30; the filename and original header are both
preserved without inventing a corrected sample identity.

These older CLS headers leave Event-ID unquoted. The native HXMA reader and
current web reader retain eleven generic columns after dropping the event
identifier. The browser tests deliberately select **column 2** as energy,
**column 5** as numerator and **column 6** as denominator, with Natural log
enabled, and compare every displayed coordinate to the source calculation.
The generic reader suggestion initially compares energy channels, so review
and correct it in the live column preview before importing these files.
Executing the pinned original HXMA `is`/`fix`/`suggest` methods separately
confirmed every value in both 586 × 11 fallback tables and the native
`energy=$1`, `numerator=$2`, `denominator=$3`, `ln=1` suggestion.

The [manifest](../backend/tests/fixtures/athena-point-edit-fixtures.json)
pins source, fixture, harness and relevant Larch module hashes. The
[compressed oracle](../backend/tests/fixtures/athena-point-edit-native.json.gz)
contains 30 cases: ten for each measured file and a constructed 41-point
boundary/spike probe. Cases cover exact/midpoint/endpoint removal,
before/after truncation at exact and intervening energies, and both margin
regions. Recorded output includes all retained values, indices, commands,
margin arrays and actual native detector outputs. A fresh replay matched all
30 cases; ordinary pytest consumes this pinned independent output.

## Implemented behavior

Open **Process → Deglitch data** or **Truncate data**. Both use one persistent
panel with point, margin and truncation modes, a source selector, live
original/modified curves, selected-point markers and local Undo/Redo buttons.
An initial read-only inspection loads μ(E) and χ(E) before a point is chosen.

| Operation | Selection and retained data |
| --- | --- |
| Point | Type an energy or arm Pick and click a plotted observation. The closest raw measurement is selected; an exact distance tie selects the later point. Removal deletes that observation without replacement. |
| Margins | Bounds are relative to the effective E₀ and must lie on one side of the edge. Larch floor indices define the inclusive measurement range. Points strictly outside the saved pre/post-edge line ± tolerance are removed; equality is retained. Tolerance is in raw signal units, initially 0.1 × edge step. |
| Before cutoff | Snap at or below the absolute cutoff, remove earlier measurements and retain the anchor. |
| After cutoff | Snap at or below the cutoff, remove the anchor and all later measurements. |
| Marked truncation | Use the same absolute cutoff for selected marked groups; explain skipped frozen groups or frozen background-standard consumers. |

The current group's ID, ordering, data identity, saved parameters, calibration
shift and earlier source provenance remain intact. All detector arrays,
retained source columns and source-row mappings are sliced using the same
retained indices. Source files on disk remain unchanged. XDI history records
the operation and removed-point count. A bounded web history also retains
removed coordinates, row indices and request settings.

Processing uses the current xraylarch backend and refreshes all transitive
background-standard consumers. If deletion makes a saved recipe invalid,
the raw edit remains available with an explicit processing error and cleared
processed curves. Undo/Redo restores exact data, source columns and recipes.
Web JSON/sidecar exchange preserves detailed point-edit history; bare native
PRJ exchange preserves modified measurements, native detector arrays and XDI
history, but cannot carry the web-only removed-row history.

χ(E) displays the backend's uniform-k χ weighted by the group's k-weight,
using E₀ + KTOE × k² as its energy axis. Selected raw energies are marked on
that processed curve with display-only interpolation. This does not alter
the measurement-removal algorithm or synthesize replacement data. Raw χ(k)
groups do not enable this UI, matching the native panel's eligibility.

Preview is read-only and revision checked before and after calculation.
The client rejects stale/reverted responses, inconsistent source partitions
and plots that disagree with retained measurements. Apply uses the reviewed
revision and validates the returned raw values. Escape cancels point picking;
edits remain in the panel after a failed save, and replot/reload enables
conflict recovery.

## Explicit differences and remaining fidelity work

The original Larch deletion template joins `signal`/`stddev` to an already
shortened `i0` suffix, corrupting detector values and sometimes lengths.
Detector truncation recomputes an index after shortening energy and can leave
detectors unsliced or drop another observation. The oracle records these
actual defects. The web implementation instead slices every aligned array
once with the selected raw indices.

Native margins can compare shifted plotting coordinates against unshifted
raw coordinates. Web selections apply calibration once and use the effective
E₀ consistently; separate nonzero-shift tests verify identical retained rows.
Malformed/out-of-range inputs and operations leaving fewer than ten points
are rejected under the existing web scientific data contract. Native command
behavior can instead coerce or empty a spectrum. Duplicate API point picks
are deduplicated rather than repeatedly removing neighboring observations.

Plotly picks the plotted observation directly; native wx/gnuplot cursor
selection uses its own normalized two-dimensional distance calculation and
double-click gesture. Exact off-curve cursor behavior, all native plotting
preferences, full wx panel/configuration lifecycle and a complete native
normalization/background/FFT replay remain unverified. No claim of complete
Athena parity follows from these 30 native cases or the web lifecycle checks.

Tests: [backend](../backend/tests/test_athena_point_edit.py),
[background dependency checks](../backend/tests/test_athena_background.py),
[component](../frontend/components/athena-point-edit.test.tsx),
[real browser workflow](../frontend/tests/e2e/athena-point-edit.spec.ts).
Executed results and temporary evidence paths are recorded in
[verification](athena-verification.md).
