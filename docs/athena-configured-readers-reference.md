# Athena X15B, X23A2MED and reader configuration

Contract checkpoint, 2026-09-10. This advances IM-01, IM-03, IM-10 and UI-11
in the [107-row Athena matrix](athena-parity.md). Full Athena remains the
objective; no row is Verified and Artemis is excluded.

## Source and native execution

All references use Demeter `06afc8da08a5a7d5a26ee14992170fcf5dc67406`:

- [X15B.pm](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/Plugins/X15B.pm), its [configuration](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/Plugins/x15b.demeter_conf) and [official binary acquisition](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/t/filetypes/x15b.dat).
- [X23A2MED.pm](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/Plugins/X23A2MED.pm), its [configuration](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/Plugins/x23a2med.demeter_conf), [official acquisition](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/t/filetypes/x23a2med.dat) and [Larch writer template](https://raw.githubusercontent.com/bruceravel/demeter/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/templates/plugin/larch/x23a2med.tmpl).
- [Wx/Config.pm](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/UI/Wx/Config.pm): Apply calls `set_default` in memory; Apply and Save also calls `write_ini`. Saving includes other already-applied preferences. `PluginConfig.pm` wraps this editor.

Source and acquisition identities are retained in the
[primary-source catalog](athena-primary-sources.json). The
[X15B manifest](../backend/tests/fixtures/athena-x15b-fixtures.json) and
[X23A2MED manifest](../backend/tests/fixtures/athena-x23a2med-fixtures.json)
record source bytes, Git blob identities, SHA-256, configuration values,
harness identities, native metadata and compressed numerical oracles.

The independent reproducers execute native `is`, `fix`, `suggest` and MED
`_correct` code unchanged, using minimal configuration/accessor stubs. The MED
bridge invokes real Larch `read_ascii` and `write_ascii`; Perl output arrays
cross that bridge as little-endian doubles, avoiding JSON decimal rounding
before Larch formats them. These checks do not execute Moose construction,
Demeter RPC/template expansion, general XDI hooks or the complete desktop UI.

```bash
MPLCONFIGDIR=/tmp/athena-config-mpl backend/.venv/bin/python backend/tests/reference/x15b_native_reference.py --source-root /tmp/athena-column-sources --output-dir /tmp/x15b-reproduced
MPLCONFIGDIR=/tmp/athena-config-mpl backend/.venv/bin/python backend/tests/reference/x23a2med_native_reference.py --source-root /tmp/athena-column-sources --output-dir /tmp/x23a2med-reproduced
```

`--source-root` must contain the downloaded pinned plugin files, with `/`
replaced by `-` in their repository paths. Reproduction verifies their hashes
before executing them. Both official default conversions match all **4,981
scalar values**: X15B **321 × 5 = 1,605**, MED **422 × 8 = 3,376**.
Reconfigurations and constructed probes reuse these acquisitions and are not
counted as additional measured samples.

## X15B binary records

The reader skips the 212-byte header and decodes each 64-byte record as 16
little-endian floats. Native selectable columns 1–14 refer to record words
1–14 after the leader; word 15 is not selectable. Configuration defaults are
energy=1, I0=6, narrow=7, wide=9, transmission=8, with duplicate selections
allowed. Output has five named columns and native four-decimal precision.

Old commented constants in X15B.pm imply a different selection. They are not
the configuration defaults and do not establish the physically correct
channel assignment for every file. The web preserves the actual defaults
and lets users review and change the detector columns. Native default
fluorescence is narrow/I0; explicit transmission is ln(I0/transmission).
The original binary is downloadable and has a hex excerpt. Metadata retains
the header project, selected word indices, previews of all 14 source scalars
and the pinned static X15B beamline/XDI defaults.

Three native executions cover defaults, the alternate comment-based choices
and duplicated narrow/wide selection. Truncation, resource limits and selected
nonfinite values fail before import; unused nonfinite source values have a
bounded diagnostic and remain in the original download.

## X23A2MED correction and channel suggestions

The reader recognizes NIST X-23A2/BMM headers and the configured detector
labels. The native `nergy` preference resolves to `energy` for Larch. It
supports one through four complete ROI/fast/slow detector sets and dual-edge
`roi1_N`/`roi2_N` data. Any zero slow count omits that entire channel as native
`fix` does; if all channels are omitted, import reports a useful error.

Default deadtime is 280 ns per detector. Above 1 ns the native iteration uses
the configured column or constant integration time, the original convergence
comparison and a 20-iteration cap. The low-fast-count branch and its dependence
on integration time are retained. At 0–1 ns the native calculation reduces
to ROI × fast / slow. The native configuration widget specifies a 10 ns
minimum, while the plugin documents and implements the zero-deadtime branch;
the web allows 0–10,000 ns to expose that behavior. Positive, finite constant
integration time is required. Overflow is reported rather than clipped.

Corrected data are written at the same `gformat(length=14)` precision as
Larch's `write_ascii`. The preview summary lists each included detector's
deadtime, the integration-time source, omissions and dual-edge selection.
Fluorescence sums the surviving first-edge channels. Native transmission
uses a fixed output position (fourth column for one detector, seventh
otherwise); this can select Iref or a corrected ROI for other layouts. The
web names that actual selection in the summary and omits an out-of-range
suggestion. It does not silently replace the native choice with It.

Eleven native executions cover defaults, zero deadtime, constant time,
one/two/three-channel layouts, one/all zero-slow channels, low fast counts,
the iteration cap and dual edges. The configured `multiedge_regex` preference
is commented out in native recognition/conversion; the web follows the actual
hardwired ROI names and does not present that unused field as effective.

## Configuration, staging and persistence

Enable each reader in **File → Plugin registry…**, then open **Configure X15B**
or **Configure X23A2MED**. The form shows current, saved and Athena default
values. Copying current/saved/default values only edits the form. **Apply**
changes subsequent inspections in this backend session. **Apply and Save**
persists all currently applied reader configurations for future starts.
This is shared local-server state. Reload refreshes changes from other windows;
stale revisions or server sessions cannot overwrite newer values.

From column selection, **File plugins…** preserves the selected file, current
mapping and batch policy. Returning retains the old converted data and preview.
**Reinspect selected file** uploads that same original again with current
settings, selects the resulting suggestions/remembered columns and redraws the
preview. It preserves the queue and original batch edge-policy snapshot.
Staged SPEC scan entries do not offer this operation because their parent file
has already been split. A failed reinspection clears the old import action and
provides Retry file inspection. Changing settings never edits imported groups.

Every staged upload and imported group retains its exact configuration
snapshot. Preview/import use those staged arrays even if configuration changes
later; source/configuration metadata and processed arrays survive JSON/PRJ
exchange. Preferences are separate from project versions and undo history.
The backend validates values and writes `plugin-config.json` atomically under
the preferences lock. Session-only changes reset on backend restart; saved
changes survive. General native INI import/export is not implemented by this
internal persistence format.

## Evidence and remaining work

[Backend reader tests](../backend/tests/test_athena_configured_readers.py) compare
every oracle value and native suggestion, damaged records, recognition,
staged independence, actual Larch processing, HTTP recovery, downloads,
restart, undo/redo and JSON/PRJ preservation.
[Configuration tests](../backend/tests/test_athena_plugin_config.py) cover
session/save semantics across readers, concurrent writes, stale sessions,
validation, failed atomic writes and independence from the enabled registry.
Component tests exercise Apply/Save/defaults/reload, pending controls,
StrictMode, errors, registry integration and reinspection batch behavior.
[Chromium tests](../frontend/tests/e2e/athena-configured-readers.spec.ts) compare
actual plotted values before/after configuration, E/k/R/q processing plots,
source downloads, PRJ exchange, two-window conflicts and mobile layout.
Executed results are recorded in [verification](athena-verification.md).

Fourteen converters are now registered. The pinned Plugins tree also contains
eight other top-level modules (10BMMultiChannel, B18, BL8Ar, BM23, SLRIBL4,
SpecFileLongLine, X23A2MultiChannel and Zip) and four nested Beamlines helpers
(BL8, MX, X11A and XDAC). Those twelve modules, user/system extension discovery,
other plugins' configuration, general
preferences/INI exchange, complete XDI hooks, source attachment packaging,
native desktop replay and the remaining processing/analysis/UI matrix remain
required. These checks do not establish full Athena parity.
