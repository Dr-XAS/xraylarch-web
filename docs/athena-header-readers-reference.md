# Athena B18 and BM23 column readers

Checkpoint, 2026-09-10. This advances IM-01, IM-03 and IM-10 in the
[107-row Athena matrix](athena-parity.md). Full Athena remains the objective;
no row is Verified and Artemis is excluded.

## Sources and scope of evidence

The implemented transformations follow the pinned native
[B18.pm](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/Plugins/B18.pm)
and [BM23.pm](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/Plugins/BM23.pm),
already recorded in the [source catalog](athena-primary-sources.json).

The [fixture manifest](../backend/tests/fixtures/athena-header-fixtures.json)
explicitly labels every new input as a **constructed probe**. These are not
measured B18 or BM23 acquisitions. They reuse the energy/count arrays of the
retained official X23 `re4chan.000` sample, with a constructed 43-column B18
layout or a five-column BM23 SPEC layout. The B18 fluorescence channels are
artificially distributed with weights 1–36; the BM23 input energy is divided
by 1,000. The multi-scan probe repeats the BM23 scan under two distinct IDs.
Input/source/oracle hashes and the harness identity are retained.

The [native reproducer](../backend/tests/reference/header_native_reference.py)
executes unchanged `is`, `fix` and `suggest` methods through minimal accessors.
Larch reads their written output, independently of the web adapters. B18 runs
both the native Larch and Ifeffit branches. Every retained scalar and native
suggestion is compared: Larch B18 **387 × 43**, Ifeffit B18 **193 × 43**,
BM23 **387 × 5**. This does not run Moose, RPC, a full Ifeffit installation,
scientific processing in desktop Athena or beamline metadata hooks.

```bash
LARCHDIR=/tmp/athena-header-larch MPLCONFIGDIR=/tmp/athena-header-mpl backend/.venv/bin/python backend/tests/reference/header_native_reference.py --source-root /tmp/athena-column-sources --output-dir /tmp/athena-header-reproduced
```

The source directory contains the manifest's pinned plugin sources with `/`
replaced by `-`. Reproduction checks identities before executing.

The pinned Demeter test tree has no B18/BM23 acquisition fixture. Additional
searches examined the public `openGDA/gda-diamond` tree at
`661bd61366648201c4a21e443e795431a5a540ec` and `ixdat/ixdat` at
`6adb4239693977aec80ce08d2b5c24e29581bde5`; no matching measurement fixture was
identified. Real acquisitions from both beamlines remain required for broader
format validation. The original [B18 documentation](https://bruceravel.github.io/demeter/pods/Demeter/Plugins/B18.pm.html)
mentions decimation, but the executable conditional limits that to Ifeffit.

## B18 behavior

Recognition requires `Diamond` on the first line and `B18-CORE XAS` on the
second. Comment lines are retained; other lines have tabs replaced and leading
whitespace removed. **All observations are retained with Larch.** The original
`fix` only skips odd-numbered non-comment lines when `is_ifeffit` is true;
it is incorrect to apply that decimation to this Larch backend.

The native default sums **columns 8–43** and divides by **column 3**, with no
logarithm. Its method names this request `transmission`, despite returning
`ln = 0`. The web presents the actual arithmetic as **Use fluorescence columns**.
The 36 numerator checkboxes and denominator can be edited with live preview,
and the existing separate-channel import option is available. A reduced file
with fewer than 43 columns has no native detector suggestion; the summary asks
the user to select the actual columns manually.

## BM23 behavior

Recognition requires `BM23` and `E.S.R.F.` on the first line. The reader cleans
the SPEC header, removes `#L` as a label prefix and multiplies the **first
column by 1,000**. Native 15-significant-digit scalar formatting is retained.
The default transmission is `ln(abs(column 3 / column 4))`.

Original energy labels may still say keV. Explicit converted-column units
keep the preview in **eV**, including a reduced table too small for the native
four-column detector suggestion. The input and converted values are available
in separate downloads; changing detector selection does not scale energy again.

Files containing several `#S` records open the existing scan chooser. Each
scan is converted independently and shown with its own energy sweep, number,
ordinal and preview. This is an integration extension: the native BM23 plugin
writes one combined table. Its one-scan native transformation is the numerical
oracle for each web scan, not evidence that the native plugin itself presents
a chooser. The adapter enforces the configured byte/column limits and the point budget
across the whole file, without an independent scan-count cap. Tab-separated
scan headers and repeated scan numbers retain independent entry identities. Empty or damaged scans are
reported as errors before any scan is staged. Broader incomplete-scan handling
and additional layouts remain open.

Column count declarations, malformed/nonfinite rows, binary NUL content,
energy overflow and resource limits are validated. Numeric observations before
a column declaration cannot be hidden in the header. Unlike the native BM23
loop, malformed text after the data boundary is rejected rather than silently
skipped. All source bytes remain downloadable after successful inspection.

## Preview and exchange checks

Enable these readers in **File → Plugin registry…** before using **Import data**.
The regular column selector displays the suggested μ(E), and changing a
numerator/denominator redraws it. BM23 collections also provide the scan-level
preview before detector selection. Import and processing use the same staged
arrays; metadata and calculated arrays survive PRJ save/reopen and restart.

[Backend tests](../backend/tests/test_athena_header_files.py) compare every
native output value, B18 backend-conditional retention, arithmetic previews,
column edits, reduced-layout energy units, multiple scans, cumulative limits,
late malformed rows, disabled readers, downloads, real Larch processing,
restart and PRJ exchange. [Chromium tests](../frontend/tests/e2e/athena-header-files.spec.ts)
check real Plotly coordinates before/after detector edits, original/converted
downloads, E/k/R/q plots, PRJ exchange, page reload and selection of one BM23
scan. Screenshots are inspected; execution results are in
[verification](athena-verification.md).

Eighteen readers are now registered. BL8Ar, SLRIBL4, SpecFileLongLine and Zip
remain outside that set, along with four nested Beamlines helpers, independent
measured B18/BM23/10BM inputs, full metadata/configuration/extension discovery,
native desktop replay and the rest of the Athena matrix.
