# Athena element/edge enforcement: SC-05 reference

Research baseline, 2026-09-07. Oracle revision: Demeter
`06afc8da08a5a7d5a26ee14992170fcf5dc67406`. Findings below distinguish executable
source, documented intent, and suggested web behavior. No Demeter runtime or
numerical parity is asserted.

## Implemented web behavior

The later implementation adds [import initialization](../backend/xraylarch_web/athena_import_policy.py)
and [Energy-menu controls](../frontend/components/athena-edge-policy.tsx).
The policy is stored in this browser tab's `sessionStorage`, survives refresh,
and is independent of project state and Undo. Choosing raw files captures one
immutable policy for that batch, including sample/reference channels and
retries. Stop changes subsequent batches; a queued batch retains its snapshot.
Project restore/preview and chi imports do not run the initializer.

For enforced energy data, the initializer resolves automatic pre-edge,
post-edge, spline and FT limits at the atomic table energy, then iterates the
fraction calculation from that seed. It preserves explicit recipe fields
other than E0. The source's `bkg.nnorm=3` is represented as Larch polynomial
degree 2, following its normalization template. Automatic endpoints can be
tightened to measured support after refinement. Explicit outer normalization
requests are retained, while effective fits are limited to measured support
and reported in warnings; see the [boundary reference](athena-normalization-limits-reference.md).
Unusable inner intervals and unsupported explicit spline/FT ranges still
produce errors. The seed recipe and adjustments are recorded in provenance.
Raw scans ending less than 100 eV after the seed become XANES. Normalized
inputs retain their unit-step signal. Forced-import failure is atomic, including
failure in a reference channel, and leaves the upload available for retry.

Each group records its selected identity separately from energy-based inference.
Native `bkg_z`, `fft_edge` and `bkg_e0_fraction` are read/written as inert group
metadata. Project provenance cannot activate the recipient's policy. Native
`H` is treated as the source's inference sentinel; invalid metadata remains
preserved without being applied.

The [verification record](athena-verification.md) contains executed checks;
[61 numerical tests](../backend/tests/test_athena_import_policy_science.py),
[25 store tests](../backend/tests/test_athena_import_policy_store.py), API and
frontend tests cover the implemented contract. This does not claim every
Demeter preference or default: personal INI files, signed end-relative/implicit
keV preference syntax, all scalar defaults, and native reference same/different
edge controls remain open. The subsequent [native normalization checkpoint](athena-native-normalization-reference.md)
corrects `bkg_nnorm` term-count/degree exchange separately. No Demeter runtime
comparison has been executed.

## Contract established by the source

| State | Meaning and lifetime |
| --- | --- |
| Group `bkg_z`, **`fft_edge`** | Absorber **symbol** and edge metadata; `bkg_edge` is not the Data attribute. Defaults are `H` and `K`; `H` also acts as the normalization-time inference sentinel. |
| Group `bkg_e0` | Numerical E0 in eV. Selecting absorber/edge metadata does not itself change E0. |
| Group `bkg_e0_fraction` | Fraction used for that group's fraction calculation; initialized from the configuration preference. |
| App/default-object `is_z`, `is_edge`, `is_edge_margin` | Runtime enforcement state, distinct from group metadata and from user configuration. Raw import copies these flags onto its new Data object. |
| Configuration `bkg.e0`, `bkg.e0_fraction` | User preferences for the default algorithm and fraction, distinct from an existing group's recipe. |

