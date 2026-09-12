# Normalization outer limits after import and calibration

This follow-up fixes the outer-fit-boundary gap recorded in the
[calibration reference](athena-calibration-reference.md). It applies to normal
processing, normalized calibration previews, fractional E0 selection and
enforced import. Native `.prj` restore also retains requested normalization
limits instead of permanently replacing them with clipped values.

## Source behavior and implementation

Demeter revision `06afc8da08a5a7d5a26ee14992170fcf5dc67406` passes `bkg_pre1`,
`bkg_pre2`, `bkg_nor1` and `bkg_nor2` unchanged to Larch in its
[normalization template](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/templates/process/larch/normalize.tmpl).
`Data.pm` retains these fields, and `Calibrate.pm::OnCalibrate` changes E0 and
the cumulative shift, leaving the requested fit endpoints alone. The original
template uses energy plus the shift and passes native term count minus one as
Larch's polynomial degree. Local Larch `preedge` then resolves:

```text
effective_pre1 = max(requested_pre1, first_energy + shift - E0)
effective_norm2 = min(requested_norm2, last_energy + shift - E0)
```

The web now uses those rules in its shared normalization range resolver.
The recipe retains its requested values. Effective values describe the fit
and appear in processing results, warnings, parameter readouts, export metadata
and the calibration preview. Moving E0 back can restore the original fit range;
an earlier calibration no longer permanently shrinks the requested interval.

For example, a requested post-edge endpoint of 5000 eV remains 5000 in the
recipe even when the scan ends earlier. The fit stops at its measured endpoint.
Both values are shown. No extra observations or extrapolated fitting samples
are created. Automatic endpoints keep their existing resolution rules, and
already-normalized input is not refitted.

Calibration shows the current normalized curve and a separately refitted
calibrated curve. Native total-shift rounding can change E − E0 by up to
0.0005 eV; simply translating the original normalized y values would miss that
change. The calibrated overlay now uses the proposed E0/shift recipe, including
the resolved fit endpoints, and matches the normalized data produced on save.
Display smoothing is applied after each fit. Raw measured arrays and acquisition
columns remain unchanged. Preview still stages all processing on a copy.

Native-only PRJ imports retain the requested pre1/norm2 fields and report their
effective limits after processing. The older native compatibility resolutions
for spline/FT endpoints and zero Kaiser width remain separate. Original native
arguments continue to be retained as source metadata.

## Executed original reference

The [reference driver](../backend/tests/reference/normalization_limits_native_reference.py)
uses unchanged `OnCalibrate` and `process/larch/normalize.tmpl`. A Perl
`Text::Template` execution renders the normalization commands before and after
calibration. Explicit widget/Data/App accessors provide field values; the actual
Larch interpreter executes both commands. The driver imports no web processing,
calibration or range functions.

The [oracle](../backend/tests/fixtures/athena-normalization-limits-native.json.gz)
records **54 calibration cases / 108 normalization dispatches**: two measured
inputs (official XDI Cu metal, 408 observations, and Fe2O3, 348 observations),
three existing shifts (0, +2.75, −4.3 eV), three reference offsets
(−3.12345, 0, +3.12345 eV), and pre-edge/post-edge/both outer-boundary requests.
Each case records original generated commands, unchanged requested fields,
updated E0/shift, effective fit limits, edge step, and all normalized/flattened/
pre-edge/post-edge values. Recording and fresh replay both passed.

[113 dedicated tests](../backend/tests/test_athena_normalization_limits.py)
compare every stored fit-array value with `rtol=2e-12`, `atol=2e-13`, verify
reference hashes, exercise Cu/Fe calibration with exact refitted overlays,
Undo/Redo and both web/bare-native PRJ round trips, include limit reporting for
linked reference groups, and check that moving the reference back restores
the usable interval. The
[manifest](../backend/tests/fixtures/athena-normalization-limits-fixtures.json)
fixes source, driver, oracle, input and Larch normalization-kernel hashes.

The prior explicit-outer-endpoint rejection tests were revised to require
native boundary resolution and retained requests. Invalid-window tests still
exercise intervals with no measured overlap, insufficient width or too few
samples. Enforced-import tests compare the resolved result with a direct Larch
fit, including fractional E0 moving beyond the original pre-edge request.
Current full-suite and browser outcomes are in [verification](athena-verification.md).

## Remaining boundaries

This establishes the Larch outer-endpoint behavior, including original
calibration dispatch. It does not execute a complete Demeter Data/wx lifecycle,
its separate fixed-step flatten-fit path, all preference-driven defaults, or
the Ifeffit normalization engine. Native inner-endpoint swapping, minimum-window
adjustments and polynomial-degree reduction with sparse data still require
separate reference cases and implementation. The web currently rejects unusable
inner intervals/insufficient support, and still requires a positive fitted edge
step. Signed end-relative preference syntax and implicit-keV inputs are separate
from the validated web eV recipe. Spline and Fourier support rules are not
changed by this normalization fix. SC-01 and PR-01 remain Partial.
