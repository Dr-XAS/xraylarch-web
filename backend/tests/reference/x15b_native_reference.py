"""Run native X15B is/fix/suggest with supplied native configuration values."""
import argparse
import gzip
import hashlib
import json
from pathlib import Path
import subprocess

import numpy as np


def driver(source):
    prefix = '''use File::Spec;
use JSON::PP;
our %params = %{decode_json($ARGV[2])};
package Demeter;
sub co { bless {}, 'NativeConfiguration' }
package NativeConfiguration;
sub default { $main::params{$_[2]} }
package main;
sub file { $ARGV[0] }
sub filename { 'converted.dat' }
sub stash_folder { $ARGV[1] }
sub fixed {}
'''
    return prefix + source[source.index('sub is {'):source.index('__PACKAGE__')] + "\nmy $obj=bless {}, 'main'; my $recognized=is($obj); fix($obj); print JSON::PP->new->encode({recognized=>$recognized,default=>{suggest($obj)},transmission=>{suggest($obj,'transmission')},fluorescence=>{suggest($obj,'fluorescence')}});\n"


def execute(source, raw, folder, values):
    folder.mkdir(parents=True, exist_ok=True)
    script = folder / 'native.pl'; script.write_text(driver(source))
    result = subprocess.run(['perl', str(script), str(raw.resolve()), str(folder.resolve()), json.dumps(values)],
                            check=True, capture_output=True, text=True, timeout=30)
    assert not result.stderr, result.stderr
    return json.loads(result.stdout), np.loadtxt(folder / 'converted.dat').tolist()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-root', type=Path, required=True)
    parser.add_argument('--output-dir', type=Path, required=True)
    args = parser.parse_args()
    fixtures = Path(__file__).resolve().parents[1] / 'fixtures'
    manifest = json.loads((fixtures / 'athena-x15b-fixtures.json').read_text())
    primary = json.loads((Path(__file__).resolve().parents[3] / 'docs/athena-primary-sources.json').read_text())['files']
    source = (args.source_root / 'lib-Demeter-Plugins-X15B.pm').read_bytes()
    entry = next(v for v in primary if v['source'].endswith('/lib/Demeter/Plugins/X15B.pm'))
    assert hashlib.sha256(source).hexdigest() == entry['sha256']
    assert hashlib.sha256(driver(source.decode()).encode()).hexdigest() == manifest['harness_sha256']
    raw = fixtures / manifest['file']['file']
    assert hashlib.sha256(raw.read_bytes()).hexdigest() == manifest['file']['sha256']
    for ref in manifest['references']:
        native, columns = execute(source.decode(), raw, args.output_dir / ref['name'], ref['values'])
        encoded = (fixtures / ref['file']).read_bytes()
        assert hashlib.sha256(encoded).hexdigest() == ref['sha256']
        assert native == ref['native']
        np.testing.assert_array_equal(columns, json.loads(gzip.decompress(encoded)))
        print(ref['name'], ref['shape'], 'native configured columns and suggestions match')


if __name__ == '__main__':
    main()
