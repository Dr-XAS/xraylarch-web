"""Write the beamline coverage table by opening every example file.

The table is read from what the import path actually does with each file, not
from the registry's own list of readers: a reader that is declared but never
fires would otherwise appear as coverage.

Run from the repository root:
  backend/.venv/bin/python backend/scripts/beamline_coverage.py \
      --output docs/beamline-coverage.md
"""
import argparse
import sys
from pathlib import Path
from tempfile import TemporaryDirectory

sys.path[:0] = [str(Path(__file__).resolve().parents[1]), str(Path(__file__).resolve().parent)]

from write_demo_hdf5 import LAYOUT_FILES
from xraylarch_web.athena import AthenaStore
from xraylarch_web.athena_file_plugins import plugin_catalog
from xraylarch_web.athena_plugin_registry import PluginRegistry
from xraylarch_web.athena_preferences import AthenaPreferences
from xraylarch_web.beamline_registry import reader_catalog
from xraylarch_web.config import Settings

ROOT = Path(__file__).resolve().parents[2]
EXAMPLES = ROOT / 'examples' / 'xafsdata'
# Which test file holds the checks for a reader, by the reader's own id.
TESTS = {'xdi': 'test_xdi_reader.py', 'athena-project': 'test_project_and_plugin_readers.py'}
HDF5_READERS = {'bluesky-nexus', 'nxxas', 'esrf-bliss', 'soleil-nexus', 'nxdata'}


def test_file_for(reader_id: str) -> str:
    if reader_id in TESTS:
        return TESTS[reader_id]
    if reader_id in HDF5_READERS:
        return 'test_hdf5_readers.py'
    if reader_id.startswith('plugin-') or reader_id == 'demeter-plugin':
        return 'test_project_and_plugin_readers.py'
    return 'test_beamline_registry.py'


def opened(store, project, path, name=None):
    """What the import path makes of one file: its reader, and whether it imports."""
    name = name or path.name
    try:
        result = store.inspect(project['id'], path.read_bytes(), name)
    except Exception as error:
        return {'name': name, 'error': f'{type(error).__name__}: {error}'}
    if result.get('kind') == 'project':
        return {'name': name, 'reader': {'id': 'athena-project', 'facility': '', 'beamline': '',
                                         'format': result['preview']['format']},
                'importable': bool(result['preview']['groups'])}
    if result.get('kind') == 'scan_list':
        result = result['scans'][0]
    return {'name': name, 'reader': result.get('beamline_reader'),
            'plugin': (result.get('file_plugin') or {}).get('id', ''),
            'importable': bool(result.get('athena_suggestion'))}


def row(entry, example):
    reader = entry.get('reader') or {}
    mark = '—'
    if entry.get('error'):
        mark = f"not read ({entry['error'].split(':')[0]})"
    elif not reader:
        mark = 'opens as plain columns, no beamline named'
    name = reader.get('id', '') or '—'
    if entry.get('plugin'):
        name += f" (converted by {entry['plugin']})"
    return (reader.get('facility', '') or '—', reader.get('beamline', '') or '—',
            reader.get('format', '') or mark, name, example,
            test_file_for(reader.get('id', '')) if reader else '—')


# Files name their facility in their own words, and two spellings of the same
# place are one facility when the question is how wide the coverage is.
ALIASES = {'APS': 'Advanced Photon Source', 'NSLS-II': 'National Synchrotron Light Source II'}


def named_facilities(rows):
    return sorted({ALIASES.get(cells[0], cells[0]) for cells in rows
                   if cells[0] not in ('—', 'not stated in the file')})


