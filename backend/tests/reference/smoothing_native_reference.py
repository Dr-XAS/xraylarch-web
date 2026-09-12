"""Execute Demeter smoothing with PDL, Larch templates and original Fortran.

Group access/update/put methods are explicit bridges; no native GUI or full
normalization lifecycle is claimed. The filter routines themselves are native.
"""
import argparse
import ctypes
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess

import numpy as np
from larch import Group, Interpreter

ROOT = Path(__file__).resolve().parents[3]
FIXTURES = ROOT / 'backend/tests/fixtures'
ORACLE = FIXTURES / 'athena-smoothing-native.json.gz'


def compile_fortran(args, env):
    source = args.ifeffit / 'src/lib'
    text = (source / 'decod.f').read_text()
    start = text.index('       subroutine f1mth(')
    end = text.index('       subroutine f2mth(', start)
    unit = args.output / 'f1mth.f'; unit.write_text(text[start:end])
    support = args.fortran_compiler.parent.parent / 'libexec/gcc/x86_64-linux-gnu/15'
    subprocess.run([str(args.fortran_compiler), '-B'+str(support)+'/', '-fPIC',
        '-ffixed-line-length-none', '-std=legacy', '-I'+str(source), '-c', str(unit),
        str(source/'specfun.f')], cwd=args.output, env=env, check=True, capture_output=True)
    library = args.output / 'smooth.so'
    subprocess.run([str(args.gcc), '-shared', '-o', str(library),
        str(args.output/'f1mth.o'), str(args.output/'specfun.o'), '-lm'], env=env, check=True, capture_output=True)
    function = ctypes.CDLL(str(library)).f1mth_
    function.argtypes = [ctypes.POINTER(ctypes.c_double), *[ctypes.POINTER(ctypes.c_int)]*3]
    function.restype = None
    def apply(y, repeats):
        y = np.asarray(y, dtype=np.float64).copy()
        n, opcode, error = ctypes.c_int(len(y)), ctypes.c_int(-1220), ctypes.c_int()
        for _ in range(repeats):
            function(y.ctypes.data_as(ctypes.POINTER(ctypes.c_double)), ctypes.byref(n), ctypes.byref(opcode), ctypes.byref(error))
            assert error.value == 0
        return y.tolist()
    return apply, {name: hashlib.sha256((source/name).read_bytes()).hexdigest()
                   for name in ('decod.f', 'specfun.f', 'encod.h', 'maxpts.h')}


