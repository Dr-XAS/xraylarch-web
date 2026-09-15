# Athena beamline metadata and X11A EDC import

This implements the acquisition-header work of
`Demeter::Plugins::Beamlines::{BL8,MX,X11A,XDAC}` at Demeter revision
`06afc8da08a5a7d5a26ee14992170fcf5dc67406`. These four helpers enrich a Data
object; they are separate from the 22 file converters in the plugin registry.

## Using it

Import a supported acquisition and review the live column plot. A **Beamline
metadata** panel shows the facility, beamline and acquisition time. Expand
**View beamline metadata** for detector, monochromator, scan-region, gain,
offset and acquisition-comment fields. **Group → Group information** shows
the same captured metadata after import and after reopening a web project.

**File → Beamline identification…** controls automatic recognition. The switch
defaults to enabled, matching `operations.identify_beamline`. Saving it affects
subsequent inspections, including **Reinspect selected file**. Already staged
files and imported groups retain their captured metadata. The preference is
stored independently of project versions and Undo. Concurrent saves use a
version check; Reload settings recovers a stale form.

The file-converter switches still apply independently. For example, an
argon-corrected BL8 file requires BL8Ar enabled before that conversion. Its
metadata is then read from the converted file, matching native identification
after reading; the Ar step is captured with a converted-source checksum.
Ordinary X11A EDC import needs no converter switch.

## Exact input and array boundary

Bruce Ravel's measured [X11A copper foil acquisition](https://gist.github.com/bruceravel/d21ac49037a8bc5e954d)
is checked in as `backend/tests/fixtures/demeter-x11a-cu.012`. The
[pinned raw revision](https://gist.githubusercontent.com/bruceravel/d21ac49037a8bc5e954d/raw/885eb7e55ee573fa011fe6a4dcc8440abe04e31f/cu.012)
has SHA-256 `53c258b4d8927bf266a5b074011c93ad2de9338c40ed501b723707dc3e78fc9d`
and 21,370 bytes. It records a rolled/annealed Cu foil at 10 K, acquired on
1992-09-15. Its four columns contain **612 observations**, although `NPTS`
declares 611. Import retains all 612 and reports the discrepancy.

The generic validator previously rejected this header's mixed text and
numbers. The X11A boundary now requires its EDC version marker, DETECTORS
labels and a matching numeric OFFSETS line. All subsequent nonblank lines
must be finite rows of the exact width. Missing boundaries and damaged
first/middle/final observations fail; they are never silently dropped.
Point and column limits apply to the full table.

Actual `larch.io.read_ascii` receives the original file. Only its inferred
column labels/units are replaced: otherwise it mistakes OFFSETS values for
labels. The detector header supplies `energy, I0, I, If` and eV. A direct
comparison with the complete measured table verifies all **2,448 values**.
Captured offsets and gains are acquisition metadata; this helper does not
subtract them from counts or alter processing parameters. Source bytes remain
available for download.

## Native contracts

| Helper | Captured native behavior |
| --- | --- |
| MX | Version, APS source, acquisition time, 10BM/10ID INI defaults, ring energy, E0, regions, settling time, offsets, gains and comments. The pinned helper exits at the dashed separator before its Column branch; that branch is intentionally not invented. Numeric import labels remain available separately. |
| XDAC | Version, NSLS source, station/date, the nine XDAC INIs, file mono/ring overrides, E0, regions, offsets, gains, comments and column labels. |
| X11A | EDC version, NSLS/X11A defaults, acquisition time and comment, ring energy, E0, HC/2D-derived spacing using native HC=12398.61, steps/degree, focusing/table-translation booleans and EDC extensions. |
| BL8 | SLRI/BL8/detector defaults, date/duration, scan/step/time/gain/count/Ar-step extensions, columns and the native crystal-selection order, including XDIBL8 and Al/Si/Mg heuristics. Element/edge inference also captures the Element fields set by native find_edge. |

The bundled `athena_beamline_defaults.json` contains the exact values of the
two MX and nine XDAC INIs. Defaults apply in native encounter order: later
fields can overwrite them. For example, a file-provided Ge mono name does
not automatically replace an earlier INI d-spacing; these are reported
acquisition fields, not a synthesized geometry model. No timezone or duration
midnight rollover is inferred.

Family/tag names are lowercase in the stored JSON, consistent with the web's
Larch-oriented representation. CRLF comments are normalized for text display.
Original bytes and the checksum remain available. Two documented native date
bugs are corrected: XDAC 12 AM/PM and X11A four-digit years. Each correction
has a warning and retains the native conversion in `native_values.start_time`.
Unusable dates produce a warning without inventing a date. The native X11A
ring-energy decimal formatting and MX early exit remain as implemented in
the pinned helpers.

BL8 uses the existing Athena edge inference with XrayDB's Elam table, then
the native crystal heuristic. Its provenance identifies this inference.
The Al/Si/Mg and explicit crystal cases have native comparisons; equivalence
over every energy or alternative native absorption resource is not claimed.

## Verification and limits

`backend/tests/reference/beamline_native_reference.py` runs unchanged Perl
helper bodies, Demeter `yesno/is_true`, and `Data::Mu::find_edge`. Dependencies
are checked against `athena-primary-sources.json`. Xray::XDI is a recording
bridge; native INIs and the pinned Elam table are read independently of web
code/defaults. Constants come from the pinned Constants.pm. This is executed
native control flow, **not an actual Xray::XDI validator, serializer, or GUI**.

The 31 recorded cases cover measured X11A, MRCAT `uhup.101`, XDAC
`re4chan.000`, all 11 INIs, file overrides, date corrections, nonzero numeric
booleans and BL8 automatic/explicit crystal precedence. The latter cases are
constructed probes. All fields match the native records after the explicitly
documented date/CRLF differences. The replay command is:

```bash
backend/.venv/bin/python backend/tests/reference/beamline_native_reference.py \
  --source-root /tmp/athena-column-sources --output-dir /tmp/athena-beamline-replay
```

The backend suite checks native metadata, damaged-row rejection, real live
column arithmetic, unchanged arrays, Larch processing, restart persistence,
preference conflicts, HTTP boundaries, converted BL8 metadata and web JSON/PRJ
round trips. The existing measured `examples/xafsdata/fe.060` is used for the
ordinary XDAC workflow; `re4chan.000` is a native-header comparison because
its enabled converter follows the separate multichannel project workflow.
MRCAT quickscan preview preserves every duplicate-energy point.

The browser tests check all 612 plotted X11A points for transmission and
changed fluorescence columns, metadata during edits, processing, refresh,
actual PRJ download/reupload, preference disable/reload and 390 px display.
Component tests cover text rendering, malformed saved fields, stale saves,
failed confirmation and late responses.

Metadata survives exact web exchange and now also appears in native
Xray::XDI project objects. The separate [XDI exchange contract](athena-xdi-reference.md)
records actual Perl/C reader and serializer execution, independent PRJ restore
without the web sidecar, and measured XDI fixtures. The helper harness above
remains a setter-call comparison. **Group → File metadata…** now provides
[native field validation and saved comments](athena-xdi-controls-reference.md),
while preserving the original helper capture. [Column exports](athena-data-export-reference.md)
now retain these acquisition fields alongside applied processing headers and
saved comments. Processing-history generation and desktop round-trip
verification remain open. Automatic enrichment of every generated
multichannel/derived project also needs its own native cloning audit. No
requirement row is marked Verified by this work, and no Artemis feature is
included.

Primary source identities, including the author-published acquisition, are
recorded in [the source catalog](athena-primary-sources.json). See
[verification results](athena-verification.md) for terminal check counts.
