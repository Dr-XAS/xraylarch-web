# An alternative spectral model: MapsTorch beside Larch

This note records what the MapsTorch fitting engine is, what it shares with
the Larch engine and what it deliberately does not, what it does not model at
all, and — written before the tests — the ways it can fail. Every failure
below has one test named for it.

It is a companion to `docs/athena-xrf-xas-reference.md`, which describes the
extraction itself: the three stages, the gating, the amplitude solve and the
quality checks. None of that changes here. Read that note first.

## The problem

The fluorescence XAS extraction turns a stack of X-ray fluorescence spectra
into μ(E) by fitting each spectrum with a model of the lines in it and reading
off the target element's area. The arithmetic between the fitted areas and
μ(E) is simple and checkable. The model of the lines is neither.

A fluorescence peak in a solid-state detector is not a Gaussian. It is a
Gaussian whose width follows a Fano law, on a low-energy tail from incomplete
charge collection, on a step from photons that scattered in the dead layer,
beside an escape peak, under an elastic and a Compton peak whose shapes are
the beamline's as much as the detector's. Every one of those is a choice of
functional form with fitted parameters, and the choices are not forced by the
data: several quite different sets of shapes fit the same spectrum to within
its counting noise while apportioning the counts between the target line and
everything else differently.

That matters for any extracted edge step: on a real Mn scan the calibration
leaves `cal_offset` and `compton_angle` nearly non-identifiable at this
incident energy, and a small move in either changes how much of the Compton
tail is read as Mn Kα.

One fit cannot tell you how much of a number is the model. Two fits, drawn
from independent line tables with independent detector-response laws over the
same data, measure how sensitive the number is to the model. They do not bound
its error: two models can share a bias, and a third could differ from both.
That sensitivity is the only reason this engine exists.

## What MapsTorch is

