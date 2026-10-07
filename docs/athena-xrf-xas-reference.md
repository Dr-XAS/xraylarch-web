# Fluorescence XAS from scan-resolved XRF fitting

This note records the method, the design decisions, and — before any test was
written — the ways each part can fail. Every failure below has one test named
for it.

## The problem

In fluorescence-mode XAS the signal is read from a multi-channel energy
dispersive detector: at each incident energy the detector returns a whole
X-ray fluorescence (XRF) spectrum, several thousand channels wide. The
conventional analysis sums a fixed channel window (a region of interest, ROI)
around the target element's Kα line and calls that the fluorescence yield.

That works when the target line is the only thing in the window. It fails at
low-energy edges and in dilute samples, because two other features live in the
same spectrum:

* the **elastic** (Rayleigh) peak, at the incident energy exactly;
* the **Compton** peak, at the incident energy shifted down by the Compton
  formula for the detector's scattering angle.

Both move as the monochromator scans. Over a 900 eV XAS scan they sweep
through the detector spectrum, and their low-energy tails sweep across the
target's ROI. What the ROI records is therefore the target line plus a
structured, energy-dependent background that looks like a slope or a step in
μ(E) and is indistinguishable from real absorption structure by inspection.

The fix is to fit the whole detector spectrum at every scan point, with the
scatter peaks placed where the incident energy says they must be, and to take
the fitted area of the target element's K-alpha lines (for a K edge) as the
fluorescence yield. K-beta is a separate nuisance component. The
stationary fluorescence lines and the moving scatter peaks are then separated
by their different energy dependence, not by a window.

## Method

The response is built on Larch's own XRF model (`larch.xrf.xrf_model`): the same
`XRF_Element` line tables, the same Fano-broadened `det_sigma`, the same
`hypermet` line shape, the same `XRF_Material` detector absorbance. No
external XRF package is used. The shared response corrections below extend
the original fixed detector-width assumptions.

### Target edge checks

The scan must cross an absorption edge of the target, or start no more than
200 eV above one. Otherwise extraction is refused with the target's nearby
edges and the other K or L3 edges inside the scan named, so an unrelated low
energy edge cannot silently become the target's line family.

When E0 is found automatically and the target edge is inside the scan, a rise
more than 50 eV from that edge produces a warning above the extraction plots.
The warning can name another element whose K or L3 edge is in the scan and
whose emission line is within 0.15 keV of the target line. This is a possible
overlap to investigate, not proof of that element's contribution. A manually
specified E0 or a target edge below the first scan point suppresses this
comparison. The fitted arrays and existing quality checks are unchanged.

### Stage A — per-detector calibration

Each detector element of a multi-element detector has its own gain, offset and
resolution. A handful of scan points (default 6, spread across the scan) are
fitted jointly per detector for the **shared, energy-independent** detector
parameters:

| Larch parameter | meaning |
| --- | --- |
| `cal_offset`, `cal_slope` | channel → keV, `E = offset + slope·channel` |
| `det_noise` | electronic noise term in `sigma = sqrt(efano·E + noise²)` |
| `peak_step`, `peak_tail` | hypermet step and tail on fluorescence lines |
| `elastic_sigmax`, `elastic_tail`, `elastic_step` | elastic peak width factor and tails |
| `compton_sigmax`, `compton_tail`, `compton_step` | the same for the Compton peak |
| `compton_angle` | scattering angle, degrees; sets the Compton centre |

#### Numerically stable response calibration

Calibration compares the intrinsic detector response with a nested expanded
response containing these shared corrections:

| Parameter | Meaning |
| --- | --- |
| `cal_curvature` | Quadratic endpoint deflection as a fraction of the linear half-span; bounded to keep the channel-energy axis strictly increasing |
| `det_variance_slope` | Effective slope of variance with photon energy, at least the material's intrinsic Fano contribution |
| `peak_gamma`, `peak_beta` | Voigt wing and fluorescence-tail decay; the Voigt wing is also applied to the scatter response |

The electronic noise alone cannot represent an incorrect energy dependence of
the resolution. The effective response parameters should not be read as
independent measurements of detector material properties.

The comparison uses two feasible generalized-least-squares updates of the
intrinsic model to estimate count variances. Both nested fits then use the
same frozen variance, `max(intrinsic prediction, 1)`, in both their inner
amplitude and outer shape solves. The one-count floor is conservative where
the mean is smaller than one. The expanded model must converge and improve
the weighted data residual sum of squares by more than the 0.999 quantile of
a chi-square distribution. Four newly freed parameters and three expanded
shelf bounds count as seven additional directions, giving a threshold of
24.322. Counting the bound relaxations as full directions is conservative.
This is an approximate nested-model criterion, not an exactly calibrated
finite-count significance test with active bounds and nuisance ridge.

This replaces the old test of absolute lack of fit against the number of
channels. Observed-count weighting overweights downward Poisson fluctuations
at low counts and cannot supply that noise expectation. Eight preselected
Poisson controls at mean rates of five and ten counts per channel exercise
the new comparison. The selected model is then estimated using the existing
count-weighted, nuisance-regularized production objective, consistently for
calibration and extraction. Model-variance weights determine model selection;
they are not silently mixed with count weights inside a fitted objective.
`detector_reports[].model_selection` records the statistic, threshold, nominal
tail probability, candidate convergence, and decision. `response_model` and
the panel identify the intrinsic or expanded response. A candidate that fails
to converge is not accepted.
The total allowance is 12,000 evaluations across the original fit, variance
updates, model comparison, and selected-response fit. Exhaustion is reported,
not treated as convergence; adding model selection must not silently consume
the selected estimator's old allowance.

The expanded shelf bounds use native Larch's maximum of 10. Hypermet divides
`step` by 100 before constructing its erfc shelf; 10 is not a probability or
a tenfold peak amplitude. The intrinsic stage retains the narrower original
bounds. Allowing the documented shelf range avoids forcing a missing scatter
shelf into stationary fluorescence amplitudes.

