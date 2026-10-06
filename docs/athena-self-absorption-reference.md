# Fluorescence self-absorption

A sample measured in fluorescence re-absorbs part of its own emission. The
deeper the fluorescence is produced, the less of it escapes, and because the
sample absorbs most strongly just above its own edge, the loss is largest
exactly where the edge jump is. The measured spectrum is therefore flattened:
the edge step is too small and the XANES and EXAFS amplitudes are damped.

The **Process → Self-absorption** panel corrects this two ways and reports
whether either correction can be believed for the sample at hand.

The reference is the
[Athena self-absorption manual](https://bruceravel.github.io/demeter/documents/Athena/process/sa.html)
and, for the finite-thickness model, Booth and Bridges, *Physica Scripta*
**T115**, 202 (2005). Attenuation coefficients come from XrayDB through
`xraydb.material_mu`, the same table Larch's own correction uses.

## The two corrections

Both work on the **normalized** absorption *n(E)* of the edge-jumping element
and share one geometry. Writing `g_in = 1/sin(angle_in)` and
`g_out = 1/sin(angle_out)` for the path lengthenings on the way in and out, the
total attenuation seen by a detected photon is

    S(n) = (mu_b + Dmu * n) * g_in + mu_f * g_out,

where `mu_b` is the attenuation of the whole material just below the edge,
`Dmu` the edge jump in attenuation, and `mu_f` the attenuation at the
fluorescence line. Angles are measured **from the sample surface**, in degrees.

**Thick sample (`algorithm: "fluo"`).** The default, and Larch's
`larch.xafs.fluo_corr` unchanged. An infinitely thick sample emits in
proportion to `n/S(n)`, which inverts in closed form:

    alpha = (mu_b + mu_f * g_out / g_in) / Dmu,    n = alpha * m / (alpha + 1 - m)

for a measured normalized signal *m*. Only the ratio of attenuations enters, so
no density is needed. This is the correction Athena offers and it is the right
one for a pellet or a thick powder.

**Finite thickness (`algorithm: "booth"`).** A uniform slab of thickness *d*
emits

    F(n) = n / S(n) * (1 - exp(-S(n) * d)),

and the normalized measurement is `F(n)/F(1)`. *F* is strictly increasing in
*n*, so each point is inverted independently by bisection (100 iterations on a
bracket widened by doubling, vectorized over the scan). Unlike the thick-sample
formula this needs *d* in absolute units, hence the **thickness** in µm and the
**density** in g/cm³. Only their product enters the physics, so either may
carry the packing fraction of a homogeneous pressed pellet. Partial surface
coverage — islands, a patchy film, powder grains with gaps — is a different
geometry: 10% coverage by 10 µm patches is not the same measurement as a
uniform 1 µm slab, and neither model describes it.

The two limits are the implementation's check, and are tested as such: as
*d → ∞* the Booth result reproduces the FLUO formula above (to round-off,
after both are renormalized), and as *d → 0* it returns the data unchanged
(residual 2.9e-06 at 0.1 nm, falling linearly in *d*).

Attenuation is evaluated at three fixed energies — the fluorescence line, and
10 eV below and above the tabulated edge — and held constant across the scan,
exactly as FLUO does. This is what makes the per-point inversion well posed; it
also means the slow energy dependence of the attenuation away from the edge is
not modelled.

## Probing depth

Supplying a **density** also reports, at every energy, the **probing depth**
of the in-and-out path (the panel's *Probing depth* view; the field is
`information_depth_um`),

    L(E) = 1 / S(n(E)) = 1 / (µ_in / sin θ_in + µ_f / sin θ_out),

in µm: the depth over which the incoming and outgoing beams together fall by
1/e. In a **semi-infinite** sample 63% of the detected signal comes from
shallower than *L*. In a **finite slab** of thickness *d* the share of the
slab's own signal from above depth *z* is
`(1 − exp(−z/L)) / (1 − exp(−d/L))`, so 63% of it comes from the top
`−L ln(1 − 0.63 (1 − exp(−d/L)))` — for a slab much thinner than *L*, from the
top 63% of the slab, not from *L*. The panel states that finite-slab depth at
the edge step, starts the depth axis at zero and draws the entered thickness on
it. *L* is longest in the pre-edge and shortest at the white line, where the
sample absorbs most.
Supplying a **thickness** as well reports the **sampled fraction**
`1 - exp(-S * d)`: the share of what an *infinitely thick* sample of the same
material would emit that this slab emits, at each energy.

Whether the thick-sample correction applies is decided at one energy, not by
the shortest length in the scan. The measurement is `F(n)/F(1)`, so what
matters is how close the reference yield `F(1)` is to its infinite-thickness
value — that is, the attenuation length at the edge step, `1/S(1)`, and the
**reference sampled fraction** `1 - exp(-S(1) d)`. The panel turns that one
number into a sentence:

| reference sampled fraction | what it means |
| --- | --- |
| ≥ 0.99 | effectively thick at the edge step; the finite-thickness correction approaches the thick-sample one. This says the two converge, not that either is right: near the pole both amplify any error in the measured white line |
| 0.63 – 0.99 | thicker than `1/S(1)` but not saturated; the two corrections differ and Booth is the smaller |
| < 0.63 | thinner than `1/S(1)`; the thick-sample correction overestimates self-absorption, so use Booth |

Comparing against the *shortest* length in the scan is wrong and was wrong
here: on a strongly absorbing sample the white-line length can be a tenth of
`1/S(1)`, so a slab that emits only 84% of the infinite yield at the edge step
— where Booth and FLUO disagree by hundreds of per cent — passes a
"ten times the shortest depth" test.

Under the thick-sample correction the density is purely diagnostic: it changes
the reported lengths and nothing else. The corrected spectrum is bit-identical
with and without it.

## What the correction produces

Both algorithms start from the source group's **own** normalized curve: the
preview and the save inherit the group's effective E₀, pre-edge and post-edge
ranges and polynomial degree unless the request names them, and the preview
reports the normalization it used. (Before 3 October 2026 the operation's own
defaults — tabulated E₀, its own ranges, a linear post-edge — were used, so the
"Measured" curve could differ from the curve shown in the main view; the
inversion is nonlinear in it, so the corrected result differed too.)

Both recover the normalized absorption *n(E)* and then write it back as a raw
µ(E), which is renormalized with those same ranges, as `fluo_corr` does
(`mu_corr` and `norm_corr`).

They write it back differently, and the difference matters. FLUO scales the raw
signal by `n/m`, which is Larch's behaviour and is kept for parity; a raw
fluorescence channel usually carries an additive background (dark current,
scattering, a neighbouring line's tail) that is scaled along with the
fluorescence, so renormalizing the product does not give back *n*. On a clean
spectrum the error is parts in a thousand; near the pole it is per cent. Booth
instead rebuilds the raw spectrum as `pre_edge(E) + edge_step * n(E)` on the
source group's own pre-edge line and edge step, so renormalizing it returns
*n(E)* itself, up to its own corrected edge step, whatever background the raw
channel carried. A forward-modelled slab on top of a sloping background and a
gain round-trips to the absorption it was generated from.

Saving makes a new group holding the corrected **normalized** spectrum,
marked as already normalized (data type `norm`), so it is not renormalized; it
is not a corrected raw fluorescence yield. Its source records the options used,
the inherited normalization included. The source group is untouched and may be
frozen.

`details` records the algorithm, the composition and geometry, the
normalization ranges, `alpha`, the fluorescence and edge energies, the measured
and corrected normalized spectra, and for Booth the thickness, density, the
equation and its assumptions.

## Refusals

The correction refuses, rather than returning a number nobody should use:

- a formula that does not contain the absorbing element, or an edge and line
  that do not belong together;
- a scan that does not straddle the tabulated edge — usually keV mistaken for
  eV, or the wrong element;
- angles outside 0.1–90°, a density outside 0.001–30 g/cm³, a thickness outside
  0.0001–10⁶ µm, or `booth` without both of the latter two;
- a material with no positive attenuation jump at the named edge;
- normalization ranges that are out of order or hold too few points, or a
  non-positive edge step;
- **a signal above what this slab can emit.** `F` rises to a finite plateau
  `F(∞)/F(1)` as *n* grows, because a more strongly absorbing sample emits from
  an ever thinner surface layer. A normalized measurement at or above that
  ceiling has no root and the refusal names it. The ceiling belongs to the
  thickness, composition, geometry and normalization you entered, not to the
  measurement: it is `(alpha + 1) / (1 - exp(-S(1) d))`, so it rises without
  bound as the slab thins, and a signal this slab cannot emit is often one a
  thinner slab of the same material can. In the thick limit it is exactly
  `alpha + 1`, where FLUO's denominator vanishes.
- a normalized signal further below zero than the inversion can represent.

Pre-edge points that are slightly negative from noise are *not* refused: the
bisection brackets below zero, stopping just short of `S(n) = 0`. This is a
numerical extension so that noise is not clamped upward and the pre-edge is not
biased, not a test of physicality — negative *n* is not a physical absorption,
and the bracket's edge is where the yield stops being defined, not where the
sample stops being possible.

## What is not here

Tröger and the Atoms-based correction, which the Athena panel also offers, are
not implemented. Neither is a depth-graded or layered sample, a correction for
grain structure or pinholes, detector dead time, or scattering. The models
assume a uniform, flat, uniformly illuminated sample of known stoichiometry —
in particular, a capillary or any other curved sample has a path length that
varies across the beam, and feeding its diameter in as a slab thickness is an
approximation of unquantified error.
Both corrections are intended for XANES; for quantitative EXAFS amplitudes they
remain approximate.

## HTTP

`POST /api/athena/projects/{ident}/self-absorption/preview` takes the same
command body as the `self_absorption` project action and returns, per group,
the energy axis, the measured and corrected normalized spectra, the
attenuation-length and sampled-fraction curves when a density was given (the
curve keeps the field name `information_depth_um`) together with
`attenuation_length_um`, and, when a thickness was given too,
`reference_sampled_fraction` and `thickness_over_attenuation_length`. It writes nothing, and rechecks the project revision
after the calculation so a long correction cannot return a view of a project
someone else has since edited. Saving posts the previewed options to
`/command`; the preview and the saved group agree exactly.