[MapsTorch](https://pypi.org/project/mapstorch/) is a differentiable PyTorch
re-implementation of the spectral model used by MAPS, the XRF fitting program
of the Advanced Photon Source. It draws the same objects as Larch's model —
Gaussian lines of Fano-broadened width, a tail, a step, an elastic peak and a
Compton peak — from a different line table, with a different width law, a
different tail parameterisation, a two-sided Compton peak, and the K, L and M
lines of an element merged into one component each.

It is optional. It brings PyTorch with it, so it is **not** in
`backend/requirements.txt`; a server without it offers only the Larch engine,
and `available_engines()` is what the panel asks.

## Method

### What changes is the spectral model

MapsTorch is an alternative spectral model, not Larch's model with other peak
shapes: its line tables, detector response, continuum response and escape
treatment all differ. The engine is a drop-in replacement for the `Fitter`
class and nothing else.
The line families fitted, the incident energies their gates open at, the
continuum basis, the Poisson-weighted box-constrained amplitude solve, the
deadtime and I₀ handling, the normalisation and every quality check are the
Larch engine's, reached through the same module-level helpers —
`subshell_edges`, `reference_energy`, `gate_plan`, `channel_energy`,
`continuum_shapes`, `solve_amplitudes`. MapsTorch is used for exactly one
thing: the unit-amplitude columns of the basis.

This is what makes a comparison worth making. If the two engines also differed
in which elements they fitted, or in how they weighted the residual, a
disagreement between their edge steps would say nothing in particular. The
panel disables the two settings MapsTorch does not use — the detector crystal
thickness and the scatter tail length — when it is chosen.

### Unit amplitude, in a model that works in logarithms

Every amplitude in MapsTorch is a base-ten logarithm: the model multiplies by
`10 ** params[name]`. A unit-amplitude column is therefore the parameter set
to `0.0`, not to `1.0`. Setting it to one would scale every column by ten, and
because the amplitude solve outside is linear and unconstrained in scale, the
fit would succeed and the areas would all be wrong by the same factor —
which normalisation would then hide.

### Families, not subshells

MapsTorch names a component for a whole line family: `Mn` is every K line of
manganese, `Pb_L` every L line, `Au_M` every M line. The Larch engine's
columns are split by the subshell the line falls from. Each MapsTorch family
is therefore mapped onto the lowest edge that feeds it — K→K, L→L3, M→M5 —
which is the edge whose crossing brings the family into the spectrum, and the
one the shared `gate_plan` then gates it at.

For a target K edge, both engines now separate K-beta from K-alpha and report
the K-alpha yield. This adapter filters MapsTorch's native line structures
through its `e_consts` argument; it does not replace its line energies,
strengths or shapes. Matrix K families remain tied. Historical absolute
K-family yields are therefore not the same observable as the new K-alpha yield.

One consequence is worth stating plainly: the two engines fit the same
component list only where both line tables carry the family. MapsTorch's
default tables have no `Mn_L` or `Cr_L`, so a fit window wide enough to reach
first-row transition-metal L lines would give the two engines different
columns, and the comparison below would no longer be like for like.

### The reference energy, and why MapsTorch's own gating is neutralised

MapsTorch gates each line itself, inside the model, against the incident
energy in `COHERENT_SCT_ENERGY`: below an edge, the lines it feeds come out as
zeros. That gate cannot be used here. The target's column has to stay in the
model below its own edge — otherwise the pre-edge of the extracted μ(E) is
zero by construction, and the pre-edge null test, which is the extraction's
main check that nothing else has leaked into the target, would pass without
measuring anything.

So the element columns are built once, at a **reference energy** chosen to
clear every edge in play (the same `reference_energy` the Larch engine uses:
the larger of the scan's top and 1.001 × the lowest crossed edge among the
opened symbols), and the per-point gating is applied afterwards, from the
shared table. The columns are also built once, from the *starting*
calibration, and held fixed while the shape parameters are fitted — for the
same reason the Larch engine holds its column set: a fitted calibration moves
the window by a channel or so, and the basis may not change shape underneath
the amplitude solve when it does.

The scatter peaks are the exception. They move with the incident energy, so
they are rebuilt per point — batched, which MapsTorch supports by letting a
parameter tensor one dimension short of the energy tensor broadcast over the
channel axis.

### Two parameters pinned

`ENERGY_QUADRATIC` is held at zero. The panel, the viewer and the Larch engine
all read the detector axis as offset plus slope times channel; a fitted
quadratic term would mean the two engines no longer agree on what the
calibration of the same detector is, and the per-detector calibration report
could not be read side by side.

The continuum is the shared `continuum_shapes` family **without** the detector
absorbance factor Larch multiplies onto it. MapsTorch's model carries no such
factor, and a background column that had been through one while the lines
beside it had not would be the wrong shape.

### What it does not model: detector escape

Larch scales escape peaks by a fraction computed from the detector material
and thickness — an array over energy, zero below the detector's own K edge.
MapsTorch's `escape_factor` is a bare scalar. These are not the same quantity,
so no value is carried across and **the MapsTorch engine models no escape
peaks at all**.

The engine says so rather than leaving it in a docstring. It appends a note to
`metadata.engine_notes`, which the panel prints above the quality checks, and
it does so only where the omission could show: the escaping photon leaves with
the detector's fluorescence energy (Si 1.740 keV, Ge 9.886 keV), so if the top
of the fit window is below that, there is no parent intensity for escape to
move and the omission is exactly zero rather than approximately. On a Ge
detector fitted below 9.9 keV — a Mn K-edge scan, for instance — there is
nothing to declare, and nothing is declared.

## What the two engines do to the same data

**Historical comparison, before the numerical/response repair.** This table
used full-K raw yields, not the current K-alpha observable in edge-step units.
Its timings and relative rankings are not validation of the current engines;
the documented optional cross-response test remains a known failure.

Measured on one synthetic 24-point Mn scan drawn from the **Larch** engine's
own basis, with a known injected μ(E), continuum 200 counts, one detector
element, three calibration points. Fitting Larch-drawn spectra with MapsTorch
is the harder direction, and deliberately so.

| | Larch | MapsTorch |
| --- | --- | --- |
| wall time, whole extraction | 7.8 s | 2.6 s |
| pre-edge mean, as a fraction of the edge jump | 0.024 | 0.232 |
| pre-edge drift, same units | −0.012 | −0.030 |
| pre-edge RMS about the drift | 0.0099 | 0.0084 |
| `pre_edge_null` verdict (limit 0.02) | fails | fails |
| edge step | 0.2817 | 0.2583 |
| reduced χ² at the previewed point | 1.07 | 3.48 |
| normalised pre-edge, largest \|μ\| | 0.017 | 0.012 |
| normalised post-edge, largest \|μ − truth\| | 0.289 | 0.098 |

Four things to read out of this.

**The edge steps differ by 8.3 %.** That is the size of the peak-shape
systematic on this data, and it is the number the comparison exists to
produce.

**The reduced χ² is three and a half times worse**, as it must be: MapsTorch's
peaks cannot exactly reproduce Larch-drawn spectra. A MapsTorch fit of real
data is not handicapped this way; the synthetic comparison is not experimental
validation.

**MapsTorch leaves a large constant pedestal below the edge** — 23 % of the
jump — because the target column is the one column allowed to go negative, so
it absorbs the misfit of every other peak. The pedestal is nearly flat (its
RMS about the drift is *smaller* than Larch's), so normalisation removes it,
which is why the normalised curve is clean. The pedestal is measured and the
verdict is reported; it is not hidden.

**Normalised, MapsTorch is closer to the injected truth above the edge** than
the engine that drew the data. This is a real effect and not a mistake, but it
is one scan and one noise seed and it should not be generalised: what it
shows is that the shapes are a systematic on the extraction's *scale*, which
normalisation largely divides out, more than on its *shape*.

A caveat on the table: `pre_edge_null` fails for **both** engines here, Larch
included, because a 24-point scan leaves only four points below the edge and
the test is noisy on four points. The verdict is not evidence against either
engine at this scan length.

## Experimental validation

The synthetic test above uses Larch-generated spectra. It does not establish
either engine's accuracy on experimental samples. The engine remains
exploratory until validated on public experimental data with a known answer.

`extract()` refuses a result if a chosen element's calibration carries the
target line out of the fit window or leaves it contributing nothing, naming
the elements. This guard is exercised by the synthetic test
`test_a_calibration_that_carries_the_target_line_out_of_the_window_is_refused`.

## Using it

In the fluorescence XAS panel, **Spectral model** offers the engines the
server has. Everything else about the fit is unchanged, the preview is
invalidated when the engine changes (a different model is a different
fit), and whatever the chosen engine does not model is printed above the
quality checks. The exported group's metadata carries `engine` and
`engine_notes`, so a saved extraction records which model made it.

Installing it: from the MapsTorch checkout, not from PyPI.

```
pip install --no-deps <MapsTorch checkout>
pip install "setuptools<81"
```

Version 0.0.1 on PyPI is too old for this engine on two counts. It imports
`pkg_resources` at module scope, which setuptools 81 and later no longer
provide — hence the pin, which the checkout needs too. And its `elastic_peak`
and `compton_peak` subtract a scalar incident energy from the channel axis,
so a batch of points does not broadcast: every spectrum in this engine's
batched solve raises a shape error. The checkout also carries
`FWHM_FANO_COEFF`, which the width law here reads. Both failures are covered,
by `the_scatter_peaks_follow_the_incident_energy` and
`a_line_lands_where_the_shared_calibration_says_it_does`.

`--no-deps` is deliberate: MapsTorch declares `numpy<2.0.0`, and Larch
requires `numpy>=2.2`. The engine runs correctly under numpy 2 — the whole
suite below passes there — so the declared pin is the thing to skip, not
Larch's requirement. Installing MapsTorch with its dependencies downgrades
numpy and breaks Larch.

Nothing else in the app depends on it, and a server without it is fully
functional.

## Failures, each with a test named for it

Engine, in `backend/tests/test_athena_xrf_mapstorch.py`:

| Failure | Test |
| --- | --- |
| An absent MapsTorch surfaces as an import traceback instead of a sentence telling the reader to choose the other engine | `an_absent_mapstorch_is_refused_in_words_not_in_a_traceback` |
| An element MapsTorch has no line table for yields an empty basis and a silently meaningless fit | `an_element_mapstorch_has_no_line_table_for_is_refused_in_words` |
| MapsTorch's internal edge gating zeroes the target column below its own edge, so the extracted pre-edge is zero by construction and the null test passes without measuring anything | `the_target_column_survives_below_its_own_edge` |
| The shared gating is not applied, so a matrix element is fitted below its edge and its pre-edge intensity is attributed to the target | `a_matrix_element_is_gated_off_below_its_edge` |
| The column set is rebuilt per point, so the basis changes shape underneath the amplitude solve | `an_element_column_does_not_change_shape_across_the_scan` |
| A non-zero quadratic calibration term, or a different energy axis convention, puts the lines in the wrong channels while the fit still converges | `a_line_lands_where_the_shared_calibration_says_it_does` |
| The batched incident energy does not broadcast, so every point gets the scatter peaks of one incident energy | `the_scatter_peaks_follow_the_incident_energy` |
| The two engines fit different components or gate them at different energies, so a disagreement between them is not about peak shapes | `the_two_engines_fit_the_same_families_at_the_same_gates` |
| A continuum column curls upward and is fitted as a broad line | `the_continuum_cannot_curl_up_into_a_line` |
| The missing escape model is silent, or warns on every fit including those where it cannot matter | `the_missing_escape_model_is_declared_where_it_could_matter` |
| The log-amplitude convention is misread, so every fitted area is wrong by a constant factor that normalisation hides | `an_injected_target_amplitude_is_recovered` |
| The engine cannot recover an edge injected by the other one, so it is not fitting the same physics | `the_other_engines_spectra_are_fitted_back_to_the_injected_edge` |
| The pedestal a mismatched peak model leaves below the edge is absorbed silently rather than measured and reported | `the_pre_edge_pedestal_of_a_mismatched_peak_model_is_reported` |
| A result does not record which engine made it, or carries its caveats nowhere | `a_result_carries_the_engine_that_made_it_and_its_caveats` |
| The Larch engine acquires caveats it does not have, or stops naming itself | `the_larch_engine_declares_nothing_and_still_names_itself` |

API, in `backend/tests/test_athena_xrf_xas_api.py`:

| Failure | Test |
| --- | --- |
| The panel is offered an engine the server cannot run, or is not offered one it can | `the_inspection_offers_only_the_engines_this_server_has` |
| A misspelled engine name falls through to the default, and the result claims a model it was not fitted with | `an_engine_the_server_does_not_have_is_refused_by_the_schema` |
| The requested engine is dropped between the request and the fitter | `the_engine_the_request_names_is_the_one_that_made_the_result` |

Panel, in `frontend/components/athena-xrf-xas.test.tsx`:

| Failure | Test |
| --- | --- |
| The chosen engine never reaches the request, so a comparison of two models compares one with itself | `offers only the engines the server has, and fits with the one chosen` |
| An engine chosen on one server is kept on one that cannot run it, and every fit fails with an error the reader can do nothing about | `falls back to Larch on a server without the engine last chosen` |
| What the engine does not model is never shown where the quality checks are read | `shows what the engine that made the fit does not model` |
