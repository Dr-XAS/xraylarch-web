"""Execute pinned B18/BM23 is/fix/suggest bodies, then read output with Larch.

Constructors/configuration hooks are bridged. B18 runs both native backend
branches to distinguish Larch retention from Ifeffit decimation.
"""
import argparse
import gzip
import hashlib
import json
from pathlib import Path
import subprocess

import numpy as np
from larch.io import read_ascii


def driver(source):
    prefix = '''use File::Spec; use Scalar::Util qw(looks_like_number); use JSON::PP;
package Demeter;
sub is_ifeffit { $ARGV[2] eq 'ifeffit' }
package main;
sub file { $ARGV[0] }
sub filename { 'converted.dat' }
sub stash_folder { $ARGV[1] }
sub fixed {}
'''
    return prefix + source[source.index('sub is {'):source.index('__PACKAGE__')] + '''
my $obj=bless {},'main'; my $recognized=$obj->is; my $file=$obj->fix;
print JSON::PP->new->canonical->encode({recognized=>$recognized,default=>{$obj->suggest},transmission=>{$obj->suggest('transmission')},fluorescence=>{$obj->suggest('fluorescence')}});
'''


def execute(source, raw, output, backend='larch'):
    output.mkdir(parents=True, exist_ok=True)
    script=output/'native.pl'; script.write_text(driver(source))
    response=subprocess.run(['perl',str(script),str(raw.resolve()),str(output.resolve()),backend],check=True,capture_output=True,text=True,timeout=30)
    assert not response.stderr, response.stderr
    group=read_ascii(str(output/'converted.dat'))
    return dict(native=json.loads(response.stdout),columns=np.asarray(group.data).T.tolist(),labels=group.array_labels)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-root',type=Path,required=True)
    parser.add_argument('--output-dir',type=Path,required=True)
    args=parser.parse_args(); fixtures=Path(__file__).resolve().parents[1]/'fixtures'
    manifest=json.loads((fixtures/'athena-header-fixtures.json').read_text())
    for ref in manifest['references']:
        source=(args.source_root/f"lib-Demeter-Plugins-{ref['reader']}.pm").read_bytes()
        record=next(v for v in manifest['sources'] if v['path'].endswith('/'+ref['reader']+'.pm'))
        assert hashlib.sha256(source).hexdigest()==record['sha256']
        raw=fixtures/ref['input']; assert hashlib.sha256(raw.read_bytes()).hexdigest()==ref['input_sha256']
        encoded=(fixtures/ref['file']).read_bytes(); assert hashlib.sha256(encoded).hexdigest()==ref['sha256']
        actual=execute(source.decode(),raw,args.output_dir/ref['name'],ref['backend']); expected=json.loads(gzip.decompress(encoded))
        assert actual==expected,ref['name']
        print(ref['name'],len(actual['columns']),'rows; native arrays and suggestions match')


if __name__=='__main__': main()
