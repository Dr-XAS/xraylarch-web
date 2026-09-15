# Athena File metadata controls

**Group → File metadata…** shows the current group's XDI version, application
versions, field families, required/recommended field presence and saved XDI
comments. Families can be expanded or collapsed together or individually.
**Validate all** checks every displayed field; each field also has a separate
**Validate** action. The numerical reader and validator remain in Larch.

## Native behavior

The reference is Demeter revision
`06afc8da08a5a7d5a26ee14992170fcf5dc67406`, specifically
[UI/Athena/XDI.pm](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/UI/Athena/XDI.pm)
and its [metadata documentation](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/documentation/Athena/other/meta.rst).
These are enabled native controls. Field add/edit/delete handlers are commented
out in this revision; the separate XDIAddParameter source file does not prove
an enabled editing feature. Absorber identity is edited with the existing
group identity controls.

Presence and value validity are separate native checks. The required list is
Element.symbol, Element.edge and Mono.d_spacing. The recommended list is
Facility.name, Facility.xray_source, Beamline.name, Scan.start_time and Column.1.
The presence lists report existing keys, including keys whose values fail
validation. Missing acquisition fields are not filled with guesses. Groups
without an acquisition header can still have current absorber fields and
saved comments.

The backend invokes `XDI_validate_item` from Larch's bundled native XDI
library. Seventy independently executed Perl/C comparisons establish the
same status codes and diagnostic strings for the recorded symbols, edges,
references, crystal spacing, facility units, dates, first-column labels,
sample temperature and extension-field cases. This covers the native
validator's observable behavior, not every possible XDI value or dictionary.

Two native quirks are retained deliberately. Validate all preserves value
case after trimming padding, while individual validation lowercases the
value. Consequently, Column.1 `ENERGY EV` fails the former and passes the
latter. The pinned native validator also accepts `2026-02-30T12:00:00`; a
successful native result does not establish full calendar validation. Neither
operation rewrites the saved field value.

Extension-family spelling is retained from the original XDI header or native
object. Earlier metadata that only retained lowercase names can recover the
spelling from an application-version token. In particular, `GSE` must retain
its spelling when paired with `GSE/1.0`: capitalizing it as `Gse` during PRJ
export caused a validation error after restore. Native PRJ round-trip tests
now cover this case. Comment text after the XDI header boundary cannot change
the captured family spelling.

## Saved comments, identity and conflicts

Save comments changes only the current group's XDI comments. Group notes,
arrays, scientific results, parameters, flags and original acquisition
metadata remain intact. Saving is allowed for frozen groups, matching the
native panel. It participates in project versioning, Undo and Redo. Unicode,
quotation/interpolation characters, empty text, tabs, CRLF and trailing
newlines are covered. Native-only project restoration retains the existing
desktop ambiguity for literal backslash-n; exact web JSON/PRJ exchange retains
the original text, as described in the [exchange contract](athena-xdi-reference.md).

The displayed and validated Element fields follow the current group's
absorber selection, as does native project output. The original declared
identity stays in source metadata. Saving comments on a beamline-enriched
group creates its current XDI metadata separately from the original helper
capture. No normalization or EXAFS processing runs for these operations.

Validation checks the project revision before and after computation. Saving
uses the same atomic revision check as other project commands. A conflict
keeps unsaved comments visible. **Reload saved metadata** explicitly replaces
the draft with the saved text and current revision; the UI explains this
before that action. Pending requests disable saving and modal dismissal,
and late responses cannot save into a newly selected group.

## Implementation and boundaries

- `backend/xraylarch_web/athena_xdi_controls.py` implements presence, effective
  metadata, strict comment input and the Larch validation adapter.
- `GET /api/athena/projects/{project}/groups/{group}/xdi` returns versioned
  metadata. `POST` to its `/validate` child accepts a revision and optionally
  a family/tag pair. The existing project command route accepts
  `action: xdi_comments` with exactly one group and `options.comments`.
- `frontend/components/athena-xdi-controls.tsx` implements the family table,
  validation results, comments and conflict recovery; the workbench exposes
  it through Group → File metadata.

Comments are limited to 50,000 characters, without silent truncation. Native
validation accepts at most 5,000 fields per request and 8,192 UTF-8 bytes per
value or application-version string. Null characters and invalid identifiers
are rejected before entering C. An unavailable Larch library is reported as
a recoverable error; reading metadata and saving comments remain available.

Each validation call uses a separate Python-owned error and version buffer
and a fresh `XDIFileStruct`, protected by a lock around the native adapter.
The inspected C entry point uses only error_message, extra_version and
dspacing. The adapter does not run a file reader, native initialization or
cleanup: native cleanup must not free Python-owned buffers. The tested Larch
library SHA-256 is
`342db951c1797328820d2c1ce1976bf66d5c33f9cde0e844022f07d066b7dcfd`.

## Reproduce the native comparison

The harness executes the actual pinned Xray::XDI Perl/C library and extracts
the unchanged `OnSaveComments` body from the source above. Only the GUI
GetValue/current_data/status connections are bridged. This is not a desktop
GUI replay. Module and source hashes are checked before recording or replay.
The runtime setup is described in the [exchange contract](athena-xdi-reference.md).

```bash
PYTHONPATH=backend backend/.venv/bin/python backend/tests/reference/xdi_controls_native_reference.py \
  --sources /tmp/athena-column-sources \
  --environment /tmp/athena-xdi-runtime/environment.json \
  --output /tmp/athena-xdi-controls-replay
```

Default execution compares all 70 validation cases, four exact saved-comment
cases and the required/recommended lists with the recorded oracle. The
fixture and harness checksums are in `athena-xdi-fixtures.json`. Backend
tests additionally exercise concurrent calls, failure atomicity, preserved
science, identity, freeze, Undo/Redo, restart and JSON/native/web PRJ exchange.
Browser tests cover Cu XDI and legacy X11A at desktop and 390 px widths,
including a real revision conflict and PRJ revalidation without the web
sidecar. A third browser case covers missing acquisition fields.

The [column exporter](athena-data-export-reference.md) now includes acquisition
fields, actual output columns, applied processing headers and saved comments
for current and separate files, plus marked-group tables. The separate
[history contract](athena-xdi-history-reference.md) now covers metadata cloning,
accumulated Scan.process, displayed acquisition times, import rebin and
native-only PRJ exchange for the connected processing operations. Exhaustive
derived/multichannel coverage, legacy xdi_* argument semantics and desktop GUI
replay remain open. The 107 parity requirements retain their
existing IDs, order and statuses; this evidence does not verify a full row.
