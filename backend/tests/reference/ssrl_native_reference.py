"""Reproduce numerical references with pinned native Perl converter routines.

Run with backend/.venv/bin/python and --source-root pointing to downloaded
lib-Demeter-Plugins-{SSRLA,SSRLB,SSRLmicro}.pm files. --output-dir must be a
scratch directory. This never modifies the retained fixtures or application.
It runs the converter methods, not the full Moose/Demeter/desktop runtime.
"""
import argparse
import hashlib
import gzip
import json
from pathlib import Path
import struct
import subprocess

import numpy as np


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-root', required=True, type=Path)
    parser.add_argument('--output-dir', required=True, type=Path)
    args = parser.parse_args()
    fixtures = Path(__file__).resolve().parents[1] / 'fixtures'
    repository = Path(__file__).resolve().parents[3]
    primary = json.loads((repository / 'docs/athena-primary-sources.json').read_text())['files']
    manifest = json.loads((fixtures / 'athena-ssrl-fixtures.json').read_text())
    args.output_dir.mkdir(parents=True, exist_ok=True)
    for entry in manifest['references']:
        name = entry['reader']
        path = args.source_root / f'lib-Demeter-Plugins-{name}.pm'
        data = path.read_bytes()
        source_record = next(row for row in primary if row['source'].endswith(f'/lib/Demeter/Plugins/{name}.pm'))
        assert hashlib.sha256(data).hexdigest() == source_record['sha256'], path
        source = data.decode()
        body = source[source.index('sub fix {'):source.index('__PACKAGE__')]
        prefix = 'use File::Spec;\nmy $EPSILON3 = 0.001;\n'
        if name == 'SSRLA': prefix += source[source.index('my %special'):source.index('sub is {')]
        harness = prefix + '''sub file { $ARGV[0] }
sub filename { 'converted.dat' }
sub stash_folder { $ARGV[1] }
sub fixed {}
sub ssrlb_version { $ARGV[2] || 1.1 }
''' + body + "\nfix(bless {}, 'main');\n"
        assert hashlib.sha256(harness.encode()).hexdigest() == entry['harness_sha256']
        driver = args.output_dir / f'{name}.pl'; driver.write_text(harness)
        destination = args.output_dir / name; destination.mkdir(exist_ok=True)
        original = fixtures / f'demeter-{name.lower()}.dat'
        subprocess.run(['perl', str(driver), str(original), str(destination)], check=True)
        converted = destination / 'converted.dat'
        assert hashlib.sha256(converted.read_bytes()).hexdigest() == entry['converted_sha256']
        with np.load(fixtures / entry['file']) as reference:
            np.testing.assert_array_equal(np.loadtxt(converted), reference['columns'])
        browser_data = (fixtures / entry['browser_file']).read_bytes()
        assert hashlib.sha256(browser_data).hexdigest() == entry['browser_sha256']
        np.testing.assert_array_equal(json.loads(gzip.decompress(browser_data)), np.loadtxt(converted))
        print(name, 'native output and retained reference match', entry['shape'])
        if name == 'SSRLB':
            # Construct 2.0 from the same measured floats. This is an encoding
            # probe, not a second independently acquired public data set.
            modern = bytearray(original.read_bytes())
            modern[:40] = modern[:40].replace(b'1.1', b'2.0')
            for pos in range(984, 16224, 4):
                word = modern[pos:pos + 4]
                value = struct.unpack('<f', word[2:4] + word[:2])[0] / 4
                modern[pos:pos + 4] = struct.pack('<f', value)
            modern_path = args.output_dir / 'ssrlb-constructed-v2.dat'; modern_path.write_bytes(modern)
            modern_dest = args.output_dir / 'SSRLB-v2'; modern_dest.mkdir(exist_ok=True)
            subprocess.run(['perl', str(driver), str(modern_path), str(modern_dest), '2.0'], check=True)
            np.testing.assert_array_equal(np.loadtxt(modern_dest / 'converted.dat'), np.loadtxt(converted))
            print('SSRLB constructed 2.0 native output matches measured 1.1 values')


if __name__ == '__main__':
    main()