The target's K-beta amplitude is independent at every point, so its overlap
with a neighbour does not set the reported K-alpha yield. Matrix K-beta ratios
are now fixed to the tabulated atomic branching, with the detector's
energy-dependent efficiency applied. The previous factor-of-two fitting range
let Cr K-beta trade against adjacent Mn K-alpha and Fe K-beta trade against
moving scatter; a shared ratio was not enough to make it identifiable.
This is an explicit thin-sample prior, not a fitted sample-absorption model.
Differential self-absorption can invalidate it and needs independent response
or geometry information, not a broader unconstrained ratio. The K-alpha
doublet also retains its tabulated branching ratio.
The result's `target_line_families` records the reported observable explicitly;
the existing component key `Mn K`, for example, now denotes Mn K-alpha.

The shape fit uses bounded trust-region least squares with central differences
in characteristic physical units and Jacobian column scaling. Unlike a purely
relative difference, its derivative step does not collapse near a zero tail.
Its objective includes the same nuisance-only ridge penalty as
the inner amplitude solve. All amplitudes are still solved independently at
each incident energy; no absorption curve or EXAFS reference enters the fit.
The elastic center remains fixed at the known incident energy. Below-edge
initialization and an independent elastic-peak starting fit were investigated,
but did not correct the response mismatch and are not used as hidden priors.

Atomic tables and unchanged stationary line profiles are reused within a
fitter. Attenuation and escape are invalidated whenever the calibrated energy
axis changes. This changes runtime, not the fitted objective or result.

Native Larch is unchanged. Instead, the XRF extraction exports each fitted
and window-sum yield divided by its own full-scan `pre_edge` edge step. This
is a pure unit conversion, not pre-edge subtraction, flattening, or smoothing.
It prevents arbitrary fluorescence/I0 units from changing upstream AUTOBK's
scale-dependent endpoint clamp. An end-to-end regression changes only I0
units by a factor of 10,000 and checks ordinary `pre_edge` plus `autobk` on
both exported curves. Other absorption data retain upstream behavior.

#### The scatter tail length, and why it is a setting rather than a fit

One shape parameter is deliberately **not** in that table. In Larch's
`hypermet` the low-energy tail falls as exp((*E* − centre)/(`beta`·`sigma`)),
so its decay length is `beta` times the peak's own width, and Larch's default
`beta` = 0.5 caps the tail at about half a peak width. That is reasonable for
a fluorescence line, whose tail comes from charge lost at the edges of the
pixel. It can be badly wrong for a scatter peak, which also collects intensity
from scattering inside the sample and the cryostat and can run several hundred
eV below a peak a few tens of eV wide. When the model cannot draw that tail it
has nowhere to put the intensity except the target element's column, which
lifts the pre-edge and the edge step together.

