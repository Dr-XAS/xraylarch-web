# Athena smoothing

**Process → Smooth data** provides boxcar averaging, Gaussian filtering,
Larch Savitzky–Golay and repeated three-point smoothing. The panel immediately
shows the selected source, then compares it with the calculated result.
Algorithm and parameter changes refresh the comparison after 400 ms. E/k/R
buttons use the same confirmed calculation; unavailable spaces are explained.
**Plot data and smoothed** explicitly refreshes it, and **Make smoothed group**
inserts the result immediately after its source. Frozen sources can be read.
The panel links to the native documentation and explains that filtering can
distort peak shapes. An irregular sampling grid implies a variable physical
energy width even when the kernel has a fixed number of samples.

## Primary reference

The Demeter revision is `06afc8da08a5a7d5a26ee14992170fcf5dc67406`.

- [Smoothing manual](https://bruceravel.github.io/demeter/documents/Athena/process/smooth.html).
- [Smooth.pm controls, preview and save](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/UI/Athena/Smooth.pm).
- [Process.pm kernels](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/Data/Process.pm).
- [Larch smooth template](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/templates/process/larch/smooth.tmpl)
  and [IFEFFIT smooth template](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/templates/process/ifeffit/smooth.tmpl).
- [Process preferences](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/configuration/process.demeter_conf)
  and [example recipes](https://github.com/bruceravel/demeter/tree/06afc8da08a5a7d5a26ee14992170fcf5dc67406/examples/recipes/Smooth).
- Original IFEFFIT 1.2.11d `src/lib/decod.f::f1mth`, opcode `-1220`,
  from the [source archive](https://deb.debian.org/debian/pool/main/i/ifeffit/ifeffit_1.2.11d.orig.tar.gz).

Source identities, Git blob checks and SHA-256 values are retained in the
[primary catalog](athena-primary-sources.json). The
[smoothing manifest](../backend/tests/fixtures/athena-smoothing-fixtures.json)
records numerical fixtures, the replay harness, actual loaded Perl modules,
PDL/package versions and original Fortran compilation inputs. The additional
Fortran files were checked against the already pinned source archive.

## Numerical contract

| Algorithm | Native behavior reproduced |
| --- | --- |
| Boxcar | Default 11 samples; an even size becomes the next odd number. Uniform weights. A size below one becomes 11. |
| Gaussian | Same size handling; default sigma 4 samples, and sigma below one becomes 4. The finite Gaussian weights are normalized over the chosen kernel. |
| Savitzky–Golay | Effective default window 31, order 9. Demeter first makes the window odd and limits order to window minus one; Larch then enforces its own window/order relationship. Actual `larch.math.savitzky_golay` supplies the filter and reflected endpoint padding. |
| Three-point | Interior: half the centre plus one quarter of each neighbour. Endpoints: three quarters of the endpoint plus one quarter of the adjacent sample. Repeated as requested, with at least one pass. |

Boxcar and Gaussian retain **N − kernel-size** points. Native Perl splicing
removes `(size−1)/2` on the left and `(size+1)/2` on the right, including one
more right-hand point than a conventional valid convolution. A size-one
boxcar therefore still removes the final point. The interface reports both
counts and the resulting number of samples. SG and three-point preserve all
input coordinates. All adjustments appear alongside the preview.

The Gaussian reference uses actual `PDL::Filter::Gaussian` from
`PDL::Filter::Linear`. Despite starting its constructor with float zeroes,
PDL's `xvals` produces doubles; the native Gaussian weights are double
precision. A float32 imitation differed in measured values and was replaced
before recording the reference. SG operates in sample-index space with
Larch's endpoint padding, rather than fitting a local polynomial to the
irregular energy coordinates.

The [executed preference reference](athena-smoothing-preferences-reference.md)
corrects the original order-4 default: Config.pm clamps the file's literal 4
to its configured minimum 9. The initial filter-only reference supplied
explicit settings and did not establish that default. SG preferences now
support session Apply, persistent Apply and Save and retained tool controls.

The web requires at least ten output samples and limits explicit kernel work.
It does not silently downsample large inputs. Malformed/nonfinite parameters,
noninteger window/order/repetitions, unsupported algorithms and windows that
do not fit are rejected. The API allows wider ranges than the desktop spin
controls (whose size range is 1–20 and Gaussian sigma range is 1–10).

## Scientific identity and persistence

Filtering uses raw μ(E) on the accepted calibrated axis, or raw χ(k) for a
chi input. The child retains the source data type, normalization flag,
difference flag, accepted processing recipe, scientific identity, background
standard, notes and display offsets. Calibration is materialized once, with
the child's energy shift set to zero. The accepted E0 is retained for
absorption inputs. Actual Larch processing recomputes k/R curves; detector,
XANES and signed energy-difference inputs explicitly lack those comparisons.
Their raw signals are never presented as ordinary normalized EXAFS.

The new group has its own arrays and no stale detector table on the new grid.
Acquisition metadata and saved XDI comments survive. Boxcar and Gaussian use
the native history descriptions; SG and three-point add truthful filter
descriptions. History survives native `.prj` export with the web sidecar
removed. A three-point count that is clamped to one records one pass.

`POST /api/athena/projects/{id}/smooth/preview` requires an explicit `method`,
source IDs, options and a project revision. It persists neither groups nor
undo records and checks the revision again after calculation. The matching
`smooth` command recomputes from the same revision/options and atomically
inserts children in source-list order. A failed later group rolls back the
whole batch. SG/three-point copies inherit marking only when appended after
the final source; inserted children and boxcar/Gaussian children start
unchecked, following the native list branches. Children are unfrozen.

The interface invalidates a preview immediately when the source, parameters
or revision changes, aborts obsolete requests and ignores late replies. It
checks response identity, finite arrays, paired plot curves and boundary
counts. Saving requires a matching preview and confirms the returned child's
parent, revision and exact input arrays before accepting it. Conflict or
save errors retain the draft and require a fresh preview. Undo/Redo and
restart restore the saved result.

## Executed evidence and remaining work

[Native replay](../backend/tests/reference/smoothing_native_reference.py)
executes the unchanged Perl `boxcar`, `gaussian_filter` and `smooth` routines.
Actual PDL performs boxcar/Gaussian filtering; Text::Template renders the
original Larch/IFEFFIT smooth templates. Larch executes SG, while an isolated
Fortran compilation executes the complete original `f1mth` with `specfun.f`
and its original includes for three-point smoothing. No rewritten numeric
kernel is used as the reference. These reference runtimes are separate from
the Python production backend.

There are 36 native cases: the official measured Cu (408 points) and Fe
(348 points) XDI scans, plus a constructed 41-point endpoint/centre impulse
signal, each under twelve filter settings. Cases cover odd/even kernels,
size one, Gaussian width reset, SG order/window adjustment and three-point
repetition counts. Every output coordinate is compared exactly and every
filtered value uses `atol=rtol=2e-14`. Default replay compares the entire
recorded observation, including actual module hashes, exactly.

```bash
PYTHONPATH=backend backend/.venv/bin/python backend/tests/reference/smoothing_native_reference.py \
  --sources /tmp/athena-smoothing-sources \
  --environment /tmp/athena-smoothing-runtime/environment.json \
  --perl-lib /tmp/athena-export-runtime/root/usr/share/perl5 \
  --ifeffit /tmp/ifeffit-1.2.11d \
  --fortran-compiler /tmp/athena-smoothing-runtime/root/usr/bin/x86_64-linux-gnu-gfortran-15 \
  --gcc /tmp/athena-xdi-runtime/root/usr/bin/x86_64-linux-gnu-gcc-15 \
  --output /tmp/athena-smoothing-native-replay
```

[Backend tests](../backend/tests/test_athena_smoothing.py) cover the reference,
real Larch preview/save processing, identity, frozen sources, calibration,
ordering/marking, atomic failure, HTTP conflicts, Undo/Redo, restart and
native-only PRJ restore. [Component tests](../frontend/components/athena-smoothing.test.tsx)
cover stale responses, parameter controls, result validation and error
recovery. [Browser tests](../frontend/tests/e2e/athena-smoothing.spec.ts) use
the real Cu column selector, Plotly E/k/R traces, all four methods, saved
history, native-only PRJ reimport and mobile cross-window conflict recovery.
Actual execution results belong to the [verification log](athena-verification.md).

This reference does not execute the entire wx GUI or native normalization,
AUTOBK and Fourier lifecycle. Group-access/update/put methods are explicit
bridges. The independent numerical evidence proves the filter arrays, not
complete desktop processing equivalence. The native Gaussian/boxcar `put`
hardcodes xmu even for chi; the web preserves the actual input meaning. The
native Larch UI replaces three-point with SG; the web provides both through
the Python backend. Native three-point metadata loss is not reproduced.
These differences remain visible in this contract.

Native SG preference persistence and control retention are now covered by the
[preference contract](athena-smoothing-preferences-reference.md), including
native Apply/Save execution, current/saved/factory values, restart and concurrent
windows. Full preference exchange and a complete desktop GUI replay remain
open. SG window/order are editable directly in the panel. Old
method-less project API requests retain the previous generalized polynomial
filter for compatibility; the new panel and preview always specify a method.
No claim of native numerical equivalence is made for that legacy path.
The full Athena parity objective remains active; Artemis is excluded.