def replay(args):
    args.output.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ, **json.loads(args.environment.read_text()))
    env['PERL5LIB'] = str(args.perl_lib) + ':' + env['PERL5LIB']
    catalog = json.loads((ROOT/'docs/athena-primary-sources.json').read_text())['files']
    hashes = {}
    def source(name):
        raw = (args.sources/name.replace('/', '-')).read_bytes()
        sha = hashlib.sha256(raw).hexdigest()
        assert sha == next(v['sha256'] for v in catalog if v['file'].endswith('/'+name))
        hashes[name] = sha
        return raw.decode()
    process = source('lib/Demeter/Data/Process.pm')
    bodies = '\n'.join(re.search(r'sub '+name+r' \{.*?\n\};', process, re.S).group()
                       for name in ('boxcar', 'gaussian_filter', 'smooth'))
    templates = {kind: source(f'lib/Demeter/templates/process/{kind}/smooth.tmpl') for kind in ('larch', 'ifeffit')}
    script = r'''use strict; use warnings; use PDL; use PDL::Filter::Linear; use JSON::PP;
use Text::Template; use Digest::SHA qw(sha256_hex);
package Demeter; sub xdi_exists {0}
package Config;
sub default { $_[0]{$_[2]} }
sub get { $_[0]{$_[1]} }
sub set { my $self=shift;my %args=@_;@{$self}{keys %args}=values %args }
package Data;
sub name {$_[0]{name}//'Measured smoothing source'}
sub group {$_[0]{group}//'h'} sub datatype {$_[0]{datatype}//'xmu'}
sub bkg_eshift {$_[0]{energy_shift}//0} sub is_larch {$_[0]{method} ne 'three_point'}
sub _update {} sub e0 {} sub resolve_defaults {} sub update_norm {} sub update_fft {}
sub get_array { @{$_[0]{x}} } sub ref_array {$_[0]{y}}
sub mo {$_[0]} sub config {$_[0]{config}}
sub put { my($self,$x,$y,%args)=@_;return bless{x=>$x,y=>$y,args=>\%args},'Data' }
sub template {
 my($self)=@_;my $kind=$self->is_larch?'larch':'ifeffit';
 my $template=Text::Template->new(TYPE=>'STRING',SOURCE=>$self->{templates}{$kind});
 my $donor=bless{group=>'g'},'Data';my $cfg=$self->config;
 return $template->fill_in(HASH=>{D=>\$self,DS=>\$donor,C=>\$cfg}) // die $Text::Template::ERROR;
}
sub dispose {push @{$_[0]{calls}},$_[1]}
''' + bodies + r'''
package main;
my $v=JSON::PP->new->decode(do{local $/;<STDIN>});
my $data=bless $v,'Data';$data->{config}=bless{sg_size=>$v->{window},sg_order=>$v->{order}},'Config';
my $child;
if($v->{method} eq 'boxcar') {$child=$data->boxcar($v->{window})}
elsif($v->{method} eq 'gaussian') {$child=$data->gaussian_filter($v->{window},$v->{sigma})}
else {$data->smooth($v->{repetitions});$child=$data}
my %modules;
for my $module(qw(PDL.pm PDL/Core.pm PDL/Basic.pm PDL/Primitive.pm PDL/Filter/Linear.pm Text/Template.pm)) {
 open my $f,'<',$INC{$module} or die $!;binmode $f;local $/;$modules{$module}=sha256_hex(<$f>);
}
print JSON::PP->new->canonical->encode({x=>$child->{x},y=>$child->{y},args=>$child->{args},
 calls=>$data->{calls}//[],modules=>\%modules,pdl_version=>$PDL::VERSION});
'''
    path = args.output / 'native.pl'; path.write_text(script)
    three_point, fortran_hashes = compile_fortran(args, env)
    scans = []
    for name, column in [('xdi-official-cu_metal_rt.xdi', 3), ('xdi-official-fe2o3_rt.xdi', 1)]:
        raw = (FIXTURES/name).read_bytes()
        # Numeric input selection is explicit and independent of web import.
        table = np.loadtxt(FIXTURES/name)
        scans.append((name, table[:,0], table[:,column], hashlib.sha256(raw).hexdigest()))
    x = np.arange(41, dtype=float); y = np.zeros(41); y[[0, 1, 20, 39, 40]] = [4, -2, 8, 3, -6]
    scans.append(('endpoint-impulses', x, y, None))
    settings = [('boxcar',1,4,4,1), ('boxcar',8,4,4,1), ('boxcar',11,4,4,1),
                ('gaussian',3,1,4,1), ('gaussian',8,2,4,1), ('gaussian',11,0,4,1),
                ('savitzky_golay',31,4,4,19), ('savitzky_golay',12,4,4,1), ('savitzky_golay',3,4,7,1),
                ('three_point',11,4,4,0), ('three_point',11,4,4,1), ('three_point',11,4,4,11)]
    rows = []
    for name, x, y, sha in scans:
        for method, window, sigma, order, repetitions in settings:
            values = dict(method=method,window=window,sigma=sigma,order=order,repetitions=repetitions,
                          x=x.tolist(),y=y.tolist(),datatype='chi' if name=='endpoint-impulses' else 'xmu',
                          energy_shift=2.25,templates=templates)
            process = subprocess.run(['perl',str(path)],input=json.dumps(values),text=True,env=env,
                                     capture_output=True,check=True,timeout=60)
            native = json.loads(process.stdout)
            if method == 'savitzky_golay':
                assert len(native['calls']) == 1  # Native Larch ignores repetitions.
                engine = Interpreter(); engine.symtable.set_symbol('g', Group(xmu=y.copy(),chi=y.copy()))
                engine.symtable.set_symbol('h', Group())
                engine.eval(native['calls'][0]); assert not engine.error, engine.error
                result = engine.symtable.get_symbol('h.chi' if values['datatype']=='chi' else 'h.xmu')
                native['x'], native['y'] = x.tolist(), result.tolist()
            elif method == 'three_point':
                native['x'], native['y'] = x.tolist(), three_point(y, len(native['calls']))
            rows.append(dict(id=f'{name}:{method}:{window}:{sigma}:{order}:{repetitions}',
                fixture=name, input_sha256=sha, input={k:v for k,v in values.items() if k!='templates'}, native=native))
    return dict(sources=hashes, fortran_sources=fortran_hashes, cases=rows)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('sources','environment','perl-lib','ifeffit','fortran-compiler','gcc','output'):
        parser.add_argument('--'+name,type=Path,required=True)
    parser.add_argument('--record',action='store_true');args=parser.parse_args()
    result = replay(args)
    if args.record:
        ORACLE.write_bytes(gzip.compress(json.dumps(result,sort_keys=True,allow_nan=False).encode(),mtime=0))
    else:
        assert result == json.loads(gzip.decompress(ORACLE.read_bytes()))
    print(f'{len(result["cases"])} native PDL, Larch-template and Fortran smoothing cases: PASS')


if __name__ == '__main__':
    main()
