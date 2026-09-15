# Athena file conversion before column selection

Source contract, 2026-09-10. This implements two native adapters under IM-10
and adds source-file access under IM-01. The full
[107-row Athena objective](athena-parity.md) remains active; Artemis is excluded.

## Original behavior and source discrepancies

The [file-plugin manual](https://bruceravel.github.io/demeter/documents/Athena/other/plugin.html)
describes recognition, conversion of a copy, column suggestions, metadata,
user/system registration, ordering, enablement and configuration. Plugins run
before the regular Larch/Ifeffit reader. The
[import overview](https://bruceravel.github.io/demeter/documents/Athena/import/index.html)
places wavelength/encoder conversion in this mechanism. The pinned column
menu itself has only eV and keV: a dormant `guess_units` lambda branch does
not implement wavelength conversion. No third unit option has been invented.

The relevant sources at Demeter `06afc8da08a5a7d5a26ee14992170fcf5dc67406` are:

- [X10C.pm](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/Plugins/X10C.pm): requires EXAFS on the first line and a later DATA START marker; removes NUL padding, comments headers, repairs joined negative numbers and supplies eight labels. It suggests energy column 1 and transmission ln(abs(column 4 / column 6)). Its `is()` loop accidentally checks `$first` instead of the current line, contradicting its POD and `fix()`. The web follows the documented recognition rule and actual converter, rather than making the format unreachable.
- [x10c.ini](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/share/xdi/x10c.ini): supplies the beamline, mono and facility metadata retained in the group. Native numeric labels `1` through `7` become `_1` through `_7` in Larch; stable column positions determine the suggestions.
- [Lytle.pm](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/Plugins/Lytle.pm): recognizes NPTS/NS/CUEDGE/CUHITE, reads DSPACE and STPDEG from header fields 5/6 and converts encoder values using Bragg's law. Suggested transmission uses columns 2/3; users can choose fluorescence columns 4/2 in the column panel.
- [Constants.pm](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/Constants.pm): the native converter uses HC = 12398.61 eV Å and degrees/radian = 57.29577951, then writes energy with `%12.5E`. The web reproduces those constants and six significant digits; using a modern hc value would move the axis. Its formula is `HC / (2*DSPACE) / sin(encoder / (degrees_per_radian*STPDEG))`.

The Lytle fixed-width repair in the native source drops the minus sign in a
joined next field. The web retains that sign, as the X10C repair does. The
official Lytle sample has no such joined fields; a separate edited-input test
exercises this explicit correction. These source defects and unresolved native
desktop replay prevent a claim of complete desktop identity.

## Implemented path

[athena_file_plugins.py](../backend/xraylarch_web/athena_file_plugins.py) holds
an ordered registration table with recognition and conversion functions. Only
recognized Athena uploads with enabled readers use it; the classic parser is unchanged. Conversion
precedes extension-based reader selection, so a renamed CSV/XDI file with a
known native signature still receives the correct adapter. The converted
table goes through the normal bounded parser and actual `larch.io.read_ascii`.

X10C's explicit boundary and the supported Lytle descriptive-header boundary
separate metadata from observations. Every nonblank row thereafter must be
finite and have all eight/five columns. Damaged first, middle and last rows,
invalid monochromator geometry, missing boundaries and resource-limit excesses
are rejected before staging an import. Lytle variants without this descriptive
header remain a documented gap; the reader must not silently discard a broken
first observation as header text.

The original bytes and converted bytes are stored separately in the local
workspace. The column dialog displays the converter and its explanation,
provides both text excerpts and downloads both complete files. NUL padding is
shown as `␀` only in the excerpt; original downloads are byte-identical. Generic
text imports also gain the original-file download. The new endpoint uses the
workspace/upload identifiers and a source/converted enum, not user file paths.

The native suggestions initialize the live arithmetic and plot. Existing
accepted-choice memory, user overrides, references, MED, preprocessing and
rebinning retain their existing precedence. Groups retain every converted
column plus adapter ID/version, settings, facility metadata where supplied,
original/converted sizes and SHA-256 hashes. This metadata and the arrays
survive web JSON and PRJ sidecars. Full original-file attachments stay in the
local import workspace; the current PRJ/JSON export does not bundle those bytes.

## Measured fixtures and verification

The [fixture manifest](../backend/tests/fixtures/athena-file-plugin-fixtures.json)
records immutable source URLs, sizes, SHA-256 and Git blob hashes:

- [demeter-x10c.dat](../backend/tests/fixtures/demeter-x10c.dat): 54,053 original bytes, 547 observations, eight columns, 446 joined negative fields. Ni/Al2O3 sample with a Ni foil noted in the header.
- [demeter-lytle.dat](../backend/tests/fixtures/demeter-lytle.dat): 28,852 original bytes, 480 observations, five columns. Cu/CAB sample; DSPACE 1.92017 Å and 4000 steps/degree.

Before this change, the first file failed as binary NUL input and the second
as malformed tabular rows. Both now import and yield Larch normalization,
AUTOBK and forward/back Fourier products.

[Backend tests](../backend/tests/test_athena_file_plugins.py) compare every
converted row to independent measured-data oracles and direct Larch reading,
check actual detector arithmetic, all-column retention, failed inputs,
restart/memory, undo, JSON/PRJ and HTTP download bytes. The
[browser flow](../frontend/tests/e2e/athena-file-plugins.spec.ts) verifies actual
file-picker recognition, all preview coordinates, source downloads, E/k/R/q
rendering, PRJ reopening and reload. Results belong in the
[verification log](athena-verification.md).

The converter checkpoint registered 94 sources; the subsequent
[registry implementation](athena-plugin-registry-reference.md) adds persistent
enablement, documentation and native YAML exchange for the two available
readers. Enable readers there before importing; fresh registry settings match
Athena’s unchecked default. The complete native reader collection,
user/system extension loading, per-plugin configuration, other beamline and
binary formats, generic wavelength conversion, archive inputs, complete
metadata mapping, attached originals in exported projects and native desktop
replay remain open. Adding these two converters does not reduce that scope.

The subsequent [SSRL reader contract](athena-ssrl-reference.md) adds SSRLA,
SSRLB and SSRLmicro, including native binary conversion and both detector-mode
suggestions. The registry now lists five implemented readers.
