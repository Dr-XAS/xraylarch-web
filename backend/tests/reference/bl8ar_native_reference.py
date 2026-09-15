"""Run unchanged BL8Ar/SpecFileLongLine methods with a native Larch fit bridge.

This executes reader control flow, output formatting and suggestions in Perl.
Moose/Wx are bridged, not a desktop replay. Larch is called independently with
the normalization-template arguments; no Ifeffit numerical equivalence claim.
"""
import argparse
import gzip
import hashlib
import json
from pathlib import Path
import subprocess

import numpy as np
from larch import Group
from larch.xafs import pre_edge


DEFAULTS = dict(harmonic=2, plot=False, margin=200, pre1=-30, pre2=-10, nor1=10, nor2=30)


def execute(source, raw, folder, params=None):
    folder.mkdir(parents=True, exist_ok=True)
    bl8 = 'package Demeter::Plugins::BL8Ar;' in source
    params = DEFAULTS | (params or {})
    prefix = '''use File::Spec; use JSON::PP;
our $params=JSON::PP->new->decode($ARGV[2]); our $bridge=JSON::PP->new->decode($ARGV[3]);
our %attrs=(measurement_mode=>'transmission',step_size=>0); our %put;
sub file { $ARGV[0] } sub filename { 'converted.dat' } sub stash_folder { $ARGV[1] } sub fixed {}
sub measurement_mode { $attrs{measurement_mode}=$_[1] if @_>1; $attrs{measurement_mode} }
sub step_size { $attrs{step_size}=$_[1] if @_>1; $attrs{step_size} }
package Demeter;
sub co { bless {},'Config' }
package Config;
sub default { $main::params->{$_[2]} }
package Demeter::Data;
sub put { my ($self,$e,$i0,%p)=@_; %main::put=(energy=>$e,i0=>$i0,parameters=>\\%p); bless {},'Demeter::Data' }
sub _update {} sub bkg_step { $main::bridge->{step} }
sub po { bless {},'Plot' } sub plot {}
package Plot; sub set {} sub start_plot {}
package main;
my $ar_k=3205.9/$params->{harmonic};
'''
    bridge = {}
    if bl8:
        rows = np.array([[float(v) for v in line.split()] for line in raw.read_text().splitlines()
                         if line.strip() and not line.startswith(('#', 'Energy'))])
        order = np.argsort(rows[:, 0], kind='stable')
        fit = Group()
        pre_edge(rows[order, 0], rows[order, 3], group=fit, e0=3205.9/params['harmonic'], nnorm=1,
            pre1=params['pre1'], pre2=params['pre2'], norm1=params['nor1'], norm2=params['nor2'])
        bridge = {'step': float(fit.edge_step)}
    stop = source.index('\n1;') if bl8 else source.index('__PACKAGE__')
    script = prefix + source[source.index('sub is {'):stop] + '''
my $obj=bless {},'main'; my $recognized=$obj->is; $obj->fix;
print JSON::PP->new->canonical->encode({recognized=>$recognized,default=>{$obj->suggest},
  transmission=>{$obj->suggest('transmission')},fluorescence=>{$obj->suggest('fluorescence')},attrs=>\\%attrs,put=>\\%put});
'''
    driver = folder/'native.pl'; driver.write_text(script)
    result = subprocess.run(['perl', str(driver), str(raw.resolve()), str(folder.resolve()), json.dumps(params), json.dumps(bridge)],
        capture_output=True, text=True, check=True, timeout=30)
    assert not result.stderr, result.stderr
    converted = (folder/'converted.dat').read_bytes()
    return {'native': json.loads(result.stdout), 'converted_sha256': hashlib.sha256(converted).hexdigest(),
            'columns': np.loadtxt(folder/'converted.dat').tolist()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-root', type=Path, required=True)
    parser.add_argument('--output-dir', type=Path, required=True)
    args = parser.parse_args()
    fixtures = Path(__file__).resolve().parents[1]/'fixtures'
    manifest = json.loads((fixtures/'athena-bl8ar-spec-long-fixtures.json').read_text())
    for ref in manifest['references']:
        src = (args.source_root/f"lib-Demeter-Plugins-{ref['reader']}.pm").read_bytes()
        assert hashlib.sha256(src).hexdigest() == ref['source_sha256']
        raw = fixtures/ref['input']; assert hashlib.sha256(raw.read_bytes()).hexdigest() == ref['input_sha256']
        encoded = (fixtures/ref['file']).read_bytes(); assert hashlib.sha256(encoded).hexdigest() == ref['sha256']
        actual = execute(src.decode(), raw, args.output_dir/ref['name'], ref['parameters'])
        assert actual == json.loads(gzip.decompress(encoded)), ref['name']
        print(ref['name'], len(actual['columns']), 'rows; native conversion and suggestions match')


if __name__ == '__main__':
    main()
