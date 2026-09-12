# Athena energy alignment: original Larch execution and web workflow

The alignment panel now provides a fixed standard, four live displays,
manual total shifts and the eight native ±5/±1/±0.5/±0.1 eV buttons,
raw/smoothed derivative fitting, marked-group processing, paired reference
channels, shift uncertainty and an inspectable fit/residual plot. Previewing
is read-only; Save alignment applies the reviewed settings with a project
revision check. Cancel discards the proposal. Undo/Redo includes the linked
groups, recalculated results and uncertainty metadata.

## Original behavior and deliberate boundaries

Primary sources are pinned to Demeter
`06afc8da08a5a7d5a26ee14992170fcf5dc67406`:

- [Align.pm](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/UI/Athena/Align.pm)
  defines plot/fit choices, manual controls, marked dispatch and readouts.
- [Larch alignment template](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/templates/process/larch/align.tmpl)
  supplies the actual derivative fit.
- [Data/E0.pm](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/Data/E0.pm)
  rounds the fitted shift and uncertainty to three decimals, updates linked
  references, and leaves E0 unchanged.
- [Config.pm](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/Config.pm)
  and `configuration/process.demeter_conf` determine effective SG settings.
- The [native example](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/examples/tests/align.pl)
  aligns iron foil at 60 K and 300 K. Its later explicit `e0` call is a
  separate operation, which the web alignment must not perform implicitly.

The [manual](https://bruceravel.github.io/demeter/documents/Athena/process/align.html)
describes a −50/+100 eV fit interval and repeated three-point smoothing.
The executable **Larch** template instead uses the half-open interval
`[standard E0−20, standard E0+50)`. Moving μ is interpolated onto the shifted
standard grid **before** calculating `deriv(mu)/deriv(energy)`. The unbounded
least-squares parameters are an absolute shift and a derivative amplitude
scale, starting at the difference of E0 values and scale 1. The amplitude
scale is a fit parameter only; measured μ is never rescaled.

With smoothing enabled the template applies one Larch Savitzky–Golay pass.
The declared order 4 is clamped to **9** by original Config methods; effective
factory fit settings are **31 points/order 9**. The panel and import
preprocessing now share this engine and capture the current SG preferences.
Reviewed explicit settings survive a later preference change. Native plotting
temporarily requests 21/4, which Config similarly resolves to **21/9**;
display smoothing is independent of fit preferences. Even/small windows follow
the template and Larch's subsequent window/order repair.

Automatic shifts are saved to 0.001 eV. Manual shifts retain the entered
precision, matching native direct assignment. Each energy group's resolved E0
is preserved, including distinct E0 values in a linked family. If a stored E0
was automatic, its current resolved value becomes explicit so recalculation
does not move it. Calibration and **Set E0** remain separate actions.

When both selected spectra have explicit reference channels, the reference
curves supply the fit and the family receives the resulting shift. If either
reference is absent, both selected sample curves are used. This avoids the
pinned Perl `and` assignment-precedence bug in `align_with_reference`, which
can select an absent moving reference. Import-time MED shift sharing and its
existing E0/copy policy remain documented in the
[preprocessing contract](athena-import-preprocessing-reference.md).

The standard and its linked family stay fixed. Frozen families, frozen
background consumers, duplicate selected families and targets whose background
dependents include the fixed standard cannot silently change it. A batch
reports skipped reasons; a single invalid target fails without saving. Failed
normalization/background recalculation is visible in the preview while the
reviewed raw energy shift can still be saved, as for calibration.

## Exchange and uncertainty

`source.alignment` retains the fit summary and a SHA-256 signature of measured
energy/μ, plus the applied shift. Stale records are not displayed as a valid
fit after raw-data or shift edits. Manual alignment clears uncertainty. The
native `bkg_delta_eshift` field carries the rounded error in `.prj` files;
import reconstructs a usable uncertainty record even with every web sidecar
line removed. The web sidecar also retains full precision, scale and
provenance. A bare native file cannot recover a derivative scale that Athena
did not serialize. Native invalid uncertainty remains inert metadata with a
notice. Fit arrays are transient preview output, not bulky source metadata.

## Independent evidence

`backend/tests/reference/alignment_native_reference.py` executes original
Perl Config parser/default methods, renders the unmodified alignment template
through Text::Template, runs it in a real Larch interpreter, and sends fitted
scalars back through the original `Data::align` method. Data access, reference
shift triggers and Perl/Larch scalar transport are explicit bridges; this is
not a full wx Athena session. The display override is checked by executing
the original Config setters/getters with the values from Align::plot; the
whole Align::plot method is not replayed by this driver.

The checked-in oracle contains **31 cases**: both directions of the original
60 K/300 K measured Fe pair; measured Cu and Fe with known shifts/gains, with
and without deterministic added noise; raw and smoothed fits; and alternative
SG windows/orders. The unmodified iron files were downloaded from the pinned
Demeter example directory and verified against Git blob SHA-1 and SHA-256.
Their SHA-256 values are:

- `demeter-fe.060.xmu`: `2484a64ae71299c17a530a9ad191a49510b53e8515279dfc8163bf56221a1c80`
- `demeter-fe.300.xmu`: `495d5a23c27be69391473bb6aa17b854f7beda04c812e82ec67f74ba3afa9815`

Tests compare the entire fit residual, fitted/rounded shifts, amplitude scale,
uncertainty, chi-square and reduced chi-square. Relative tolerance is 2e−8;
absolute tolerance is 2e−11 for fitted statistics and 1e−10 for residuals.
One exactly translated Cu case takes a slightly different LM termination path
near zero residual (maximum difference 2.93e−11); nonzero measured/noisy fits
are also compared. Original rounding and per-reference E0 behavior are checked
exactly. Source/driver/input/kernel/oracle hashes are recorded in
`athena-alignment-fixtures.json`. Recording and independent replay both pass.

Backend tests also exercise all four displays and both fit choices through
preview/save, unchanged measurements and standard, distinct linked E0 values,
freeze/duplicate/dependency handling, two-reference selection and fallback,
captured preferences, stale metadata, version conflicts, invalid options,
Undo/Redo, and native project exchange with/without the web sidecar. Component
tests reject stale/malformed previews and unexpected save responses. Actual
desktop/mobile browser tests import measured Cu and a translated/gained copy,
check every column-preview coordinate, compare rendered alignment traces with
server output, cancel manual changes, fit/save/undo/redo, and reimport a bare
native project including its uncertainty.

The old API without `options.method` retains its earlier custom alignment
contract for existing clients. The new panel always uses `demeter-larch`.
The original main-panel uncertainty context menu, complete native GUI/state
dispatch, every parameter/plot modifier interaction and the broader full
Athena acceptance matrix remain open. Neither the Ifeffit fit algorithm nor
Artemis is claimed here. PR-02 and PR-03 keep their original Pending statuses.
