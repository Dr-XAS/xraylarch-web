# Athena merging: native arithmetic and reviewable results

**Process → Merge marked groups** previews μ(E), normalized μ(E), or χ(k)
from the marked groups in project order. Importance, edge-step and native
noise weighting are available. The panel shows the actual contributors,
normalized weights, excluded short scans and three plots: mean ± standard
deviation, scaled standard deviation, and mean with its input scans. Save
creates new groups and leaves the original spectra unchanged. The result
panel remains open so the spread and input curves can still be compared.
Ctrl/Command+Shift+M, N and C open the respective merge spaces; shortcuts do
not intercept text editing or another open dialog.

## Native calculation contract

Sources are pinned to Demeter `06afc8da08a5a7d5a26ee14992170fcf5dc67406`:

- [Data/Process.pm](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/Data/Process.pm)
  supplies `merge`, `mergeE` and `mergek` dispatch, exclusions and weights.
- [Larch process templates](https://github.com/bruceravel/demeter/tree/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/templates/process/larch)
  supply the grid, interpolation, mean, scatter and noise-estimation commands.
- [Process preferences](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/configuration/process.demeter_conf)
  default to importance, exclusion enabled, a ten-point margin, and metadata
  copying. Each group's importance defaults to one.
- [Athena.pm](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/UI/Athena.pm)
  supplies selection, reference dispatch, labels and shortcuts.
- [Plot.pm](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/Data/Plot.pm)
  and the gnuplot `stddev*`/`variance*` templates define spread displays.

The short-scan rule compares point counts with the **first marked scan**,
using energy for μ/norm and k for χ. A difference of ten points is retained
with the default margin; eleven is excluded. Filtering occurs before weight
normalization. At least two contributors must remain. Zero individual
weights are allowed, but their sum must be finite and positive.

Energy bounds are the intersection of the **raw, unshifted** energy extents.
The output grid is the first contributor's shifted energy sliced at
`index_of(raw_min):index_of(raw_max)`; the upper endpoint is excluded.
Each shifted input is interpolated onto that grid using Larch's `interp`.
Despite the template's `fill_value=0`, this Larch routine performs linear
extrapolation outside an input's measured range. The web calculation retains
this behavior and reports the number of extrapolated points. Completely
disjoint raw or shifted ranges and grids shorter than eight points fail
without saving. Normalized merging uses `norm`, not `flat`.

For normalized coefficients cᵢ and N retained scans, the native arrays are:

```
mean  = Σ cᵢ yᵢ
sigma = sqrt(N / (N - 1) × Σ cᵢ (yᵢ - mean)²)
```

This is the native scatter formula even for unequal or zero weights. It
describes differences between the scans and is not a propagated detector
uncertainty, standard error of the mean, or a general unbiased weighted
variance estimator. The plot labelled **Variance** follows Athena's display
convention: it draws sigma scaled by `max(mean) / max(sigma) / 2`, not sigma².
Zero scatter produces a zero spread curve.

The [user manual](https://bruceravel.github.io/demeter/documents/Athena/process/merge.html)
describes lower weight for noisier data. The executable pinned source uses
**εk directly**, so larger noise receives more weight. The UI explicitly
labels this native mode and explains the discrepancy. It executes Larch
`estimate_noise` with the original `chi_noise` template arguments. That
template passes `window`, which goes through `**kws`; effective `kwindow`
therefore remains Larch's default Kaiser. εk is rounded to four significant
figures, matching `Data::chi_noise`. Invalid noise estimates are reported;
no inverse-noise replacement or arbitrary fallback weight is invented.

New groups retain the first contributing group's processing settings and
resolved E₀, with energy shift zero. Energy merges are μ(E) groups; χ merges
are χ groups. Normalized-input identity follows the first input's flag,
matching cloning in the original process method. Reprocessing can therefore
normalize a merged `norm` array again. The preview displays the actual array
being saved, and reports any subsequent processing error visibly.

## References, preferences and project exchange

For energy merges, reference merging requires every **retained sample** to
have an explicit linked reference. Distinct references are collected in
sample order, then independently filtered and weighted with their own
importance/step/noise values. Two distinct reference contributors must remain
to calculate scatter. Missing or shared single references produce a visible
note. Successful output has reciprocal sample/reference links; only the new
sample is marked. χ merging creates no reference output.

This follows the documented all-reference energy-domain rule. The pinned
Athena UI instead gates on the first sample and can merge a partial reference
subset, including for χ. The web does not reproduce that inconsistent UI
dispatch. Tests use both absent references and fully linked families; a
reference excluded by short-scan filtering is not silently included later.

Save merge defaults persists weighting, exclusion/margin, display, metadata
copying and reference merging independently of any project. Reload saved
defaults explicitly replaces the edited preference fields. A revision check
rejects concurrent preference writes. Native INI preference exchange and the
desktop preference-dialog lifecycle remain outside this implementation.

Preview does not change project data. Save uses the exact reviewed options
and source IDs against the accepted project revision. The frontend rejects
obsolete/malformed previews, changed source arrays, different saved mean or
scatter arrays, and missing reciprocal reference links. Undo/Redo restores
the new groups as one operation. Frozen sources can be read for a merge.

The web project retains provenance, contributors, coefficients, exclusions
and `source.raw_arrays.stddev`. Native PRJ export writes the actual `stddev`
array and `is_merge=e/n/k`; these arrays and reference links survive a bare
native round trip with all `# Athena-Web` sidecar lines removed. Native
`is_merge` remains preserved metadata on import; it does not reconstruct all
web contributor provenance or reopen the merge-result panel. The existing
current-group CSV endpoint names native scatter `merge_stddev`. Historical
API merge requests without `method: "demeter-larch"` retain their previous
custom arithmetic; the dedicated UI always requests the native method.

## Independent evidence and remaining parity

`backend/tests/reference/merge_native_reference.py` executes the original
Perl Config parser/default methods and `Process::merge/mergeE/mergek`, renders
the original eight merge templates and noise template with Text::Template,
and evaluates them in a real Larch interpreter. Object storage, cloning,
update calls and data transport are explicit bridges. Input normalization
and background subtraction are independently prepared by Larch; the full
desktop processing pipeline and wx GUI are not executed. The original noise
template is executed, while the native four-significant-figure assignment is
represented by the equivalent Python formatting operation.

The recorded oracle has **30 cases**: all three merge spaces and all three
weighting modes; exclusion on/off at ten/eleven missing points with unequal
energy shifts; equal, zero and unequal importance weights. It uses the three
unmodified measured iron-foil scans from the pinned
[merge example](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/examples/tests/merge.pl).
Their Git blob identities and SHA-256 hashes were checked when downloaded.
`backend/tests/fixtures/athena-merge-fixtures.json` pins the fixtures, driver,
oracle, original sources, Larch interpolation and noise kernels.

The backend compares every output coordinate (absolute tolerance 2e-12),
mean (relative 2e-12/absolute 2e-13), scatter (relative 2e-10/absolute 2e-13)
and coefficient (relative 1e-14), plus counts, exclusions, noise values and
E₀/shift. The other merge tests cover previews, references, frozen sources,
source immutability, atomic errors, preferences/restart/conflicts, Undo/Redo,
native/web PRJ and CSV scatter. Frontend component tests cover stale replies,
invalid output, exact save, retained plots and preference recovery; workbench
tests cover ID order, edits/retry, selection, drafts and shortcuts.

Desktop and mobile browser tests import all three actual XDAC files through
column selection, compare every raw μ point with ln(I0/It), preview all three
spaces, exercise weighting and reference outputs, save, compare all three
spread views, Undo/Redo, and export/reimport bare PRJ. References in this
browser fixture deliberately reuse each measured transmission channel;
they are constructed linked references, not additional independent scans.

This establishes a merge subset. Full native plot dispatch with per-group
multipliers, offsets, reprocessed normalized displays and k weighting, spread
inspection after closing/reloading or importing a historical merged PRJ,
native preference-file exchange and an actual desktop GUI round trip remain
open. PR-04/PR-05 retain their original matrix statuses; this evidence does
not claim full Athena parity. See the dated checkpoint in
[verification notes](athena-verification.md).
