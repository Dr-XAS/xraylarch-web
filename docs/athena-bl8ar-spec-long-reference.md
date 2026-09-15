# BL8Ar correction and SPEC long-label reader

Source contract checked 2026-09-11 against Demeter revision
`06afc8da08a5a7d5a26ee14992170fcf5dc67406`. This advances IM-01 and IM-10;
it does not establish full Athena parity. Artemis remains outside scope.

## Native behavior and implemented workflow

[BL8Ar.pm](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/Plugins/BL8Ar.pm)
recognizes the first-line BL8 signature and the first integer E0 header when
`0 <= ArK/harmonic - header_E0 < margin`. The actual default absorption table
is Elam: Ar K is **3205.9 eV**, so harmonic 2 puts the correction boundary at
**1602.95 eV**. The rounded 3206/1603 values in the configuration prose are
not the executed threshold. The pinned Elam table, get_energy implementation,
reader and both normalization templates have retained source hashes in
[the source catalog](athena-primary-sources.json).

File → Plugin registry → BL8Ar enables the reader. Configure exposes harmonic
1/2/3, the activation margin, pre/post-edge bounds and the optional I0 review.
Defaults are harmonic 2, margin 200 eV, pre-edge −30 to −10 eV, post-edge +10
to +30 eV and review off. Apply affects subsequent inspections in the current
server; Apply and Save persists all currently applied reader settings.
Reinspect selected file explicitly applies updated settings. Previously staged
data keep their own settings and review requirement.

The native Larch template calls `pre_edge` with `nnorm=bkg_nnorm-1`.
BL8Ar's two terms therefore mean a linear post-edge fit. The adapter executes
that actual Larch call on energy and column 4 (I0). It subtracts the fitted
step only at energies strictly above the argon threshold. The point exactly
at the threshold is unchanged. All output columns use the native six
significant digits; the step header uses three decimal places. Original file
bytes remain downloadable separately from this converted copy.

| Acquisition header | Columns | Default sample expression | Uncorrected column 6 |
| --- | ---: | --- | --- |
| Transmission-mode XAS | 6 | ln(abs(column 4 / column 5)) | × 1 |
| Si Drift 4-Array | 10 | sum(columns 7–10) / column 4 | × 4 |
| Ge 13-array | 19 | sum(columns 7–10) / column 4 | × 13 |

The Ge default is intentional source fidelity: the native method computes a
13-channel expression but returns the hard-coded first four. The interface
explains this and allows all 13 detectors to be selected, with an immediate
curve update. Column 6 can be selected as the reference with Reference natural
log off, as described in the native reader's documentation.

The optional I0 plot overlays original I0, pre-edge fit, post-edge fit and
corrected I0, with shaded regression ranges and the argon boundary. When
review is enabled it opens automatically; importing stays disabled until the
plot has rendered and the user confirms this file. Confirmation collapses the
diagnostic plot so the live column preview is prominent; Show I0 correction
reopens it. Each subsequent batch file needs its own confirmation even when
column mappings are reused. The backend also checks the staged requirement.
When review is off the diagnostic remains available without blocking import.

[SpecFileLongLine.pm](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/Plugins/SpecFileLongLine.pm)
checks the initial contiguous comment header, stops at the first `#L` line,
and recognizes it only when its byte length **including newline exceeds
254**. The converter removes every `#L` line and preserves all other bytes,
including CRLF and original numeric precision. Its transmission suggestion
is ln(abs(column 56 / column 57)) with column 1 as energy. Tables too short
for that suggestion still open with manual selection and an explicit notice.
This is a literal file converter, not a general SPEC scan splitter. The SPEC
zapline reader and BM23 reader keep their earlier precedence when enabled.

## Verification and limits

Four analytic files in `backend/tests/fixtures/` are explicitly named
`constructed-bl8ar-{trans,sidrift,ge}.dat` and `constructed-spec-long.dat`.
They are reproducible from
`backend/tests/reference/make_bl8ar_spec_probes.py`, whose hash is recorded in
`athena-bl8ar-spec-long-fixtures.json`. These are **constructed probes, not
measured acquisitions**. The I0 includes curvature and a broadened 600-count
step, so changing fit windows changes the fitted correction. At default
windows the fitted step is approximately 603.2; the alternate windows give
604.4. These values describe the probes, not beamline measurements.

`backend/tests/reference/bl8ar_native_reference.py` runs the unchanged native
Perl `is`, `fix` and `suggest` bodies. Moose construction and Wx are bridged;
normalization uses an independent Larch call with the native template's
arguments. Five retained references (three acquisition modes, changed fit
windows and long SPEC) cover **21,311 output values**. Tests compare converted
SHA-256 values, which proves whole output-byte equality for these cases,
plus native recognition and suggestions. The bridge is not an executed
Ifeffit or Wx desktop numerical oracle.

Backend tests also cover activation/margin boundaries, integer header
matching, strict post-threshold correction, negative fitted jumps, invalid
configurations, corrupted rows, input/output budgets, absent native detector
columns, exact long-line recognition, original downloads, live sample and
reference edits, normalization, undo, JSON/PRJ retention and HTTP review
enforcement across configuration changes. Component tests check actual plot
readiness, per-upload review reset, render failures, immutable plot inputs and
numeric configuration choices. Chromium tests exercise the rendered I0 fit,
four-to-thirteen detector edits, raw reference, repeated-file review,
processing and PRJ exchange; the long-SPEC test edits the denominator at
390 px width and verifies the exact converted download. Terminal results are
recorded in [the verification log](athena-verification.md).

Known differences and evidence still required:

- Native BL8Ar calculates its harmonic threshold when its module loads. The
  web adapter recalculates it on each new inspection, so an applied harmonic
  works without restarting; staged files are unchanged.
- Native Larch takes an absolute edge step even for a falling I0 edge. This
  adapter preserves that behavior and shows a falling-edge notice. Ifeffit's
  `preedg.f` can retain the sign, so backend equivalence is not claimed.
- Fits require distinct positive energies, four observations per regression
  interval and intervals wholly inside the scan. Invalid inputs fail before
  staging instead of silently shrinking the fit or changing its degree.
  Decreasing input order is sorted for fitting only; output rows retain their
  source order and can use the ordinary import sorting control.
- The official [SLRI BL8 page](https://www.slri.or.th/en_web/bl8-x-ray.html)
  advertises reference data, but its aluminium entry currently has no download
  link. Searches of the official Demeter tree and public BL8 sources did not
  yield an independent Al/Ar raw acquisition. Measured BL8 and long-SPEC
  fixtures, desktop plot/prompt replay, non-default absorption resources and
  the four separate beamline XDI metadata helpers remain required.
