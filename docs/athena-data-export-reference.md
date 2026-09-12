# Athena column-data export and native reference

**File → Export column data…** exports the current group, combines marked
groups into one table, or downloads a ZIP containing one file per marked
group. The dialog previews the actual columns, first five rows, full header
and any interpolation notices before downloading. It uses applied processing
parameters; unapplied parameter drafts must be applied first. The earlier
plot-space CSV export remains available separately.

The implementation is in
[`athena_export.py`](../backend/xraylarch_web/athena_export.py) and
[`athena-data-export.tsx`](../frontend/components/athena-data-export.tsx).
Actual Larch `write_ascii` formats every numerical column file. The verified
subset and remaining native comparisons are distinguished below; this is
not a claim of complete Athena parity.

The baseline is Demeter revision
`06afc8da08a5a7d5a26ee14992170fcf5dc67406`. The native
[column-file guide](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/documentation/Athena/output/column.rst),
[actual menus](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/UI/Athena.pm),
[UI save handlers](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/UI/Athena/IO.pm),
Data/IO.pm, Data/XDI.pm and the Larch save templates are recorded with source
and Git blob hashes in the [catalog](athena-primary-sources.json).

## Full enabled output surface

| Workflow | Native requirements |
| --- | --- |
| Current group | Separate mu(E), norm(E), chi(k), chi(R) and chi(q) files. File names derive from the group label, using .xmu, .nor, .chik, .chir and .chiq. |
| chi(k) options | `file.chik_out` defaults to all weights; alternatives are 0, 1, 2, 3 or the group's arbitrary weight (`kw`). The arbitrary output weight is read from fit_karb_value, not inferred from another control. |
| Marked groups, one table | Nineteen selectors: xmu, norm, der, nder, sec, nsec; chi and k weights 1/2/3; R real/imaginary/magnitude/phase and phase derivative; q real/imaginary/magnitude/phase. The phase-derivative menu is conditional on show_dphase. |
| Marked selection | Preserve list order, even when the active group differs. Empty marks produce a recoverable cancellation. First marked group supplies the common abscissa. Raw-mu and derivative outputs offer plot multipliers. |
| Separate marked files | Same five formats as current-group export, one file per marked group in list order. Browser packaging must retain distinct names when native label sanitization produces collisions. |
| Header and comments | XDI version/application identity, acquisition metadata, current Element fields, Column fields that describe the actual output, Athena processing parameters and saved XDI comments. Output Column fields temporarily replace acquisition Column fields and are then restored in the native object. |
| Parameter reports | All-group and marked-group spreadsheet reports remain separate work from numerical column files. Their parameter scope is specified by the native report workflow. |

This is Athena scope. Reading shared source containing fit/Artemis branches
does not include those branches in the implementation.

## Implemented numerical and metadata contracts

The [Data/IO.pm](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/Data/IO.pm)
column dictionaries and actual templates distinguish these products:

| Format | Required numeric products |
| --- | --- |
| mu(E) | Shifted energy, original absorption, background, pre/post-edge curves, first/second absorption derivatives and I0 when supplied. XANES requires zero background. |
| norm(E) | Shifted energy, normalized absorption/background, flattened absorption/background and first/second normalized derivatives. XANES requires zero background products. |
| chi(k), all | k, unweighted chi, k/ k²/ k³ weighted chi, forward window and absolute energy. The pinned template computes energy using E0 + k² / 0.2624682917. |
| chi(k), selected weight | Two columns: k and chi times k to the selected weight. |
| chi(R) | R, real/imaginary/magnitude/phase, reverse window and phase derivative. The actual template includes the derivative even though the guide's list stops at the window. |
| chi(q) | q, real/imaginary/magnitude/phase, forward window and chi weighted with the FT weight. Grids and lengths must be checked explicitly. |

Raw-mu and normalized derivatives are calculated separately with Larch
`deriv(y) / deriv(energy)`, repeated for second derivatives. The backend's
`dmude` and `d2mude` describe **unflattened normalized** mu and are not relabeled
as raw derivatives. Retained I0 is included only with a matching energy
length; stale detector arrays cause a recoverable export error.

Executed native templates establish normalized background as
`(bkg - pre_edge) / edge_step + y_offset`, flattened background as
`(bkg - pre_edge) / edge_step + flat - norm`, and the R-phase derivative scaled
to the maximum R magnitude. A constant phase exports a zero derivative.
XANES background columns are zero with matching column labels. A norm(E) file
contains both normalized and flattened curves even when the plot's flatten
option is off: the latter is reconstructed from saved pre/post-edge curves
without refitting or changing the project. Normalized-input backgrounds
follow the native `is_nor` template.

For marked energy output, each group's applied flatten flag chooses its
normalization. Larch linearly interpolates onto the first marked energy grid,
preserving project list order independently of the active group. The actual
native interpolation template also extrapolates at the endpoints despite its
`fill_value=0` argument; the web preview and file explicitly count those
points. Optional plot multipliers apply to marked raw mu and raw derivatives.
Marked k/R/q outputs require matching grids; the dialog directs incompatible
groups to separate files or matching transform settings.

The selected arbitrary k weight defaults to each group's retained native
`fit_karb_value`, falling back to its applied FT weight when no separate
native value exists. **Use a shared output weight** supplies an explicit
override from 0 through 4, including fractional values. Export does not change
transform settings. The all-weight and marked k files include absolute
energy when the group's E0 is known. An imported pure-chi group can use a
valid retained native `bkg_e0`; if it has no energy origin, the energy column
is omitted with a notice. Detector groups export their raw signal and any
aligned I0 without invented absorption products.