Definitions: [`Data.pm` attributes](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/Data.pm#L109-L111),
[E0/fraction](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/Data.pm#L227-L233),
[absorber/edge](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/Data.pm#L324-L359).
`Main::OnAbsorber` and `OnEdge` only assign metadata and mark the project modified;
`E0::e0_atomic` separately looks up `bkg_z`/`fft_edge` through
`Xray::Absorption->get_energy`.
([UI handlers](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/UI/Athena/Main.pm#L922-L933),
[atomic lookup](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/Data/E0.pm#L172-L176))

### Enable, stop, and affected groups

`Athena.pm`'s `$E0_SPECIFY` dispatch opens `SpecifyConfig::new`, then updates app
and `Demeter->dd` enforcement fields on acceptance. Cancel leaves them alone.
`$E0_UNSPECIFY` clears the element/edge and resets margin to 15. Neither handler
loops over existing groups, changes their E0, resets their parameters, or undoes
earlier processing. The dialog displays the current runtime values.
([dispatch](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/UI/Athena.pm#L1005-L1033),
[dialog](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/UI/Athena/SpecifyConfig.pm#L25-L59))

| Operation | Pinned behavior |
| --- | --- |
| Enable/Stop with existing groups | Changes runtime policy only. Existing objects' copied enforcement flags are not cleared by Stop. |
| Ordinary raw energy-data import | `UI::Athena::IO::_data` copies the active pair; `Mu::put_data` reaches `initialize_e0` during real processing, after column display ends. |
| Raw chi(k) import | `put_data` resolves k ranges and bypasses E0 initialization. |
| Native project import | `IO::_prj` imports saved records without copying app enforcement flags. Both Perl and JSON `_record` methods set `from_athena=1`, load saved arguments, and clear data/column update flags. Ordinary saved mu/XANES normalization retains the saved E0 path. |
| Explicit E0 action on existing groups | Separate `Main::set_e0` loop over all/marked groups, or the current-group context action; not the enforcement toggle. |

Sources: [raw import](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/UI/Athena/IO.pm#L299-L320),
[`put_data`](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/Data/Mu.pm#L164-L301),
[project UI](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/UI/Athena/IO.pm#L839-L892),
[Perl records](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/Data/Prj.pm#L270-L486),
[JSON records](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/Data/JSON.pm#L241-L418),
[existing-group actions](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/UI/Athena/Main.pm#L1440-L1478).

These are initialization rules, not a permanent E0 lock. Later import
preprocessing can copy a standard's parameters or align energy; an existing
object can also revisit initialization when columns are rebuilt.
([`IO::_group`](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/UI/Athena/IO.pm#L630-L811))

### Table → defaults → fraction

The [official manual](https://bruceravel.github.io/demeter/documents/Athena/params/e0.html)
describes tabulated E0, default parameter determination, then fraction refinement.
The exact implementation is [`Mu::initialize_e0`](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/Data/Mu.pm#L288-L301):

1. With a valid enforced pair, call `e0(get_energy(is_z, is_edge))`, mark
   normalization dirty, and `_update('all')`.
2. Call `resolve_defaults`.
3. Call `e0('fraction')`, starting from the tabulated seed.

Without enforcement, the initializer calls `e0('ifeffit')` only if E0 is unset,
then resolves defaults. `Data::_update('normalize')` merely ensures input/columns
exist; `_update('all')` additionally normalizes and, as appropriate to datatype,
does background/FT/BFT processing.
([update dispatch](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/Data.pm#L703-L753))

**“Defaults” does not mean wiping the recipe.** `Defaults::resolve_defaults`
resolves current pre-edge, normalization, spline and FT ranges against E0/data;
resolves fraction and clamps; and can select XANES defaults for a short scan.
Examples include end-relative upper bounds and energy-dependent pre-edge limits.
It does not reset every background parameter, Fourier window, or energy shift.
The separate `Defaults::to_default` selectively reloads configuration defaults;
its switch has no `bkg_e0` reset arm.
([range resolution and selective resets](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/Data/Defaults.pm#L29-L201),
[range conventions](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/Data/Defaults.pm#L211-L274))

`E0::e0_fraction` normalizes at the current E0 and interpolates the first crossing
of `fraction * bkg_step` in the **pre-edge-subtracted** `pre` array, on
`energy + bkg_eshift`. It repeats at most five times, stopping at an E0 change
of at most 0.001 eV. It does not independently replace the seed with a derivative
guess. Fractions at/below zero fall back to 0.5; above one clamp to one.
([fraction implementation](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/Data/E0.pm#L105-L135),
[tolerance](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/Constants.pm#L49))

Exact backend templates:

| Template under `lib/Demeter/templates/process/` | Relevant behavior |
| --- | --- |
| [`larch/find_e0.tmpl`](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/templates/process/larch/find_e0.tmpl) | Calls Larch `find_e0` on raw energy/mu. |
| [`ifeffit/find_e0.tmpl`](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/templates/process/ifeffit/find_e0.tmpl) | Calls Ifeffit `pre_edge` without explicit E0. |
| [`larch/normalize.tmpl`](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/templates/process/larch/normalize.tmpl) | Explicit E0 and shifted energy, pre/post ranges, `nnorm=bkg_nnorm-1`; constructs `pre=mu-pre_edge`. |
| [`ifeffit/normalize.tmpl`](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/templates/process/ifeffit/normalize.tmpl) | Explicit E0 and shifted energy; `norm_order=bkg_nnorm`; optional fixed edge step. |

## Preferences and persistence

The pinned configuration offers `bkg.e0 = derivative|zero|fraction|atomic|peak`,
default `derivative`, and `bkg.e0_fraction`, default `0.5`. The manual's
`Bkg,fraction` label corresponds to the latter actual key.
([configuration](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/configuration/bkg.demeter_conf#L46-L77))

`UI::Wx::Config::apply` updates runtime configuration, and calls `write_ini` only
for Save. Configuration reload restores those preferences; the desktop default
is `~/.horae/demeter.ini` on Unix. Demeter's own `ui=web` mode disables INI reads
and writes. There is no Bkg callback that sweeps existing groups when these
preferences change; new groups initialize their fraction from the then-current
configuration.
([apply/save](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/UI/Wx/Config.pm#L272-L324),
[Athena callback](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/UI/Athena/Prefs.pm#L40-L83),
[INI location](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/Config.pm#L85-L90),
[INI read/write](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/Config.pm#L499-L538))

Native serialization keeps group `bkg_z`, `fft_edge`, `bkg_e0` and
`bkg_e0_fraction`. `Data::all` explicitly deletes `is_z`, `is_edge` and
`is_edge_margin`; both native writers use `_clean_up_args`, which starts from
`all`. Thus a project records the resulting recipe, not an instruction to enable
enforcement or replace the recipient's preferences.
([serialization exclusion](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/Data.pm#L489-L505),
[writers and cleanup](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/Data/Athena.pm#L142-L302))

## Source discrepancies and boundaries

- **Margin is inactive here.** The dialog stores it, but the margin comparison
  and forced metadata reassignment in `E0::e0` are commented out. The active
  initializer enforces unconditionally. Do not invent a ±15 eV search window.
  ([commented branch](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/Data/E0.pm#L60-L88))
- **Preference/documentation discrepancy:** the ordinary import chain traced
  above hardcodes `ifeffit`; it does not dispatch through `bkg.e0`. Treat honoring
  other default methods as documented-intent support, not verified behavior of
  this pinned import path.
- **Metadata caveat:** active enforcement seeds E0 but does not explicitly assign
  `bkg_z`/`fft_edge`. Normalization infers them when `bkg_z=H`; `find_edge` prefers
  valid XDI element/edge metadata, otherwise searches K/L edges with special
  remappings. Conflicting XDI metadata can therefore remain inconsistent with
  the enforced seed.
  ([normalization](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/Data/Mu.pm#L319-L328),
  [`find_edge`](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/Data/Mu.pm#L823-L877))
- **Static source bug candidate, not runtime-tested:** enforced `is_nor` data
  can recurse through `normalize → initialize_e0 → _update('all') → normalize`
  while normalization remains dirty. Do not port that control flow. Also the
  fraction loop lacks a missing-crossing error and uses index `i-1` even at the
  first sample. Retain explicit scientific validation in the web implementation.
  ([normalized branch](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/Data/Mu.pm#L366-L378))

## Group identity editor follow-up

The webapp now offers a separate current-group absorber/edge editor. It changes
saved identity and the corresponding effective-result labels without changing
E0, energy shift, processing arrays, recipes, reference links, fraction history
or import enforcement. Frozen edits are rejected atomically; unfrozen chi,
difference and failed-processing groups can retain descriptive identity.
Older absorption groups obtain missing identity from an existing cached E0,
without scientific recalculation. Derived operations retain selected identity
and the saved fraction separately from operation history. The
[verification record](athena-verification.md) supplies tests and live evidence.

This follows the metadata-only `OnAbsorber`/`OnEdge` handlers in
[Main.pm](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/UI/Athena/Main.pm#L922-L933).
The source's `all_group` set also includes absorber, edge and importance;
full-parameter copying of those fields remains open in the webapp.

## Minimal implementation recommendation for this store

The following is the original research handoff, retained to explain the
implementation choices above:

1. Keep enforcement `{element, edge}` and default-method/fraction preferences in
   explicit workspace/session state, separate from group `AthenaParameters`.
   Enabling/disabling does not rewrite existing groups or invalidate their
   analyses. If persisted per web project, label that a web extension and do not
   activate it when restoring someone else's native/web project.
2. When enforcement is enabled for ordinary raw mu/XANES import, validate the pair
   against the available table and shifted energy coverage. Resolve automatic ranges using the tabulated
   E0, then run fraction refinement from that seed. Preserve explicit valid
   ranges and energy calibration; reject unusable ranges with an actionable
   error. Project restore/preview must use saved recipes and bypass destination
   enforcement. Chi and signed differences are ineligible for E0 enforcement.
3. Science handoff: the current `compute_e0(..., method="fraction",
   seed_e0=tabulated_e0, fraction=f)` interface supports the required seed.
   Merely setting `parameters.e0` is insufficient because an omitted `seed_e0`
   starts a fresh derivative search. Use `atomic_edge(element, edge)` for the
   table lookup. Resolve ranges before refinement and do final processing once;
   do not reproduce the recursive `_update('all')` sequence. The helper currently
   accepts `0 < f <= 1`. Demeter also clamps/falls back for out-of-range
   fractions; the web helper reports invalid inputs rather than silently
   substituting a different fraction.
4. Record selected absorber/edge and E0-selection provenance separately from
   inferred identity; retain native metadata (currently `source.native.args`).
   An explicit atomic choice on an existing group is the parent's `set_e0`
   action, not an implicit consequence of enabling future-import enforcement.
   Keep scientific edits within the existing atomic update/frozen/dependency
   rules. Saving group provenance must not turn it into session policy.

Suggested later acceptance oracles: toggle with existing groups unchanged;
raw import receives table→resolved-ranges→fraction; Stop then import another
element; restore a saved project under conflicting enforcement unchanged;
preference changes leave old fractions intact; native export/import does not
reactivate enforcement; invalid edge/coverage/window failures leave no partial
groups. These checks were not implemented or run in this research task.

## Reproducible source bundle

Code URLs above are pinned; the bundle also includes the
[pinned manual text](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/documentation/Athena/params/e0.rst).
The committed [source manifest](athena-primary-sources.json) includes the
29-file enforcement reference bundle (678,226 bytes), with relative paths,
exact URLs, content SHA-256 and Git blob SHA-1 identities. During research
every blob was checked against the Git tree at the pinned revision. The
manifest also retains the separately reviewed background and E0 sources.

Critical content SHA-256 values:

| File | SHA-256 |
| --- | --- |
| `lib/Demeter/UI/Athena.pm` | `dc5126ed6cd5f40c7104736d68fba42118cab4e272bcca9fc04726f205225de4` |
| `lib/Demeter/UI/Athena/IO.pm` | `e595761d78809f12a5b7327454a121114b5c97e648945442d101fc00d2b7c54a` |
| `lib/Demeter/Data/Mu.pm` | `a3738bd61b41a4dbbca9d10e231b51044642222f148c8c9cba900be662f78f57` |
| `lib/Demeter/Data/E0.pm` | `a933d8ee57c1bcae3b842821e4cfdbb8194146bee1290cf53af6853e5f0cec3f` |
| `lib/Demeter/Data/Defaults.pm` | `e8e510e3b2c359e6e53887ee4e1b56639cfe8e2eb4b20d85917ca05740292bbc` |

Scope was limited to the menu/dialog, import and project readers, E0/default
processing, configuration and relevant templates. Multi-detector/plugin and
every derived-group path were not exhaustively audited.
