"""Replay pinned MEE templates and Process.pm::mee, with explicit data bridges.

Larch's independent Athena reader supplies normalized measured data. Real
Text::Template renders the original templates; Larch executes their equations.
The original Perl mee body executes parameter handling and zero padding. GUI,
background updating, cloning and XDI are stubs, not a desktop-equivalence claim.
"""
import argparse
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess

import numpy as np
from larch import Group, Interpreter, __version__
from larch.io import read_athena

ROOT = Path(__file__).resolve().parents[3]
FIXTURES = ROOT / 'backend/tests/fixtures'
ORACLE = FIXTURES / 'athena-mee-native.json.gz'


def replay(sources, environment, perl_lib, output):
    output.mkdir(parents=True, exist_ok=True)
    catalog = json.loads((ROOT / 'docs/athena-primary-sources.json').read_text())['files']
    hashes = {}
    def source(rel):
        b = (sources / rel.replace('/', '-')).read_bytes()
        hashes[rel] = hashlib.sha256(b).hexdigest()
        assert hashes[rel] == next(r['sha256'] for r in catalog if r['file'].endswith('/' + rel))
        return b.decode()
    body = re.search(r'sub mee \{.*?\n\};', source('lib/Demeter/Data/Process.pm'), re.S).group()
    templates = {key: source(f'lib/Demeter/templates/process/larch/mee_{key}.tmpl') for key in ('reflect', 'arctan', 'do')}
    perl = r'''use strict; use warnings; use JSON::PP; use Text::Template; use Digest::SHA qw(sha256_hex);
package Demeter; sub xdi_exists { 0 }
package Data;
sub group { 'g' } sub bkg_e0 { $_[0]{e0} } sub _update {} sub standard {} sub unset_standard {}
sub name { 'Measured MEE bridge' } sub Clone { bless { group=>'h' }, 'Child' }
sub dispense { $_[0]{calls}{$_[2]} = $_[3] }
sub fetch_array { @{ $_[1] eq 'g.energy' ? $_[0]{x} : $_[0]{model} } }
sub place_array { $_[0]{model} = $_[2] }
''' + body + r'''
package Child; our @ISA=('Data'); sub group { 'h' }
package main;
my $v=JSON::PP->new->decode(do{local $/;<STDIN>});
my $data=bless $v,'Data'; my $child=bless {},'Child';
$data->mee(shift=>$v->{shift},amp=>$v->{amplitude},width=>$v->{width},how=>$v->{how});
my $args=$data->{calls}{'mee_'.$v->{how}};
my %texts;
for my $key (qw(reflect arctan do)) {
 my $t=Text::Template->new(TYPE=>'STRING',SOURCE=>$v->{templates}{$key});
 $texts{$key}=$t->fill_in(HASH=>{S=>\$data,D=>\$data,DS=>\$child,
   shift=>$args->{shift},width=>$args->{width},amp=>$data->{calls}{mee_do}{amp}}) // die $Text::Template::ERROR;
}
my $hash=do{local $/;open my $f,'<',$INC{'Text/Template.pm'} or die $!;sha256_hex(<$f>)};
print JSON::PP->new->canonical->encode({code=>\%texts,model=>$data->{model},args=>$args,
 amp=>$data->{calls}{mee_do}{amp},template_version=>$Text::Template::VERSION,template_sha256=>$hash});
'''
    path = output / 'native.pl'; path.write_text(perl)
    env = dict(os.environ, **json.loads(environment.read_text()))
    env['PERL5LIB'] = str(perl_lib.resolve()) + os.pathsep + env.get('PERL5LIB', '')
    def native(payload):
        result = subprocess.run(['perl', str(path)], input=json.dumps(payload | {'templates': templates}),
            text=True, capture_output=True, env=env, check=True, timeout=30)
        return json.loads(result.stdout)
    data = read_athena(str(FIXTURES / 'demeter-mee-LaCoO3.prj'), do_preedge=True, do_bkg=False, do_fft=False)
    cases = []
    for index, group in enumerate(data.groups.values()):
        for method in ('reflect', 'arctan'):
            variants = [('recipe', 121.04, .014, .5), ('manual', 122., .014, 2.)]
            if index == 0:
                variants += [('negative', 122., -.01, -1.), ('zero', 122., 0., .001)]
            for suffix, shift, amp, width in variants:
                payload = dict(x=group.energy.tolist(), model=np.zeros(len(group.energy)).tolist(),
                    e0=group.e0, shift=shift, amplitude=amp, width=width, how=method)
                rendered = native(payload)
                interp = Interpreter(writer=io.StringIO())
                g = Group(energy=group.energy.copy(), norm=group.norm.copy())
                h = Group()
                interp.symtable.set_symbol('g', g); interp.symtable.set_symbol('h', h)
                interp(rendered['code'][method])
                assert not interp.error, [e.get_error() for e in interp.error]
                model = interp.symtable.get_symbol('m___ee.xint')
                padded = native(payload | {'model': model.tolist()})
                if method == 'reflect':
                    model = np.asarray(padded['model'])
                    interp.symtable.set_symbol('m___ee.xint', model)
                interp(padded['code']['do'])
                assert not interp.error, [e.get_error() for e in interp.error]
                cases.append(dict(id=f'LaCoO3-{index+1}-{method}-{suffix}', energy=group.energy.tolist(),
                    norm=group.norm.tolist(), e0=group.e0, options=dict(method='reflection' if method=='reflect' else 'arctangent',
                    shift=shift, amplitude=amp, width=width), model=model.tolist(), corrected=h.xmu.tolist(),
                    native_amplitude=padded['amp'], native_width=padded['args']['width'],
                    code=padded['code'][method]+padded['code']['do']))
    return dict(cases=cases, source_sha256=hashes, larch_version=__version__,
        template_version=padded['template_version'], template_sha256=padded['template_sha256'],
        fixture_sha256=hashlib.sha256((FIXTURES/'demeter-mee-LaCoO3.prj').read_bytes()).hexdigest())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for key in ('sources', 'environment', 'perl-lib', 'output'):
        parser.add_argument('--'+key, type=Path, required=True)
    parser.add_argument('--record', action='store_true')
    args = parser.parse_args()
    result = replay(args.sources, args.environment, args.perl_lib, args.output)
    if args.record:
        ORACLE.write_bytes(gzip.compress(json.dumps(result, sort_keys=True, allow_nan=False).encode(), mtime=0))
    else:
        assert result == json.loads(gzip.decompress(ORACLE.read_bytes()))
    print(f'{len(result["cases"])} native MEE cases: PASS')


if __name__ == '__main__':
    main()
