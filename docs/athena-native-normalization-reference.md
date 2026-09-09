# Native Athena normalization settings

Checkpoint: 2026-09-09. Native project exchange follows Demeter revision
`06afc8da08a5a7d5a26ee14992170fcf5dc67406` with its Larch normalization
template. This corrects two import/export conventions; it does not establish
complete Demeter/Ifeffit numerical equivalence.

## Polynomial terms and degrees

Demeter's [Larch normalization template](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/templates/process/larch/normalize.tmpl)
passes `nnorm=bkg_nnorm-1`. Native `bkg_nnorm` counts polynomial terms, while
the web recipe and Larch `nnorm` specify degree. Import subtracts one and
native export adds one. Three native terms therefore produce a quadratic,
rather than the cubic produced by the former direct mapping.

| Native terms | Web/Larch degree | Polynomial |
| --- | --- | --- |
| 1 | 0 | Constant |
| 2 | 1 | Linear |
| 3 | 2 | Quadratic |
| 4 | 3 | Cubic; Larch extension, not verified for Ifeffit |

Missing native order uses three terms, matching the pinned `Data.pm` default
with stock preferences. Both native loaders construct a Data object and apply
saved attributes; neither applies the separate XANES reset preference. Empty,
null and the historical text `None` use that same fallback. Personal desktop
preferences are not imported.

Web JSON and current or historical Athena-Web sidecars retain their explicit
degree, including `None` for automatic selection. Native-only exports of an
automatic web recipe use the effective fitted degree plus one. Invalid native
orders retain raw spectra and a visible processing error, and remain editable
and undoable. They are not silently converted to a valid degree.

The pinned Ifeffit normalization template instead passes `norm_order=bkg_nnorm`.
Ifeffit 1.2.11d `preedg.f` reduces orders of at least three to two when its fit
interval is at most 100 eV. Its `iff_pre_edge.f` caller allocates three
coefficients, so four-term exchange is not a safe Ifeffit compatibility claim.
These engine differences remain open; the web uses Larch processing.

## Energy-dependent normalization

The active Demeter field is `bkg_funnorm`, default false in
[`Data.pm`](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/Data.pm).
Both [`Data/Prj.pm`](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/Data/Prj.pm)
and [`Data/JSON.pm`](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/Data/JSON.pm)
explicitly ignore the obsolete `bkg_fnorm` field. Native import/export now
maps web `fnorm` to `bkg_funnorm`. The obsolete field survives as unapplied
source metadata and cannot enable processing. Explicit web/sidecar settings
remain unchanged, even when historical native arguments disagree.

## Evidence and limits

[Regression tests](../backend/tests/test_athena_native_normalization.py) exercise
native JSON and compressed Perl projects, lazy previews, restore, native-only
exchange, automatic and historical web recipes, malformed-order repair and
undo, and enabled/disabled functional normalization. Normalized arrays,
pre/post-edge fits and edge steps are compared to direct Larch `pre_edge` with
an explicitly supplied degree. Larch's native reader is used only for raw
arrays and arguments, because its own processing path passes the native count
directly as a degree.

The original measured Pt difference fixture has 21 spectra with native order
three and obsolete `bkg_fnorm=1`. All preview recipes now use degree two; the
four measured records tested retain functional normalization off. Numerical
comparisons explicitly repair their separate EXAFS taper/range problems before
processing, while preserving every normalization setting. Those repairs are
test choices, not automatic changes to imported projects. Untouched Pt
processing still rejects zero-width Kaiser windows, and saved spline/FT
endpoints slightly exceed coverage under local Larch constants. Full native
processing and exact Ifeffit comparisons remain unfinished.

Pinned source hashes are in [the source manifest](athena-primary-sources.json);
executed checks are recorded in [verification notes](athena-verification.md).
