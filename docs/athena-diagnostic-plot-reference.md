# Quad, Bi-Quad and k/q diagnostic plots

`Plot → Diagnostic plots…` opens a read-only view of the saved processing.
Choose the current spectrum for Quad or k/q; Bi-Quad uses exactly two marked
groups in project order. The Quad and Bi-Quad entries in **Plot shortcuts…**
use the same backend and rendering component, including the marked-q
right-click shortcut. This avoids different scientific curves at different
entry points.

The plot weight accepts finite real values from zero through four. Blank uses
the first selected group's saved Fourier-transform weight. This common weight
applies to both spectra in Bi-Quad. When it differs from a group's saved
weight, Larch recomputes the forward and backward transforms on a temporary
copy of its processed, unweighted χ(k). Background extraction, normalization,
calibration, project revisions and stored arrays are unchanged.

## Panel contract

| View | Energy | k | R | q |
| --- | --- | --- | --- | --- |
| Quad | Raw μ(E), background, pre-edge and post-edge lines | k-weighted χ(k) | Magnitude **and** real part | Real part of the back-transform |
| Bi-Quad | Both flattened spectra, even when a group's normal flatten toggle is off | Both spectra at the common plot weight | Both magnitudes | Both real parts |
| k/q | — | Weighted χ(k), overlaid with the selected q component | — | Real, imaginary or magnitude; already weighted by the forward transform |

Quad/Bi-Quad ignore saved plot multipliers and offsets, as do the native
templates. The k/q comparison applies `multiplier × y + offset` to each
curve; native `Data::points` treats a zero multiplier as one. It does not
multiply χ(q) by q again. The native `plot('kq')` shortcut chooses the real
component; this UI also exposes imaginary and magnitude through the native
lower-level `_plotkq_command` component choices.

Bi-Quad initially shows E₀(first) − 60 through E₀(first) + 180 eV. Other axes
initially show their supplied data. Each panel provides local range controls,
Plotly zoom/pan and image download. Changing plot context clears prior range
edits. The global desktop plotting ranges, title/legend preferences, window
overlays and linked cursors are not yet integrated into these dialogs.

Quad and Bi-Quad require successful EXAFS processing and an energy spectrum.
They reject XANES, detector and χ(k)-only input rather than displaying an
incomplete four-panel plot. k/q accepts successfully processed χ(k) input.
Frozen groups can be inspected. Missing, nonfinite, mismatched or stale arrays
produce an actionable error. A project-version conflict cancels the response;
the browser discards obsolete responses after selection or settings changes.

### Intentional native correction

The pinned `biquad.tmpl` applies `$D->bkg_eshift` to both `$D` and `$DS` energy
arrays. Thus the second group's curve can use the wrong calibration. Here,
each spectrum uses its own shifted energy. The UI reports this difference
when shifts differ. Reference tests first assert the original erroneous axis,
then compare against the explicitly corrected axis; all y coordinates remain
the original template's output. No calibration is inferred or changed.

## Primary evidence

The [Athena special-plot guide](https://bruceravel.github.io/demeter/documents/Athena/plot/etc.html)
describes the intended diagnostics. Exact panel membership, component choice
and modifier behavior are taken from revision
`06afc8da08a5a7d5a26ee14992170fcf5dc67406`:

- [Data/Plot.pm](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/Data/Plot.pm):
  `quadplot`, `biquadplot`, `_plotkq_command`, `_plotk_command`, `_plotq_command`.
- [Quad template](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/templates/plot/gnuplot/quad.tmpl)
  and [Bi-Quad template](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/templates/plot/gnuplot/biquad.tmpl).
- `newk.tmpl`, `newq.tmpl`, `overq.tmpl`, `Data::get_kweight`, and
  [Data/Arrays.pm](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/Data/Arrays.pm)::`points`.

These files are SHA-256 pinned in [the primary-source catalog](athena-primary-sources.json).

## Executed verification

`backend/tests/reference/special_plot_native_reference.py` executes unchanged
original Perl method bodies and Text::Template templates, then reads the
actual files written by `Data::points`. It prepares measured Fe `.060`/`.061`
spectra independently with Larch `pre_edge`, `autobk`, `xftf` and `xftr`.
Production web plotting code is not used to generate the native output.

The 90 observations cover all three diagnostics, q real/imaginary/magnitude,
weights 0, 1, 1.5, 2, 3, 4, and positive/negative/zero display multipliers with
nonzero offsets. Distinct positive/negative energy shifts expose the Bi-Quad
bug. Comparison tolerance is `rtol=3e-13`, `atol=5e-11` for Perl point-file
decimal precision. Temporary plot-weight overrides are also compared directly
with independently invoked Larch transforms at `1e-13` tolerance.

Accessors, processing-update calls and chart dispatch are explicit bridges.
The executed evidence validates the plotting methods, templates and numeric
point writers; it does not execute the complete native Wx/gnuplot application,
the full processing state machine or global display preferences. Complete
Athena parity is still open.

The recorded output is `backend/tests/fixtures/athena-special-plot-native.json.gz`.
The matching manifest pins the driver, oracle and measured input files.
Regenerate and replay using:

```sh
PYTHONPATH=backend backend/.venv/bin/python \
  backend/tests/reference/special_plot_native_reference.py \
  --sources /tmp/athena-special-plot-sources \
  --environment /tmp/athena-smoothing-preferences-runtime/environment.json \
  --perl-lib /tmp/athena-export-runtime/root/usr/share/perl5 \
  --output /tmp/athena-special-native --record
```

Omit `--record` for an exact replay. Refresh manifest hashes after deliberate
reference changes. The `/tmp` paths identify the prepared local source/Perl
environment, not bundled application dependencies.

Backend tests cover HTTP request validation, exact marked membership, frozen
groups, stale revisions, restart, and export/reimport without the web sidecar.
Browser tests import the original `Fe.prj`, compare every displayed Plotly
array with the API response, exercise both entry points and range/weight
controls, and assert the saved project remains exactly unchanged. See the
[verification log](athena-verification.md) for the latest executed checks.
