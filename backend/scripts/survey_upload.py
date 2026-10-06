"""Open scans through the real import path and print what each became.

Usage, from the repository root:
    backend/.venv/bin/python backend/scripts/survey_upload.py series/*.0*

For each file: the reader and beamline it was recognized as, the channels and
the measurement chosen (with the edge contrast that chose it), the reference,
and every inspection warning. Files the importer refuses print the reason.
"""
import pathlib
import sys
import tempfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from xraylarch_web.athena import AthenaStore
from xraylarch_web.athena_file_plugins import plugin_catalog
from xraylarch_web.athena_plugin_registry import PluginRegistry
from xraylarch_web.athena_preferences import AthenaPreferences
from xraylarch_web.config import Settings
from xraylarch_web.errors import WebInputError

for argument in sys.argv[1:]:
    path = pathlib.Path(argument)
    with tempfile.TemporaryDirectory() as room:
        settings = Settings(data_root=pathlib.Path(room))
        AthenaPreferences(settings).save_plugins(
            PluginRegistry(enabled={plugin['id']: True for plugin in plugin_catalog()}))
        store = AthenaStore(settings)
        project = store.create()
        try:
            result = store.inspect(project['id'], path.read_bytes(), path.name)
        except WebInputError as refusal:
            print(f'\n{path.name}\n  REFUSED: {refusal}')
            continue
    if result.get('kind'):
        print(f"\n{path.name}\n  opens as a {result['kind'].replace('_', ' ')}, not a column table")
        continue

    labels = {column['column_id']: column['name'] for column in result['columns']}
    spell = lambda v: [labels.get(i, i) for i in v] if isinstance(v, list) else labels.get(v, v)
    reader = result.get('beamline_reader')
    print(f'\n{path.name}  ({result["row_count"]} rows, {len(result["columns"])} columns)')
    print('  columns:', ', '.join(labels.values()))
    print('  file_plugin:', result.get('file_plugin'))
    for warning in result.get('warnings', []):
        print('  warning:', warning)
    if reader is None:
        print('  NO READER')
        continue
    print(f'  {reader["id"]} | {reader["facility"]} | {reader["beamline"]} ({reader["confidence"]})')
    print('  roles:', {role: spell(value) for role, value in reader['roles'].items()})
    for mode, choice in reader['suggestions'].items():
        print(f'    {mode}: {spell(choice["numerator"])} / {spell(choice["denominator"])}'
              f'  vs {spell(choice["energy_column"])} in {choice["units"]}')
    if reader.get('reference'):
        print('  reference:', {k: spell(v) for k, v in reader['reference'].items()})
    measurement = reader.get('measurement')
    if measurement:
        print(f"  edge contrast at {measurement['edge_energy']:g} eV:", measurement['contrast'])
        for note in measurement['notes']:
            print('   ', note)
    chosen = result['athena_suggestion']
    print('  chosen:', chosen['mode'], spell(chosen['numerator']), '/', spell(chosen['denominator']))
