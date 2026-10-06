# Athena pre-edge peak fitting: single spectra and shared-peak series

**Analysis → XANES peak fitting** fits one to eight positive peaks on a linear background,
optionally with an arctangent or error-function edge step, over a chosen
energy (or k) window. Each peak is a Gaussian, Lorentzian or
Voigt line shape from `lmfit`, parameterized so that `amplitude` is the
*integrated area* under the peak, `center` its position and `sigma` its width.
The panel reports every fitted parameter with its standard error, plus the
derived FWHM and height, and the unweighted reduced χ² of the fit.

Ticking **Fit a series with shared peaks** turns the same panel into a joint
fit of two or more spectra.

## What the numbers mean

- **Area** is in signal × abscissa units — normalized μ(E) × eV for a pre-edge
  peak on `norm`, or χ(k) × Å⁻¹ on `chi`. It is the quantity that scales with
  the number of absorbing sites, which is why it, rather than peak height, is
  what a pre-edge analysis reports.
- **Centre** and **FWHM** are in eV (or Å⁻¹ on `chi`). The centroid of the
  pre-edge feature is the oxidation-state indicator; the splitting between
  components reports on site geometry.
- **Standard errors** come from the covariance matrix `lmfit` returns, scaled
  by the fit's own residual variance. The fit is unweighted, because an
  interpolated, normalized XANES spectrum carries no per-point σ that would
  mean anything. The errors are therefore *relative* precisions of the model
  given the data, not propagated counting statistics, and they assume
  independent residuals; interpolated XANES residuals are correlated, so read
  them as lower bounds.
- Every value is displayed to two significant digits of its own standard
  error, so the digits shown are the ones the fit actually resolves.
- **Reduced χ²** is unweighted and in squared signal units. It measures
  misfit, not noise, and is only comparable between fits of the same data over
  the same window.

## Background: line, or line plus an edge step

A pre-edge peak sits on the rising absorption edge. With only a straight line
under it, the fit tilts the line into the onset and the line takes part of the
peak area: on a synthetic Mn-like pre-edge (true area 0.25 on an arctangent
edge 10 eV above the peak) the line-only fit returns 0.167 ± 0.009. Choosing
**Line + arctangent step** (or error-function step) adds the edge Athena uses —
a height, a centre and a width — and the same data give 0.257 ± 0.008. The
step's centre starts at the group's E₀ and may lie up to one window width
outside the window, because a pre-edge window usually stops below the edge; its
height is kept nonnegative. As in Athena, the centre and width are held where
they are set and only the height is fitted, unless **Refine step centre and
width** is ticked. Freeing the step's centre and width adds two parameters
that a short pre-edge window rarely determines; hold them unless the fit
converges with them free.

The background model is not a detail here: on a pre-edge sitting on a rising
edge, the fitted area depends strongly on whether the step is modelled. Areas
are comparable only between fits made with the same background, window and
peak shape.

The dialog opens on the pre-edge (E₀ − 20 to E₀) and starts peak 1 from the
data: at the largest rise above the straight line joining the window's ends,
with the width where that rise halves and the matching area. **Estimate peak 1
from the data** repeats this after the window changes.

If `lmfit` converges but cannot invert the curvature matrix, the panel says so
explicitly — "the fit converged but produced no error estimates" — rather than
showing values that look fitted. That is the signature of peaks that are not
separable with the given starting values.

## Fitting a series with shared peaks

The series fit shares a peak's centre, its width, or both across all spectra,
while each spectrum keeps its own peak areas and its own background. The
residuals of all spectra are concatenated into a single unweighted
least-squares problem, so a shared parameter is determined by every spectrum at
once and carries one standard error for the whole series.

Sharing is an assumption, and the fit does not test it. It holds when the same
sites are measured on one calibrated energy scale and only their amount
changes. It fails exactly where an operando series is interesting: an
oxidation-state change shifts the pre-edge, and calibration drift moves it too.
So fit each spectrum on its own first, compare the centres and widths with their
errors, and share only what agrees. A shared error is conditional on the
sharing being right.

The series fit does that comparison for you. It also fits every spectrum alone
with the same window, peaks and background, and for each shared quantity
computes the χ² of the one-at-a-time values about their error-weighted mean
against n − 1 degrees of freedom. Below p = 0.01 the panel says, above
everything else, that the data do not support sharing that quantity. The
one-at-a-time errors are nominal lower bounds, so the test errs toward calling
disagreement; read it as "look at the trend plot", not as a verdict on the
chemistry.

Either tie can be released (**Share peak centres**, **Share peak widths**), but
not both: with nothing shared the series fit is only the single fits run
together, and the app refuses it with "A series fit must share peak centres,
widths, or both; otherwise fit each spectrum separately."

Limits: at least 2 and at most 40 spectra; the window is the common energy
range of all of them, so a spectrum that does not cover the window is refused
rather than silently extrapolated.

### What it buys, and when the data refuse it

Measured on 4 of the 28 vanadium K-edge glasses in
`examples/xanes/Vglasses.prj`, one Gaussian over 5462–5478 eV, peak 1 started
from the data:

| | Shared series fit | Each spectrum alone |
| --- | --- | --- |
| Peak centre | 5468.438 ± 0.012 eV (one value) | 5468.503 ± 0.021 → 5468.377 ± 0.029 eV, falling with fugacity |
| Peak width (σ) | 0.789 ± 0.013 eV (FWHM 1.857 eV) | four values |
| Sharing check | — | centre rejected (χ² 17.2 for 3, p = 0.0006); width consistent (χ² 1.34 for 3, p = 0.72) |

A shared centre would be about 1.7× better determined than any single-spectrum
centre — if the four glasses shared one. They do not: the separate centres move
0.13 eV toward lower energy as the glass is more reduced, the shift vanadium's
oxidation state is expected to cause, and the check says so. Sharing the width
alone is supported. (An earlier version of this page reported that `LW_20`
does not converge on its own; that is not reproduced — on 3 October 2026 it
converged from every start tried.)

### Trend plot

A series fit also draws its result as a trend: peak area (and any centre or
width that was not shared) against position in the series, with the nominal
error bars, one panel per quantity. A shared centre or width is drawn as a flat
line beside the values each spectrum gives on its own, which is the picture
that shows whether sharing was justified. At forty spectra the overlaid curves
are unreadable and the trend is not.

## Reading the result panel

The series panel is two tables. The first gives the shared peak parameters
once, with the single error the series supports. The second has one row per
spectrum with the quantities that vary — areas, plus any centre or width that
was *not* tied — and a "misfit" column, which is that spectrum's mean squared
residual: its share of the total, not a separate fit quality.

## API

Single fit — `POST /api/athena/projects/{id}/analyze`:

```json
{"version": 3, "action": "peaks", "group_ids": ["<group>"],
 "options": {"array": "norm", "xmin": 5462, "xmax": 5478,
             "peaks": [{"center": 5468.5, "sigma": 1.0, "amplitude": 1.0, "kind": "gaussian"}]}}
```

Series fit — the same with `"action": "peaks_series"`, two or more
`group_ids`, and `"share": {"center": true, "sigma": true}`.

The result carries `spectra` (one entry per group, each with `parameters` and
`redchi`), `labels`, the overall `redchi`, and `details.shared_across_series`
naming which parameters were tied.
