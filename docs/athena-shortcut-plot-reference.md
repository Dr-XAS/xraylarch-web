# Athena shortcut plots

The **Plot shortcuts…** dialog computes its seven single-panel comparisons in
the backend from saved Larch arrays. Quad and Bi-Quad use the shared
[diagnostic implementation](athena-diagnostic-plot-reference.md). Viewing a
plot, selecting a component, hiding a curve or exporting an SVG does not save
a project revision.

## Curves and scaling

Let s be the saved group multiplier, o its offset, N its normalized data,
F its flattened data, D the derivative of the unflattened normalized data,
and Δμ its processed edge step. A normalized shortcut chooses F when that
group's **Flatten normalized data** setting is enabled and N otherwise.
Native Data::points interprets a literal zero multiplier as one, including
a comparison multiplier rounded to zero. The server reports both the
requested and effective multiplier.

| Shortcut | Membership and calculation |
| --- | --- |
| Normalized μ(E) + derivative | Current group: s × (F or N) + o, followed by D × round(0.5 / max(abs(D)), 3) + o. Default energy range is E₀ − 30 to E₀ + 70 eV. The derivative multiplier replaces s. |
| Data + I₀ + signal | Current raw μ(E), I₀ and signal, with their captured detector factors and saved group multiplier/offset. A missing or unusable detector channel is reported individually. |
| Marked I₀ | Retained raw I₀ in source units, with each group's saved multiplier/offset. It does not use the detector-comparison factor. |
| Marked normalized data × edge step | (F or N) × Δμ + o for every marked eligible group. Edge step replaces the saved group multiplier. |
| Marked E − E₀ | Each group's own shifted energy minus its processed E₀. Raw display uses μ(E); other energy modes choose F/N. Native dispatch switches derivatives off for this shortcut. |
| k-space weights 1, 2, 3 | Scale kχ and k³χ to the signed maximum of k²χ, rounding each scale to three decimals. Offsets are +1.2 × max(k²χ), zero and −1.2 × max(k²χ). Saved group multipliers/offsets are replaced. |
| R-space weights 1, 2, 3 | Recalculate Larch transforms at each weight. Scale weights 1/3 by the ratio of full-array magnitude maxima to weight 2, rounded to three decimals. Offsets are +max(abs(χ₂(R))), zero and its negative. Magnitude, real, imaginary and phase displays use the same magnitude-derived factors. |

Marked shortcuts use all persisted marks in project order, including groups
hidden by the list search. Their existing **Stack offset** adds index × stack
offset to the native group offset; this is a web display option. A skipped
group keeps its position in that index. Backend checks require the exact
ordered marked selection and reject outdated revisions before and after
calculation. Frozen source groups can be viewed.

## Detector state and project exchange

Raw-column imports calculate comparison factors from
abs(max(μ(E))) / max(channel). They are captured in
source.detector_plot_scales so later point removal does not silently
recompute the import-time display factor. Legacy groups without captured
factors resolve them when first viewed; their old project history is not
reconstructed.

There are two different native project rules:

- Original Demeter Data::Prj::_record recalculates legacy Perl PRJ factors as
  **signed** max(μ(E)) / max(channel), overwriting saved scale arguments.
  Legacy PRJ import follows that rule. An all-negative spectrum can therefore
  change the sign of its detector comparison after native-only exchange.
- Serialized JSON Data state can retain its saved detector factors. The web
  reader uses valid saved factors for that format.

A web JSON round trip or a PRJ round trip with its web sidecar retains the
captured factors exactly. Native-only PRJ import follows the legacy rule.
PRJ export writes nonempty channel expressions for aligned detector arrays
so native plotting and serialization can find them; those expressions are
metadata and are not executed by the web backend. Zero-maximum channels
without a usable saved factor remain importable and are reported as
unavailable in scaled detector comparisons.

The first full regression run exposed convolution code that relied on
make_group sharing the caller's mutable source dictionary. The constructor
now copies source metadata to preserve import ownership. Convolution writes
its noise seed, noise standard deviation, edge step and XDI history into the
new group's own source after construction.

## Display and export

Curve labels wrap outside the plot so long group names and scale factors
remain readable on narrow screens. Each legend button shows or hides its
curve, with an accessible pressed state. **Download shortcut SVG** includes
the visible curves, their complete labels and current plot ranges. Export
uses a separate Plotly figure with a wide legend column; it does not resize
or mutate the displayed plot. The matching-version
[Plotly export API](https://github.com/plotly/plotly.js/blob/v3.1.0/src/plot_api/to_image.js)
accepts a data/layout object for this purpose.

## Executed reference and remaining boundaries

The pinned native revision is
06afc8da08a5a7d5a26ee14992170fcf5dc67406. Source identities are in
[the source catalog](athena-primary-sources.json). The
[reference driver](../backend/tests/reference/shortcut_plot_native_reference.py)
runs unchanged Data::plot, plot_ed, plotk123, plotR123, the three marked
Athena UI handlers, their gnuplot templates and Data::points through Perl and
Text::Template. Original k123 process expressions are evaluated separately
against independently prepared measured Fe .060/.061 data.

The 66 observations cover Flatten on/off, positive/negative/zero group
scales, nonzero offsets, different shifts, both E₀-at-zero energy forms, and
all four R components. Point-file comparisons use rtol=3e-13, atol=5e-11;
the recorded reference also replays exactly. The
[fixture manifest](../backend/tests/fixtures/athena-shortcut-plot-fixtures.json)
pins the oracle, reference drivers and two measured source files.
[Backend tests](../backend/tests/test_athena_plot_shortcuts.py) additionally
exercise zero/invalid channels, rounded-zero scales, signed maxima,
read-only frozen projects, invalid selections, revision conflicts,
restart, web/native project exchange and concurrent edits.
[Browser tests](../frontend/tests/e2e/athena-plot-shortcuts.spec.ts) use the
original Fe.prj plus measured detector data, desktop/mobile viewports,
exact server-to-Plotly arrays, real downloads and reimport.

Accessors, Wx controls, plot preferences and processing updates are bridges.
The I₀/signal menu's flag setup is supplied to the unchanged energy plotting
method. The original columns/larch template has inconsistent indentation;
its factor expressions are inspected, not claimed as an executed original
column-import pipeline. Legacy PRJ scale initialization is source-backed;
the full native project reader is not executed by this reference driver.
Phase input is independently prepared as unwrapped complex phase; the
native processing state machine is not part of the point-writer comparison.

The reference records the normalized/derivative method's E₀-marker request,
but marker rendering remains open. Global smoothing/secondary-derivative
flags, custom native plot preferences and ranges, R envelopes and phase
derivatives, transform-window overlays, XKCD rendering and full native
Wx/gnuplot acceptance remain open under the original parity matrix. The
guarded web view reports undefined zero-maximum comparisons rather than
returning a partially generated native plot. This work does not establish
complete Athena parity.
