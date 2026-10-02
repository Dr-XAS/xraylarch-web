# EXAFS disorder models: Artemis and Larch references

Research checked 2026-10-01. This is a scientific inventory and implementation
rationale; the [Artemis Web guide](artemis-web.md) describes the current interface.

## What “insert Debye–Waller factor” does

In native Artemis, the σ² path-label menu inserts a correlated Debye or Einstein
expression and creates the required GDS parameters. Measurement temperature is
normally **Set** and characteristic temperature is **Guess**. The expression
remains editable, and can be copied to other paths. This is a model-editing action;
it does not apply an extra damping correction to measured χ(k).
[Artemis: setting math expressions](https://bruceravel.github.io/demeter/documents/Artemis/path/mathexp.html).

## Models grounded in the existing fitting engine

| Model | σ² expression | Meaning |
| --- | --- | --- |
| Independent or shared disorder | `sig2` | A Guess, Set, or Def parameter can be reused by selected paths. |
| Einstein | `sigma2_eins(temp, theta_e)` | One characteristic vibration temperature; both arguments in K. |
| Correlated Debye | `sigma2_debye(temp, theta_d)` | Path-dependent correlations from a Debye spectrum; both arguments in K. |
| Thermal plus static disorder | `sig2_static + sigma2_eins(temp, theta_e)` or the Debye counterpart | Adds a temperature-independent variance in Å². |

Native Artemis also accepts `eins` and `debye`.
Thermal/static separation benefits from several measurement temperatures.
Correlated Debye is most defensible for monoatomic solids such as Cu, Au, and Pt.
[Artemis: modeling disorder](https://bruceravel.github.io/demeter/documents/Artemis/extended/ss.html).
Demeter explicitly demonstrates a Debye expression with an additive σ² term.
[Demeter::Path](https://bruceravel.github.io/demeter/pods/Demeter/Path.pm.html).

### Larch implementation contract

Larch's Python functions take `(temperature, characteristic_temperature, path)`.
Their fitting-expression counterparts take two arguments because Larch binds
the current FEFF path during each evaluation. Results are in Å².
[Larch path documentation](https://xraypy.github.io/xraylarch/xafs_feffpaths.html).

The checked implementation uses

\[
\sigma_E^2(T)=\frac{A}{\mu\Theta_E\tanh(\Theta_E/(2T))},
\qquad A=\frac{10^{20}\hbar^2}{2k_Bm_u}\simeq24.254\;\mathrm{\AA^2\,K\,u}.
\]

For a single-scattering path, μ is the absorber/scatterer reduced mass. Larch
computes its effective mass from inverse masses in the FEFF
path geometry. Debye uses atomic masses, coordinates, and FEFF's
Norman radius. Keep this path context. The Einstein docstring has the coth
argument reversed; the implemented `tanh(theta/(2*t))` is the relevant expression.
The upstream routines clamp nonpositive inputs, so the web interface should
validate physical domains explicitly. T = 0 has a finite quantum limit; Θ must
be positive.
[Larch implementation](https://github.com/xraypy/xraylarch/blob/master/larch/xafs/sigma2_models.py).

Larch's fitting example shares one characteristic temperature across several
measured temperatures. Its documentation also recommends Debye over Einstein
for multiple scattering in simple systems. Enabling these path functions in a
single-group fit does not itself provide simultaneous fitting of a temperature
series.
[Larch fitting example](https://xraypy.github.io/xraylarch/xafs_feffit.html).

## Related disorder descriptions

### Multiple-scattering constraints

Artemis gives geometry-specific examples: certain collinear forward-scattering
paths share their outer single-scattering path's σ²; selected absorber-revisit
paths use `2*sig2`, and a repeated back-and-forth path uses `4*sig2`. A triangle
example uses `sig2_first + sig2_outer/2`. These approximations neglect some
transverse or angular disorder. They should be explicit user constraints, never
automatically selected solely from the number of legs.
[Artemis examples and Hudson et al. reference](https://bruceravel.github.io/demeter/documents/Artemis/extended/ss.html#colinear-multiple-scattering-paths).

### Non-Gaussian disorder

Both engines support third and fourth cumulants as separate path parameters:
`third` in Å³ and `fourth` in Å⁴. They describe asymmetry and departure from a
Gaussian distribution. Third cumulants correlate with ΔR/ΔE₀; fourth cumulants
correlate with σ²/amplitude. They supplement σ² and need their own validation,
reports, persistence, and export support.
[Artemis path parameters](https://bruceravel.github.io/demeter/documents/Artemis/path/pathparams.html),
[Larch path parameters](https://xraypy.github.io/xraylarch/xafs_feffpaths.html).

Larch's `gnxas(r0, sigma, beta)` is a distribution-amplitude helper, not a σ²
function. It belongs to a distribution-of-paths workflow and should not appear
as another Debye/Einstein choice.
[Larch implementation](https://github.com/xraypy/xraylarch/blob/master/larch/xafs/sigma2_models.py).

### Methods that need additional scientific inputs

- **Dynamical-matrix calculations:** DMDW uses force constants and Lanczos
  recursion to calculate path-specific vibrational disorder and account for
  effects beyond simple Debye/Einstein models. It needs a dynamical matrix;
  a CIF alone does not supply one.
  [FEFF DMDW](https://feff.phys.washington.edu/feffproject-dmdw.html),
  [Vila et al., Physical Review B 76, 014301 (2007)](https://arxiv.org/abs/cond-mat/0702397).
- **Molecular dynamics:** displacement-correlation calculations can derive
  Debye–Waller factors from atomistic simulations. They require trajectories
  and a specified model of dynamics.
  [Vila, Lindahl and Rehr, Physical Review B 85, 024303 (2012)](https://arxiv.org/abs/1108.6084).
- **Reference-spectrum comparison:** log-ratio/phase-difference analysis
  estimates *changes* in cumulants for a spectrally isolated shell. These are
  relative values, not an absolute σ² model for arbitrary FEFF paths.
  [Athena log-ratio analysis](https://bruceravel.github.io/demeter/aug/analysis/lr.html).
- **Absorption corrections:** McMaster, I₀ response, and self-absorption can
  produce apparent σ² corrections. Keep their experimental assumptions and
  provenance separate from physical static/thermal disorder; do not silently
  insert them when choosing a thermal model.
  [Artemis absorption calculations](https://bruceravel.github.io/demeter/documents/Artemis/atoms/abs.html).

## Integration priorities

1. Provide a visible σ² insertion control with independent/shared, Einstein,
   Debye, and optional static-offset expressions; create only missing GDS
   parameters and preserve their existing values.
2. Evaluate with the current FEFF path throughout validation and optimization;
   preserve editable expressions in project files and native exports.
3. Treat characteristic temperatures and static terms as physically constrained
   parameters. A fitted value is not evidence that a chosen model is valid.
4. Keep geometry-specific constraints editable. Add higher cumulants and
   external simulation workflows only with their complete scientific inputs
   and persistence/export support.
