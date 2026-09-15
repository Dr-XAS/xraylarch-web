# Athena file-plugin registry

Source contract, 2026-09-10. Registry work advances IM-10 and the preference
portion of UI-11. All [107 Athena requirements](athena-parity.md) remain in
scope; no row is certified Verified and Artemis remains excluded.

## Native source contract

The [manual](https://bruceravel.github.io/demeter/documents/Athena/other/plugin.html)
describes enabled readers, documentation/configuration access, system/user
discovery and reader ordering. Implementation references are pinned to Demeter
`06afc8da08a5a7d5a26ee14992170fcf5dc67406`:

- [PluginRegistry.pm](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/UI/Athena/PluginRegistry.pm) reads `athena.plugin_registry` with YAML::Tiny, creates a sorted checkbox list, excludes FileType, restores each checkbox and immediately persists the whole state on a change. With no saved file, the empty mapping leaves plugins unchecked. Documentation is available for every plugin; Configure appears only when the plugin has a conffile.
- [IO.pm](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/UI/Athena/IO.pm) tests only checked plugins and invokes the first recognized converter before column selection. Registry changes do not reinterpret already inspected columns or imported groups.
- [Demeter.pm](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter.pm) enumerates the system directory; its private directory is commented out. Registration follows directory enumeration, although the displayed list is sorted and the manual describes alphabetical checks with user readers first. The web's registered readers follow the displayed alphabetical order. DUBBLE and SRS overlap: DUBBLE wins when both are enabled; enabled SRS can read the file when DUBBLE is disabled. Native numerical conversion agrees, but the two native MED suggestions differ; the web preserves that distinction.
- [PluginConfig.pm](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/UI/Athena/PluginConfig.pm) wraps the general preferences editor. [lytle.demeter_conf](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/Plugins/lytle.demeter_conf) defines stpdeg = 2000 (integer, 1000–10000) and dspace = 1.92017 Å for early files without header settings. The current Lytle converter overwrites these defaults with file header fields; the earlier layouts and its effective configuration editor remain open. No inactive Configure control is presented as implemented.

## Interaction and persistence

**File → Plugin registry…** opens the available-reader list. **File plugins…**
inside import opens the same panel while retaining selected files, column
mapping and batch state. Returning restores import; a disabled-file failure
can then use **Retry file inspection** without reselection.

The 22 available readers (10BMMultiChannel, B18, BL8Ar, BM23, CMC, DUBBLE, HXMA,
LNLS, Lytle, PFBL12C, SLRIBL4, SPEC, SRS, SSRLA, SSRLB, SSRLmicro, SpecFileLongLine, X10C, X15B,
X23A2MED, X23A2MultiChannel and Zip) show descriptions, versions, ordered system-reader entries,
local documentation and original source links. Switches save immediately to
local server preferences. Unlike the earlier always-on converter checkpoint,
fresh settings now match Athena's unchecked default. Enable the formats needed
before importing. Ordinary ASCII/CSV/XDI reading requires no plugin switch.

The backend reports the specific disabled reader and recovery action, never
calls a disabled converter, and can continue to a later enabled matching
reader. Registry state is used at inspection time. Once staged, converted
arrays can still be previewed and imported after disabling that reader.
Existing groups, revisions, undo/redo, PRJ restores, column memory and rebin
defaults remain independent.

Settings live in the existing preferences namespace in `plugins.json`. Reads
validate state; atomic writes share the preferences lock and require the
observed version. Two windows cannot overwrite each other's settings. The
panel retains confirmed switches after failure, offers reload/retry and
disables writes while pending. A checkbox updates after the server confirms
its value. Stale initial requests cannot overwrite a newer mount's state.

## Native YAML exchange

Import replaces the saved registry with the native flat name/flag mapping.
Export writes sorted fully qualified names with numeric 0/1 values and the
native filename. Known readers absent from an imported mapping are disabled.
Unknown entries are retained, displayed separately as unavailable and exported
again; they do not imply an installed or executable reader.

The reader accepts quoted/unquoted 0/1 and conventional true/false values. The
native interoperability path is numeric 0/1. Files are bounded to 64 KB and
256 entries. Duplicate names, nested structures, aliases, tags, nonboolean
values and multiple documents cannot produce ambiguous switch state. The JSON
API requires booleans and a current integer version. Invalid files and stale
imports leave saved preferences unchanged.

For direct comparison, [YAML::Tiny 1.76](https://www.cpan.org/modules/by-module/YAML/YAML-Tiny-1.76.tar.gz)
was downloaded to a temporary Perl library directory; no system installation
changed. Archive SHA-256:
`a8d584394cf069bf8f17cba3dd5099003b097fce316c31fb094f1b1c171c08a3`.
Tiny.pm SHA-256:
`d6bb1c9b3124578364745f9dd55126c6bb3753c3310b5cdbd0572153834f1c93`.

The web export was loaded by real YAML::Tiny, converted to checkbox Perl
boolean values and dumped as PluginRegistry.pm's OnCheck does. All flags and
output bytes matched. Tiny's raw Load returns scalar strings, so directly
dumping those strings quotes the numeric values. That alternate output is a
[constructed native-library fixture](../backend/tests/fixtures/athena-plugin-registry-native.yaml),
with [provenance](../backend/tests/fixtures/athena-plugin-registry-native.json).
Both representations preserve the same flags on import. This is a real YAML
library check, not complete desktop UI replay.

## Verification and remaining scope

[Backend tests](../backend/tests/test_athena_plugin_registry.py) cover defaults,
order, disabled-converter traps, actual X10C/Lytle retry, staged/project
independence, concurrent saves, failed writes, restart, validation, unknown
entries and native YAML/HTTP exchange. Converter tests now explicitly enable
readers in setup. [Component tests](../frontend/components/athena-plugin-registry.test.tsx)
cover confirmation, errors/reload, import, unknown entries, pending writes and
stale loads. [Chromium](../frontend/tests/e2e/athena-plugin-registry.spec.ts)
recovers the blocked X10C upload, displays its plot, imports it, changes settings
without editing the project, tests a second browser window and exchanges the
native registry. Results and screenshot review are in [verification](athena-verification.md).

The catalog now contains nineteen implemented converters, including the
[SSRL readers](athena-ssrl-reference.md), [SPEC scan lists](athena-spec-reference.md)
and [SRS/DUBBLE/PFBL12C angle readers](athena-angle-readers-reference.md),
plus [CMC/HXMA/LNLS scalar readers](athena-scalar-readers-reference.md) and
[X15B/X23A2MED configured readers](athena-configured-readers-reference.md) and
[X23A2/10BM multichannel projects](athena-multichannel-reference.md), plus
[B18/BM23 column readers](athena-header-readers-reference.md) and the
[Zip list reader](athena-zip-reference.md). System/user extension discovery,
remaining readers, configuration for other plugins and the broader preferences
tree/INI exchange remain required.
Source browsing, other Athena processing/analysis/UI workflows and desktop
replay remain in the full matrix. The registry checkpoint recorded 98 unique sources, including configuration
and the exact YAML reference library. The SSRL checkpoint adds six pinned
source/sample entries for a total of 104. The SPEC checkpoint adds eight
reader-source inspections and one official acquisition for 113 entries;
only SPEC among those eight was implemented at that checkpoint. The following
angle-reader checkpoint implements SRS, DUBBLE and PFBL12C and adds five
official acquisitions, bringing the primary-source manifest to 118 entries.
The scalar-reader checkpoint adds CMC, HXMA and LNLS acquisitions for 121
entries; their three plugin sources were already included in the SPEC source
audit. Native defaults and retained arrays are tested independently of the
web converter.

The configured-reader checkpoint adds ten unique source/sample entries for
**131** total. X15B and X23A2MED now expose functioning Configure forms:
current/saved/default values, session Apply, persistent Apply and Save, reload,
validated inputs and session/revision conflict handling. Save includes other
currently applied reader settings, following native write_ini semantics.
The import panel can reinspect the original selected file after configuration
changes; returning alone retains the staged preview. See the
[configuration contract](athena-configured-readers-reference.md) for the two
native numerical oracles, internal JSON persistence and remaining INI scope.

The [dispersive calibration checkpoint](athena-dispersive-reference.md) adds
SLRIBL4 and native `athena.dxas` settings, bringing the unique primary-source
catalog to 171 entries. Pixel/stripe source inspection requires a saved
calibration; calibration-tool inspection always reads the original pixels.
The official ESRF file exercises the broad native signature, with no claim
that it is an SLRI acquisition. Exact native writer formatting remains open.

The four `Beamlines::{BL8,MX,X11A,XDAC}` modules are XDI metadata enrichers,
separate from the 22 registered file converters. Their acquisition fields,
11 INI defaults, comments, date handling and automatic-identification preference
now have a [native metadata comparison and import workflow](athena-beamline-metadata-reference.md).
The fields appear beside live column previews and in Group information, and
survive web JSON/PRJ-sidecar exchange. Native Xray::XDI serialization, full XDI
round trips and multichannel cloning remain open.

[BL8Ar and SpecFileLongLine](athena-bl8ar-spec-long-reference.md) implement the
remaining two top-level conversions, including the I0 review plot, native
configuration, source retention and live column selection. Constructed probes
match executed native conversion bytes. Measured independent acquisitions
and full desktop replay remain required.
