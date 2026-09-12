# XDI acquisition metadata and native Athena project exchange

XDI imports now display acquisition fields beside the live column plot and
in **Group → Group information**. Larch continues to read the numerical
table. Changing numerator, denominator or logarithm updates the plotted
signal while preserving acquisition metadata and all original detector
columns. No plugin switch is needed for `.xdi` files.

## Native contract and measured sources

The contracts are Demeter revision
`06afc8da08a5a7d5a26ee14992170fcf5dc67406`,
[`Data/Athena.pm`](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/Data/Athena.pm),
[`Data/Prj.pm`](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/Data/Prj.pm),
and the actual Perl/C XDI implementation at
[`ed21ad5aa3a066f569e13e607679b2542fc93fa7`](https://github.com/XraySpectroscopy/XAS-Data-Interchange/tree/ed21ad5aa3a066f569e13e607679b2542fc93fa7).
The pinned XDI specification declares family and field names case insensitive.
Metadata is represented with lowercase names for Larch/web use; imported
native objects separately retain their original family/tag spelling.

| Official measured input | Observations | Columns |
| --- | ---: | --- |
| [Cu foil, room temperature](https://github.com/XraySpectroscopy/XAS-Data-Interchange/blob/ed21ad5aa3a066f569e13e607679b2542fc93fa7/data/cu_metal_rt.xdi) | 408 | energy, i0, itrans, mutrans |
| [Fe2O3, room temperature](https://github.com/XraySpectroscopy/XAS-Data-Interchange/blob/ed21ad5aa3a066f569e13e607679b2542fc93fa7/data/fe2o3_rt.xdi) | 348 | energy, mutrans, i0 |

The original bytes, SHA-256 and Git blob identities are recorded in
`backend/tests/fixtures/athena-xdi-fixtures.json` and the
[primary source catalog](athena-primary-sources.json). All **2,676 numeric
table values** are compared with the original files, including detector
columns not selected for absorption. Cu defaults to ln(I0/Itrans); Fe2O3
defaults to the supplied mutrans column. Its measured values are not replaced
by a guessed detector ratio.

## Identity and persistence

The valid standard `Element.symbol` and `Element.edge` fields supply the
group's absorber identity. This is independent of the numerical E0 and energy
shift. A test intentionally declares Fe in the Cu acquisition: the metadata
remains Fe while the measured edge stays near 8980 eV. Explicit **Enforce
element and edge** import settings take precedence. The original acquisition
declaration stays in source metadata even when that policy changes the group.
Invalid or legacy nonstandard declarations do not supply this identity.

Version strings, all parsed families (including extension families), exact
reader comments, column labels/units, observation count and source checksum
are stored under `source.xdi_metadata`. Web JSON and the PRJ web sidecar retain
this object exactly. Larch's Python reader omits the separator blank line that
the native C reader includes at the start of comments; each representation
retains its own reader's text. No nonblank acquisition comment is discarded.

Native `$xdi = bless({...}, 'Xray::XDI')` records are decoded as inert literals.
Only this recognized class and a valid metadata shape are promoted to the
acquisition panel. Unknown classes and malformed XDI objects remain in source
metadata with a diagnostic, without preventing usable spectra from opening.
Executable expressions are rejected before changing the destination project.

PRJ export now writes a native Xray::XDI object as well as the existing web
sidecar. It retains original native field spelling and auxiliary fields,
clears the native `data` hash as `Xray::XDI.serialize` does, and excludes the
foreign C handle. Athena's x/y and optional detector arrays carry numerical
observations. Fresh XDI or recognized beamline metadata also produces an
object usable by actual Perl Xray::XDI methods. The current group's absorber
identity updates the native Element fields and scalar identity; the exact
original declaration remains in the web sidecar. Case-insensitive updates do
not create duplicate `Symbol`/`symbol` fields.

Strings are emitted as escaped Perl literals: Unicode, tabs, quotes, dollar
signs and array sigils remain data. Native `Data::Prj` restores the two literal
characters backslash+n in comments to a newline. That native ambiguity is
retained for independent native exchange; the web sidecar preserves an actual
literal backslash+n exactly. Inconsistent saved native/normalized fields fail
export with a recoverable error rather than silently choosing one version.

## Independent native execution

`backend/tests/reference/xdi_native_reference.py` executes the official Perl
`Xray::XDI`, its compiled C reader and its actual Moose clone/serializer.
It verifies the hashes of the Perl modules actually loaded. It also runs the
unchanged Demeter `_write_record_athena` body, checked against the source
catalog, with a small Data bridge that supplies already-read numerical
arrays, arguments and the real XDI object. The bridge does not implement
normalization or the desktop GUI.

Three recorded cases cover the two acquisitions plus constructed Unicode,
quotation, interpolation-character and newline metadata on the Cu file.
`athena-xdi-native.json.gz` stores the original native objects, arrays and PRJ
records. Default replay compares every recorded field and byte of native
writer output with fixed Perl hash ordering. Five additional executions pass
web-emitted literals to real Perl Xray::XDI methods: the three imported native
objects, a fresh Larch XDI object and fresh X11A beamline metadata. The only
Perl evaluated is pinned code and literals emitted by this trusted test
harness; it never evaluates uploaded projects.

The verification runtime was built under `/tmp/athena-xdi-runtime` using
Perl 5.40.1, Moose and the pinned XDI C/Perl sources. Missing compiler/Perl
dependencies were downloaded as Debian packages and extracted beneath that
temporary runtime; no system package installation was performed. The C
library was compiled with `gcc -shared -fPIC -O2` from `xdifile.c`, `strutil.c`
and `slre.c`, linked with libm. `perl Makefile.PL` and `make` built the Perl
extension into `blib`. Runtime PATH, PERL5LIB, library/header paths and compiler
paths are in `environment.json`; downloaded package hashes are recorded in
`package-checksums.json` alongside it. To replay with that runtime:

```bash
PYTHONPATH=backend backend/.venv/bin/python backend/tests/reference/xdi_native_reference.py \
  --sources /tmp/athena-column-sources \
  --environment /tmp/athena-xdi-runtime/environment.json \
  --output /tmp/athena-xdi-replay
```

Backend tests cover the complete measured tables, column-preview arithmetic,
processing, source downloads, identity precedence, native/web round trips,
case preservation, malformed/inert objects and atomic rejection. Chromium
tests exercise real desktop/mobile plots, metadata, column changes, import,
refresh and PRJ download/reimport **after removing the web sidecar**.
See [terminal results](athena-verification.md) for completed checks.

## File metadata controls and remaining parity work

The UI contract is the pinned
[`UI/Athena/XDI.pm`](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/UI/Athena/XDI.pm)
and [metadata documentation](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/documentation/Athena/other/meta.rst).
The active native controls provide versions, family display, expand/collapse,
required/recommended-field status, individual/all-field validation and **Save
comments**. Field add/edit/delete handlers are commented out in this revision,
despite the separate XDIAddParameter dialog module being present. Their mere
source-file presence does not make them active native requirements. These
active controls are now available through **Group → File metadata…**,
including saved comments independent of group notes. The separate
[controls contract](athena-xdi-controls-reference.md) records actual native
validation, exact comments, freeze/Undo/Redo, conflicts and PRJ revalidation.

The [column-export workflow](athena-data-export-reference.md) now previews
and downloads current, marked and separate files, with actual output-column
definitions and applied processing headers. Import recognizes an XDI
first-line signature independently of the filename extension. Reopening
exported `.xmu`, `.nor` and `.chik` files therefore retains acquisition fields
and comments alongside the column preview and imported values.

The [history contract](athena-xdi-history-reference.md) now provides native
clone observations and operation-chain evidence for accumulated processing
history, preserved comments, acquisition times and native-only PRJ exchange.
Exhaustive XDI validation and all derived/multichannel combinations remain open.
Legacy `xdi_*` argument families still require their own semantic
audit. Full desktop Athena import/edit/save replay remains required; actual
native Perl/C execution here does not claim that GUI coverage. All 107 parity
requirements keep their original IDs and statuses. Artemis remains outside
this work.
