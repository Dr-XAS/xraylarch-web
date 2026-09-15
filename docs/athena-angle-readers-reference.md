# Athena SRS, DUBBLE and Photon Factory readers

Source contract, 2026-09-10. This advances IM-01, IM-03 and IM-10 in the
[full Athena matrix](athena-parity.md). The complete 107-row objective remains
active, with no row certified Verified. Artemis remains excluded.

## Native sources and measured evidence

The converters are based on
[SRS.pm](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/Plugins/SRS.pm),
[DUBBLE.pm](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/Plugins/DUBBLE.pm)
and [PFBL12C.pm](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/Plugins/PFBL12C.pm),
pinned to Demeter `06afc8da08a5a7d5a26ee14992170fcf5dc67406`. Five original
acquisitions from `t/filetypes/` were downloaded and checked against the
pinned Git tree. Their source URLs, byte counts, SHA-256 and Git blob hashes
are retained in [the fixture manifest](../backend/tests/fixtures/athena-angle-fixtures.json).

| Official sample | Converted table | Reference |
| --- | --- | --- |
| `srs9.dat`, Co-containing sample | 397 × 15; nine MED channels | Actual native SRS converter and suggestions |
| `srs32.dat`, CuO standard | 353 × 38; 32 MED channels | Actual native SRS converter and suggestions |
| `dubble.dat`, illite acquisition | 377 × 15; nine MED channels | Actual native DUBBLE and generic SRS fallback |
| `pfbl12c.dat`, Hg/cysteine acquisition | 818 × 5; requested/attained energy | Actual native PFBL12C converter and suggestion |
| `srsc.dat`, H-ZSM-5 scan | 205 × 7; explicitly labelled energy | Direct source-table comparison; native converter fails |

The first four provide **29,114 converted scalar values** that match the
executed native Perl output exactly after real Larch reading. The fifth
retains all **1,435 original numeric values** without angle conversion. These
counts distinguish native execution from independent source-table checks.

## SRS detector records and defaults

SRS and DUBBLE recognize the `&SRS` header; DUBBLE additionally requires its
header identifier. The ordinary record starts with six scalars. MED counts
follow on continuation lines of four values, with the final line possibly
shorter. All observations are checked for consistent record structure, so a
missing continuation cannot shift later detector counts into another point.
The non-MED form and interrupted acquisitions ending in `DATA ABORTED` retain
their completed observations. C comments, including indented comments, remain
available in the source and converted header.

Angle records use the native Si(111) spacing **3.13543 Å**,
`2π × 1973.27053324 eV Å`, and four-decimal energy output. Native `is_med`
detection relies on early records and direction heuristics; the web instead
validates the actual six-scalar/continuation structure throughout the file.
It does not infer an already converted energy axis merely from monotonicity.

Native MED suggestions select fluorescence even when transmission is
requested. SRS nine-element data use G1–G3 over I0. SRS 32-element data use
the native explicit set of 18 channels; the app does not replace this with
an all-channel sum.
DUBBLE uses MED2–MED9 over I0. All remaining detector columns remain available
for manual summation or individual-group import, with live preview.

When both readers are enabled, the web's alphabetical registry chooses
DUBBLE first. If only SRS is enabled, native SRS also reads DUBBLE records,
but its default omits MED8 in addition to MED1. Actual native execution
confirms both the identical converted numerical tables and this seven-channel
versus eight-channel distinction. Disabled-reader recovery and saved registry
settings continue to work.

## Explicit-energy SRS variant

The official `srsc.dat` declares `ENERGY TIME REFER SIGNAL1 SIGNAL2 SIGNAL3
ENCODER`. Its 205 energy values are already in eV; they and all other columns
are retained exactly. The web recognizes this explicit declaration, including
the indented C header, rather than converting the energy values as millidegrees.

The unchanged native SRS routine actually fails with division by zero on the
first indented C comment. Its code computes an `xaxis` hint but does not apply
that hint to the conversion. The reproducible failure is recorded; no native
converted array is claimed for this sample. Browser tests explicitly change
the default log ratio to **SIGNAL1 / REFER**, inspect the actual preview and
verify successful Larch processing. The default negative-step ratio is also
preserved with its processing error when explicitly accepted; no automatic
sign correction or detector reassignment occurs.

## Photon Factory angle conversion

PFBL12C recognizes native 9809 headers for KEK-PF, SPring-8, SAGA-LS and AichiSR.
The official acquisition establishes the KEK-PF path; substitutions of the
other recognized facility headers are constructed recognition probes, not
independent measured data from each facility.

Both requested and attained angles become energy using native
**hc = 12398.52 eV Å** and the header's D spacing. The last matching header
wins. If no spacing is present, native `2D = 1 Å` is retained and explicitly
shown in the conversion summary so the energy axis can be reviewed. A
constructed missing-spacing probe was run through the actual native routine;
its full requested/attained energy arrays are retained separately. Invalid
nonpositive spacing, unusable angles and numerical overflow/underflow produce
explicit errors.

Energy and detector values use native three-decimal output, and time uses
two decimals. Offsets remain unapplied, as in native code. Additional detector
columns are retained. The DOS EOF marker terminates the table. Transmission
uses **attained energy**, I0/I1 and logarithm; users can switch to the requested
energy and see the plotted x coordinates change before importing.

Converted files begin with an explicit energy-table identifier. Without it,
Larch recognizes the retained KEK-PF header again and assigns `angle_drive` /
`angle_read` labels and degree units to values already converted to eV. The
identifier preserves ordinary Larch reading with `energy_requested`,
`energy_attained`, `time`, `i0`, `i1` labels. Actual numerical values remain
unchanged. The source download is still byte-identical; converted headers are
not claimed to be byte-identical to native output.

## Reproduction, integration and open work

Enable **SRS**, **DUBBLE** or **PFBL12C** in **File → Plugin registry…**, then
import the source file normally. Existing column editing, remembered choices,
live arithmetic preview, original/converted downloads, processing, undo,
restart and JSON/PRJ exchange apply to these readers. Conversion metadata and
all converted columns survive exchange; standalone original attachments are
still local and are not yet bundled in saved projects.

Run the [native reproducer](../backend/tests/reference/angle_native_reference.py)
with locally downloaded pinned modules:

```bash
backend/.venv/bin/python backend/tests/reference/angle_native_reference.py \
  --source-root /tmp/athena-column-sources --output-dir /tmp/angle-reproduced
```

It verifies module and fixture hashes, executes unchanged `is`, `fix`,
`suggest` and helper methods using minimal accessor/constant stubs, compares
all native arrays and suggestions, checks the DUBBLE fallback and PF missing-D
probe, and reproduces the native SRSC failure. Moose construction and DUBBLE's
XDI metadata hook are not executed. This is not a full Athena desktop replay.

[Backend tests](../backend/tests/test_athena_angle_files.py) and
[real browser flows](../frontend/tests/e2e/athena-angle-files.spec.ts) cover the
measured conversions, detector edits, energy choice, exact previews, resource
limits, incomplete records, download bytes, E/k/R/q, PRJ exchange and recovery.
Counts and screenshot findings are in [verification](athena-verification.md).

Remaining native readers, beamline layout variants, full XDI metadata mapping,
user/system extension discovery, configuration, complete Athena workflows and
desktop replay remain in scope.
