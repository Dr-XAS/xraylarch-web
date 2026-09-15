"""Replay original Athena convolution/noise methods and Larch templates.

Normalization/plot/clone objects are explicit bridges. The supplied edge step
is a fixture input, not evidence for full native normalization equivalence.
"""
import argparse
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
REV = '06afc8da08a5a7d5a26ee14992170fcf5dc67406'
ORACLE = ROOT/'backend/tests/fixtures/athena-convolution-native.json.gz'


def replay(args):
    args.output.mkdir(parents=True, exist_ok=True)
    catalog = {r['file']:r['sha256'] for r in json.loads((ROOT/'docs/athena-primary-sources.json').read_text())['files']}
    hashes = {}
    def source(name):
        raw = (args.sources/name.replace('/','-')).read_bytes(); sha = hashlib.sha256(raw).hexdigest()
        assert catalog['demeter-'+REV+'/'+name] == sha
        hashes[name] = sha
        return raw.decode()
    process = source('lib/Demeter/Data/Process.pm')
    panel = source('lib/Demeter/UI/Athena/ConvoluteNoise.pm')
    templates = {n:source(f'lib/Demeter/templates/process/larch/{n}.tmpl') for n in ['convolve','noise']}
    methods = '\n'.join(re.search(r'sub '+n+r' \{.*?\n\};', process, re.S).group() for n in ['convolve','noise'])
    ui = '\n'.join(re.search(r'sub '+n+r' \{.*?\n\};', panel, re.S).group() for n in ['get_values','plot'])
    script = r'''use strict;use warnings;use JSON::PP;use Text::Template;
package Config;
sub get {$_[0]{$_[1]} // ''} sub default {'gaussian'} sub set {my($s,@v)=@_;my %v=@v;@{$s}{keys %v}=values %v;}
package Demeter; sub xdi_exists {0}
package Data;
sub mo {$_[0]} sub config {$_[0]{config}} sub group {'g'} sub name {$_[0]{name}}
sub bkg_step {$_[0]{step}} sub _update {push @{$_[0]{updates}},$_[1]}
sub update_norm {} sub update_fft {} sub po {$_[0]} sub set {} sub start_plot {} sub plot {}
sub Clone {my($s,%v)=@_;return bless {%$s,%v},ref($s)}
sub template {my($s,$kind,$name)=@_;my $c=$s->{config};my $t=Text::Template->new(TYPE=>'STRING',SOURCE=>$s->{templates}{$name});my $out=$t->fill_in(HASH=>{D=>\$s,C=>\$c});die $Text::Template::ERROR if !defined $out;return $out;}
sub dispose {push @{$_[0]{commands}},$_[1]}
''' + methods + r'''
package Widget; sub GetSelection {$_[0]{value}} sub GetValue {$_[0]{value}} sub SetValue {$_[0]{value}=$_[1]} sub Enable {$_[0]{enabled}=$_[1]}
package Wx::BusyCursor; sub new {bless {},shift}
package App; sub heap_check {} sub status {} sub pull_single_values {}
package Panel;use Scalar::Util qw(looks_like_number);
''' + ui + r'''
package main;
my $v=JSON::PP->new->decode(do{local $/;<STDIN>});
$::app=bless {main=>bless({PlotE=>bless({},'App')},'App')},'App';
my @rows;
for my $case (@{$v->{cases}}) {
 my $d=bless {name=>'Measured source',step=>$case->{edge_step},config=>bless({},'Config'),commands=>[],updates=>[],templates=>$v->{templates}},'Data';
 my $p=bless {function=>bless({value=>$case->{form} eq 'gaussian'?0:1},'Widget'),width=>bless({value=>$case->{width}},'Widget'),noise=>bless({value=>$case->{noise}},'Widget'),make=>bless({},'Widget')},'Panel';
 if($case->{chi}) {$d->noise(noise=>$case->{noise},which=>'chi')}
 else {$p->plot($d)}
 push @rows,{%$case,commands=>$d->{commands},updates=>$d->{updates},label=>$case->{chi}?'chi':$p->{processed}{name},effective_width=>$p->{width}{value},effective_noise=>$p->{noise}{value}};
}
print JSON::PP->new->canonical->encode(\@rows);
'''
    path = args.output/'native.pl'; path.write_text(script)
    inputs = {}
    for label, filename in [('Cu','xdi-official-cu_metal_rt.xdi'),('Fe','xdi-official-fe2o3_rt.xdi')]:
        raw = (ROOT/'backend/tests/fixtures'/filename).read_bytes(); table=np.loadtxt(ROOT/'backend/tests/fixtures'/filename)
        inputs[label]=dict(energy=table[:,0].tolist(),mu=table[:,3 if label == "Cu" else 1].tolist(),fixture=filename,sha256=hashlib.sha256(raw).hexdigest())
    x=np.arange(41,dtype=float)+7000; y=np.zeros(41);y[[0,1,20,39,40]]=[1,-2,3,-1,2]
    inputs['impulses']=dict(energy=x.tolist(),mu=y.tolist(),fixture='constructed endpoint impulses')
    cases=[]
    for label in inputs:
        for name,form,width,noise,step in [('unchanged','gaussian',0,0,2.5),('gaussian','gaussian',1,0,2.5),('lorentzian','lorentzian',1,0,2.5),('wide','lorentzian',3,0,2.5),('noise-only','gaussian',0,.01,2.5),('combined','gaussian',1,.02,.6),('lorentz-noise','lorentzian',2,.03,3.4),('negative-ui','gaussian',-1,-2,2.5)]:
            cases.append(dict(name=label+'-'+name,input=label,form=form,width=width,noise=noise,edge_step=step,seed=123456))
    cases.append(dict(name='chi-noise',input='impulses',form='gaussian',width=0,noise=.02,edge_step=100,seed=42,chi=True))
    env=dict(os.environ,**json.loads(args.environment.read_text()));env['PERL5LIB']=str(args.perl_lib)+':'+env['PERL5LIB']
    result=subprocess.run(['perl',str(path)],env=env,input=json.dumps(dict(cases=cases,templates=templates)),text=True,capture_output=True,timeout=60)
    if result.returncode:raise RuntimeError(result.stderr)
    rows=json.loads(result.stdout)
    # Preserve the host's global RNG; only the reference interpreter uses it.
    state=np.random.get_state()
    try:
        for row in rows:
            src=inputs[row['input']];engine=Interpreter();g=Group(energy=np.asarray(src['energy']),xmu=np.asarray(src['mu']),chi=np.asarray(src['mu']))
            engine.symtable.set_symbol('g',g);engine.eval(f'random.seed({row["seed"]})')
            for command in row['commands']:
                engine.eval(command)
                if engine.error:raise RuntimeError([e.get_error() for e in engine.error])
            row['modified_mu']=(g.chi if row.get('chi') else g.xmu).tolist()
            if hasattr(g,'random'):row['noise_values']=g.random.tolist()
    finally:np.random.set_state(state)
    return dict(sources=hashes,inputs=inputs,rows=rows)


def main():
    p=argparse.ArgumentParser(description=__doc__)
    for n in ['sources','environment','perl-lib','output']:p.add_argument('--'+n,type=Path,required=True)
    p.add_argument('--record',action='store_true');args=p.parse_args();result=replay(args)
    if args.record:ORACLE.write_bytes(gzip.compress(json.dumps(result,sort_keys=True,allow_nan=False).encode(),mtime=0))
    else:assert result==json.loads(gzip.decompress(ORACLE.read_bytes()))
    print(f'{len(result["rows"])} native convolution/noise/UI/Larch cases: PASS')


if __name__=='__main__':main()
