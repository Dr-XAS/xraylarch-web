# Athena linear combination fitting: weights, combinatorial search, and standard suggestions

**Analysis → Linear combination fitting** models an unknown spectrum as a weighted
sum of measured standards over an energy (or k) window:

> μ_unknown(E) ≈ Σ wᵢ · μᵢ(E)

and reports each weight with its standard error, the R-factor
(Σ residual² / Σ observed²), the reduced χ², and the fit curve for plotting.
Two options change the physics: **Weights sum to 1** eliminates one weight so
the fit is a composition rather than a composition plus a free scale, and
**Non-negative weights** bounds each weight below at zero.

Three things sit on top of that single fit: a combinatorial search over a set
of standards, uncertainties on the weights, and a bundled reference library
that can suggest which standards to try.

## Weight uncertainties

The fit is an unweighted linear least squares, because a normalized,
interpolated XANES spectrum carries no per-point σ that would mean anything.
With design matrix D over N points and p free weights,

> s² = RSS / (N − p),  cov = s² (DᵀD)⁻¹

and each weight's standard error is the square root of its diagonal entry.
Under **Weights sum to 1**, the last weight is not fitted but derived as
1 − Σ others, so its variance is the *sum of the whole covariance matrix*,
including the (generally negative) off-diagonal terms — standards that trade
off against each other make the derived weight better determined than a naive
sum of variances would suggest.

A weight pinned at the zero bound is not a fitted parameter, and its error is
reported as absent, labelled "held at zero", rather than as 0. Reading a pinned
weight as "0 ± 0" would claim certainty the fit never produced.

These are **nominal least-squares errors, with the zero-held weights treated as
fixed rather than fitted** — that is the phrase the panel uses, and it is what
the numbers are. As with the peak fits, they assume independent residuals.
Interpolated XANES residuals are correlated along the energy axis, so treat the
quoted errors as lower bounds on the real uncertainty, and treat differences
between two fits that are within a couple of these errors as not resolved.

### When no errors are reported at all

Standards that are nearly linearly dependent over the window are ordinary in
LCF — two oxides of the same element can be almost indistinguishable after
normalization. The fit still returns sensible weights for their *sum*, but the
split between them is not determined by the data.

The covariance is therefore formed from a singular value decomposition of the
design matrix rather than by inverting DᵀD, which squares the condition number
and turns that indeterminacy into finite errors that mean nothing. When the
condition number exceeds `LCF_MAX_CONDITION` (1e8 in `athena_science.py`), the
errors are withheld and the panel explains why in place of the usual note. The
weights themselves are still reported: use fewer or more distinct standards to
resolve them.

## Combinatorial search

**Fit every combination** fits every subset of the marked standards whose
size lies between **Fewest standards** and **Most standards**, and ranks
the results by R-factor, breaking ties toward the smaller subset. Each
combination gets the full treatment — same window, same `sum_to_one` and
`nonnegative` settings, its own weights and errors — so the ranking compares
like with like.

Combinations whose standards are linearly dependent over the window (a
duplicate standard, or one that is a near-exact combination of the others) are
skipped rather than fitted to a singular matrix; the panel reports how many
were tried and how many were skipped.

The search is capped at 2000 combinations (`MAX_LCF_COMBINATIONS` in
`athena_science.py`); past that the request is refused with the count, rather
than being silently truncated.

**A lower R-factor from a bigger subset is not evidence that the subset is
right.** Adding a standard can only reduce the residual, so compare subsets of
the same size against each other, and accept a larger one only when it lowers
the R-factor by much more than adding a standard typically does, and when its
extra weight is several times its own standard error.

## Suggesting standards from the bundled reference library

Pressing **Suggest standards from the library** in the LCF panel takes the
active group's element and edge, fits each bundled standard for that edge
against it one at a time, and lists them best first. Ticked standards are
copied into the project (into a "Reference library" folder) by **Add selected
to project**, where they behave exactly like imported groups and can be marked
for a combination search.

