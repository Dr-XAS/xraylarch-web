# Athena acquisition metadata and processing history

This continues the Athena-only IO-01 requirement. It does not establish complete
Athena parity or add Artemis. The [metadata manual](https://bruceravel.github.io/demeter/documents/Athena/other/meta.html)
requires acquisition fields and user comments to survive projects and output
headers. The implementation also follows the native processing-history calls
in pinned Demeter `06afc8da08a5a7d5a26ee14992170fcf5dc67406`.

## Native behavior and scope

[`Data/XDI.pm::xdi_make_clone`](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/Data/XDI.pm#L241)
deep-clones XDI metadata, updates the absorber/edge, optionally removes scan
times and appends a semicolon-separated processing description. Negative time
removal deletes only the end time; positive removal deletes both. With no
removal, the original acquisition times remain. Perl treats `"0"` as false.
A plain copy of nonempty history appends a trailing `; `, which is preserved.

The pinned callers establish these mappings:

| Operation | History addition | Acquisition times |
| --- | --- | --- |
| Group copy and Copy series | Empty text, using native copy semantics | Keep both |
| Rebin, including column import | `Data rebinned onto a three-region energy grid` | Keep both |
| Merge | `Merge of N scans` | Keep primary start, remove end |
| Difference | `Difference spectrum` | Keep both |
| Multi-electron excitation removal | `Removed multi-electron excitation` | Keep both |

Sources are [Process.pm](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/Data/Process.pm),
[Diff.pm](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/Diff.pm#L148),
[Group.pm](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/UI/Athena/Group.pm),
[Series.pm](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/UI/Athena/Series.pm)
and [IO.pm](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/UI/Athena/IO.pm#L634).
Source hashes are in the [primary catalog](athena-primary-sources.json).

Other existing web operations now retain metadata too: smoothing,
deglitching, truncation, convolution, deconvolution, self-absorption, weighted
sum and dispersive calibration. Their descriptions name the actual web
operation; they are not claims that the corresponding native caller uses those
strings. The [smoothing panel](athena-smoothing-reference.md) now has explicit
boxcar/Gaussian algorithms with their native descriptions and Larch SG and
three-point algorithms with truthful history. The legacy method-less API
retains generalized SG and never receives a boxcar/Gaussian description.
Native Summer has no explicit XDI clone/history call. These web
operations preserve acquisition times, and combinations use the primary input's
metadata. Their separate numerical/UI parity requirements remain open.

Import-time rebin records one operation for each independently rebinned sample
and reference. Native IO first clones the already-rebinned sample metadata into
the reference, then can rebin the reference, producing two history additions.
The web records only the rebin actually applied to each channel. The original
column preview remains read-only.

## Implementation and exchange

[`athena_xdi_history.py`](../backend/xraylarch_web/athena_xdi_history.py)
copies acquisition fields, exact saved comments, version information and
original column descriptors/counts. It uses the current absorber identity.
Original source metadata stays unchanged. Separate detector arrays are never
mistaken for transformed observations: rebin explicitly transforms its retained
detector signals and stores original columns under its original-data record;
other changed-grid operations do not attach the old table to the new grid.
Native C handles and reader-error state are not copied.

Ordinary ASCII groups can start processing history even without recognized
beamline headers. Dispersive calibration inherits metadata from the pixel
upload; the conventional standard supplies calibration rather than acquisition
fields. The new group receives no invented acquisition timestamp.

**Group → File metadata…** presents acquisition times and the exact accumulated
`Scan.process` text. It explains inherited column metadata, while keeping user
comments editable and independent of group notes. Native PRJ export carries the
history in its real `$xdi` object. Reimport works after removing every
`# Athena-Web` sidecar line. Current-group and per-group column exports include
the corresponding Scan family. Combined marked-column files continue to use
their separate native header contract; this work does not claim that a single
Scan family describes every column in a multi-scan table.

## Executed reference and regression evidence

The [reference harness](../backend/tests/reference/xdi_history_native_reference.py)
uses the unchanged native clone function, real Xray::XDI 1.00, its C reader,
Moose clone and Perl serializer. Only the group's three metadata accessors are
bridged. It runs both official Cu/Fe XDI measurements with controlled header
probes: absent/nonempty/`0` history; copy, correction, merge, difference and
positive timestamp removal. The latter is a primitive probe, not a claimed
Athena UI command. It also executes web-generated inert test literals through
actual Xray::XDI methods; uploaded projects are never evaluated as Perl.

All **30 native object snapshots** match the web clone field for field. The
same 30 web literals are read and serialized by real Perl objects. A fresh
default replay matches the [recorded oracle](../backend/tests/fixtures/athena-xdi-history-native.json.gz)
exactly. The [manifest](../backend/tests/fixtures/athena-xdi-history-fixtures.json)
pins the harness, measured files, source routines, oracle and modules actually
loaded by Perl.

The initial unseeded replay was not stable: Moose's traversal can trigger a
source-file reread and overwrite modified metadata, and Data::Dumper ordering
also varies. The reproducible reference uses `PERL_HASH_SEED=0` and
`PERL_PERTURB_KEYS=0`, without editing native code. Other native hash orders and
the complete desktop lifecycle are not covered by this equivalence claim.
The web always preserves the captured metadata without reopening a source path.

```bash
PYTHONPATH=backend backend/.venv/bin/python backend/tests/reference/xdi_history_native_reference.py \
  --sources /tmp/athena-xdi-history-sources \
  --environment /tmp/athena-xdi-runtime/environment.json \
  --output /tmp/athena-xdi-history-native-confirm
```

[Backend tests](../backend/tests/test_athena_xdi_history.py) cover native fields,
all connected transformations, independent comments/current identity, frozen
sources, multi-operation history, atomic failure, Undo/Redo, restart, import
rebin, the independent Larch Athena reader, bare PRJ restore and column headers.
[Component tests](../frontend/components/athena-xdi-controls.test.tsx) cover
read-only history, literal rendering, refresh and existing comment controls.
[Browser tests](../frontend/tests/e2e/athena-xdi-history.spec.ts) cover actual
desktop/mobile import previews, comment editing, MEE preview/save, history,
Undo/Redo and native-only PRJ download/reimport. Run outcomes and visual
inspection are recorded in the [verification log](athena-verification.md).

Exhaustive acquisition plugins/validation, complete native GUI exchange and the
remaining 107-row Athena matrix are not proven by these checks.
