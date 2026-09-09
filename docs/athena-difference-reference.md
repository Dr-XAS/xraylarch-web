# Athena difference-tool reference

Reference revision: Demeter `06afc8da08a5a7d5a26ee14992170fcf5dc67406`.
The source hashes and original measured fixture are recorded in
[athena-primary-sources.json](athena-primary-sources.json).
Execution evidence belongs in [athena-verification.md](athena-verification.md).

## Desktop behavior used for the implementation

The [difference panel](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/UI/Athena/Difference.pm)
selects a DATA group and a STANDARD independently of marks. Its six forms are
`xmu`, `norm`, `der`, `nder`, `sec`, and `nsec`. The initial form is normalized,
multiplier is 1, inversion is off, input overlays and integration are on, and
integration bounds are −20/+30 eV relative to DATA E0. Selecting raw mu enables
renormalization; the user can change that choice. It offers current/marked
plots and saved groups, integrated-area sequences, and a k-space view.

The [calculation object](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/Diff.pm)
resolves the normalized form separately for each input: a group's flatten
preference selects `flat` instead of `norm`. Normalized derivative forms remain
distinct from raw derivatives. Its name tokens include DATA, STANDARD, resolved
DATA form, multiplier, both bounds, area and literal percent. Inversion swaps
DATA/STANDARD name tokens. Only area is explicitly formatted to five decimals.

The [Larch template](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/templates/analysis/larch/diff_diff.tmpl)
interpolates DATA onto the full STANDARD grid and evaluates
`(data − multiplier × standard)`, negating the entire result when inverted.
The local Larch `interp` defaults to linear interpolation and extrapolation.
The [Ifeffit template](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/templates/analysis/ifeffit/diff_diff.tmpl)
uses `qinterp`; the webapp does not claim equivalent interpolation to that
alternative engine. It retains the full reference grid and reports the number
of extrapolated DATA points and any integration over extrapolated coverage.

The source integrates a natural cubic spline using up to six Romberg
refinements, stopping when successive diagonal estimates differ by at most
1e−5. The web implementation exposes convergence and iteration count instead
of presenting a nonconverged finite estimate as an exact area.

## Coordinates and saved processing mode

The templates remove the DATA energy shift from an intermediate axis, and
`make_group` adds it back. The webapp keeps the entire calculation, integration,
preview and saved output on physical shifted energy coordinates. Integration
bounds use DATA effective E0, falling back to saved explicit E0 if necessary;
no new absorption edge is inferred from a signed difference. The saved recipe
has energy shift zero to avoid applying calibration twice.

Saving copies the target recipe and identity while clearing live reference and
background-standard links. Raw-form results use `mu`, other forms use `xanes`.
The explicit `is_difference` flag represents the web mode that skips energy
normalization. Choosing renormalization clears that mode and processes the new
group; a processing failure aborts the whole multi-group save. Frozen inputs
can be read without changing them.

Native `is_xmu`/`is_xanes` and `is_nor` are independent. Signed energy exports
set `is_nor` alongside the appropriate type and `is_diff`; native restore
retains those type distinctions. The sidecar also carries an explicit mode
flag and contradictory native/sidecar flags are rejected. This does not make
every historical native difference/type convention equivalent to the web model.

The k preview follows the source's temporary processing workflow: it uses the
target recipe and E0, with normalized input when renormalization is off, and
raw input otherwise. Its error is reported per result without discarding the
valid energy difference or changing source groups. The preview does not create
a saved group or replace the target's Fourier results. Optional DATA/STANDARD
overlays use each original group's cached k grid and saved k-weight, without
applying the difference multiplier, inversion, plot multiplier or offset.
Missing input curves have separate warnings; a shared STANDARD is plotted once.

## Preview and save contract

`POST /projects/{id}/difference/preview` accepts the project version, difference
action, ordered DATA IDs and options with an explicit standard. The response
contains the resolved options, exact arrays, integrals, labels and warnings.
The project is checked again after calculation to reject a concurrent edit.
Preview does not write groups, histories or analyses.

The same request to `/command` recomputes and saves all results under one lock.
The frontend invalidates previews when inputs or the accepted project change;
save submits the accepted preview's version and complete option snapshot.
An empty-options two-group command retains the earlier API behavior for
existing clients, including its chi-domain subtraction. The full energy panel
has six explicit forms and does not treat chi as an energy spectrum.
The energy CSV exports the exact energy-domain difference and input overlays;
the JSON report also includes the resolved options, integration diagnostics,
warnings and any k-preview arrays.

## Measured fixture and remaining limits

The original [difference recipe](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/examples/recipes/Difference/diff.pl)
uses record 1 as standard and records 6, 9, 12, 15, 18 and 21 as DATA from
`diff.prj`. Its 21 measured platinum spectra each contain 161 samples. The
downloaded [fixture](../backend/tests/fixtures/demeter-diff.prj) matches the
pinned Git blob byte for byte. This is measured-data evidence, not an executed
Demeter/Ifeffit numerical oracle.

The untouched native project currently imports with retained raw data and
processing errors because its saved Kaiser background window has zero taper
width. The subsequent [native normalization checkpoint](athena-native-normalization-reference.md)
corrects `bkg_nnorm` order-to-degree conversion and ignores obsolete `bkg_fnorm`.
Saved spline/FT endpoints also slightly exceed coverage under local Larch
constants. A comparison using independently specified Larch normalization must
state that recipe, rather than claiming untouched native processing passed.

Integration bounds must lie within the full STANDARD spline grid; the webapp
does not extrapolate the integration spline past its endpoints. Disabled
integration reports no area, and `%a` becomes `n/a` rather than a stale prior
value. Labels are limited to 200 characters with a visible truncation warning.
Full desktop parity, historical native preferences, exact Ifeffit numerics and
general downstream provenance remapping remain open.