With no window given, the suggestion runs over Athena's default XANES range,
e0 − 20 eV to e0 + 80 eV.

### Reading the suggestion R-factors

Each standard is fitted **alone, with a free scale** (`sum_to_one` off,
`nonnegative` on). That is the right question for "does this standard look
like my sample", but it is a different question from the combination fit's, so
**a suggestion R-factor is not comparable with a combination fit's R-factor**.
Use the suggestions to rank standards against *each other* and to pick a
starting set; judge the fit itself from the combination search.

The **scale** column is the free amplitude. On its own it establishes neither
that the shapes agree — the R-factor ranks that — nor how much of the species
is present. A scale away from 1 can come from an edge step normalized
differently, from a mixture, or from a poor match; read it beside the R-factor
and the residual, never instead of them.

A standard that does not cover the window is listed under the table with the
reason, rather than dropped — "not tried" and "does not match" are different
findings.

### What is in the library

25 standards, from project files already distributed with xraylarch under
`examples/`:

| Element | Edge | Standards | Source file |
| --- | --- | --- | --- |
| Au | L3 | 9 | `pca/cyanobacteria.prj` |
| As | K | 3 | `xafsdata/AthenaProjectFiles/AsKa_standards.prj` |
| Cu | K | 7 | `xafsdata/AthenaProjectFiles/CuHERFD_standards.prj` |
| Eu | L3 | 4 | `xafsdata/AthenaProjectFiles/Eu_standards_athena.prj` |
| Mn | K | 2 | `xafsdata/AthenaProjectFiles/Mn_all.prj` |

**The seven Cu K standards are HERFD, not conventional transmission or
fluorescence XAS.** High-energy-resolution fluorescence-detected spectra have
sharper features than conventional ones measured on the same material, so
fitting a conventional Cu spectrum against them will misfit systematically.
They are labelled `HERFD` in the suggestion table for that reason; the other 18
are `XAS`.

The project files do not attribute the individual measurements, so the library
carries a deliberately conservative citation: confirm provenance before
publishing a fit that relies on these standards.

### Why a library standard is identical to the imported one

A standard read from the library reproduces the same group you would get by
importing that project file and selecting the standard by hand — identical
normalization parameters, identical edge step, and bit-for-bit identical
`energy`, `norm` and `flat` arrays. A regression test asserts this for all 25
standards.

That is not automatic. Larch's own project writer emits a header that looks
like Demeter's but stores the normalization order as a *polynomial degree*,
where Demeter stores *degree plus one*. The import path decides which
convention applies by looking for `# Using Larch version ` in the file's first
few lines, and the library reads the header the same way. Getting it wrong is
not a cosmetic difference: on the As K standards it shifted the edge step by
about 10 per cent (0.370 against 0.413) and made the best As combination fit
roughly three times worse (R = 0.021 against R = 0.0074).

## API

Single fit and combinatorial search — `POST /api/athena/projects/{id}/analyze`:

```json
{"version": 7, "action": "lcf", "group_ids": ["<unknown>"],
 "options": {"array": "norm", "xmin": 11851.5, "xmax": 11951.5,
             "standards": ["<std-1>", "<std-2>"], "sum_to_one": true, "nonnegative": true}}
```

```json
{"version": 7, "action": "lcf_search", "group_ids": ["<unknown>"],
 "options": {"standards": ["<std-1>", "<std-2>", "<std-3>"],
             "min_components": 1, "max_components": 3}}
```

Suggestions — `"action": "lcf_suggest"`, one group, `"options": {"top": 12}`;
the element and edge come from the group. Adding the picks is an operate
command, not an analysis:

```json
{"version": 7, "action": "add_references", "group_ids": [],
 "options": {"library_ids": ["as-k-kankite", "as-k-arsenopyrite"]}}
```

Adding a standard that is already in the project is refused rather than
duplicated.
