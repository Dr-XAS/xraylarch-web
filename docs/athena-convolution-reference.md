# Convolution and artificial noise

**Process → Convolve data** now provides Gaussian/Lorentzian energy broadening,
normal random noise, live original/modified E/k/R comparisons and a reviewed
derived-group save. The controls remain available after closing and reopening
the tool. Width and noise initially equal zero, matching the native panel;
this produces an exact raw-data copy. The default line shape is Gaussian.

## Pinned source contract

The [manual](https://bruceravel.github.io/demeter/documents/Athena/process/conv.html)
describes broadening, edge-step-relative noise, comparison plotting and creation
of a new group. Behavior is pinned to Demeter
`06afc8da08a5a7d5a26ee14992170fcf5dc67406`, particularly
[ConvoluteNoise.pm](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/UI/Athena/ConvoluteNoise.pm),
[Data::Process](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/Data/Process.pm),
the [Larch convolution template](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/templates/process/larch/convolve.tmpl)
and [Larch noise template](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/templates/process/larch/noise.tmpl).
Downloaded files were checked against Git blob IDs and catalog SHA-256 hashes.

The executable Larch path broadens raw `xmu` through `larch.math.smooth`.
It does not pass normalized data to `xas_convolve`, nor use the web's previous
generic FFT kernel. Gaussian width is sigma; Lorentzian width is HWHM, both
in eV. The call preserves Larch's interpolation, internal uniform grid,
reflected padding, kernel normalization and interpolation back to the original
coordinates. Raw sample count and output coordinates remain unchanged.
Calibrated energy is materialized once in the derived group, whose shift is
zero; the accepted source recipe and E0 are retained for reprocessing.

Noise is added after broadening. Native `noise(which='xmu')` first updates
normalization, then multiplies the requested noise fraction by that current
edge step. The web therefore processes the broadened group before obtaining
the scale, adds normal random values to its raw signal, and processes again.
The plot reports the actual noise sigma in input-signal units. Changing plot
spaces does not generate a new noise realization. Replotting does.

The panel uses a captured 32-bit seed. A private NumPy MT19937 `RandomState`
reproduces the native template's seeded `random.normal` stream without changing
process-global random state. The seed returned by preview is sent unchanged
on save, so every saved point equals its reviewed value. The source metadata
records requested options, effective noise sigma, edge step, seed, generator,
parent recipe and materialized shift. Batch commands use consecutive seeds in
project order, avoiding identical relative noise patterns between sources.

## Scientific and project boundaries

The [backend primitive](../backend/xraylarch_web/athena_convolution.py) accepts
finite typed values: width 0–1000 eV, noise 0–100 and an optional unsigned
32-bit seed. The native editor coerces negative width/noise to zero; the web
instead rejects negative entries visibly, requiring the user to choose zero.
The executed reference includes native negative-control coercion separately.

The exact Larch grid is bounded before allocation at 100 million convolution
multiply-add estimates, matching the existing MEE broadening budget. The
standard Cu 10 K/50 K examples fit this bound. Pathological grids require
explicit rebinning; no alternate kernel or silent coarsening is substituted.
Noise-only calculations skip energy regridding. Project/raw-array limits and
atomic batch guards still apply.

χ(k) supports noise in absolute χ units, with energy-width controls disabled
and the prior energy-width draft retained. The native panel intends this
mode but calls `noise(which='xmu')` even for χ inputs; the web explicitly uses
the native lower-level χ-noise convention, independently exercised by the
reference. Detector counts and signed differences can be broadened, but noise
requires a usable positive edge step. This is reported instead of inventing
an absorption step for a counts/difference array. Normalized μ(E), normalized
XANES and FEFF type/identity flags remain part of the existing processing path.

Frozen groups can be read and cloned. Derived groups are inserted immediately
after their source, retain notes/display values and become unfrozen. Sources
and their source-file detector arrays remain intact. Derived signal grids do
not masquerade as original detector measurements. Undo/Redo, project revision
conflicts and failed calculations are atomic. API routes are
`POST /api/athena/projects/{id}/convolve/preview` and the existing `convolve`
project command. The command now always uses the native Larch path; the old
stateless `transform_spectrum('convolve')` helper remains separately tested
and is no longer the Athena workbench implementation.

Web XDI history truthfully distinguishes broadening, added noise (actual sigma
and seed), and an unchanged copy. Acquisition comments/identity remain attached
and history survives native-only PRJ reimport. Native ConvoluteNoise does not
add these operation descriptions itself; this is explicit web provenance,
not a claim of byte-identical native history. The complete web project also
retains the full numerical options; a bare native project retains the actual
modified data and the exported history text.

## Executed reference and workflow evidence

The [reference harness](../backend/tests/reference/convolution_native_reference.py)
executes unchanged `ConvoluteNoise::get_values/plot`, `Data::Process::convolve/noise`
and original templates rendered with Text::Template, then evaluates the commands
with Larch. The original UI guards, order of operations, labels, negative-value
coercion and lower-level χ-noise branch are exercised. Wx/plot/clone objects
and normalization updates use explicit bridges; the native edge step is a
supplied fixture parameter. This reference proves kernel/noise scaling and
control flow, not native normalization of the fixture.

Twenty-five cases cover official measured Cu (408 observations), Fe2O3 (348),
constructed endpoint/central impulses, Gaussian/Lorentzian widths, zero-copy,
noise-only, combined operations, different edge steps and χ-noise. Every
output is compared at `atol=rtol=2e-14`; exact repeatability is separately
asserted for preview/save and private concurrent RNG calls. The initial Fe
column-index mistake was corrected before recording. A fresh replay reproduced
all 25 recorded observations exactly.

```bash
PYTHONPATH=backend backend/.venv/bin/python backend/tests/reference/convolution_native_reference.py \
  --sources /tmp/athena-convolution-sources \
  --environment /tmp/athena-smoothing-runtime/environment.json \
  --perl-lib /tmp/athena-export-runtime/root/usr/share/perl5 \
  --output /tmp/athena-convolution-replay
```

The [manifest](../backend/tests/fixtures/athena-convolution-fixtures.json)
pins native sources, measured inputs, harness, compressed oracle and local
Larch math source. [Backend tests](../backend/tests/test_athena_convolution.py)
exercise the native observations, RNG distribution/repeatability/isolation,
calibration, processed edge-step capture, frozen groups, type eligibility,
batch ordering/atomic failure, HTTP conflicts and exact native PRJ exchange.
[Component tests](../frontend/components/athena-convolution.test.tsx) cover
native defaults, live E/k/R handoff, captured/fresh seeds, malformed/stale
responses, draft retention and failed saves. [Real browser workflows](../frontend/tests/e2e/athena-convolution.spec.ts)
import measured Cu through the live column plot, compare every displayed point,
save all four broadening/noise combinations, Undo/Redo and reimport a downloaded
PRJ after deleting every web sidecar. The mobile flow also checks fresh noise,
two-window revision conflicts, retained controls and recovery after reload.
See [the verification log](athena-verification.md) for actual run outcomes.

The complete original wx application, native normalization/background/FFT
pipeline, all legacy project fields and long-job behavior remain unverified.
The original 107 requirement IDs/order/statuses remain unchanged; PR-10 has
subset evidence and is not promoted to Verified. Full Athena parity remains
unproven; Artemis is excluded.
