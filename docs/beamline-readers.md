# The beamline reader registry

How web Larch decides which beamline wrote an uploaded file, and which of its
columns measure what. The list of beamlines this reaches is generated, not
written by hand, and lives in [beamline-coverage.md](beamline-coverage.md).

## The problem it solves

Every synchrotron beamline writes its XAS scans in its own way, and most of
those files are columns of numbers under a header no other beamline writes.
Before this registry, a file whose columns were not named `i0`/`it` was
imported by matching substrings in the column labels, which picks up a diode
called `Io_diode` or a scaler timer called `ion_time` as the incident beam.
The resulting spectrum looks plausible and is wrong.

## What happens on import

1. **Identify.** `beamline_registry.identify_beamline` reads the first 80
   lines and matches them against the patterns each beamline's data
   acquisition system writes — an XDI version line, an Epics StepScan banner,
   a BLISS `#S` line, the MRCAT column header, and so on. A data acquisition
   system's own banner is tried first, because it names a station and not
   only a format; the self-describing formats (XDI, SPEC, FDMNES, the
   Bluesky column export) follow, most specific first, so that `# Facility:`
   — a field a file of any format can carry — is the last thing consulted
   and a SPEC file that happens to name its facility stays SPEC. Only the
   first 80 lines are searched: a marker further down is inside the data,
   not in a header. HDF5 is sniffed by magic number and handed to
   `hdf5_readers`, which walks the NeXus tree and converts the scan it finds
   to columns.
2. **Attribute.** Where no header names a beamline but one of Demeter's file
   readers claims the file, `attribute_plugin` names the beamline that reader
   stands for. A 2006 APS 9-BM scan is an ordinary SPEC file to anything
   reading its first line; only the dark-current logic of Demeter's `CMC`
   reader knows the station. A file whose own header names its beamline keeps
   that name: the header is the file's statement about itself, while the
   reader is an inference from the shape of the columns.
3. **Name the channels.** `beamline_roles` maps the columns to `energy`,
   `i0`, `transmission`, `fluorescence` and `reference`, using the beamline's
   own naming conventions rather than substring matching, and fills the
   import dialog's column choices from them. A Demeter plugin's own column
   suggestion still wins for the formats it handles, so the pinned Athena
   parity behaviour is untouched.

Each reader reports how far its claim goes, as `confidence`: `beamline` only
when the file itself states the station, `format` when the station is an
expectation — the one this acquisition system or this Demeter reader usually
writes from — and the evidence line then says so in words. A station that is
assumed is a station a user can correct.

Where two columns make the same claim and nothing in the file settles it —
two labels that both name the incident beam, say — the registry leaves that
role unset rather than taking whichever column came first. An unfilled
choice asks the user one question; a choice filled by column order produces
a spectrum that looks right and is not.

The result reaches the browser as `beamline_reader` on the inspection
response, and the import dialog shows it above the column choices: the
facility, the beamline, the format, the channels, and the evidence the
recognition rested on. Every choice it made can still be changed by hand.

`GET /api/athena/formats` returns the whole catalog without a project or an
upload, because "will it open my data?" is asked before anyone has uploaded
anything. The file-chooser shows it under *Which beamlines and formats open
here?*.

## HDF5 upload safety and limits

HDF5 imports and both XRF panels require self-contained files. External links,
external raw storage and virtual datasets are refused before data are read,
including when they occur outside the selected scan. Existing XRF uploads are
checked again before preview or extraction.

The default upload limit remains 50 MB. `XRAYLARCH_MAX_POINTS` bounds each
dimension, and `XRAYLARCH_MAX_UPLOAD_BYTES` also bounds decoded non-detector
data and each compressed chunk. Attributes count toward that budget; bounded
text reads charge actual text bytes rather than reserving 64 KiB per short
attribute. Ordinary files retain the `XRAYLARCH_MAX_COLUMNS` dataset limit.

