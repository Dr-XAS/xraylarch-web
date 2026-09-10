# Athena CMC, HXMA and LNLS scalar readers

Source contract, 2026-09-10. This advances IM-01, IM-03 and IM-10 in the
[107-row Athena matrix](athena-parity.md). Full parity remains open; no row
is certified Verified. Artemis remains excluded.

## Sources and independent numerical evidence

The unchanged native `is`, `fix`, `suggest` and helper routines from
[CMC.pm](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/Plugins/CMC.pm),
[HXMA.pm](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/Plugins/HXMA.pm)
and [LNLS.pm](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/Plugins/LNLS.pm)
were executed with minimal accessor stubs. Native IO calls `suggest()` without
an argument, so the default must be compared independently from the explicit
transmission/fluorescence suggestions. Moose construction and XDI metadata
hooks were not executed; this is not full Athena desktop replay.

Three public acquisitions were downloaded from the pinned repository and
verified against its Git tree. Their original bytes, SHA-256, Git blob hash,
source URL and native numerical references are retained in the
[fixture manifest](../backend/tests/fixtures/athena-scalar-fixtures.json).

| Official file | Raw numeric width | Native converted table | Default signal |
| --- | --- | --- | --- |
| `t/filetypes/cmc.dat` | 36 | 258 × 13 | ln(abs(I0/I1)); I1 is zero in this acquisition |
| `t/filetypes/hxma.dat` | 11 | 414 × 5 | ln(abs(I0/It)) |
| `t/filetypes/lnls.dat` | 8 plus date/time | 999 × 8 | Ge15 / Curta |

All **13,416 converted values** match native output exactly after actual
Larch `read_ascii`. Headers intentionally retain more provenance and are not
byte-identical to native output. HXMA native headers contain the absolute
input path; its path-independent numerical oracle is compared separately.

## CMC dark current and channel choices

The fourth line identifies `bmexafs` or `9bmuser`. Energy, I0–I2, Iref, Lytle
and MCA columns are retained in source order. Other PV columns remain in the
original download. Logical labels separated by multiple spaces preserve
multiword auxiliary names; the official source has three such counter labels.

For each matching offset column, the first row determines a dark-current
rate:

```
rate = (first_counts - first_offset * first_time) / first_time
corrected_counts[row] = raw_counts[row] - rate * time[row]
```

The last source column supplies each integration time. The official sample's
I0/I1/I2 rates are **136, 0, 101 counts/s**. Later offset PVs do not recompute
these rates. Missing matching offsets leave counts unchanged. A zero first
integration time fails when division is needed; absent offsets do not require
that division. Native matching is case-sensitive after case-insensitive
recognition: upper-case ion names are retained without subtraction. The
conversion summary identifies missing offsets and this case distinction.

Native NaN-to-zero replacement is retained and reported, including NaNs caused
by a nonfinite first-point dark rate. Metadata records replacement counts and
source positions. Unused nonfinite PVs are diagnostic data; nonfinite retained
values other than the native NaN replacement, or nonfinite integration times,
produce explicit errors. No point is silently dropped.

Native fluorescence uses **MCA2 + MCA3 + MCA4 + MCA5 + MCA6 + MCA8**, divided
by I0. MCA1 and MCA7 remain available for manual inclusion, with live preview.
The official measurement has a zero transmission denominator and only a
40 eV scan range. Its initial transmission preview correctly reports zero
counts. Choose **Use fluorescence columns**, then **Data type → XANES · short
energy range** to preview and process it. Detector selection and data type
are explicit user choices; the file reader does not silently replace them.

## CLS named and fallback scalar columns

HXMA recognizes `CLS Data Acquisition`. The first `Event-ID` header names
the source PV columns; the later placeholder header does not replace it.
For identified HXMA records, the converter selects `Energy:sp`, `mcs04:fbk`,
`mcs05:fbk`, `mcs06:fbk`, `mcs03:fbk`, labelled energy, I0, It, Ir and Lytle.
The measured source indices are 4, 6, 7, 8 and 5 (one-based).

SXRMB and tables without named PV headers use native fallback behavior:
remove only the leading event ID and retain all other scalar columns. The
native fixed suggestions still use columns 1/2/3/5, so the fallback summary
asks users to review them. SXRMB and absent-header evidence here uses
constructed variants, not additional public acquisitions. Named HXMA tables
with missing required PVs fail explicitly rather than taking the event ID
as the missing detector. Comma/whitespace scalar separators are accepted.
Offsets are not subtracted. Raw PV labels, retained/omitted indices, original
bytes and the converted numerical table remain available.

## LNLS date/time and written precision

The reader recognizes the native tab-separated Data/Hora header or dated
records. It removes the leading date/time values from the numeric table and
retains both full vectors in source metadata. The 999 original pairs survive
local restart, JSON exchange and PRJ exchange. Dates are retained as written;
no calendar or timezone interpretation changes them.

A header containing `Fluorescencia` defaults to column 5 / column 2, as does
headerless dated input. A Data/Hora header without that label forces native
transmission column 2 / column 3. Headerless output has generic numeric labels.
The real source's last `Fluorescencia` column is already a ratio; it can be
selected directly and differs in written precision from computing Ge15/Curta.

The native `isfloat` regular expression has an unescaped dot. Unsigned decimal
tokens are printed with four fractional digits; negative decimal and most
scientific tokens preserve their source text. For example, `1e06` matches the
native pattern while `1.2345e-03` does not. These details are checked against
executed native output, not re-created expectations from the web converter.

## Reproduction, integration and scope

The [native reproducer](../backend/tests/reference/scalar_native_reference.py)
checks source, fixture and harness hashes, re-executes all three original
acquisitions and twelve retained constructed probes, then compares every
numeric value and default/explicit suggestion:

```bash
backend/.venv/bin/python backend/tests/reference/scalar_native_reference.py \
  --source-root /tmp/athena-column-sources --output-dir /tmp/scalar-reproduced
```

Enable the reader in **File → Plugin registry…** before inspection. All three
use the existing live column preview, detector edits, original/converted
downloads, processing, undo/redo, restart and saved-project exchange. Backend
coverage is in [scalar tests](../backend/tests/test_athena_scalar_files.py);
browser coverage is in [scalar flows](../frontend/tests/e2e/athena-scalar-files.spec.ts).
Exact execution counts and screenshot findings are in
[verification](athena-verification.md).

Malformed widths, damaged numeric records, missing necessary declarations,
encoding errors and resource excesses fail without partial project writes.
These validations intentionally avoid native silent corruption or undefined
column fallbacks. Full XDI metadata mapping, every beamline variant, further
native readers, extension discovery/configuration and remaining Athena
processing/analysis/UI workflows remain required. Original attachments are
available locally; complete attachment packaging in saved projects remains
separate open work.
