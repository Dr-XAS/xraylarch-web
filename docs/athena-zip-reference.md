# Athena ZIP list reader

Contract: unchanged [Zip.pm](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/Plugins/Zip.pm)
at Demeter revision `06afc8da08a5a7d5a26ee14992170fcf5dc67406`.
This reader returns a **list of files**, not a merged spectrum or a project.
The [Athena import dispatcher](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/UI/Athena/IO.pm)
recursively imports a list-output plugin’s files and then calls its cleanup.
Its `suggest` method is empty; each constituent file needs its own reader and
column choices. The native POD example uses energy `$1` and `ln($2/$3)` for
the bundled three-column iron-foil files.

## Implemented flow

Enable **Zip** in File → Plugin registry (the native default is unchecked).
Use Import data, drag and drop, or choose a `.zip` from Open project. The
archive panel lists full member names, original order, sizes and independent
entry numbers. Select all, none, invert, or select individual files, then
**Review selected files**. Original ZIP and individual member downloads retain
their exact bytes. Member paths are display labels, never extraction paths.

The accepted selection joins the existing file queue. Ordinary data opens in
live column selection; SPEC/BM23 collections open in scan selection; native
projects open in group preview; multichannel readers retain their project
output. A nested ZIP opens another file chooser. Files after the ZIP remain
queued. Matching-column batch reuse is the existing explicit checkbox; clear
it to stop for every file. A failed raw-file inspection now offers **Skip this
file**, preserving the rest of the queue. No data groups are added during
archive inspection or member download. Download failures retain selection
and do not forward a partially downloaded batch.

The archive is staged once as original bytes plus metadata. Downloaded members
are individually inspected and retain their own original source downloads,
scientific columns and normal JSON/PRJ exchange metadata. Changing the Zip
registry switch does not invalidate a staged archive. Constituent files use
the reader settings in force when they are inspected. Archive member names
are displayed in full, while the existing source-name sanitizer selects a
safe basename for individual file downloads and imported group labels.

## Boundaries and native differences

- Athena first checks [Files::is_zipproj](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/Files.pm).
  Root members `order`, `gds.yaml` or `HORAE` identify fitting projects and are
  rejected before any staging. No Artemis import is implemented. The native
  gate is executed independently for all three markers plus ordinary and
  nested names; its results are retained in the oracle.
- Files follow central-directory order. Duplicate names have independent
  ordinal identities; Python reads by `ZipInfo`, avoiding name collisions.
  Directory entries are counted and omitted from file selection. The native
  plugin lists `memberNames` without excluding directories or distinguishing
  duplicate names. The retained official flat archive has neither case.
- No archive paths are written to disk. Native `fix` writes each member to a
  stash subfolder and `clean` removes it; the web workflow stages one opaque
  ZIP and streams member bytes. Nested/absolute/parent paths cannot write
  outside the workspace. Link and special-file entries are rejected.
- Compressed upload and total declared expanded bytes each obey the configured
  upload limit (50 MB by default). The list is limited to 1,000 central-directory
  entries. Size and CRC are checked before staging any archive result; member
  downloads check the chosen member again. Encrypted/unsupported compression,
  truncated/corrupt ZIPs and control-character names return recoverable errors.
- Empty files and non-data files are visible so users can exclude or download
  them. Selecting one can fail the usual data inspection; it is not silently
  discarded. Archives of only directories/zero entries are rejected as empty.
- Staged archive previews and raw-column uploads share the existing workspace
  lifetime; no new automatic archive-retention policy is claimed. Wider native
  extension discovery, remaining readers and full Athena desktop replay remain
  part of the complete goal.

## Independent reference and tests

The retained [official fixture](../backend/tests/fixtures/demeter-data.zip)
is `examples/data/data.zip` (also `t/data.zip` in the pinned tree), Git blob
`deb91d16fe96ce12a90665c4fc713b6659362f9d`. It contains **fe.060, fe.061,
fe.062**, each **22,365 bytes / 511 observations**, totaling 67,095 bytes.
These are measured acquisitions, unlike the explicitly constructed B18/BM23
probes used in the heterogeneous-container test.

[zip_native_reference.py](../backend/tests/reference/zip_native_reference.py)
executes the unchanged native `is/fix/suggest/clean` bodies with real CPAN
**Archive::Zip 1.68**, File::Spec and File::Path. Only Moose construction,
accessors and the random stash suffix are bridged. Native extraction order,
every member's SHA-256/size, empty suggestions and actual cleanup match the
[retained oracle](../backend/tests/fixtures/athena-zip-native.json).
The [manifest](../backend/tests/fixtures/athena-zip-fixture.json) records the
fixture, native source, harness, oracle and CPAN distribution identities.
This proves the list-conversion contract on the official archive; it does
not claim a full Athena GUI or Moose application run.

Reproduce with the pinned source cache and Archive::Zip available in PERL5LIB:

```bash
PERL5LIB=/tmp/Archive-Zip-1.68/lib backend/.venv/bin/python \
  backend/tests/reference/zip_native_reference.py \
  --source-root /tmp/athena-column-sources --output-dir /tmp/athena-zip-reproduced
```

Backend tests compare all three measured energy/μ arrays to independent
native-POD arithmetic, process them with Larch, save/reopen PRJ, restart the
store and exercise the real HTTP boundary. Additional cases cover mixed
projects/scans/archives, duplicate names, directories, Unicode names, paths,
four compression methods, a self-extracting prefix, late corruption, resource
limits, registry snapshots, namespace isolation, native fitting-project rejection and failed staging writes.
Browser tests exercise native member downloads, actual Plotly trace values
before/after edits, subset import, all four processed plot spaces, PRJ restore,
page reload, mobile selection, Open project routing and a mixed-container
queue with non-data recovery. See [execution results](athena-verification.md).
