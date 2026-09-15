# Athena SSRL file readers

Source contract, 2026-09-10. This advances IM-01, IM-03 and IM-10 in the
[full Athena matrix](athena-parity.md). No requirement is certified Verified.
Artemis remains excluded.

## Native sources and measured inputs

All sources are pinned to Demeter
`06afc8da08a5a7d5a26ee14992170fcf5dc67406`. The
[SSRL fixture manifest](../backend/tests/fixtures/athena-ssrl-fixtures.json)
records source URLs, SHA-256 hashes, Git blob identities and byte counts.
The general [source manifest](athena-primary-sources.json) includes all three
reader modules and public acquisitions.

| Reader | Native implementation | Official acquisition | Converted observations |
| --- | --- | --- | --- |
| SSRLA 0.2 | [SSRLA.pm](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/Plugins/SSRLA.pm) | [ssrla.dat](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/t/filetypes/ssrla.dat), 31,074 bytes; Ag:Cys / Ag foil, TRANS.DET | 455 × 6 |
| SSRLB 0.2 | [SSRLB.pm](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/Plugins/SSRLB.pm) | [ssrlb.dat](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/t/filetypes/ssrlb.dat), 16,384 bytes; Mo acquisition, Data Collector 1.1 | 635 × 6 |
| SSRLmicro 0.1 | [SSRLmicro.pm](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/Plugins/SSRLmicro.pm) | [ssrlmicro.dat](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/t/filetypes/ssrlmicro.dat), 142,689 bytes; MicroEXAFS 1.0, 32 SCA plus 32 ICR channels | 296 × 37 from 69 source columns |

These are original public acquisitions, not synthetic spectra. In total,
**1,386 observations and 17,492 retained column values** match native converter
output exactly after real Larch reading.

## Recognition, conversion and column suggestions

Enable the relevant reader under **File → Plugin registry…**. Recognition
uses the collector signature before extension handling. SSRLA additionally
checks that its second line has no NUL byte; SSRLB checks the fixed first
40-byte title and NUL-containing second record. MicroEXAFS has its own title.

SSRLA reads the variable `Data:` label block up to its blank terminator,
moves achieved energy before requested energy and the real-time clock, and
emits the native four decimal places. It applies the native achieved-energy
threshold: values below 0.001 eV are omitted, with the omitted source row
numbers and count retained in conversion metadata. Other damaged rows are
rejected, not silently treated as headers or padding. ROBL Latin-1 copyright
and degree symbols are converted to readable ASCII in the transformed copy.

SSRLB reads the fixed 800-byte header, offset/weight records, 20-byte labels,
point-count record and declared observation table. Before collector 2.0, the
two 16-bit words of each float are swapped and the decoded value is divided
by four. Collector 2.0 uses little-endian IEEE floats directly. Output uses
native three-decimal formatting, with achieved energy first. The original
fixture's 160 trailing NUL bytes are accepted. Incomplete records, conflicting
counts, nonfinite observations and unexpected nonzero trailing bytes produce
explicit errors. Declared resource bounds are checked before decoding arrays.

MicroEXAFS moves energy before the clock, retains detector columns followed
by SCA columns, omits ICR columns and changes native labels such as `SCA1.1`
to `S1_1`. Every source row and every source value, including omitted ICR
channels, is validated. The input permits one ICR companion per retained
channel within the bounded source-column budget; the converted table obeys
the normal column limit. Original bytes retain the complete 69-column table.
The web does not invent an ICR correction or substitute ICR for fluorescence.

The default transmission suggestions match the native plugins. Explicit
**Use transmission columns** and **Use fluorescence columns** controls expose
the corresponding plugin suggestions, update the live expression/plot, and
retain independent data-type, reference and preprocessing choices. Applying a
suggestion switches off individual-channel import; users can then select a
channel range and choose sum or individual groups. Unavailable suggestions
are omitted for shorter layouts. Ordinary Measurement/log changes continue to
preserve manually selected detector columns.

The real MicroEXAFS fixture has zero I1/I2 counts. Its default transmission
mapping produces a recoverable zero-denominator error. Fluorescence column
6 / column 3 works; selecting columns 6–37 sums all 32 SCA channels over I0.
Conversely, the ASCII and binary fixtures are transmission acquisitions.
Their optional I2/I0 ratio is preserved when explicitly selected, but has a
negative fitted absorption step. The app retains those raw values and an
explicit processing error, rather than changing their sign or fabricating a
normalization result. Browser checks return to the valid transmission mapping
before importing these fixtures.

## Original data, metadata and native differences

The source download remains byte-identical. Converted text has a separate
download and preview. Binary source previews show the first 512 bytes in hex,
with clear truncation and access to the entire original file. Converted
columns, source/converted hashes, source labels, column order, native decimal
precision and omitted channel/row records survive JSON and PRJ exchange.
Standalone original-file attachments are still local staged files and are
not yet bundled into exported projects.

Detector offsets and weights are never applied by these native readers.
Complete ASCII offset tables are reordered to match the converted columns.
Incomplete diagnostic tables remain as original header text; the public micro
fixture has 67 offsets for 69 labels. Native SSRLmicro attempts its header
reorder before identifying detector columns and prints only the first two
offsets. The web preserves incomplete diagnostics instead, and uses the full
known order for complete tables. Scientific arrays are identical in either
case. The native binary plugin displays offset/weight bytes as native IEEE
floats even for the legacy word ordering; the web retains that diagnostic
presentation, including nonfinite text if encountered, without applying it
to or invalidating finite observations.

Strict malformed-row, count and trailing-data rejection are explicit web
validation differences from the native converter's permissive read/printf
loop. No claim of byte-identical converted headers or desktop UI replay is
made.

## Reproducing the native numerical reference

The checked-in NPZ and compressed JSON reference arrays come from actually
running each pinned Perl `fix` method and its unchanged helper methods. The
small harness supplies fixture file paths, a stash directory, the collector
version and EPSILON3, replacing Moose accessors only. This is execution of the
native conversion routines, not the full Demeter application.

With the pinned source files downloaded under their slash-to-hyphen names:

```bash
backend/.venv/bin/python backend/tests/reference/ssrl_native_reference.py \
  --source-root /tmp/athena-column-sources \
  --output-dir /tmp/athena-ssrl-reproduced
```

The [reproducer](../backend/tests/reference/ssrl_native_reference.py) checks
source/harness/output hashes and both stored array formats. It additionally
re-encodes the measured 1.1 binary values as a **constructed 2.0 encoding
probe**, runs the actual native 2.0 path, and compares all values. No public
2.0 acquisition or complete installed desktop run is claimed.

Perl/Python numeric formatting and JavaScript `toFixed` differ at exact half
units. For example, native three-decimal output is 20019.562 for 20019.5625.
Browser tests consume the actual native references; they do not derive
expected native rounding with JavaScript.

[Backend regressions](../backend/tests/test_athena_ssrl_plugins.py) cover full
arrays, live column arithmetic, zero-transmission recovery, 32-channel sums
and independent previews, actual Larch processing, errors, downloads,
restart, undo and project exchange. The
[browser flows](../frontend/tests/e2e/athena-ssrl.spec.ts) change detector
columns, inspect real Plotly curves, download both files, plot E/k/R/q, save
and restore PRJ and reload. Results are recorded in
[verification](athena-verification.md).

The full native reader collection, extension discovery, configuration,
remaining import resource/layout variants, other Athena processing and
analysis workflows and full desktop replay remain required.
