# Saved merge spread: persistent inspection and original plotting rules

**Plot → Saved merge spread…** displays the current merged spectrum with
its saved standard deviation. The group selector can switch to another
merge in the project. The viewer remains available after closing the merge
tool, restarting the backend, refreshing the page, and importing a historical
Athena PRJ. Frozen groups are readable. Viewing never changes the project's
revision, source arrays, recipes, marks or stored scatter.

The two displays are the merged curve with ± standard deviation, and the
merged curve with scaled standard deviation. Normalized merges can switch
between normalization and flattening. Energy merges' scaled-spread view
can display raw, normalized or flattened μ(E); this exposes the energy
normalization state inherited by the original variance plot. χ merges can
use the group's current k weight or a display-only value from zero to four,
including fractional weights. The existing Plotly toolbar provides zoom,
pan, legend toggles and PNG download.

## Scientific and native display contract

The viewer recognizes valid `is_merge=e/n/k` in imported native metadata,
native web merge provenance, and older web merges with explicit population
scatter. It requires a finite, nonnegative, pointwise saved scatter array.
Missing or misaligned arrays produce an error; the viewer does not estimate
scatter from other groups or reinterpret ordinary measurement errors as a
merge. Old population scatter remains labelled as such without adding an
N/(N−1) correction. A group whose current data type contradicts its stored
merge space cannot be displayed as that merge.

The [Athena manual](https://bruceravel.github.io/demeter/documents/Athena/plot/etc.html#special-plots-for-merged-groups)
defines the two spread displays. Executable behavior is pinned to Demeter
`06afc8da08a5a7d5a26ee14992170fcf5dc67406`:

- [Data/Plot.pm](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/Data/Plot.pm)
  supplies `plot`, `stddevplot`, `varianceplot` and base-plot dispatch.
- [Data/Mu.pm](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/Data/Mu.pm)
  chooses the current energy curve; `Data.pm::nsuff` chooses norm or flat.
- [Data/Arrays.pm](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/Data/Arrays.pm)
  supplies the actual `points` arithmetic and point-file writer.
- The seven [gnuplot templates](https://github.com/bruceravel/demeter/tree/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/templates/plot/gnuplot)
  are `newe`, `newk`, `stddeve`, `stddevn`, `stddevk`, `variancee` and `variancek`.

Energy coordinates receive the group's current energy shift. χ coordinates
remain on the **saved raw k grid**; changing transform resampling does not
resample its stored scatter. Normalized displays use the group's current
Larch `norm` or `flat` array, with a grid correspondence check. Athena adds
the saved scatter directly to that processed curve; it does not refit or
propagate the scatter through normalization.

Let M be the group's plot multiplier, O its offset, W=k^weight in χ space
(otherwise one), Y the chosen displayed signal and σ the saved scatter.
Original `Data::points` treats zero scale as one; write S=M or one when M=0.
The native standard-deviation display is:

```
center = S × W × Y + O
upper  = S × W × (Y + σ + O) + O
lower  = S × W × (Y − σ + O) + O
```

The repeated offset in the envelopes is present in the executable source,
even though it can move the envelope away from the central line. The viewer
explains this when O is nonzero; setting O=0 gives a centered envelope.
Negative multipliers retain the native signed curves. A zero multiplier
also receives an explicit native-coercion note.

The native **variance** display is scaled standard deviation, not σ². Its
scale is M×max(raw saved signal)/max(σ)/2, and its curve is that scale times
W×σ plus O. The raw saved signal determines the scale even when the central
energy curve is displayed normalized or flattened. A computed zero scale
again becomes one under native `points`. If all σ values are zero, native
template evaluation fails with division by zero. The web instead displays
zero scatter before O and explains that deliberate recovery.

These are plotting conventions, not uncertainty-propagation formulas.
Plot options never overwrite σ. Nonfinite output from extreme scaling is
reported rather than rendered. New native merges now inherit the first
contributor's plot multiplier and offset, as with native cloning; their
saved mean/scatter arrays remain independent of presentation.

## Persistence and interface checks

`AthenaStore.plot_saved_merge` serves a version-checked read-only result.
The frontend cancels superseded requests, clears obsolete traces immediately,
and rejects responses with mismatched project/group/revision/options, grid
coordinates or invalid curve values. Plot controls remain mounted while a
replacement response loads. Failed reads can be retried without changing
scientific state. Group information supplies the stored multiplier/offset;
local flattening and k-weight choices apply only to this viewer.

Valid imported `is_merge` is now marked as applied when an aligned stddev
array exists. It does not reconstruct missing contributor provenance. Native
PRJ serialization retains the scatter and plot settings; the viewer also
works after every `# Athena-Web` sidecar line has been removed. Existing
historical `.prj` files therefore do not depend on a previous web merge.

The merge creation panel still previews the arrays to be saved and retains
its contributor comparisons. The saved-spread viewer is the native display
of the resulting/current group, including subsequent normalization and plot
settings; those two contexts are described separately.

## Independent execution and fixtures

`backend/tests/reference/merge_plot_native_reference.py` executes unchanged
original `plot`, `_plot_command`, `_plotk_command`, `stddevplot`,
`varianceplot`, `_plotE_command`, `_plotE_string`, `nsuff`, `get_kweight` and
`points`, with real Text::Template rendering and actual point-file output.
Object accessors, plot initialization/hooks and scientific update calls are
bridges. Larch independently prepares norm/flat from measured merged iron
arrays; the full desktop background/normalization update loop and gnuplot
window are not executed by the reference driver.

The oracle contains **46 observations**: raw, normalized/flattened and χ
merges; both plots; positive, negative and zero scales; nonzero offsets;
k weights 0, 1, 1.5, 2, 3 and 4; and zero scatter. Forty-five produce native
point files; the zero-scatter variance observation records the native error.
Comparison uses all written x/y coordinates, relative tolerance 2e-13 and
absolute tolerance 5e-11 to account for Perl's text output precision. No
scientific tolerance was relaxed after a mismatch.

The harness explicitly captures Text::Template's BROKEN callback and isolates
each case's output files. The first harness version allowed a template error
to leave a prior case's point file visible; the zero-scatter regression caught
that invalid reference. The corrected oracle records the actual failure, and
a fresh replay exactly reproduces all observations.

`athena-merge-plot-fixtures.json` pins the driver, oracle, measured merge
source oracle, original Perl/templates and three unmodified historical Larch
repository examples: `AsScorodite.prj` (energy merges), `Fe.prj` (normalized
merges), and `bal3ybco.prj` (χ merges). Backend tests cover restart, frozen
groups, native/web exchange, missing/invalid scatter, stale HTTP revisions,
legacy population semantics and inherited plot settings. Browser tests cover
all three original projects at desktop/mobile sizes, actual rendered arrays,
local plot choices, exact project immutability, refresh, and bare PRJ reimport.

This closes the persistent saved-spread viewing gap, including native display
modifiers for the stated modes. Global derivative/smoothing plot states,
main-plot target routing, all desktop preference lifecycle behavior and an
actual wx/gnuplot GUI round trip remain open. Other PL-13 special plots and
the larger Athena feature list remain requested; no full-parity completion
is asserted. See the dated [verification checkpoint](athena-verification.md).
