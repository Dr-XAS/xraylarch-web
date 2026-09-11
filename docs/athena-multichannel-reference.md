# Athena multichannel project readers

Contract checkpoint, 2026-09-10. This advances IM-01, IM-03, IM-10 and UI-11
in the [107-row matrix](athena-parity.md). Complete Athena remains the goal;
Artemis is excluded and no matrix row is Verified.

## Native source and retained acquisitions

Sources are pinned to Demeter `06afc8da08a5a7d5a26ee14992170fcf5dc67406`:

- [10BMMultiChannel.pm](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/Plugins/10BMMultiChannel.pm) and its [configuration](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/Plugins/10bmmultichannel.demeter_conf).
- [X23A2MultiChannel.pm](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/Plugins/X23A2MultiChannel.pm), [Data::MultiChannel](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/Data/MultiChannel.pm) and [Data::sort_data](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/Data.pm).
- [Official recipe and three re4chan acquisitions](https://github.com/bruceravel/demeter/tree/06afc8da08a5a7d5a26ee14992170fcf5dc67406/examples/recipes/MultiChannel). Each acquisition has **387 rows × 12 columns** and four simultaneously measured rhenium standards. All three original files are retained byte for byte.

The [fixture manifest](../backend/tests/fixtures/athena-multichannel-fixtures.json)
records input/source hashes, official Git blob identities, constructed-probe
provenance, configuration values and nine compressed native oracles. The
10BM probes relabel the official X23 table and alter headers or row order;
they are **not measured 10BM acquisitions**. Their negative temperature
labels reflect these artificial inputs, not physical sample temperatures.

The [independent reproducer](../backend/tests/reference/multichannel_native_reference.py)
executes unchanged native `is`, `fix`, `make_data` and the Ifeffit branch of
`sort_data`. Minimal accessors bridge array storage and capture the generated
expressions. Real Larch reads the input and evaluates energy, transmission,
I0 and signal expressions. Tests compare every resulting value and every
sorted source column, including names, data types and journal. These checks
bridge rather than execute Moose construction, RPC, template expansion,
native project serialization, E0/default resolution and XDI hooks. They do
not establish complete desktop replay.

```bash
LARCHDIR=/tmp/athena-mc-larch MPLCONFIGDIR=/tmp/athena-mc-mpl backend/.venv/bin/python backend/tests/reference/multichannel_native_reference.py --source-root /tmp/athena-column-sources --output-dir /tmp/athena-mc-reproduced
```

Download the manifest's pinned sources to `--source-root`, replacing `/` in
their source paths with `-`. Reproduction verifies source/input/oracle hashes
before executing. Nine cases cover three official acquisitions and 10BM
defaults, changed columns/names/shifts/type/reference, disabled/missing
thermocouple, E0 beyond the scan and reversed/duplicate energy records.

## Conversion and scientific behavior

Both plugins produce **projects**, so the web opens group preview and
selection instead of a single-spectrum column selector. X23 recognizes its
XDAC header and four I0/four It labels. It creates `channel 1` through
`channel 4` using `ln(abs(I0 / It))`. Native X23 has no registry configuration
file; its optional programmatic `do_reference` property defaults false and is
not exposed as a desktop registry control. No reference is imported by this
reader's default path.

10BM recognizes `MRCAT_XAFS` plus eight consecutive mcs labels. All native
configuration fields are available: four names, numerator/denominator column
numbers, four energy shifts, optional reference, reference name/denominator,
temperature label and μ(E)/XANES type. The reference numerator is the sum of
the four sample transmission columns. Neither plugin ties a reference group
to the samples; the native plugin leaves those links unset.

10BM adds each configured shift directly to that channel's energy array;
the imported recipe's shift is zero. Applying it again would double the
correction. Temperature uses the configured detector at the first energy
strictly above the integer E0 header value, or the last row if no point is
above it. The label truncates `200 × (value / 100000 − 1)` toward zero and adds
`C`. An empty or missing label produces native `0`. Sample labels combine
filename, configured name and temperature; reference labels omit temperature.
The 10BM journal preserves the source header, separator and column labels.

Data are stably sorted as whole rows by energy. The first row is retained;
subsequent rows at most **0.001 eV** above the last retained point are removed,
matching native `Data::sort_data` for eV input. Retained source indices and
input/output counts are recorded. The pinned [old Larch sort template](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/templates/process/larch/sort.tmpl)
sorts each column independently and cannot serve as a valid detector-row
correspondence oracle. The web uses the desktop row-preserving algorithm and
Larch for scientific processing. It does not reproduce that template defect.

At least eight retained energy points are required by the web processing
contract. Invalid detector columns, malformed rows, nonfinite transmission,
zero counts and resource-limit failures reject conversion before staging or
project mutation. The original acquisition remains available for review.
Full column arrays and I0/signal metadata follow the retained row order.

## Review, configuration and persistence

Enable either reader under **File → Plugin registry…**, then select or drop
the acquisition in **Import data**. Review each channel independently; μ(E),
normalized, flattened and derivative previews use the staged data. Selection
is independent of the viewed channel. Existing all/subset, regex and periodic
selection rules apply, including Athena's explicit empty-selection-imports-all
behavior. Raw-file, multichannel and `.prj` batches hand off between the two
import panels without converting twice or importing a file twice.

For 10BM, **Configure reader** opens the editor in the project preview.
**Apply** changes this server session; **Apply and Save** persists all applied
reader configurations. The displayed groups stay fixed until **Reinspect
source file** uploads the same original again. Reinspection replaces the
snapshot and resets selection. Failure removes the stale import action;
**Retry preview** keeps the original file and pending queue.

**Download original file** returns byte-identical input. **Download converted
project** returns an Athena Web JSON project containing all converted groups,
raw detector metadata and configuration snapshots. Import is a single
versioned restore operation. Project restart, undo/redo and JSON/PRJ exchange
preserve source metadata, recipes and scientific arrays. Preview caches are
workspace-scoped, bounded and evict original bytes together with converted
projects; failed staging removes partial entries.

[Backend tests](../backend/tests/test_athena_multichannel.py) cover the native
oracles, staging, all-channel processing previews, subsets, configurations,
limits, failures, cache eviction, namespace isolation, real HTTP downloads,
restart and exchange. Component tests cover configuration values, staged
handoff, queue retention, retry and independent preview selection.
[Chromium tests](../frontend/tests/e2e/athena-multichannel.spec.ts) inspect real
Plotly coordinates, inline reconfiguration, normalized previews, E/k/R/q,
source downloads, PRJ exchange, page reload and long-label/mobile layout.
Executed results are recorded in [verification](athena-verification.md).

## Remaining full-Athena work

Sixteen converters are registered. Six top-level pinned reader modules remain:
B18, BL8Ar, BM23, SLRIBL4, SpecFileLongLine and Zip. Four nested Beamlines
helpers (BL8, MX, X11A, XDAC), complete beamline/XDI hooks, dynamic extension
discovery, native preference/INI exchange, full desktop replay and the other
processing/analysis/UI rows remain required. The 10BM reader still needs an
independent measured 10BM acquisition in addition to the native constructed
probes. None of these checks establishes complete Athena parity.
