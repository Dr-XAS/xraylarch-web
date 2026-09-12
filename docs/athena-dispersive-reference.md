# Athena dispersive XAS calibration

The manual's [Dispersive XAS page](https://bruceravel.github.io/demeter/documents/Athena/process/pixel.html)
is an upstream TODO. The functional contract comes from pinned Demeter revision
`06afc8da08a5a7d5a26ee14992170fcf5dc67406`:

- [Data/Pixel.pm](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/Data/Pixel.pm): standard assignment, 10%/90% initial guess, coefficient refinement and conversion to a new normal absorption group.
- [UI/Athena/Dispersive.pm](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/UI/Athena/Dispersive.pm): beamline mappings, Reset, Refine, Replot, Make, plot limits and automatic `athena.dxas` persistence.
- [pixel_setup.tmpl](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/templates/process/ifeffit/pixel_setup.tmpl) and [pixel_fit.tmpl](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/templates/process/ifeffit/pixel_fit.tmpl): the actual derivative residual, interpolation and fit limits. These pixel templates are supplied for Ifeffit only.
- [dispersive defaults](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/configuration/dispersive.demeter_conf): quadratic 0, four smoothing passes, pixel post-edge extent 1000, display E₀−100 to E₀+400 eV.
- [SLRIBL4.pm](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/Plugins/SLRIBL4.pm): case-sensitive first-line `pixel` and `stripe` signature, saved calibration and first-two-column conversion.

## Workflow and scientific calculation

Import a conventional standard as normal energy data, then open **Process →
Dispersive energy calibration**. Select the conventional group and upload its
pixel measurement. The raw pixel plot updates while choosing pixel/numerator/
denominator columns, sums, absolute-ratio logarithm, inversion, row sorting or
signal reversal. An empty detector selection means constant 1. The conventional
group remains independent of marked groups. Manual conversion without a
standard is available when the coefficients are known.

The three column presets expose raw μ(pixel), Athena's ESRF `ln(abs($2))`, and
Athena's SLRI `ln(abs($2/$3))`. The official ESRF **cus2.pl** recipe explicitly
uses raw μ(pixel), despite the UI's ESRF logarithm preset: inspect the curve
and choose the mapping appropriate to the actual file. No facility identity
is inferred from the preset or from the broad pixel/stripe signature.

**Estimate initial coefficients** finds the 10% and 90% normalized edge
positions in each measurement and solves the affine mapping between the two
pairs. Each fraction uses up to five normalization iterations and a 0.001
coordinate tolerance; nonconvergence is reported. A manually supplied quadratic
term is retained, as in `Pixel::guess`. **Reset parameters** starts again with
the default quadratic term. Pixel normalization windows and polynomial degree
can be adjusted separately from the conventional group's saved recipe.

Energy is `offset + linear × pixel + quadratic × pixel²`, in eV. Refinement
follows the executed expressions in the native templates: differentiate **raw
μ**, smooth the pixel derivative, interpolate onto conventional energies and
fit a freely varying derivative scale along with the three coefficients. It
does not fit the normalized preview curves. Ifeffit's smoothing stencil is
½ center plus ¼ each neighbor, with ¾ center plus ¼ neighbor at endpoints.
Its `qintrp` formula blends local quadratics in the interior and uses linear
interpolation/extrapolation near endpoints. The fixed fit interval is the
overlap of the initial calibrated range after a +5/−10 eV margin with the
conventional scan. Residuals, scale, iterations, limits, sum of squares and
extrapolated-point warnings are returned with the fit.

Larch performs normalization and derivatives; lmfit leastsq refines the
coefficients. Positive, strictly monotonic calibrated energy is required.
Decreasing calibrated axes reverse the energy/signal pairs together. The
Photon Factory **Reverse signal order** option reverses μ alone before
calibration, a distinct operation used by its upstream recipe. A preview with
a conventional standard plots both normalized curves on an energy axis.
Editing the request immediately invalidates old curves and old fit statistics;
late responses cannot supply a curve for another column selection.

Estimate, Reset, Refine and explicit Replot persist the displayed coefficients,
matching the native Replot side effect. Automatic live previews while typing
are read-only. Save/Load and native **athena.dxas** YAML import/export also work
without a pixel file. Settings use a separate versioned preferences record,
survive server restart and stay outside project undo. A conflicting save keeps
the visible fit and reports the conflict; it cannot overwrite another window's
saved calibration. Calibration files accept only three finite scalar numbers.

