"""Execute pinned CMC/HXMA/LNLS is/fix/suggest methods against retained oracles.

Moose constructors and XDI hooks are not executed. Numeric oracles exclude
headers because HXMA writes the absolute input path into its output header.
"""
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
use Scalar::Util qw(looks_like_number);
my %attrs = (beamline=>'',is_transmission=>0,is_datetime=>0);
sub file { $ARGV[0] }
sub filename { 'converted.dat' }
sub stash_folder { $ARGV[1] }
sub fixed {}
sub beamline { $attrs{beamline}=$_[1] if @_>1; return $attrs{beamline} }
sub is_transmission { $attrs{is_transmission}=$_[1] if @_>1; return $attrs{is_transmission} }
sub is_datetime { $attrs{is_datetime}=$_[1] if @_>1; return $attrs{is_datetime} }
'''
    return prefix + source[source.index('sub is {'):source.index('__PACKAGE__')] + "\nmy $obj = bless {}, 'main'; my $recognized=is($obj); fix($obj); print JSON::PP->new->encode({recognized=>$recognized,attrs=>\\%attrs,default=>{suggest($obj)},transmission=>{suggest($obj,'transmission')},fluorescence=>{suggest($obj,'fluorescence')}});\n"


def execute(source, input_path, folder):
    folder.mkdir(parents=True, exist_ok=True)
    script = folder / 'native.pl'; script.write_text(driver(source))
    result = subprocess.run(['perl', str(script), str(input_path.resolve()), str(folder.resolve())],
                            capture_output=True, text=True, timeout=30, check=True)
    assert not result.stderr, result.stderr
    return json.loads(result.stdout), np.loadtxt(folder / 'converted.dat', ndmin=2).tolist()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-root', type=Path, required=True)
    parser.add_argument('--output-dir', type=Path, required=True)
    args = parser.parse_args()
    fixtures = Path(__file__).resolve().parents[1] / 'fixtures'
    primary = json.loads((Path(__file__).resolve().parents[3] / 'docs/athena-primary-sources.json').read_text())['files']
    manifest = json.loads((fixtures / 'athena-scalar-fixtures.json').read_text())
    sources = {}
    for entry in manifest['references']:
        name, reader = entry['sample'], entry['reader']
        source = (args.source_root / f'lib-Demeter-Plugins-{reader}.pm').read_bytes()
        recorded = next(v for v in primary if v['source'].endswith(f'/lib/Demeter/Plugins/{reader}.pm'))
        assert hashlib.sha256(source).hexdigest() == recorded['sha256']
        sources[reader] = source.decode()
        assert hashlib.sha256(driver(sources[reader]).encode()).hexdigest() == entry['harness_sha256']
        raw = fixtures / f'demeter-{name}.dat'
        original = next(v for v in manifest['files'] if v['file'] == raw.name)
        assert hashlib.sha256(raw.read_bytes()).hexdigest() == original['sha256']
        native, columns = execute(sources[reader], raw, args.output_dir / name)
        retained = (fixtures / entry['file']).read_bytes()
        assert hashlib.sha256(retained).hexdigest() == entry['sha256']
        assert native == entry['native']
        np.testing.assert_array_equal(columns, json.loads(gzip.decompress(retained)))
        print(name, entry['shape'], 'all native columns and suggestions match')
    record = manifest['probes']; encoded = (fixtures / record['file']).read_bytes()
    assert hashlib.sha256(encoded).hexdigest() == record['sha256']
    for probe in json.loads(gzip.decompress(encoded)):
        folder = args.output_dir / probe['name']; folder.mkdir(parents=True, exist_ok=True)
        raw = folder / 'input.dat'; raw.write_text(probe['input'])
        native, columns = execute(sources[probe['reader']], raw, folder)
        assert native == probe['native']
        np.testing.assert_array_equal(columns, probe['columns'])
        print(probe['name'], 'constructed input, native columns and suggestions match')


if __name__ == '__main__':
    main()