Import identifies XDI by its first-line signature as well as its `.xdi`
extension. Reopening `.xmu`, `.nor` or `.chik` output retains acquisition
metadata, processing fields and comments in the column editor and saved
group. Numerical preview/import comparisons cover all three formats;
normalized-file imports explicitly select the normalized data type.

Current q files preserve every saved filtered q value. The input-only window
and weighted-chi columns are interpolated onto q and zero-padded outside
measured k support, with a file/preview notice. This handles the extra q point
that can be produced by the reverse transform without dropping data.

Native data headers are generated with
`templates/report/standard/data_report.tmpl`. This includes effective E0,
energy shift, normalization fit/ranges, AUTOBK and FT settings, and plot
multiplier/offset. Historical native quirks include two Athena.window entries
and a hardcoded standard value. Header generation must report actual web
processing, preserve acquisition metadata and identify the real application
version; it must not claim the file was produced by desktop Athena.

The web header identifies XrayLarch and the actual Larch version. Current and
separate files retain acquisition fields and extension-family casing,
replace acquisition Column definitions with the actual output columns, and
include current absorber/edge, saved XDI comments and independent group notes.
Processing headers report effective ranges, fixed-step state, applied
normalization/background/transform settings, distinct forward/reverse
windows, actual background-standard identity and plot scale/offset. Equations
for the saved pre/post-edge curves are expressed as polynomials centered at
E0. These coefficients describe saved curves, not a new fit to raw absorption.
Combined marked files retain the first group's Element fields and each
group's processing settings/comments; they do not merge acquisition fields
from different measurements into one acquisition identity.

Export is read-only, including frozen groups. Both preview and download
check the project revision before and after preparation. The browser requires
the same confirmed revision and attachment filename before saving bytes;
cross-window changes require reloading the project. All files are prepared
and validated before any attachment is returned. Exports are limited to two
million numeric values per request. ZIP names derive from labels, with safe
path handling and case-insensitive collision suffixes, including reserved
Windows names.

## Actual template execution

`backend/tests/reference/export_templates_native_reference.py` loads the
unchanged pinned templates with real Perl Text::Template 1.61 using the same
substitution mechanism and whitespace cleanup as Demeter. Object accessors
and distinct nine-point arrays are explicit constructed probes. The rendered
commands then run through the actual repository Larch Interpreter and
write_ascii, recording every numeric output value, label/header and error
class. A further five product cases execute the unchanged derivative, phase,
post-background, flattening and interpolation templates against explicit
input arrays. It does not execute Athena's entire GUI, end-to-end
preprocessing, report generator or selection controller.

The original thirty-six observations cover every marked selector, all current template
families, five selected k weights, I0 presence, missing XANES background and
unequal marked k grids. There are **28 error-free table writes and 8 execution
error cases**, with **2 of those error cases still writing files**. The
recorded errors describe native behavior; they are not passing web feature
tests. Including the five numerical-product cases, the reference now contains
**41 observations**. Default replay compares every recorded product as well
as table values, labels, headers and errors.

- All five selected-weight commands fail with SyntaxError in the pinned
  save_chikw template. The rendered write_ascii call lacks a separating comma;
  the preceding weighted-array assignment also has a trailing comma.
- XANES mu templates write seven/eight numeric columns with only six/seven
  labels when a background array exists. They set nbkg to zero but export bkg.
  When bkg is absent, AttributeError is reported, yet Larch writes a two-column
  file with None header entries. Successful file creation alone is therefore
  insufficient evidence.
- The XANES norm template writes seven numeric columns and only five labels.
  Its background arrays are zeroed as intended.
- Unequal marked k array lengths report ValueError with the current Larch
  writer. The equal-grid cases do not establish interpolation behavior.
- Marked dph output has an empty descriptive file-type suffix because its
  header translation table omits that selector. Numeric dph columns still
  write successfully in the constructed probe.

These observations guide repairs needed to fulfill the documented workflows.
Reproducing broken syntax or mislabeled values is not feature completion.
Backend regressions now cover all five current formats using measured Cu/Fe
XDI and legacy X11A Cu acquisitions, all nineteen marked selectors, every
selected k weight, unavailable data products, headers/comments, filename
collisions, grid handling and revision conflicts. Browser tests exercise
real download/reimport of all 408 Cu absorption values, marked-table output,
mobile ZIP extraction and every fractional-weight value, plus stale-revision
recovery. These compare the explicitly tested products; a complete desktop
GUI round trip and every native data-type/processing-history combination
remain unverified. All/marked parameter spreadsheets are now available as a
[separate Excel-report workflow](athena-parameter-report-reference.md). No Artemis
implementation is included.

## Replay

The dependency was downloaded as Ubuntu's `libtext-template-perl_1.61-1_all.deb`,
SHA-256 `8473881900e54a4b75f270e7a6d265fbbbb97ad535fede97ee801fa07886060f`,
verified against package metadata and extracted under `/tmp/athena-export-runtime`.
It was not installed into the system. The previous native XDI runtime supplies
Perl. Fixture, harness, template module and local Larch writer checksums are
recorded in `backend/tests/fixtures/athena-export-fixtures.json`.

```bash
PYTHONPATH=backend backend/.venv/bin/python backend/tests/reference/export_templates_native_reference.py \
  --sources /tmp/athena-column-sources \
  --environment /tmp/athena-xdi-runtime/environment.json \
  --text-template-lib /tmp/athena-export-runtime/root/usr/share/perl5 \
  --output /tmp/athena-export-template-replay
```

Default replay compares the complete record with
`athena-export-templates-native.json`. Expanded recording/replay logs are
`/tmp/athena-export-products-native.log` and
`/tmp/athena-export-products-replay.log`. The source catalog now has 234 unique
identities. The [verification record](athena-verification.md) reports complete
and focused checks. All 107 parity requirement IDs/order/statuses remain
unchanged; the evidence above records progress within their full scope.
