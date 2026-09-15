"""Re-run pinned SPEC::fix with fixture path accessors, outside the desktop UI.

Use --source pointing to the pinned SPEC.pm. Numerical references and hashes
are verified, never overwritten. Output files live in a temporary directory.
"""
import argparse
import gzip
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile

import numpy as np


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True, type=Path)
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[3]
    fixtures = Path(__file__).resolve().parents[1] / 'fixtures'
    primary = json.loads((repo / 'docs/athena-primary-sources.json').read_text())['files']
    record = next(row for row in primary if row['source'].endswith('/lib/Demeter/Plugins/SPEC.pm'))
    data = args.source.read_bytes()
    assert hashlib.sha256(data).hexdigest() == record['sha256']
    source = data.decode(); body = source[source.index('sub fix {'):source.index('__PACKAGE__')]
    harness = '''use File::Spec;
use File::Path qw(remove_tree);
use Scalar::Util qw(looks_like_number);
use JSON::PP;
package Demeter;
sub randomstring { return '123456' }
package main;
my $folder;
sub file { $ARGV[0] }
sub filename { 'snbl.dat' }
sub stash_folder { $ARGV[1] }
sub folder { $folder = $_[1] if @_ > 1; return $folder }
sub fixed {}
''' + body + "\nprint JSON::PP->new->encode(fix(bless {}, 'main'));\n"
    manifest = json.loads((fixtures / 'athena-spec-fixture.json').read_text())
    ref = manifest['reference']; original = fixtures / manifest['file']['file']
    assert hashlib.sha256(original.read_bytes()).hexdigest() == manifest['file']['sha256']
    assert hashlib.sha256(harness.encode()).hexdigest() == ref['harness_sha256']
    encoded = (fixtures / ref['file']).read_bytes()
    assert hashlib.sha256(encoded).hexdigest() == ref['sha256']
    expected = json.loads(gzip.decompress(encoded))['scans']
    with tempfile.TemporaryDirectory(prefix='spec-', dir='/tmp') as tmp:
        driver = Path(tmp) / 'native.pl'; driver.write_text(harness)
        result = subprocess.run(['perl', str(driver), str(original), tmp], check=True, capture_output=True, text=True)
        files = json.loads(result.stdout)
        assert len(files) == len(expected) == 2
        for index, filename in enumerate(files):
            path = Path(filename)
            assert hashlib.sha256(path.read_bytes()).hexdigest() == ref['converted_sha256'][index]
            actual = np.loadtxt(path)
            np.testing.assert_array_equal(actual, expected[index]['columns'])
            print('Scan', index + 1, actual.shape, 'native output and retained reference match')


if __name__ == '__main__':
    main()
