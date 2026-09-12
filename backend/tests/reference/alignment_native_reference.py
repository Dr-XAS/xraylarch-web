"""Execute the pinned Demeter alignment template with real Larch minimization.

The original Config parser/default methods determine SG preferences, and the
original Data::align method determines rounding and E0 behavior. Data access
and the scalar transport between Perl and Larch are explicit bridges.
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
from larch.fitting import minimize
from larch.xafs import pre_edge

ROOT=Path(__file__).resolve().parents[3]
FIX=ROOT/'backend/tests/fixtures'
ORACLE=FIX/'athena-alignment-native.json.gz'
REV='06afc8da08a5a7d5a26ee14992170fcf5dc67406'


def replay(args):
    args.output.mkdir(parents=True,exist_ok=True)
    catalog={r['file']:r['sha256'] for r in json.loads((ROOT/'docs/athena-primary-sources.json').read_text())['files']}
    hashes={}
    def source(name):
        path=next(root/name.replace('/','-') for root in args.sources if (root/name.replace('/','-')).exists())
        b=path.read_bytes();sha=hashlib.sha256(b).hexdigest()
        assert catalog['demeter-'+REV+'/'+name]==sha
        hashes[name]=sha;return b.decode()
    config=source('lib/Demeter/Config.pm');e0=source('lib/Demeter/Data/E0.pm')
    template=source('lib/Demeter/templates/process/larch/align.tmpl')
    process=source('lib/Demeter/configuration/process.demeter_conf')
    def method(text,name):return re.search(r'sub '+name+r' \{.*?\n\};',text,re.S).group()
    bodies='\n'.join(method(config,n) for n in ['set','get','Push','_read_config_file','set_this_param','set_default','default'])
    configuration=args.output/'process.demeter_conf';configuration.write_text(process)
    script=r'''use strict;use warnings;use JSON::PP;use Text::Template;
package Config;
use File::Basename;use File::Spec;use Cwd qw(abs_path);use Carp;
use Scalar::Util qw(looks_like_number);use Regexp::Assemble;
my(%ini,%params_of);
sub is_windows {0} sub push_all_config_files {} sub mo {$_[0]} sub ui {'athena'}
''' + bodies + r'''
package Data;
our $AUTOLOAD;
sub AUTOLOAD {my$s=shift;(my$n=$AUTOLOAD)=~s/.*:://;return if$n eq'DESTROY';$s->{$n}=shift if @_;return $s->{$n}//0}
sub mo {$_[0]} sub _update {} sub call_sentinal {} sub dispense {} sub standard {}
sub bkg_eshift {my$s=shift;if(@_){$s->{bkg_eshift}=shift;$s->{reference}{bkg_eshift}=$s->{bkg_eshift} if$s->{reference}}return$s->{bkg_eshift}}
sub fetch_scalar {return $_[1] eq'aa___esh'?$main::v->{fitted_shift}:$main::v->{stderr}}
''' + method(e0,'align') + r'''
package main;our$v=JSON::PP->new->decode(do{local$/;<STDIN>});
my$c=bless{},'Config';$c->_read_config_file($v->{configuration});
my$factory={window=>$c->default('smooth','sg_size'),order=>$c->default('smooth','sg_order')};
$c->set_default('smooth','sg_size',$v->{window});$c->set_default('smooth','sg_order',$v->{order});
my$effective={window=>$c->default('smooth','sg_size'),order=>$c->default('smooth','sg_order')};
my$d=bless{group=>'moving',bkg_e0=>$v->{moving_e0},bkg_eshift=>$v->{moving_shift}},'Data';
my$ds=bless{group=>'standard',bkg_e0=>$v->{standard_e0},bkg_eshift=>$v->{standard_shift}},'Data';
my$p=bless{e_smooth=>$v->{smoothed}},'Data';
my$t=Text::Template->new(TYPE=>'STRING',SOURCE=>$v->{template});
my$command=$t->fill_in(HASH=>{D=>\$d,DS=>\$ds,C=>\$c,P=>\$p});die$Text::Template::ERROR if !defined$command;
# These are the exact temporary settings in Align::plot. Execute Config's
# original setter/getter to observe its order clamp and restoration.
$c->set_default('smooth','sg_size',21);$c->set_default('smooth','sg_order',4);
my$display={window=>$c->default('smooth','sg_size'),order=>$c->default('smooth','sg_order')};
$c->set_default('smooth','sg_size',$effective->{window});$c->set_default('smooth','sg_order',$effective->{order});
my$ref=bless{bkg_e0=>$v->{moving_e0}+.75,bkg_eshift=>$v->{moving_shift}},'Data';$d->{reference}=$ref;
$ds->align($d) if exists$v->{fitted_shift};
print JSON::PP->new->canonical->encode({command=>$command,factory=>$factory,effective=>$effective,display=>$display,
 shift=>$d->bkg_eshift,e0=>$d->bkg_e0,stderr=>$d->bkg_delta_eshift,ref_shift=>$ref->bkg_eshift,ref_e0=>$ref->bkg_e0,ref_stderr=>$ref->bkg_delta_eshift,
 restored=>{window=>$c->default('smooth','sg_size'),order=>$c->default('smooth','sg_order')}});
'''
    path=args.output/'native.pl';path.write_text(script)
    env=dict(os.environ,**json.loads(args.environment.read_text()));env['PERL5LIB']=str(args.perl_lib)+':'+env['PERL5LIB']
    def render(case,**extra):
        payload=dict(configuration=str(configuration),template=template,**case,**extra)
        proc=subprocess.run(['perl',str(path)],input=json.dumps(payload),env=env,text=True,capture_output=True,timeout=30)
        if proc.returncode:raise RuntimeError(proc.stderr)
        return json.loads(proc.stdout)
    inputs={}
    for name,file,col in [('Cu','xdi-official-cu_metal_rt.xdi',3),('Fe60','demeter-fe.060.xmu',1),('Fe300','demeter-fe.300.xmu',1)]:
        a=np.loadtxt(FIX/file);g=Group();pre_edge(a[:,0],a[:,col],group=g)
        inputs[name]=dict(energy=a[:,0].tolist(),mu=a[:,col].tolist(),e0=float(g.e0),fixture=file,sha256=hashlib.sha256((FIX/file).read_bytes()).hexdigest())
    cases=[]
    for smoothed in [0,3]:
        for standard,moving in [('Fe60','Fe300'),('Fe300','Fe60')]:
            cases.append(dict(standard=standard,moving=moving,offset=0.,gain=1.,noise=0.,standard_shift=0.,moving_shift=0.,smoothed=smoothed,window=31,order=4))
        for name in ['Cu','Fe60']:
            for offset,gain in [(-4.3214,.2),(3.1254,2.),(7.6544,1.5)]:
                for noise in [0.,.0002]:
                    cases.append(dict(standard=name,moving=name,offset=offset,gain=gain,noise=noise,standard_shift=2.75,moving_shift=-1.5,smoothed=smoothed,window=31,order=4))
    for window,order in [(21,9),(12,11),(3,9)]:
        cases.append(dict(standard='Fe60',moving='Fe300',offset=0.,gain=1.,noise=0.,standard_shift=-1.25,moving_shift=2.5,smoothed=3,window=window,order=order))
    rows=[]
    for i,case in enumerate(cases):
        standard,moving=inputs[case['standard']],inputs[case['moving']]
        sx=np.asarray(standard['energy']);sy=np.asarray(standard['mu'])
        mx=np.asarray(moving['energy'])+case['offset'];my=np.asarray(moving['mu'])*case['gain']
        if case['noise']:my=my+np.random.default_rng(391).normal(0,case['noise'],len(my))
        case=dict(case,standard_e0=standard['e0']+case['standard_shift'],moving_e0=moving['e0']+case['offset']+case['moving_shift'])
        native=render(case)
        engine=Interpreter();engine.symtable.set_symbol('standard',Group(energy=sx,xmu=sy));engine.symtable.set_symbol('moving',Group(energy=mx,xmu=my))
        captured=[]
        def capture(*a,**k):
            fit=minimize(*a,**k);captured.append(fit);return fit
        engine.symtable.set_symbol('minimize',capture)
        engine.eval(native['command'].replace('<<nl>>',''))
        assert not engine.error,[e.get_error() for e in engine.error]
        assert len(captured)==1 and captured[0].success
        fit=captured[0];pars=engine.symtable.get_symbol('aa__')
        stderr=pars.esh.stderr
        commit=render(case,fitted_shift=float(pars.esh.value),stderr=0. if stderr is None else float(stderr))
        rows.append(dict(name=f'{i}-{case["moving"]}-to-{case["standard"]}',case=case,native=native,commit=commit,
            moving_energy=mx.tolist(),moving_mu=my.tolist(),fitted_shift=float(pars.esh.value),scale=float(pars.scale.value),
            stderr=None if stderr is None else float(stderr),residual=np.asarray(fit.residual).tolist(),chisqr=float(fit.chi_square),redchi=float(fit.chi_reduced)))
    return dict(sources=hashes,inputs=inputs,rows=rows)


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--sources',nargs='+',type=Path,required=True)
    for n in ['environment','perl-lib','output']:p.add_argument('--'+n,type=Path,required=True)
    p.add_argument('--record',action='store_true');args=p.parse_args();result=replay(args)
    if args.record:ORACLE.write_bytes(gzip.compress(json.dumps(result,sort_keys=True,allow_nan=False).encode(),mtime=0))
    else:assert result==json.loads(gzip.decompress(ORACLE.read_bytes()))
    print(f'{len(result["rows"])} original Larch alignment template / Config / Data::align observations: PASS')
if __name__=='__main__':main()
