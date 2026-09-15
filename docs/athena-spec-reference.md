# Athena SPEC multi-scan import

Source contract, 2026-09-10. This advances IM-01, IM-04 and IM-10 in the
[107-row Athena matrix](athena-parity.md). Full Athena remains the objective;
Artemis is excluded and no requirement is certified Verified.

## Native source and actual reference

The implementation follows the list-output path in
[SPEC.pm](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/Plugins/SPEC.pm)
and [Athena IO.pm](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/UI/Athena/IO.pm#L201),
pinned to Demeter `06afc8da08a5a7d5a26ee14992170fcf5dc67406`.
The plugin recognizes `#S … zapline mono` scans regardless of file extension,
splits them into separate tables, multiplies the first column by 1000, and
retains every other scalar column in order. Native IO recursively imports the
resulting list. It does not explicitly forward the parent plugin object to
those child imports; source-method suggestions are therefore not evidence
that the desktop applies those suggestions in that recursive path.

The original [SNBL acquisition](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/t/filetypes/snbl.dat)
contains 456 and 906 observations, each with 18 columns. The retained
[fixture manifest](../backend/tests/fixtures/athena-spec-fixture.json) records
its URL, byte count, SHA-256, Git blob identity and native-reference hashes.
The unchanged Perl `fix` method was executed with minimal accessor/path stubs;
`suggest` and `clean` are retained verbatim in the harness but are not invoked.
Every one of the **24,516 converted scalar values**
matches the web output after real Larch reading. This is native converter
execution, not a complete desktop replay.

Reproduce the reference with the pinned module downloaded locally:

```bash
backend/.venv/bin/python backend/tests/reference/spec_native_reference.py \
  --source /tmp/athena-column-sources/lib-Demeter-Plugins-SPEC.pm
```

The [reproducer](../backend/tests/reference/spec_native_reference.py) verifies
source, fixture, harness and native-output hashes, then compares both scans
against the checked-in compressed numerical reference.

## Suggestions must be checked against the measurement

There are two source/sample discrepancies:

- Native `suggest` uses energy column 13 in keV. In this official acquisition,
  column 13 is the constant MusstEnc3 counter; ZapEnergy is column 16. The web
  selects explicitly labelled ZapEnergy, retains the native fixed index in
  provenance and explains the difference. Native first-column scaling is
  preserved even though column 1 is Mon counts in this sample.
- Native code suggests `ln(column 8 / column 10)`, while the module's usage
  notes specify the opposite ratio. With the measured Ion1/Ion2 channels the
  code's ratio has a negative absorption step. The preview shows that actual
  signal. Explicit **Invert signal** produces a positive edge step for both
  scans and permits normalization and EXAFS processing. No sign is changed
  implicitly. The six optional fluorescence channels in this acquisition are
  zero, so it does not establish a usable fluorescence processing result.

Selecting the constant column shows a vertical preview with the actual
constant x values; choosing ZapEnergy restores the energy curve. These are
pre-normalization previews, not automatic approval of the scientific mapping.

## Selection, staging and mixed queues

Enable **SPEC** under **File → Plugin registry…**, then select the source file
in **Import data**. The scan panel shows scan numbers, commands, acquisition
dates, point counts and column counts. All/none/invert and individual
checkboxes control inclusion independently of the active preview. Duplicate
scan numbers retain separate entry identities. Selected scans always enter
the queue in file order.

Each scan preview uses the reader's suggestions and labels that fact. **Review
selected scans** opens the ordinary column controls, where remembered choices
and explicit edits apply. Matching scans can reuse the accepted mapping;
different layouts or disabled reuse pause for review. The existing live
preview, detector expressions, reference choices and preprocessing controls
remain available.

All supported scans are parsed and validated through Larch before staging.
One original file is shared by the staged scans; each has its own converted
table, arrays and inspection metadata. Failure during staging removes only
that collection's new files. Fetching a staged scan refreshes remembered
choices without uploading or converting it again. Accepted imports remain
sequential: a failure on scan 2 retains accepted scan 1, and retry resumes
scan 2 without duplication. Queued native PRJ and raw files continue after
the selected scans.

[Native column memory](athena-column-memory-reference.md) retains sign and
multiplier on a changed layout. After using inversion for SPEC, a subsequent
Cu μ(E) file therefore previews its remembered negative sign. **Use suggested
columns** explicitly clears that inversion. The mixed-queue browser test
checks both curves before accepting the positive Cu spectrum.

Original downloads are byte-identical. Converted downloads are per scan.
Scan metadata, conversion hashes, all converted columns, chosen mappings and
scientific results survive restart and JSON/PRJ exchange. Original source
attachments remain staged local files; exported projects do not yet bundle
them.

## Explicit limits and verification

The reader reports empty scans and non-zapline commands as unavailable while
preserving them in the original file. All `#S` boundaries are separated, so
unrelated motor observations cannot silently join the preceding supported
scan. Damaged supported scans, inconsistent counts, nonfinite values and
resource-limit excesses fail explicitly. These checks differ from native
permissive row skipping. The web also repeats complete file headers for each
scan; native repeats only its saved `#F` line after the first. Converted
headers are not claimed to be byte-identical.

[Backend tests](../backend/tests/test_athena_spec.py) cover all native values,
real Larch processing, staging rollback, shared originals, refreshed settings,
aggregate limits, malformed inputs, duplicate numbers, subset import, restart,
undo and exchange. [Component tests](../frontend/components/athena-scan-selection.test.tsx)
and workbench tests cover selection, queue ownership, mapping reuse and retry.
[Chromium flows](../frontend/tests/e2e/athena-spec.spec.ts) compare actual Plotly
coordinates, independent column edits, E/k/R/q, original downloads, PRJ
round trips and an injected second-scan failure followed by PRJ/raw imports.
Run results and screenshot observations are recorded in
[verification](athena-verification.md).

Other SPEC command/layout families, the remaining native reader collection,
user/system extension discovery and configuration, the complete Athena
processing/analysis/UI workflows and full desktop replay remain required.
