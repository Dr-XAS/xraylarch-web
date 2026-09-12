# Multi-electron excitation removal

The Athena **Process → Multi-electron excitation** panel implements the
reflection and arctangent methods, E/k/R comparison plots, energy-shift picking
and creation of a corrected group immediately after its source. The initial
plot shows the source at zero shift. Editing a valid positive shift, amplitude,
width or algorithm recalculates the preview after a short debounce. Changing
plot space uses the same confirmed calculation. Frozen sources can be read.

The reference is pinned Demeter
`06afc8da08a5a7d5a26ee14992170fcf5dc67406`:

- [Athena MEE manual](https://bruceravel.github.io/demeter/documents/Athena/process/mee.html).
- [MEE panel](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/UI/Athena/MEE.pm), including its additional R plot and cursor conversion.
- [Process.pm::mee](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/Data/Process.pm).
- [Larch processing templates](https://github.com/bruceravel/demeter/tree/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/templates/process/larch): `mee_reflect`, `mee_arctan`, `mee_do`.
- [Measured LaCoO3 project and recipe](https://github.com/bruceravel/demeter/tree/06afc8da08a5a7d5a26ee14992170fcf5dc67406/examples/recipes/MEE).

These sources and the measured file are hash recorded in the
[primary catalog](athena-primary-sources.json) and the
[fixture manifest](../backend/tests/fixtures/athena-mee-fixtures.json).

## Numerical behavior

The input is the source's **accepted normalized μ(E)**, before optional
flattening, on its calibrated energy axis. The earlier project operation
subtracted a manually scaled arctangent from raw μ(E); this panel and project
command now follow the native normalized-data workflow.

Reflection translates a Lorentzian-broadened copy of the normalized edge by
the positive shift. It does not reverse sample order. The implementation uses
Larch `smooth(..., sigma=width, form='lorentzian')` and `interp`, then explicitly
zeros values below the original first energy plus shift. That padding is
required because Larch's `interp` extrapolates even with `fill_value=0`.

Arctangent uses `0.5 + atan((E - E0 - shift) / width) / pi`. Both methods
subtract amplitude times this model from the normalized input. The original
pre-edge tail is retained for arctangent. Width is the Lorentzian HWHM in eV;
amplitude is a fraction of the normalized edge step. The three parameters
remain manual, with no automatic identification or fitting.

Native parameter behavior is retained: negative amplitude becomes zero,
and any width below 0.01 eV becomes 0.01 eV. A notice shows either adjustment.
Amplitude is not artificially capped at one. One explicit upstream defect is
not reproduced: Perl `amp ||= 1` substitutes one for an explicitly requested
zero. The web preserves zero, matching the manual's disabled-removal meaning.
The executed reference records this discrepancy, including negative values
that correctly become zero in the native implementation.

The project command accepts `method`, `shift`, `amplitude`, `width`, and an
optional explicit `e0` for API clients handling signed energy differences.
The panel always uses the accepted group E0. `edge_step` is no longer an
independent project-command input because this workflow operates in normalized
units. The lower-level standalone raw-unit arctangent utility remains separate.
Malformed/nonfinite controls, invalid edges, out-of-range secondary edges and
unavailable normalization are rejected before persistence. Larch's actual
dense convolution work is bounded; oversized reflection calculations request
explicit rebinning instead of silently changing sampling.

The corrected normalized-minus-model values become the clone's input μ array,
as in `mee_do`. The source recipe, input normalization flag, scientific identity,
background-standard link, group notes and plot offsets are retained. The
accepted energy calibration is materialized once and the child's shift is zero.
The child is processed again with Larch. E plots show that newly normalized
child; k/R plots show its recomputed EXAFS and Fourier magnitude. XANES inputs
retain E previews and report unavailable k/R views. A child processing failure
prevents saving it. Source groups are unchanged, including frozen sources.

## Preview and persistence contract

`POST /projects/{id}/mee/preview` takes the same version, source IDs and options
as the `multi_electron` command. It creates no saved groups or undo records and
rechecks the project revision after calculation. Full arrays are returned for
all three plot spaces. Saving recomputes from the exact confirmed options and
revision, inserts children after their sources in list order and commits the
batch atomically. Undo/Redo and `.prj` exchange retain the new data and model
provenance. Failed batches leave earlier source groups and output untouched.

The panel discards previews on source, setting or revision changes and ignores
late responses. It permits saving only a matching preview. Source/algorithm
selectors have explicit accessible labels. Curve picking converts E minus E0,
or k² divided by native `0.2624682917`, to a relative shift rounded to 0.001 eV;
R picking is unavailable. Changing views cancels a pending pick.

## Evidence and remaining work

[Native replay](../backend/tests/reference/mee_native_reference.py) uses actual
Text::Template to render all three unchanged Larch templates. Larch executes
their equations on both measured LaCoO3 scans (405 and 333 points). Unmodified
`Process.pm::mee` executes parameter coercion and shifted-array padding with
explicit data-access, cloning and background-update bridges. Twelve cases cover
recipe/manual settings, both methods, negative amplitude, zero amplitude and
minimum broadening. Default replay compares the recorded output exactly.

```bash
PYTHONPATH=backend backend/.venv/bin/python backend/tests/reference/mee_native_reference.py \
  --sources /tmp/athena-mee-sources \
  --environment /tmp/athena-xdi-runtime/environment.json \
  --perl-lib /tmp/athena-export-runtime/root/usr/share/perl5 \
  --output /tmp/athena-mee-native-replay
```

[Backend regressions](../backend/tests/test_athena_mee.py) compare all measured
model values against this reference and verify normalized scaling, exact
preview/save arrays in E/k/R, source preservation, frozen groups, calibration,
XANES, native clamps, atomic batches, Undo/Redo, PRJ restore and HTTP conflicts.
[Component tests](../frontend/components/athena-mee.test.tsx) exercise request
identity, stale replies, plot inputs, coordinate picking and error recovery.
[Browser tests](../frontend/tests/e2e/athena-mee.spec.ts) import the official PRJ
through the normal file picker, then exercise actual Plotly curves and saving.
Execution results and visual inspection are recorded in the
[verification log](athena-verification.md).

The reference does not replay the complete desktop GUI, IFEFFIT broadening,
native normalization/AUTOBK lifecycle or XDI clone-history mutation. Its
independent reader supplies normalized inputs to the model comparison; this
must not be interpreted as proof that every normalization implementation agrees.
The separate [XDI history reference](athena-xdi-history-reference.md) now covers
the native clone primitive, MEE history inheritance and native-only project
exchange. Full desktop lifecycle comparison and the rest of the Athena parity
matrix remain open. No Artemis functionality is introduced.