Detector files instead allow 2,048 datasets (`XRAYLARCH_MAX_DETECTOR_DATASETS`),
including instrument metadata, and 256 MB of decoded real numeric detector
arrays (`XRAYLARCH_MAX_DETECTOR_BYTES`). An 8-element, 4,096-channel, 560-point
cube needs about 147 MB as float64, so this admits a full scan with headroom
without allowing arbitrary allocations. NeXus arrays use (points, elements,
channels), with at most 64 elements and 8,192 channels; 20-BM stores individual
elements as (1, points, channels). The aggregate budget counts distinct cubes
once even if instrument and data groups alias them. Readers select one cube
and separately bound the requested window allocation. Scalar aliases still
count separately. Large detector arrays must have at least one stored byte per
100 decoded bytes, preventing tiny fill-only or highly compressed declarations
from consuming the expanded budget. File, chunk, attribute, and link checks
remain in force; this is not an exemption for detector payloads.
Partial chunks are charged at their full size, and total allocated chunk count
is bounded by `XRAYLARCH_MAX_POINTS`; the chunk index is traversed once.
Numeric arrays are budgeted at no less than float64
size. A small compressed file can therefore be refused even when its upload
size fits. Split an oversized file or have the administrator review the limits;
the reader does not silently downsample it. Numeric types must be fixed-size
real values, and arrays have at most three dimensions. Scalar text is bounded
to 64 KiB; variable-length dataset arrays and reference/compound types are
refused. Text attributes, including the motor-name table, use bounded reads.

Compression is limited to gzip, shuffle and Fletcher32 in their standard order.
The preflight checks actual gzip expansion with a bounded decoder, not just the
declared chunk shape. Other filters must be removed when exporting the file.
This is input validation, not a sandbox for bugs in the native HDF5 library.

The application calls the extraction engine through `xrf_hdf5`, which performs
these checks without changing the numerical reduction. New upload callers must
use that boundary rather than the engine's internal HDF5 functions.

## What the evidence is

Each reader is exercised on a real file from that beamline where the
repository has one; `backend/scripts/beamline_coverage.py` regenerates the
coverage table by opening every example through the same import path the
browser uses, so a reader that is declared but never fires cannot appear
there as coverage.

The HDF5 layouts are the weak point and are labelled as such. The repository
carries no HDF5 file, and no file written natively by ESRF, Diamond, SOLEIL or
PETRA III could be found in public, so `backend/scripts/write_demo_hdf5.py`
writes one synthetic file per documented layout, each with a Mn K edge of
known height. They show the walker handles the layout and maps the channels;
they are not evidence that it opens that facility's real files.

Three public NXxas files are read from the directory named by
`WEBLARCH_PUBLIC_EXAMPLES`, and skipped when it is unset — a GSECARS 13-ID-C Co
foil, a Photon Factory BL9A Fe scan, and an APS 13-BM-D Fe series. The NXxas
three are conversions rather than files a beamline writes, which is itself
most of what they teach: each converter followed a different draft of the
definition, so the incident monitor is `monitor/data` in one and
`instrument/i0/data` in another, and the station is written in four different
places across them. The reader reads every one of those places, keeps the
converter's own computed absorption as the measurement, and offers the
monitors beside it. The Photon Factory scan is the only measurement available
in more than one form — the 9809 original is in the repository, and the XDI
and NeXus conversions are not — and comparing them found the conversions'
energy axis to be miscalibrated by about 0.6%, placing the Fe K edge 34 eV
below where Fe's edge is, while the original agrees with its own recorded
Bragg angles to 0.07 eV.

## Limits

- A beamline whose files carry no distinguishing header cannot be recognized,
  and such a file opens as plain columns with the choices left to the user.
  That is the correct outcome, not a failure.
- Readers that cover several facilities at once — Demeter's `PFBL12C`, which
  reads Photon Factory, SPring-8, SAGA and Aichi files alike — name no
  facility, because choosing one of them would be a guess. Those files say
  which facility wrote them in their own headers.
- A few mappings rest on a station's local counter names rather than on
  anything the format defines — ESRF's zapline files call their detectors
  `Mon`, `Ion1` and `Ion2`, whose order along the beam is a convention of the
  station that wrote them. The repository's example file confirms that order
  by its edge step, and the evidence line says the order is a convention, so
  a station that wires them differently is visible rather than silent.
- A counter's name need not say what it measured. The Photon Factory's 9809
  collector calls its two counters I0 and I1 in a fluorescence scan as in a
  transmission one, and declares the measurement on its station line instead
  (`BL9A      Fluorescence( 3)`). Reading I1 as the transmitted beam there
  imports the spectrum upside down, so the reader follows the declared mode:
  in a fluorescence scan I1 is the detector and no transmission is offered.
- An HDF5 file holding several scans opens as its first entry only. The APS
  13-BM-D example holds three samples, and the other two are not reachable
  from the import dialog yet.
- Raw FDMNES output (`..._out.dat`) is not imported; its multi-row header is
  rejected by the column parser. The convolved output beside it
  (`..._out_conv.dat`) opens normally, and that is the file an analysis uses.
