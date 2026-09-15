"""Re-run pinned native angle-file converters and verify retained references.

Only native is/fix/suggest and their helper methods run. Moose construction
and DUBBLE's XDI metadata hook are not executed. Original methods are unchanged.
"""
import argparse
import gzip
import hashlib
import json
from pathlib import Path
import subprocess

import numpy as np


def driver(source, reader):
    prefix = '''use File::Spec;
use Scalar::Util qw(looks_like_number);
use JSON::PP;
my $PI = 4*atan2(1,1);
my $HBARC = 1973.27053324;
my $TWOD = 2*3.13543;
my $NLMED = 3;
my $HC = 12398.52;
my %attrs = (is_med=>0,nelements=>0,xaxis=>'encoder',is_dubble=>0);
sub file { $ARGV[0] }
sub filename { 'converted.dat' }
sub stash_folder { $ARGV[1] }
sub fixed {}
sub is_med { $attrs{is_med}=$_[1] if @_>1; return $attrs{is_med} }
sub nelements { $attrs{nelements}=$_[1] if @_>1; return $attrs{nelements} }
sub xaxis { $attrs{xaxis}=$_[1] if @_>1; return $attrs{xaxis} }
sub is_dubble { $attrs{is_dubble}=$_[1] if @_>1; return $attrs{is_dubble} }
'''
    end = source.index("after 'add_metadata'") if reader == 'DUBBLE' else source.index('__PACKAGE__')
    return prefix + source[source.index('sub is {'):end] + "\nmy $obj = bless {}, 'main'; my $recognized = is($obj); fix($obj); print JSON::PP->new->encode({recognized=>$recognized,attrs=>\\%attrs,transmission=>{suggest($obj,'transmission')},fluorescence=>{suggest($obj,'fluorescence')}});\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-root', required=True, type=Path)
    parser.add_argument('--output-dir', required=True, type=Path)
    args = parser.parse_args()
    fixtures = Path(__file__).resolve().parents[1] / 'fixtures'
    primary = json.loads((Path(__file__).resolve().parents[3] / 'docs/athena-primary-sources.json').read_text())['files']
    manifest = json.loads((fixtures / 'athena-angle-fixtures.json').read_text())
    for ref in [*manifest['references'], dict(manifest['srsc_native_failure'], sample='srsc', reader='SRS')]:
        name, reader = ref['sample'], ref['reader']
        source = (args.source_root / f'lib-Demeter-Plugins-{reader}.pm').read_bytes()
        entry = next(v for v in primary if v['source'].endswith(f'/lib/Demeter/Plugins/{reader}.pm'))
        assert hashlib.sha256(source).hexdigest() == entry['sha256']
        harness = driver(source.decode(), reader)
        assert hashlib.sha256(harness.encode()).hexdigest() == ref['harness_sha256']
        folder = args.output_dir / name; folder.mkdir(parents=True, exist_ok=True)
        script = folder / 'native.pl'; script.write_text(harness)
        raw = fixtures / f'demeter-{name}.dat'
        original = next(v for v in manifest['files'] if v['file'] == raw.name)
        assert hashlib.sha256(raw.read_bytes()).hexdigest() == original['sha256']
        result = subprocess.run(['perl', str(script), str(raw), str(folder)], capture_output=True, text=True, timeout=30)
        if name == 'srsc':
            assert result.returncode != 0 and 'Illegal division by zero' in result.stderr
            print('srsc: native division-by-zero failure reproduced; no native array claimed')
            continue
        assert result.returncode == 0, result.stderr
        assert json.loads(result.stdout) == ref['native']
        output = folder / 'converted.dat'
        assert hashlib.sha256(output.read_bytes()).hexdigest() == ref['converted_sha256']
        retained = (fixtures / ref['file']).read_bytes()
        assert hashlib.sha256(retained).hexdigest() == ref['sha256']
        np.testing.assert_array_equal(np.loadtxt(output), json.loads(gzip.decompress(retained)))
        print(name, ref['shape'], 'native conversion and suggestions match retained reference')
        if name == 'dubble':
            # The generic reader is a real native fallback, with different
            # channel choices even though conversion produces the same values.
            generic_source = (args.source_root / 'lib-Demeter-Plugins-SRS.pm').read_bytes()
            generic_record = next(v for v in primary if v['source'].endswith('/lib/Demeter/Plugins/SRS.pm'))
            assert hashlib.sha256(generic_source).hexdigest() == generic_record['sha256']
            generic_folder = args.output_dir / 'dubble-srs'; generic_folder.mkdir(exist_ok=True)
            generic_script = generic_folder / 'native.pl'; generic_script.write_text(driver(generic_source.decode(), 'SRS'))
            generic = subprocess.run(['perl', str(generic_script), str(raw), str(generic_folder)],
                                     capture_output=True, text=True, timeout=30, check=True)
            expected_generic = manifest['dubble_srs_fallback']
            assert json.loads(generic.stdout) == expected_generic['native']
            generic_output = generic_folder / 'converted.dat'
            assert hashlib.sha256(generic_output.read_bytes()).hexdigest() == expected_generic['converted_sha256']
            np.testing.assert_array_equal(np.loadtxt(generic_output), np.loadtxt(output))
            print('dubble: generic SRS fallback arrays and seven-channel suggestion verified')
        if name == 'pfbl12c':
            probe_folder = args.output_dir / 'pf-default'; probe_folder.mkdir(exist_ok=True)
            probe = probe_folder / 'input.dat'
            probe.write_bytes(raw.read_bytes().replace(b'D=  3.13551 A', b'monochromator spacing absent'))
            subprocess.run(['perl', str(script), str(probe), str(probe_folder)],
                           capture_output=True, text=True, timeout=30, check=True)
            probe_output = probe_folder / 'converted.dat'; expected_probe = manifest['pf_missing_spacing']
            assert hashlib.sha256(probe_output.read_bytes()).hexdigest() == expected_probe['converted_sha256']
            encoded = (fixtures / expected_probe['file']).read_bytes()
            assert hashlib.sha256(encoded).hexdigest() == expected_probe['sha256']
            values = np.loadtxt(probe_output)
            np.testing.assert_array_equal(values[:,:2], json.loads(gzip.decompress(encoded)))
            np.testing.assert_array_equal(values[:,2:], np.loadtxt(output)[:,2:])
            print('pfbl12c: native missing-spacing fallback 2D=1 verified')


if __name__ == '__main__':
    main()
