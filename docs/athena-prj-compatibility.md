# Athena project import compatibility

Checkpoint: 2026-09-09. This fixes project opening and processing failures found
with real examples; it does not establish full desktop Athena parity.

## Downloaded examples

Eight files were downloaded from the official Demeter repository at revision
`06afc8da08a5a7d5a26ee14992170fcf5dc67406`. Each downloaded byte stream was
checked against the pinned Git blob. Seven match existing repository examples;
the JSON example is now a retained test fixture. The
[download manifest](../backend/tests/fixtures/athena-official-manifest.json)
records source URLs, SHA-256, Git blob hashes and sizes.

| Official example | Groups | Import, normalize, AUTOBK, FT and reverse FT | JSON/PRJ save and reload |
| --- | ---: | --- | --- |
| cu.prj | 3 | Pass | Pass |
| athena_json.prj | 17 | Pass | Pass |
| fbo.prj | 1 | Pass | Pass |
| methyltin.prj | 2 | Pass | Pass |
| zirconolite.prj | 9 | Pass | Pass |
| HgDNA_data.prj | 2 | Pass | Pass |
| LaCoO3.prj | 2 | Pass | Pass |
| diff.prj | 21 | Pass | Pass |

All 57 spectra retain their original coordinate/signal arrays. Tests require
finite normalization, flattening, chi, R and q arrays; first-group normalization
in each project is compared to a separate direct Larch call at `1e-12`
relative/absolute tolerance. Both export formats preserve complete recipes,
source metadata and calculated arrays on web reload.

Actual Chromium tests additionally upload cu, zirconolite and athena_json
through the ordinary **Import data** control, request normalized previews,
render all four plot spaces, download Save project, upload that downloaded
file and compare every original/round-tripped spectrum and recipe. A fourth
browser test imports raw data → project → raw data in one batch and checks
the final group order. These four browser tests pass.

## Causes and implemented behavior

- Ordinary file selection and drag/drop now dispatch project files to the
  project preview, including uppercase `.PRJ`, JSON and gzip extensions.
  Mixed queues transfer between the project and column-mapping panels only
  after releasing the previous operation's busy state.
- Native Data::Dumper parsing now handles physical multiline strings, nested
  hashes, Perl escaping, `undef` and inert `bless({...}, 'Xray::XDI')` metadata.
  It never runs Perl, instantiates a saved class or evaluates general calls.
  Legacy files with repeated group IDs keep every spectrum and record the
  ambiguity; links resolve to the first occurrence. Strict web/JSON identity
  validation is retained. These representations are described in the
  [Athena project-format manual](https://bruceravel.github.io/demeter/documents/Athena/output/project.html).
- Native clamp names are case insensitive and map to `0, 3, 6, 12, 24, 96`
  for none/slight/weak/medium/strong/rigid, following the pinned configuration
  recorded in [primary sources](athena-primary-sources.json).
- The exact `# Using Larch version` producer header selects Larch's saved
  polynomial degree convention. A Demeter header mentioning its Larch backend
  retains the native term-count convention. See
  [normalization exchange](athena-native-normalization-reference.md) and
  [local Larch's project writer](../larch/io/athena_project.py).
- Native normalization outer endpoints are now resolved during processing,
  preserving requested pre1/norm2 values in the recipe as well as the original
  arguments. See the executed [boundary reference](athena-normalization-limits-reference.md).
  Background and FT limits retain their import-time coverage resolutions.
  Demeter's zero-width background Kaiser setting resolves to `0.1` as in its
  [Larch AUTOBK template](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/templates/process/larch/autobk.tmpl).
  Original arguments and explicit compatibility notes remain available.
  Normalization outer-fit resolution also applies to web recipes. The other
  native compatibility adjustments remain specific to native import.
- Irrelevant normalization/background placeholders in native chi(k) records
  no longer prevent Fourier processing. Malformed active numerical parameters
  preserve raw spectra with editable processing errors.
- Kaiser/Gaussian shape parameters are no longer rejected by the ordinary
  taper-length guard. A zero-width Fourier Kaiser uses Larch's existing legacy
  Bessel formula, with a visible note; the previously unreachable `bessel`
  branch is now accepted. Its rectangular limit follows `window.f` in the
  [Ifeffit 1.2.11d source archive](https://deb.debian.org/debian/pool/main/i/ifeffit/ifeffit_1.2.11d.orig.tar.gz),
  using Larch's grid snapping. Positive-beta windows retain Larch's current
  formula; exact Ifeffit window equivalence is not claimed.
- An AUTOBK fit with unavailable covariance now retains its fitted curves
  and reports that no uncertainty estimate is available. Larch no longer
  indexes a missing covariance matrix when uncertainty calculation is off.
  The AgL3_CAMD example exercises this failure directly.

## Broader corpus and remaining failures

The reproducible [corpus report](athena-project-corpus-results.json) covers
83 distinct local files: all 82 normal projects import, retaining 1,067 groups;
the deliberately executable `danger.prj` is rejected. Of the imported groups,
1,015 process successfully and 52 retain raw data with a processing error.
Per-file hashes and every failed group/error are included in the report.

Remaining errors include nonpositive fitted steps, uncalibrated dispersive
pixel axes, E0 or fit ranges outside measured data, unsupported saved weights,
overlapping ordinary taper ranges and an insufficient background-standard
range. These need inspection or additional compatibility work; they are not
silently replaced with guessed scientific settings. In yb_iron, twelve groups
now process with the legacy reverse window; `.003` still has a nonpositive
fitted step and remains explicitly flagged.

Native fits/properties retained as source metadata are not necessarily restored
as editable web analysis models. The [107-row functional matrix](athena-parity.md)
still contains partial and pending requirements, including import preprocessing,
full preference handling, phase correction, batch fitting, PCA target transforms,
additional peak/self-absorption models, noise-based weighting and native
analysis-state coverage. No whole-feature row is promoted to Verified here.
The web import limits also remain: at most 100 groups in a project and 100,000
points per spectrum, plus the configured upload/metadata size limits.

## Reproduce

Final verification: **1,464 backend tests**, **326 frontend tests**, and **8
Chromium tests** passed. Type checking and the production build also passed.

From the repository root:

```sh
MPLCONFIGDIR=/tmp/athena-mpl backend/.venv/bin/python -m pytest backend/tests -q
PYTHONPATH=backend MPLCONFIGDIR=/tmp/athena-mpl backend/.venv/bin/python backend/scripts/audit_athena_projects.py --output /tmp/athena-corpus.json
```

From `frontend`, run `npm test`, `npm run typecheck`, `npm run build` and
`npm run test:e2e -- tests/e2e/athena-project.spec.ts`. Install the matching
Playwright Chromium browser first. Browser tests use temporary backend data
and a separate `.next-e2e` output directory so local development can stay open.

On the Ubuntu 26 host used for this checkpoint, Playwright 1.58 required the
supported Linux package selection below. These commands were used successfully:

```sh
PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-x64 PLAYWRIGHT_BROWSERS_PATH=/tmp/athena-playwright npx playwright install chromium --only-shell
PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-x64 PLAYWRIGHT_BROWSERS_PATH=/tmp/athena-playwright npm run test:e2e
```