The request field `scatter_beta` (default 0.5, Larch's own) sets it for both
scatter columns. **Raise it** when the pre-edge null test fails and the
detector-spectrum panel shows the model falling away faster than the data
below the elastic line. On a synthetic scan built with a sixteen-fold tail,
leaving it at the default inflates the pre-edge target amplitude by more than
half; setting it to the generating value recovers the injected amplitudes to
within 10 %.

It is a setting rather than a free parameter. Intensity below the elastic
line can reflect either a shifted Compton peak or a longer tail, so fitting
both requires an identifiability check rather than just a lower residual.

Every column — element line, scatter peak and continuum term alike — is put
through the same detector response before it reaches the fit: Larch's
`model.atten` and live time, and then the escape response, in which a line at
*E* leaves a copy at *E* − *E*<sub>Kα</sub> of the detector material. Applying
that to only some columns would let the fit pay for one component's escape
peak out of another component's amplitude.

The scatter **centres are not free**. At scan point *p* with incident energy
*E<sub>p</sub>*, the elastic centre is *E<sub>p</sub>* and the Compton centre is

&nbsp;&nbsp;&nbsp;&nbsp;`E' = E / (1 + (E/511.0)·(1 − cos θ))`  (keV, electron rest mass 511 keV)

with θ the one fitted angle. This is the "scatter energy pinned to each
point's incident energy" the method requires; leaving the centres free lets
them drift onto fluorescence lines.

The fit is *separable*: the linear amplitudes are not lmfit parameters. At
every iteration the nonlinear shape parameters fix the basis, the amplitudes
are solved in closed form (stage B), and the residual is the weighted
misfit. This is variable projection — it removes ~10 parameters per
calibration point from the search and makes the fit converge from a poor start.

### Stage B — the per-point amplitude solve

With the detector parameters frozen, at every scan point and every detector
the measured spectrum is a nonnegative combination of:

* one column per element and excitation subshell, with the target K-beta
  separated from K-alpha (fixed shapes across the whole scan);
* one elastic and one Compton column, **rebuilt at that point's centres**;
* a handful of continuum columns — decaying exponentials seen through the
  same detector absorbance — fitted alongside everything else.

Nothing is subtracted from the data before the solve. Production weights are
`w_c = 1/max(y_c, 1)`, an observed-count approximation to inverse Poisson
variance, not an unbiased low-count estimate. Subtracting a background
estimate first leaves a residual that is no
longer Poisson with variance equal to itself, and hands a background-dominated
channel the weight of an empty one. A positive combination of decaying
exponentials is a completely monotone function, so with those amplitudes held
nonnegative the continuum cannot curl up into a peak. It can still change the
baseline under a line; positivity does not eliminate continuum-model bias.
It replaces a
peak-clipping estimate (`larch.xrf.xrf_bgr`), which on synthetic scans
carrying a known continuum biased the recovered edge by about ten per cent at
a reduced chi-square near six, where this basis recovers the edge to under one
per cent at a chi-square of one.

Nuisance amplitudes are regularised by a ridge proportional to each column's
own Gram diagonal, so the ridge is scale-free. The signed target has no ridge
or numerical floor. The system is solved **exactly** under the bounds:
the unconstrained solution is taken where it is already feasible — there the
gradient vanishes, so it *is* the constrained optimum — and the remaining
points use QR elimination of the signed columns followed by nonnegative least
squares and recovery of the signed amplitudes. The constrained objective is
unchanged; its optimality is reported per detector. No point is clipped
towards the bounds or iterated towards them for a fixed budget.

Two constraints matter:

* **Nuisance columns are nonnegative.** Negative fluorescence or negative
  scatter is unphysical, and allowing it lets a bright neighbouring line be
  cancelled by a negative one.
* **The target column is signed.** Clamping the target at zero censors the
  small, signed model-mismatch baseline in the pre-edge, which biases the
  pre-edge upward and destroys the null test below. The target amplitude is
  allowed to go slightly negative; that is the honest answer when there is no
  target fluorescence.

### The edge gate

Larch's `XRF_Element` includes only edges below the incident energy — that is
its physical gate, and it is what makes matrix elements appear at the right
moment in the scan. But it also means that at the bottom of a Mn scan, where
the incident energy is below the Mn K edge, Larch builds **no Mn lines at
all** and the extracted pre-edge is identically zero. The pre-edge is where
the null test lives, so hard-zeroing it is not acceptable.

So the model is built in two pieces:

* the **target** element is built once at a fixed incident energy at or above
  the scan maximum, and its column is never gated. Pre-edge intensity is free
  to be whatever the data say, including nothing.
* **matrix** elements are built once at the same fixed energy — so their
  `elem.mu` scale is constant across the scan and is absorbed into the fitted
  amplitude — and then gated per point, **one column per subshell**. An
  element's K lines and its L lines are excited by different edges and switch
  on at different points in the scan; gating the element as a whole on its
  lowest edge would let K lines appear hundreds of eV before the beam can
  produce them. Each column is zeroed at every point whose incident energy is
  at or below that subshell's own absorption edge, read from `xraydb`.

An `open_gates` option names elements whose lines reach the detector from
outside the illuminated volume — scatter from a downstream component, say —
and are therefore present at every point regardless of their edge.

### Stage C — assembly

Per detector *d* and scan point *p* the fitted target **area** (the sum of the
target column times its amplitude) is multiplied by that detector's deadtime
correction factor for that point, then summed over detectors and divided by
the chosen I0 channel. The plain ROI window sum is carried through the
identical deadtime and I0 arithmetic so the two are comparable, and both are
normalised with Larch's `pre_edge`.

The exported `fit_over_i0` and `roi_over_i0` arrays are those raw yields
divided by their respective full-scan edge steps, not the background-subtracted
`norm` arrays. `metadata.mu_units` is `edge_step` and
`metadata.raw_edge_steps` records the `fit` and `roi` divisors. Multiplying an
exported array by its recorded divisor recovers the original counts/I0 yield.
`fit_counts` and `roi_counts` remain deadtime-corrected counts. Every
`per_detector` contribution uses the summed fit's divisor, preserving their
sum and relative weights. The saved group's extraction metadata carries both
raw steps and the normalization recipe.

Quality `edge_step` and `signed_jump` use the exported units; dimensionless
quality fractions and pass/fail checks are unchanged. The panel reconstructs
the signed raw yield step for display. A negative yield stays negative and an
inverted edge is still reported, since the divisor is positive. The conversion
does not correct self-absorption. Changing the later normalization recipe or
rescaling mu again can still expose upstream AUTOBK's clamp-unit dependence.
An edgeless yield is refused using the unclamped fitted jump and the native
step floor, rather than dividing a flat window sum by Larch's minimum step.

### Choosing the I0 channel

Which scalar channel carried the incident flux is the one thing in the request
the file does not state. Beamlines name their scalers after the hardware that
carries them — `IpreKB`, `Ipreslit` — rather than after the role they play, so
searching the channel list for the string `i0` finds the monitor on some files
and nothing at all on others, and a fallback to "whichever channel sorts
first" is not a fallback: it is a different experiment, silently run.

Two fields in the inspection response replace the guess.

* `usable_i0` is the subset of channels that are strictly positive at every
  scan point, which is exactly the test the extraction applies before dividing
  by one. Offering a channel outside it is offering a dead end, and the test
  `test_a_channel_that_is_not_strictly_positive_is_not_offered_as_i0` asserts
  that the offer and the refusal agree.
* `suggested_i0` is a ranked guess among those: a channel whose first
  hyphen-separated token starts with one of `i0`, `io`, `ipre`, `imon`, `mon`,
  `iflux`, excluding the tokens that name a detector *downstream* of the sample
  (`it`, `i1`, `i2`, `iref`, `itrans`, `ifluo`, `if`) — dividing fluorescence
  by one of those gives a ratio of two absorptions that still looks like a
  spectrum. Among the survivors, counts are preferred to the same signal
  reported as a current, and a net count to a raw one. It is `null` when
  nothing looks like a monitor, because a panel that asks is better than a
  curve normalised by a motor position.

The ranking is order-independent, so two files from the same beamline whose
HDF5 channel order differs normalise by the same monitor.

## Quality indicators

* **Pre-edge baseline diagnostic** (`pre_edge_null`). Below the edge the
  target's own edge contributes nothing, so the extracted signal should sit
  flat and near zero there. Four numbers, each as a fraction of the edge jump:
  the mean level, the drift (end minus start of a straight-line fit over the
  pre-edge window), that same line carried across the whole scan
  (`drift_over_scan_frac_of_jump`, which is what normalisation does with it),
  and the RMS about the line. The verdict judges the mean, the RMS and the
  carried drift (limit `NULL_DRIFT_LIMIT`, 5 % of the jump): a straight
  pre-edge from −10 % to +10 % of the jump has zero mean and no scatter and
  used to pass. It is a diagnostic, not a correctness verdict. Within limits
  is necessary, not sufficient: a bias shared above and below the edge passes
  it; a real pre-edge pedestal from harmonics in the beam, which excite the
  target at every incident energy, fails it although the extraction is right;
  and below-edge fluorescence from broadened edge tails or pre-edge
  transitions belongs to the sample. A window sum whose window catches a
  moving scatter tail fails it; a well-placed window can pass it.
* **Detector agreement.** Each detector is normalised on its own and the
  relative spread of the per-detector edge steps is reported, along with the
  worst pairwise RMS difference between normalised μ(E). A detector that
  disagrees is usually miscalibrated or shadowed.

## What is *not* here

Self-absorption is not corrected here. The extracted μ(E) is the fluorescence
signal in edge-step units; correcting it is a separate step on the resulting group,
described in the
[self-absorption contract](athena-self-absorption-reference.md).

## How each part can fail

Written before the tests. Each row names the test that catches it.

### Engine — basis and gating

| Failure | Why it would happen | Test |
| --- | --- | --- |
| The target column is empty below its own edge, so the whole pre-edge is hard zero | Larch drops edges above the incident energy; if the target were built per point it would vanish | `test_target_column_survives_below_its_own_edge` |
| A matrix element contributes above *and* below its edge | the per-point gate is not applied, or is applied with the wrong comparison | `test_matrix_element_is_gated_off_below_its_edge` |
| The element column's scale jumps mid-scan | `elem.mu` is evaluated at the incident energy; rebuilding per point changes the column scale and so the fitted amplitude | `test_element_column_scale_is_constant_across_the_scan` |
| The scatter peaks sit at the wrong place | the centre is taken from the model's `xray_energy` instead of the point's incident energy, or the Compton formula is inverted | `test_scatter_centres_track_the_incident_energy` |
| An element's K lines switch on at its L edge | one gate per element instead of one per subshell; iron's L edges are far below a manganese scan, so its K lines would light up inside the target's pre-edge | `test_k_lines_stay_dark_below_the_k_edge_although_the_l_lines_are_lit` |
| A component is deleted by its own escape response | Larch's escape term interpolates onto a shifted axis and fills off-window points with NaN, which the next step turns into zero | `test_escape_copies_a_line_below_itself_without_erasing_the_parent` |
| An escape peak is invented for a detector that cannot make one | the escape response is applied without checking the detector's own K edge against the line energy | `test_escape_is_silent_below_the_detector_k_edge` |

### Engine — the solve

| Failure | Why it would happen | Test |
| --- | --- | --- |
| A known injected target amplitude is not recovered | any of: wrong column normalisation, ridge applied on an absolute rather than relative scale, weights applied to only one side of the system | `test_injected_target_amplitude_is_recovered` |
| Pre-edge is biased upward | the target amplitude is clamped nonnegative, so model mismatch can only push it up | `test_signed_target_keeps_the_pre_edge_unbiased` |
| A bright neighbour is absorbed into the target | nuisance columns allowed to go negative | `test_nuisance_amplitudes_stay_nonnegative` |
| Loud channels dominate the fit | uniform instead of Poisson weighting | `test_poisson_weighting_downweights_the_loud_channels` |
| The solve silently returns the ridge's answer | the ridge is too large relative to the Gram diagonal | `test_ridge_does_not_shrink_a_well_determined_amplitude` |
| The fit claims a precision the data do not have | a background estimate is subtracted and the *remainder* is used as the variance, which it is not; the reduced chi-square then runs to tens or hundreds while the fit looks fine | `test_reduced_chi_square_matches_the_counting_noise_model` |
| The continuum carries the target's own edge | one background shape scaled by each point's total counts is tied to the target's absorption, so part of the signal is removed before the fit sees it | `test_the_continuum_does_not_take_a_share_of_the_target_edge` |
| The continuum makes a bump where a line is | a flexible background with signed amplitudes can shape itself into a peak and take a share of one | `test_the_continuum_basis_cannot_curl_up_into_a_line` |
| A clipped amplitude is passed off as the constrained optimum | clipping a negative to zero is not the optimum when columns overlap: the other amplitudes have to move to take up what it was carrying | `test_the_bounded_solve_beats_clipping_the_unconstrained_one` |

### Engine — calibration

| Failure | Why it would happen | Test |
| --- | --- | --- |
| Calibration converges to the wrong gain | the scatter centres are free, so the peak positions no longer pin the energy axis | `test_calibration_recovers_a_perturbed_gain` |
| Calibration is not reproducible | the calibration subset depends on dict ordering or on an unseeded random draw | `test_calibration_subset_is_deterministic` |
| A calibration that stopped at its iteration limit looks like one that converged | the optimizer's own verdict is discarded, and every number downstream inherits the difference silently | `test_calibration_reports_whether_the_optimizer_finished` |

### Engine — assembly

| Failure | Why it would happen | Test |
| --- | --- | --- |
| Deadtime is divided instead of multiplied, or applied after summing detectors | the factor is per detector and per point; summing first loses the per-detector weighting | `test_deadtime_is_applied_per_detector_before_summing` |
| I0 normalisation is skipped or applied to only one of the two extractions | the fit and the ROI must go through identical arithmetic to be comparable | `test_fit_and_roi_share_the_same_deadtime_and_i0_arithmetic` |
| Arbitrary monitor units change the extracted EXAFS | upstream AUTOBK's endpoint clamp depends on absolute mu units | `test_flux_monitor_units_do_not_change_exafs_from_exported_yields` |
| The extraction is flat or NaN because I0 has a zero | division by a zero or negative I0 point | `test_nonpositive_i0_is_rejected_with_a_readable_message` |
| A moving scatter tail is reported as absorption structure | the whole point of the method; the ROI must fail the null test where the fit passes | `test_moving_scatter_biases_the_window_sum_but_not_the_fit` |
| A truncated deadtime stream is treated as no deadtime at all | an array of the wrong length silently became unity, and the result was still reported as corrected | `test_a_wrong_length_deadtime_array_is_refused` |
| A zero or negative deadtime factor erases or inverts a detector element | the factor is a multiplier and both produce a plausible-looking spectrum | `test_a_nonpositive_deadtime_factor_is_refused` |
| Uncorrected data are saved as corrected | carrying a missing factor as unity is the right arithmetic and the wrong provenance | `test_a_scan_without_deadtime_says_so_rather_than_claiming_a_correction` |
| A descending scan is plotted against the wrong energies | Larch's `pre_edge` sorts the axis inside itself and returns the curve in that order, while the counts are still in file order | `test_a_descending_scan_is_sorted_before_it_is_paired` |
| The saved group cannot be reproduced from what it records | a hand-picked subset of the request leaves out whichever field was added last | `test_metadata_records_every_option_of_the_request` |
| The preview a reader judges is not what the export writes | a stride applied before the calibration points are chosen gives a different fit of the points it keeps | `test_a_strided_preview_is_a_subset_of_the_full_extraction` |
| One dead element blocks an eight-element extraction | any unusable deadtime factor refused the whole file, and nothing could leave the element out | `test_one_dead_element_does_not_block_the_others` |
| A 20-BM detector file cannot be opened at all | the reader knew only one data group holding a 3-D cube; 20-BM writes one `MCA n` array per element | `test_a_20bm_detector_file_is_read_as_one_multi_element_detector` |
| An element recorded off its neighbours adds its line partly outside the comparison window | the window is fixed in channels and every element was read at the same channels | `test_an_element_recorded_off_its_neighbours_is_read_back_in_line` |
| The first preview of a full-size scan fails | the fit window defaulted to every channel, over the basis limit on 560 × 8 × 4096 | `test_the_default_fit_window_stays_inside_the_basis_limit_on_a_full_detector` |
| The "conventional" curve sums the scatter peaks | an empty comparison window meant the whole fit window | `test_the_default_comparison_window_is_the_target_line_not_the_whole_fit_window` |
| The preview spectrum shows nothing of the target | it defaulted to scan point 0, below the edge | `test_the_default_preview_point_is_past_the_edge` |

### Quality indicators

| Failure | Why it would happen | Test |
| --- | --- | --- |
| An upside-down edge passes every check | Larch's `edge_step` is an absolute value, so a target column driven negative above the edge has a healthy-looking step | `test_an_inverted_edge_is_reported_although_larch_takes_its_absolute_value` |
| An over-subtracted extraction goes negative where the yield is largest | neither the pre-edge null test nor the edge step looks above the edge | `test_a_negative_post_edge_is_flagged` |
| A pre-edge that scatters wildly about zero is called clean | a verdict built on the mean alone, displayed beside an RMS it never read | `test_pre_edge_verdict_reads_the_residual_it_displays` |
| A straight pre-edge drift is called a clean baseline | the verdict read the mean and the scatter about a line, not the line's slope, which normalisation carries across the scan | `test_a_linear_pre_edge_drift_is_not_called_a_clean_baseline` |
| A shadowed or miscalibrated detector element is not noticed | the per-detector curves are never compared after normalisation | `test_detector_agreement_is_reported_for_a_multi_element_detector` |
| Detectors are failed for differing in solid angle, and passed when they share a bias | judging the spread of the edge jumps, which differs by design, instead of the normalised shapes | `test_detector_agreement_judges_shape_not_the_size_of_the_jump` |

### End to end — a known chi(k) put in and taken out

The tests above build their spectra from the same Larch model the engine fits
with, so a wrong peak shape, a wrong continuum or a wrong energy axis cancels
on both sides and none of them can see it. `xrf_injection_fixture` breaks that
symmetry: it is written against no part of Larch or of the engine, and it
injects a known single-shell EXAFS χ(k). It uses a pseudo-Voigt rather than the
engine's Voigt-based hypermet, a clipped exponential tail, a Kramers
bremsstrahlung continuum through a transmission window, a quadratic channel
axis, tabulated K lines rather than Larch's fuller line list, and elastic
and Compton peaks attenuated by the sample's own absorption so that the
nuisance features carry an inverted copy of the edge.

The axis curvature and energy-dependent width are now fitted explicitly. An
additional recovery case uses two charge-collection tail populations, which
the single-tail fitted response cannot exactly represent. Only two old
assertions that required the extraction to have a defect were replaced: a
known pre-edge offset is now injected into the quality reporter and must be
reported. The recovery limits were not relaxed.

Every curve compared goes through the same downstream processing:
`pre_edge(pre1=-170, pre2=-40, norm1=100, norm2=880, nnorm=2)` then
`autobk(rbkg=1.0, kweight=2, kmin=0, kmax=14)`. The number reported is
`rms((χ − χ_injected)·k²) / rms(χ_injected·k²)` over k = 3–10 Å⁻¹.

| Failure | Why it would happen | Test |
| --- | --- | --- |
| The extraction only reproduces spectra its own basis made | every other test synthesises from the model being fitted, so response error is invisible | `test_a_chi_the_model_never_saw_comes_back_out` |
| The fitting buys nothing over a fixed channel window | if a ROI sum returned the same χ(k) the module would be unnecessary | `test_the_window_sum_does_not_recover_what_the_fit_recovers` |
| Scatter or continuum leaks into the target column | the target column is signed and the continuum is smooth, so a mismodelled continuum can settle into the target | `test_nothing_fluoresces_below_the_target_edge` |
| A leaking extraction is reported as clean | an indicator that passes whatever the numbers do is worse than no indicator | `test_a_pre_edge_leak_is_reported_rather_than_hidden` |
| A detector's calibration is fitted on the wrong detector | the loop over detectors shares state, so one detector's gain is applied to another's spectra | `test_detectors_of_unequal_gain_agree_after_their_own_calibrations` |
| The ungated control stops recovering, or a deliberately added pre-edge leak is hidden | an overlapping line must not prevent recovery, and quality reporting must still detect known contamination | `test_an_ungated_matrix_recovers_but_an_added_leak_is_reported` |

Processing the exactly known absorption supplies a downstream control, not a
mathematical error floor: extraction and spline errors can partially cancel.
Both analytic truth and processed truth are compared, so a small
total error cannot hide cancellation with the background-removal error.
The helper applies `pre_edge` to each curve, then passes a fresh group with
mu divided by its edge step and explicit `edge_step=1` to unmodified AUTOBK.
The truth control therefore no longer changes with the number of detector
elements or arbitrary yield units. The separate output-path regression still
checks ordinary `pre_edge` plus AUTOBK on exported yields as a user would.

The original fixture's Fano variance coefficient is ten times the physical
Ge value. It remains unchanged as a broad-response stress case. Additional
Ge and silicon-drift-like cases use physical Fano coefficients, with and
without gated Fe and with and without Poisson statistics, under the same 20%
recovery limits. These are detector-width cases: both retain Ge attenuation
and escape in the fitter, so the silicon-like case is not validation of a
complete silicon detector model. Fe adds fluorescence in this fixture, not an absorption edge
in the total attenuation; a resulting edge artifact is cross-talk, not Fe
self-absorption. Scatter already carries an inverted target edge, so an
across-edge difference is not a pure target response template.

After the response and numerical repair, these results reproduce on the
same aarch64 host with NumPy 2.4.6 and 2.5.3, SciPy 1.17.1 and lmfit 1.3.4.
The exported signals agree within 4e-15 relative between those environments
and every calibration converges. Errors below are fractions, not percentages.

| Synthetic case | Fit vs analytic chi | Fit vs processed truth |
| --- | ---: | ---: |
| Broad-response stress case, noiseless | 0.06384 | 0.01253 |
| Broad-response stress case, Poisson counts | 0.07831 | 0.06542 |
| No matrix elements | 0.06619 | 0.00398 |
| Fe excited throughout the scan | 0.06708 | 0.02065 |
| Additional independent charge-collection tail | 0.08332 | 0.05836 |

The eight realistic-width combinations span 0.06732 to 0.08874 against
analytic chi, below the unchanged 0.20 limits. These synthetic cases establish
recovery under the tested mismatches, not detector-independent accuracy on
arbitrary measured spectra. Shared response parameters can still hit bounds;
quality diagnostics and comparison with a measured reference remain necessary.

The validated claim is oscillation recovery on k=3-10, below the matrix Fe
edge, together with the checked near-edge shape. It is not recovery of the
full normalized mu(E), chi above a matrix edge, or absolute yields. Smooth
post-edge bias can be absorbed by AUTOBK while chi in this window passes.
Recovery runs print each detector's `at_bounds` as well as convergence and
response choice; an optimizer success alone is not physical validation.
With fixed matrix branching, these eight width cases have no reported bound
hits, but the ungated stress control still hits `det_noise` and
`compton_angle`. The noiseless Ge-width and silicon-like cases retain about
12% and 16% normalized deficits at the end of the scan. Their near-edge
maximum differences within 50 eV are below 1.2% of the jump, while k=12.5-14
RMS errors are about 38% and 24%. Removing a bound hit does not remove response
bias outside the accepted k window.
The pre-edge-null limits are not weakened: twelve of the thirteen saved
successful synthetic recoveries fail the mean or extrapolated-drift check;
the ungated control passes. A failed check warns of
baseline/model mismatch, but by itself neither proves nor disproves recovery
in the tested k window. The Cr measured null failure must be read alongside
its independent EXAFS comparison, not used as stand-alone evidence.

The former NumPy split began with roundoff in the bounded amplitude solver's
SVD. An initially rank-deficient, poorly scaled nonlinear calibration amplified
it before reaching its iteration cap. Stabilizing that solve alone made the
answer repeatable but did not fix recovery. Correcting the width law and axis,
separating target K-beta, and exporting XRF yields in edge-step units
were also required. Reduced chi-square alone was not an accuracy test.

The fixture returns total K-line counts, whereas the extraction now reports
K-alpha. Their normalized shapes agree because the fixture fixes its line
ratio; their absolute counts are different observables. No absolute K-alpha
yield-accuracy claim follows from this normalized recovery table.

Run from `backend/` with each supported interpreter and `PYTHONPATH=..`:

```sh
python -m pytest -q -s tests/test_xrf_injection_recovery.py tests/test_athena_xrf_xas.py
```

Check both `xraylarch_web.__file__` and `larch.__file__` when sharing a virtual
environment between worktrees. The same native AUTOBK implementation must
process the extracted signal and its reference.

### API surface

| Failure | Why it would happen | Test |
| --- | --- | --- |
| The panel is offered no detector or no I0 channel | the reader misses the 3-D detector array or the scalar channels, so every later request names something the file does not carry | `test_the_scan_file_is_read_back_with_its_detector_and_channels` |
| A stale client overwrites a newer project | the version token is not checked before and after the slow solve | `test_stale_version_is_rejected_before_and_after_the_solve` |
| A preview mutates the project | the preview writes fitted parameters back into the stored scan record | `test_preview_does_not_mutate_the_project` |
| A response carries NaN and cannot be stored | the project store writes JSON with `allow_nan=False` | `test_response_arrays_are_finite` |
| An unreadable or non-XRF file 500s | h5py raises OSError/KeyError rather than a domain error | `test_unreadable_scan_is_rejected_with_a_recovery_message` |
| Export produces a group that Athena cannot process | wrong `data_type`, or missing provenance | `test_exported_groups_are_normalizable_and_carry_provenance` |
| A huge scan exhausts memory or the exchange budget | no bound on points × detectors × channels | `test_oversized_scan_is_refused` |
| A channel the extraction will refuse is offered as I0 | the summary lists every channel without applying the positivity test the solve applies | `test_a_channel_that_is_not_strictly_positive_is_not_offered_as_i0` |
| The scan is normalised by a detector downstream of the sample | the monitor is guessed by name, and `It`/`Iref` are as plausible-looking as `IpreKB` | `test_the_suggested_i0_is_not_a_channel_downstream_of_the_sample` |
| A scan is normalised by a motor position | the guess always returns something rather than admitting it recognised nothing | `test_nothing_is_suggested_when_no_channel_looks_like_a_monitor` |
| Two files from one beamline normalise by different monitors | the guess depends on the order HDF5 hands back names | `test_the_i0_suggestion_is_the_same_whatever_order_the_channels_arrive_in` |
| The same monitor is read as a current on one file and as counts on another | several reports of one scaler are ranked arbitrarily | `test_the_suggestion_prefers_counts_to_the_same_signal_as_a_current` |
| A detector the reader rejected is allocated anyway | the limits are enforced when the file is inspected, not when a later request names a detector | `test_a_detector_outside_the_inspected_table_is_refused` |
| Each dimension is within its limit and the product is tens of gigabytes | points, detectors and channels are bounded separately | `test_an_oversized_count_block_is_refused_before_it_is_read` |
| The fit basis is larger than the counts and nothing bounds it | it carries one copy per component and is built per detector | `test_an_oversized_fit_basis_is_refused` |

### Panel

| Failure | Why it would happen | Test |
| --- | --- | --- |
| The plot shows a result computed from other settings | no settings key, or a late response overwrites a newer one | `renders only the preview that matches the current settings` |
| The user cannot tell the fit from the window sum | both traces drawn identically | `draws the fitted extraction and the window sum as distinct named traces` |
| A failed preview leaves the previous curves on screen | the error path does not clear the stale preview | `clears a stale preview when the request fails` |
| Quality numbers are shown without saying whether they pass | a bare number with no threshold is not an indicator | `reports the pre-edge null test and detector agreement with a pass or fail` |
| Export is offered before there is anything to export | the commit button is not disabled while the preview is empty | `disables export until a preview has arrived` |
| Zoom is lost on every keystroke | `uirevision` includes presentation state | `preserves the plot ui revision across presentation-only changes` |
| The scan is normalised by a dead scaler channel | the panel picks the first name matching `i0`, or failing that the first channel of all | `offers only the I₀ channels the extraction would accept, and starts on the suggested one` |
| An unrecognised monitor is filled in with a guess rather than asked for | an empty suggestion falls back to a default instead of blocking the fit | `asks for the I₀ channel when the server recognizes none` |
| A calibration that did not finish is presented as a clean extraction | the per-element report is computed and then dropped before the response is drawn | `reports a detector element whose calibration did not converge` |
| The element choice never reaches the fit | the raw viewer's selection did not transfer, and an unusable element could not be left out | `extracts from the ticked detector elements, at the shifts typed, and never from an unusable one` |
| A full-detector default window, or a window nobody can see | windows defaulted to the whole detector; automatic windows were not reported | `leaves the windows to the server when they are empty, and says what it chose` |
| The plots hide the result | 1e-15 component tails set the log axis; a window sum at 17 flattened the fitted edge | `scales the plots to what was measured and fitted, not to component tails or the window sum` |

The component tests above run against a mocked API, so a field renamed on one
side alone still passes them. Two browser tests run the real upload, the real
solve and the real project store, which is the only place that shows.

| Failure | Why it would happen | Test |
| --- | --- | --- |
| The panel draws something other than what the server returned | a field renamed on one side, or a unit applied twice on the way to the plot | `plots the extraction the server actually returned, through the real upload and solve` (Playwright) |
| The exported group is not the curve the reader approved | the export refits with different settings, or writes the window sum into the fitted group | `exports the curve the reader approved rather than a second fit` (Playwright) |

### What the indicators do not cover

`edge_step_spread` is the spread of the absolute edge steps of the individual
detector elements. Elements differ in solid angle and in gain, so a real
multi-element detector spreads even when every element reports the same
spectrum: the 5% threshold reads as a warning to look, not as a defect. The
shape disagreement is `worst_pairwise_rms`, taken between the elements after
each is normalised. The pre-edge null test likewise measures the extracted
signal itself, so an absorption edge with a slowly rising pre-edge tail shows
a small non-zero drift that belongs to the sample and not to the extraction.

### How to read `detector_reports`

The entries are calibration diagnostics, and the field `calibration_subset_only`
says so: `redchi`, `nfev`, `success`, `ier` and `message` all come from the
stage-A shape fit on the calibration subset, not from the per-point solves
that produce the curve. The two fields that do describe the whole scan are
`unconverged_points`, which must be zero, and `max_optimality`, the largest
first-order optimality residual over the per-point solves, which should be
near machine precision.

`success` is lmfit's termination criterion for the selected production fit,
not a measure of fit quality. `nfev` totals evaluations across all calibration
and comparison fits. A retained intrinsic fit can have `success=true` while
the expanded comparison failed; `model_selection.candidate_converged` and the
panel report that failure separately.
A false result is a warning: calibration has not demonstrated convergence,
even if its residual is small. The repaired synthetic acceptance requires
convergence rather than an evaluation cap. Read `redchi` together with the
quality block, residual spectra, bounds, and detector agreement; no single
one of these establishes correct target separation.

`at_bounds` names the shape parameters the fit left resting on a limit. A
parameter on its bound is the optimizer saying it wanted to go further, so
the shape is the bound's and not the data's, and whatever the data wanted
past it has been pushed into the other columns — the target's among them.
lmfit still calls such a fit converged. Zero floors and the intrinsic
`det_variance_slope` floor are not listed: they mean no extra response
contribution, rather than an unphysical demand to go past a limit. The entry that
matters most here is `compton_angle`: nothing else in the model can shift the
Compton peak, so an element reporting it means the scan's Compton peak does
not sit anywhere the fit is allowed to put it, and the geometry in the request
should be checked.

The response carries no uncertainties on the per-point target amplitudes.
Propagating them honestly would have to carry the frozen shape parameters'
covariance through a bounded solve in which most points sit on at least one
bound, where a linear error estimate is not valid; a number that ignored this
would be read as an error bar on μ(E) and would be wrong by an unknown factor.
The quality indicators are the scatter estimate the module does offer.

## Measured-data validation

Synthetic recovery and numerical reproducibility do not establish that a fit
improves every measured spectrum. A well-placed window around an isolated line
can already contain almost all available target information. Fitting extra
nuisance amplitudes can then increase variance without removing appreciable
bias. Response mismatch remains a separate source of systematic error.

The measured scans checked so far mostly take the expanded response path.
At high counts, small systematic shape mismatches can exceed the nested-model
threshold. Some expanded comparisons do not converge and retain the intrinsic
response with an explicit warning. Neither model choice nor a lower residual
validates the extracted XAS.

In one measured comparison, the fit was marginally worse across the checked
series. In another, the fit improved near-edge shape but worsened EXAFS, and its pre-edge-null
diagnostic failed. The UI and documentation may claim numerical reproducibility
and recovery in the tested synthetic cases, not generally better measured
data, accurate absolute photon yields, or independently validated EXAFS.

Use a simultaneous independent reference where available, first checking that
it actually contains the target edge. Compare fitted K-alpha and the beamline
window under identical normalization and background settings. If sample
thickness and geometry are unknown, compare near-edge shape and oscillation
phase, allowing only one amplitude scale; do not infer a self-absorption
correction from agreement with the reference. Agreement with another XRF
spectral fit is a model comparison, not ground truth.

Read convergence, bounds, residual spectra, and pre-edge-null diagnostics
together. The elastic and Compton features can remain unresolved, making
offset, width, and scattering angle strongly correlated even when the target
yield is stable. An effective fitted angle is not a measurement of beamline
geometry. Convergence establishes a stopping criterion, not unique physical
response parameters or absence of model bias.

Measured inputs, results, plots, and timing tables are kept outside this
repository. The earlier report of capped calibrations and a suspected changing
line list described the previous implementation. The current fitter fixes its
atomic tables at construction and uses the staged, bounded calibration above;
historical diagnoses must not be read as validation of the repaired model.

### What the panel shows

The per-element calibration report was already computed and thrown away before
it reached the browser. It is now rendered under the quality indicators as a
collapsed summary — how many elements converged, how many left a shape
parameter resting on a limit — with one line per element carrying its reduced
χ², its total evaluation count and termination message, the parameters at bounds, the
count of per-point solves that did not converge or were held at zero, and the
fitted energy axis and Compton angle. Read it as "the first place to look when
the quality checks fail", not as a verdict in itself; see *How to read
`detector_reports`* above.

### The preview stride

The preview stride selects returned points, not the points that determine
calibration, edge-step units, or quality diagnostics. Frozen-response yields
are solved for the full scan in bounded-memory batches, retaining only the
preview spectrum and output arrays. A strided preview is therefore an exact
subset of the full extraction, rather than a curve divided by a different
edge step. Making the group reuses matching detector fits from a recent
preview and saves all points. Striding reduces response size and plotting
cost, not the amount of spectral calibration work.

### Execution and reuse

Independent detector elements run in a persistent spawn-based process pool.
`XRAYLARCH_XRF_WORKERS` defaults to eight, capped by available CPU affinity;
set it to one for serial execution. Each worker uses one native numerical
thread. The server retains detector order when collecting and summing results.
Concurrent requests share the pool, not eight new workers per request.
Cache hits do not wait for unrelated detector fits. If process creation or a
worker process fails, the affected request falls back to serial and the next
cold request recreates the pool, with a log message. After three consecutive
pool failures it stays serial until restart; a successful parallel fit resets
the failure count. Scientific fit errors are not hidden by this fallback.
Each backend server process owns its pool, so account for this setting when
running multiple backend processes.

Budget about 2 GB resident memory for eight workers after the first XRF request,
in addition to the server and the cache. Larger scans can need more temporary
memory while fitting. Lower `XRAYLARCH_XRF_WORKERS` (for example to two), or set
it to one to avoid the process pool. This trades speed for memory. Workers exit
when their server dies, including abrupt termination: Linux uses a parent-death
SIGTERM plus an immediate parent check; a daemon parent watcher provides the
portable fallback. Process creation uses a persistent launcher thread so
retiring a request thread does not kill the workers. The multiprocessing
resource tracker exits after the parent and workers close its inherited pipe.

A process-local least-recently-used cache holds at most eight serialized
entries and 64 MiB, shared between full detector fits and finished results.
The key includes the scan-content digest and every result-affecting option.
Project version and upload identity are rebound, never reused from another
request. Display stride, preview point/detector, and the choice to save a
window group can reuse the same full-scan detector fits. Only the displayed
detector's preview spectrum is retained. A different preview point or detector
is drawn by repeating its original amplitude-solve batch, not changing its
arithmetic. Matching complete results avoid that work too. Simultaneous cold
requests may compute the same fit twice, but still share the one worker pool.

Uploads are still authorized, read, and safety-checked before cache lookup.
Changing a fitting or normalization option or the scan content misses the
corresponding cache entry. Eviction and restart only cost recomputation;
cached and uncached results use the same estimator and units. No fit is
reused across a software restart, and no measured arrays are persisted by
this cache.

Within one calibration, a finite-difference Jacobian moves one shape
parameter at a time, so most of each basis evaluation repeats an earlier one.
The Larch engine reuses the detector's xraydb attenuation and escape scale per
channel-energy axis, the scatter columns per scatter shape, and the continuum
columns per axis. Each is keyed by the exact bit pattern of every input it
depends on. The detector material's escape-line constants are looked up once.
Larch's own per-element components, which the engine does not read, are no
longer drawn a second time. The reused arrays are the ones a fresh evaluation
returns, bit for bit, so fitted parameters and yields do not change.

### Automatic windows and the preview point

Left empty, the fit window runs from 1.2 keV below the target's strongest line
family (intensity-weighted, so Kα is Kα₁ and Kα₂) to 0.5 keV above the highest
incident energy; the comparison window is that line ± 1.2 detector FWHM at the
engine's starting noise; the preview point is the first scan point 20 eV past
the edge. All three go through the request's starting calibration, so a
detector far from 10 eV per channel needs its own calibration typed first —
otherwise the fit finds no target line in the window and says so. The resolved
values, not "automatic", are what the result and the saved group record.

### Detector elements, shifts and the APS 20-BM layout

The `elements` option chooses the detector elements the fit, the deadtime
correction and the window sum all use; the result names the excluded ones. An
element whose deadtime factor is unusable is refused only when chosen.
`channel_shifts` reads an element a whole number of channels higher or lower,
for an element recorded off its neighbours; each element is calibrated on its
own for the fit, so the shift matters mostly to the fixed comparison window.

Both readers also open the APS 20-BM LabVIEW detector file: `1D Scan/MCA 1`…
`MCA n`, each (1, points, channels), read as one detector `MCA` whose element
*n*−1 is `MCA n`; the monochromator energy from `X Positions`; every scaler and
ROI sum under `Detectors` as a channel. These files carry no per-element
deadtime factor, so the spectra are used uncorrected and the result says so;
`XMAP12B:DT Corr I0` is offered as a monitor like any other.


## Sources

Larch `larch/xrf/xrf_model.py`, `larch/xrf/xrf_bgr.py`, `larch/xafs/pre_edge.py`
at the commit this branch is based on. The method follows the standard
practice of fitting the full multi-channel spectrum per scan point rather than
integrating a fixed window; no external implementation is reproduced.
