# Athena parameter Excel reports

**Edit → Excel report on all groups… / Excel report on marked groups…** now
opens a section-based preview and downloads the complete 28-column `.xls`
report. The [backend](../backend/xraylarch_web/athena_report.py) uses xlwt to
write genuine BIFF8 XLS bytes. The [dialog](../frontend/components/athena-parameter-report.tsx)
preserves scope during preview/download errors and requires a confirmed
project revision, filename and XLS signature before saving the attachment.
The XLS format is an explicit native requirement; the bundled artifact
runtime exposes XLSX authoring, so xlwt provides the XLS capability in the
application. Artifact Tool is used for verification of a temporary
LibreOffice-converted copy, not as an application runtime dependency.

The enabled Athena report workflow is **Edit → Export → Excel report on all
groups / Excel report on marked groups**. The
[manual](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/documentation/Athena/output/report.rst)
describes parameter spreadsheets separately from numerical column files.
The actual implementation is `Report`, `header` and `row` in
[`UI/Athena/Group.pm`](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/UI/Athena/Group.pm),
verified against the pinned Git tree and recorded in the source catalog.
These parameter spreadsheets are separate from numerical column exports.

The native implementation writes an `.xls` workbook using
`Spreadsheet::WriteExcel`, with one worksheet. It iterates the group list in
order and tests marks only when the requested scope is marked. It does not
filter on frozen state or the active group. Rows start at worksheet row 8;
row 7 contains labels and row 6 groups related parameters into sections.
Four spacer columns divide 28 populated parameter columns across A–AF.

| Section | Populated columns in native order | Native value source |
| --- | --- | --- |
| Identity | Group, Element, Edge, Importance, Edge shift | name, get_name(bkg_z), fft_edge, importance, bkg_eshift |
| Background removal | E0, Algorithm, Rbkg, k-weight, Normalization order, Pre-edge range, Normalization range, Spline range (k), Spline range (E), Edge step, Standard, Lower clamp, Upper clamp | bkg_e0, bkg_algorithm, bkg_rbkg, bkg_kw, bkg_nnorm, bkg_pre1/2, bkg_nor1/2, bkg_spl1/2, bkg_spl1e/2e, bkg_step, standard name or None, number2clamp(bkg_clamp1/2) |
| Forward transform | k-range, dk, Window, Arb. kw, Phase correction | fft_kmin/max, fft_dk, fft_kwindow, fit_karb_value, yesno(fft_pc) |
| Reverse transform | R-range, dR, Window | bft_rmin/max, bft_dr, bft_rwindow |
| Plotting | Plot multiplier, y offset | plot_multiplier, y_offset |

Native ranges are text formatted to three decimal places. Scalar numeric
cells use general, three-decimal or scientific display formats; the writer
receives the scalar value, not a pre-rounded string. The title includes
Athena identity, creation time and environment information across merged
cells. A web report must identify the actual application/runtime and retain
numeric cell types. It must use applied values and explicitly distinguish
unavailable processing from zero, especially for chi and detector groups.

## Applied and retained parameter values

Applied Larch values take precedence over saved control values; unapplied UI
drafts do not enter the report. Inactive settings remain visible with an
applicability note, and unavailable/invalid values become the text `n.a.`,
not numeric zero. Processing failures do not prevent a report of saved
settings. A saved explicit edge step remains available even when processing
failed. The report does not refit data or change the project.

- Importance retains a finite native value, including zero, and defaults to
  Athena's 1 when none was imported.
- Normalization order is the number of terms: applied polynomial degree + 1.
  Already-normalized input is identified as not fitted.
- Algorithm reports AUTOBK when it actually ran. Phase correction reports
  `no`, reflecting the current transforms rather than a dormant native flag.
- The standard column resolves the current linked group's label against the
  entire project, including a standard outside the report selection.
- Arbitrary weight uses the retained native `fit_karb_value`; absent a
  separate value, it uses the applied FT weight and explains the fallback.
- Clamp names follow the native nearest-level conversion with default
  values 0/3/6/12/24/96. Custom numeric strengths remain in parentheses so
  conversion to a descriptive level does not erase the actual setting.
- Element names match all 118 names from native Chemistry::Elements 1.081,
  including its `Aluminium` spelling. Explicit absorber/edge identity is used.
- Pure chi can retain its native E0 as an energy origin, explicitly distinct
  from an edge found by processing chi. Detector/difference groups identify
  their inactive absorption/transform settings.

The workbook keeps native columns A–AF, the four spacer columns and the row-7
column labels. Native number formats preserve underlying precision. The web
version adds usable column widths, wrapped headers, frozen top seven rows and
first column, and applicability notes below the data. Formula-like group names
are literal text. The title identifies the real application, runtime and
project revision. There is one Parameters worksheet, with no invented summary
or recalculation formulas. All selected groups, including frozen ones, remain
in project list order. Empty marks produce a recoverable choice instead of
an apparently successful empty report.

## Executed native reference and verification

`backend/tests/reference/parameter_report_native_reference.py` executes the
unchanged pinned `Report`, `header`, `row` and `number2clamp` source bodies.
The real Spreadsheet::WriteExcel 2.40 writes both all/marked XLS files; real
Chemistry::Elements provides names. Constructed accessors supply the data,
clock, GUI group list and boolean helper. File paths are supplied explicitly,
so the file-picker branch is not executed. This is native report execution,
not a desktop GUI or full processing oracle. No uploaded project code is
evaluated.

An independent xlrd reader records all labels, 140 populated data cells and
their types/formats across the two scopes, merged ranges, 13 clamp cases and
all 118 element names. Default replay verifies the complete record. Source,
harness, oracle, actual loaded native module and downloaded package hashes
are recorded in `backend/tests/fixtures/athena-parameter-report-fixtures.json`.
The native Perl dependencies were extracted under `/tmp/athena-report-runtime`
without installing system packages. The existing XDI runtime supplies Perl.

```bash
PYTHONPATH=backend backend/.venv/bin/python backend/tests/reference/parameter_report_native_reference.py \
  --sources /tmp/athena-column-sources \
  --environment /tmp/athena-xdi-runtime/environment.json \
  --perl-lib /tmp/athena-report-runtime/root/usr/share/perl5 \
  --output /tmp/athena-report-native-replay
```

Backend tests compare the web XLS cells with those executed native files and
cover measured Cu, normalized/XANES input, native JSON/difference/detector PRJ
imports, frozen groups, missing settings, exact numeric precision and
revision checks before/after file generation. Desktop/mobile browser tests
download real all/marked XLS files and independently read every parameter,
including a real conflict and successful reload recovery. LibreOffice opened
the actual downloaded XLS; an XLSX verification copy was imported into
Artifact Tool for inspection and visual review of all five sections and
notes. The exported product remains XLS. Counts and logs are in the
[verification record](athena-verification.md).

Customized native clamp-preference tables, every desktop processing algorithm
and GUI file-picker execution still need full-platform parity work. Those
remaining requirements are not established by the report's static workbook
comparisons or its successful browser download.

The adjacent empirical fitting-standard menu belongs to the explicitly
deferred Artemis work. It remains recorded in the original IO-09 requirement
without adding an Artemis implementation. All 107 requirement IDs, order
and statuses are retained.