**Make calibrated data group** inserts a new unmarked μ(E) group after the
selected standard, with normal processing defaults and undo/redo. Source
columns, original row order, mapping, coefficient values, standard identity
and source SHA-256 survive JSON/PRJ exchange. Original file downloads preserve
all bytes. Source columns use the existing validated project array schema and
participate in project size limits and exchange checks. Sorting and decreasing-energy conversion align retained
columns with group rows; `row_order` maps back to the source table.

## Automatic pixel/stripe import

Enable **SLRIBL4** in File → Plugin registry. Like the native plugin, it reads
the first two columns without logarithm and applies the saved calibration
before ordinary column selection. Missing calibration reports a recovery path
to this tool or native settings import. The original source remains available
alongside converted energy/μ data. Reinspect to use newly saved coefficients;
already staged arrays and imported groups retain their accepted calibration.
This brings the registry to 20 available readers. Two other top-level native
plugins and four nested Beamlines helpers, plus broader extension discovery,
remain part of the complete Athena objective.

The reader's signature also matches the official **ESRF** file. That file is
used honestly as a signature-compatible acquisition, not relabelled as an SLRI
measurement. A separate measured SLRI acquisition remains required. The web
converter retains 15 significant digits in its converted text; equivalence to
the native `points()` writer's exact formatting has not been established.

## Retained fixtures and verification boundary

[Fixture identities](../backend/tests/fixtures/athena-dispersive-fixtures.json)
include full SHA-256 and Git blob hashes at the pinned revision:

| Official file | Retained observations | Interpretation |
| --- | ---: | --- |
| ESRF_ID24/cus2/cu_08 | 1,241 | Pixel 0–1240, raw μ, 12 colon metadata lines |
| ESRF_ID24/cus2/cufoil_rt.txt | 725 | Conventional Cu, keV converted to eV |
| PhotonFactory/Pd_foil.CSV | 1,024 | First comma-prefixed acquisition-time row is a header; reverse μ only |
| PhotonFactory/Pd_foil_ref.txt | 481 | Conventional Pd, eV |
| ESRF_ID24/cus2/cu_08.calib | 1,241 | Separately published calibrated axis in keV; its μ is preprocessed |

The Cu prototype fit has approximately offset 8952.153, linear 0.286523 and
quadratic 5.514e−6. Against the separately supplied `.calib` energy axis its
RMS difference is 0.146 eV, maximum 0.349 eV. That upstream axis is rounded to
1e−5 keV and corresponds approximately to coefficients 8952, 0.287, 5e−6.
This is an independent physical-axis check, **not** an Ifeffit optimizer
equivalence claim. The source recipe's printed optimizer result is not stored
with the sample. Tests require <0.5 eV RMS and <1 eV maximum axis difference.

The Pd tests use the supplied conventional scan without the **pf.pl** recipe's
extra 1 eV Gaussian convolution, so they exercise measured-file calibration
and reversal rather than claiming an exact replay of that whole recipe.
Native normalization/optimizer execution, the recipe's large gzip time-series
CSV handling, measured SLRI data, automatic calibration upon file selection,
and the complete native preference tree remain open. The current table input
limit is 64 columns; large time-series matrices need a separate selection
workflow. No Artemis functionality is included.

[Backend tests](../backend/tests/test_athena_dispersive.py) check all retained
input observations, independent polynomial interpolation and matrix-stencil
oracles, synthetic coefficient recovery, measured fits, native Larch reading
of exported PRJ, source alignment, undo/redo, value budgets, namespace isolation,
settings persistence, malformed files and real HTTP routing. [Frontend tests](../frontend/components/athena-dispersive.test.tsx)
cover live edits, stale responses, persistence conflicts and failed-make retry.
[Browser tests](../frontend/tests/e2e/athena-dispersive.spec.ts) exercise real
uploads and Plotly curves, fitting, settings files, processing spaces and PRJ
round trips. Execution results belong in [verification notes](athena-verification.md).
PR-14 remains Partial; none of the 107 requirements is promoted to Verified.
