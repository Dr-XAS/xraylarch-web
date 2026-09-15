# Athena import rebinning reference

Baseline: Demeter `06afc8da08a5a7d5a26ee14992170fcf5dc67406`, reviewed
2026-09-10. This implements the rebin portion of IM-07; the full Athena
objective, its 107 matrix rows, and the exclusion of Artemis remain unchanged.

## Sources and numerical contract

The [import preprocessing manual](https://bruceravel.github.io/demeter/documents/Athena/import/preproc.html)
and [rebin manual](https://bruceravel.github.io/demeter/documents/Athena/process/rebin.html)
describe the three-region grid. The numerical implementation follows pinned
`Data/Process.pm::rebin`, `Constants.pm`, the Larch `rebin/rebin_prep` templates,
`ColumnSelection/Rebin.pm`, `UI/Athena/IO.pm::_group`, and the defaults in
`process.demeter_conf`. Source hashes are in [the manifest](athena-primary-sources.json).

The native Larch path is fixed-width smoothing followed by interpolation,
not the variable-bin averaging of `larch.rebin_xafs`:

1. Resolve the grid E0 on the original input. With absorber enforcement, use
   the tabulated seed, resolve normalization ranges, and refine the requested
   normalized fraction. Dense/repeated readings remain available for scalar
   Larch normalization and fraction selection; no atomic-only fallback is used.
2. Starting at the first measured energy, use scalar additions for the pre-edge
   grid below E0−30 eV (default step 10 eV), the XANES region from E0−30 to
   E0+50 eV (step 0.5 eV), and the EXAFS region (k step 0.05 Å⁻¹).
   Demeter's exact `ETOK=0.262468292` is used. Append the final measured energy.
3. Smooth mu and detector arrays with the PDL uniform kernel, default width 3.
   `PDL::Primitive::conv1d` uses periodic endpoints and offsets
   `j-floor((width-1)/2)`. Even widths 2, 4, …, 10 are supported, matching the
   native preference range 1–11. Larger widths can wrap opposite scan ends.
4. Remove the first and last smoothed source samples and energies. Invoke the
   local Larch `interp(..., fill_value=0)` on the grid, then remove its first
   and last output samples. This local function extrapolates with a linear
   polynomial when its ordering check permits it; the fill argument alone
   does not imply zero-valued extrapolation.
5. Initialize the rebinned group, apply final edge enforcement, copy an
   optional standard, create/rebin its reference, and then align. Reference
   grid E0 is resolved independently. The native same-element 25 eV safeguard
   can substitute the sample identity's tabulated energy for its reference.

The Ifeffit template retains output endpoints and interpolates detector arrays
from the unsmoothed standard. These are explicit backend differences; the web
implementation follows the requested **Larch backend**. PDL behavior was
verified against its published 2.083 `primitive.pd` C loop. No claim is made
that the complete Perl/wx application or installed PDL runtime was replayed.

## Import and preview behavior

`athena_rebin.py` owns the plan; preview and import call the same plan builder.
Mu, XANES and normalized inputs support direct, transmission and fluorescence
arithmetic, detector sums, individual MED channels, eV/keV and stable row sorting.
Chi input disables the energy-grid control. The optional explicit grid E0 is
always eV and does not force a reference's E0. Reversed region boundaries are
exchanged with a warning, as in Athena. Invalid ranges, nonpositive/sub-precision
steps, fewer than ten resulting points and grids over 100,000 points fail
before import. Source scans can contain up to 250,000 readings; ordinary
processed spectra retain their previous stricter validation contract.

The column preview overlays original and rebinned mu before normalization and
background removal. It reports grid E0 and source/output counts per group.
“Plot original data” only changes visibility. Grid edits invalidate pending
requests; existing pause/replot, reference visibility and stale-response rules
still apply. Desktop/mobile layouts and rendered Plotly arrays are tested.

Successful imports persist the five region choices and restore rebin activation
for matching columns, including after restart. Changed layouts disable rebinning.
Width comes from the saved global preference and manual grid E0 is cleared;
see the [remembered-choice contract](athena-column-memory-reference.md) for the
source/manual discrepancy and precedence. Matching batch files and retries reuse
the selected settings. One file, including all channels and references, remains
an atomic project revision; a late failure does not commit earlier groups from
that file. Undo restores its prior project state.

The source stores `rebin` diagnostics plus `rebin_original` containing original
energy/mu, all selected-source columns, detector arrays, and any sorting
permutation. All repeated readings are retained; no rows are silently dropped.
Rebinned i0/signal use the same smoothing/interpolation. Standard deviations
propagate independent input variance through the combined linear operator,
including correlations caused by overlapping smoothing kernels. Original
arrays are validated and counted toward the 2,000,000-value exchange limit.
Web JSON and the web extension inside `.prj` preserve them. A desktop reader
that does not understand that extension still receives the rebinned spectrum;
preservation through an external desktop re-save has not been verified.

## Measured fixture and evidence

`backend/tests/fixtures/demeter-uhup.101` is the original HUP transmission quick
scan used by pinned `examples/tests/rebin.pl`, with numerator column 2 and
denominator column 3. Its source URL and SHA-256 are in
`backend/tests/fixtures/athena-rebin-fixtures.json`. The MRCAT V0.3 header is
recognized using local Larch's `APSMRCAT_BeamlineData` contract. Every data row
after its declared labels is checked before Larch reads it; malformed first,
middle and final observations cannot be discarded as metadata.

The file contains **2,006 readings, five columns, and 24 repeated energies**.
Default automatic grid E0 is **17168.101 eV**, yielding **396 points**. Tests
compare arrays with a scalar transcription of the native grid and PDL C loop,
using the real local Larch interpolator. Widths 1–11, endpoint trimming,
reversed boundaries, exact duplicate interpolation, extrapolation and error
propagation are covered. An independent matrix oracle checks covariance.
Enforced fractions are checked against direct Larch normalization and a scalar
crossing interpolation, including the real U scan and a 100,001-reading scan.

`test_athena_import_rebin.py` also exercises type/arithmetic combinations,
sorted keV columns, separate reference grids, standard-copy/alignment ordering,
same-element safeguards, original-data validation, budget limits, HTTP,
atomic retry/undo, and JSON/PRJ round trips. `test_parsing_mrcat.py` verifies
unaltered arrays against both direct Larch and independently parsed data rows.
Chromium imports two copies through the real file picker, compares the rendered
original data with the downloaded file, compares stored groups with the rendered
rebinned arrays, verifies originals and reloads the saved project.

IM-07 remains **Partial**: the full native preference tree/exchange, unmodeled standard
parameters, all desktop combinations and complete native UI replay remain open.
The [post-import rebin workflow](athena-post-rebin-reference.md) now shares the
native grid plan and adds measured E/k previews, current/marked creation and
shared saved grid defaults. PR-06 remains Partial, with its own tests and
documented native differences. The lower-level legacy transform helper still
uses `rebin_xafs`; the current web command no longer dispatches through it.
IM-10 remains Partial; MRCAT/XDAC support does not implement every file plugin.