def table(header, rows):
    widths = [max(len(str(cell)) for cell in column) for column in zip(header, *rows)] \
        if rows else [len(cell) for cell in header]
    lines = [' | '.join(str(cell).ljust(width) for cell, width in zip(header, widths)).rstrip(),
             '-|-'.join('-' * width for width in widths)]
    for item in rows:
        lines.append(' | '.join(str(cell).ljust(width) for cell, width in zip(item, widths)).rstrip())
    return '\n'.join(f'| {line} |'.replace('|  |', '| |') for line in lines)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()

    with TemporaryDirectory(prefix='beamline-coverage-') as folder:
        room = Path(folder)
        settings = Settings(data_root=room / 'store')
        AthenaPreferences(settings).save_plugins(
            PluginRegistry(enabled={plugin['id']: True for plugin in plugin_catalog()}))
        store = AthenaStore(settings)
        project = store.create()

        rows, synthetic, covered = [], [], set()

        def record(entry, example, into):
            into.append(row(entry, example))
            covered.add((entry.get('reader') or {}).get('id', ''))
            if entry.get('plugin'):
                covered.add(f"plugin-{entry['plugin'].lower()}")

        files = [*sorted((EXAMPLES / 'beamlines').iterdir()),
                 *sorted(EXAMPLES.glob('*.xdi')),
                 EXAMPLES / 'AthenaProjectFiles' / 'cu.prj']
        for path in files:
            record(opened(store, project, path), f'`examples/xafsdata/.../{path.name}`', rows)
        for layout, write in sorted(LAYOUT_FILES.items()):
            path = write(room / f'{layout}.nxs')
            record(opened(store, project, path),
                   f'synthetic, `write_demo_hdf5.py` ({layout})', synthetic)

    missing = [(item['facility'] or '—', item['beamline'] or '—', item['format'], item['id'],
                'none in this repository', test_file_for(item['id']))
               for item in reader_catalog() if item['id'] not in covered]

    facilities = named_facilities(rows)
    only_synthetic = sorted(set(named_facilities(synthetic)) - set(facilities))
    header = ('Facility', 'Beamline', 'Format', 'Reader', 'Example file', 'Test')
    text = f"""# Which beamlines web Larch can open

Every row below was produced by running the file through the same import path
the browser uses, with all of Demeter's file readers enabled, so a reader that
is declared but never fires does not appear here as coverage. Regenerate the
table with:

    backend/.venv/bin/python backend/scripts/beamline_coverage.py \\
        --output docs/beamline-coverage.md

The "Reader" column names the registry entry that identified the file. Where a
Demeter file reader converted the file first -- which is how a beamline that
says nothing about itself in its header gets named at all -- that reader is
named too, and it has to be enabled in the import preferences for the file to
open that way.

## Real files, in this repository

{len(facilities)} facilities are represented by a real file that opens here: {'; '.join(facilities)}.

The Facility column below repeats whatever each file calls its own facility,
so the same place appears under more than one name ({', '.join(f'"{short}" and "{full}"' for short, full in sorted(ALIASES.items()))});
the count above treats those as one facility each.

{table(header, rows)}

Two rows name no beamline, both correctly. `generic_columns_no_header.dat` has
no header at all, so there is nothing to identify and it opens as plain
columns. `FDMNES_2022_Mo2C_out.dat` is raw FDMNES output, whose multi-row
header the column parser rejects; the convolved output beside it
(`..._conv.dat`) opens normally, and that is the file an analysis would use.

## Synthetic NeXus files, one per documented layout

No public HDF5 example from these facilities could be fetched into this
environment and the repository carries none, so
`backend/scripts/write_demo_hdf5.py` writes one file per documented layout,
each with a Mn K edge of known height. They show that the reader walks the
layout and maps the channels; they are **not** evidence that it opens that
facility's real files. They add {len(only_synthetic)} further facilities: {'; '.join(only_synthetic)}.

{table(header, synthetic)}

The Bluesky reader was written against one APS Bluesky export that cannot be
published; it is not in the repository and no test reads it.

## Recognized, but with no example file here

These beamlines are named when a file of theirs arrives, from the header
patterns or from one of Demeter's file readers, but nothing in the repository
exercises them.

{table(header, missing)}
"""
    args.output.write_text(text)
    print(f'{len(rows)} files, {len(facilities)} facilities -> {args.output}')


if __name__ == '__main__':
    main()
