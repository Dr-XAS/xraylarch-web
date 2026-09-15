"""Execute original calibration/normalization dispatch at measured boundaries.

Only widgets and the Data/App field accessors are bridged. Perl renders the
unchanged normalize.tmpl before/after unchanged OnCalibrate. Larch executes
those commands; no web scientific processing or range resolver is imported.
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
from larch.xafs import pre_edge

ROOT=Path(__file__).resolve().parents[3]
FIX=ROOT/'backend/tests/fixtures'
ORACLE=FIX/'athena-normalization-limits-native.json.gz'
REV='06afc8da08a5a7d5a26ee14992170fcf5dc67406'


def replay(args):
    args.output.mkdir(parents=True,exist_ok=True)
    catalog={r['file']:r['sha256'] for r in json.loads((ROOT/'docs/athena-primary-sources.json').read_text())['files']}
    hashes={}
    def source(path,base):
        b=(base/path.replace('/','-')).read_bytes();sha=hashlib.sha256(b).hexdigest()
        assert sha==catalog['demeter-'+REV+'/'+path]
        hashes[path]=sha;return b.decode()
    template=source('lib/Demeter/templates/process/larch/normalize.tmpl',args.templates)
    ui=source('lib/Demeter/UI/Athena/Calibrate.pm',args.calibration)
    method=re.search(r'sub OnCalibrate \{.*?\n\};',ui,re.S).group()
    script=r'''use strict;use warnings;use JSON::PP;use Text::Template;
package Field;sub GetValue {$_[0]{value}} sub SetValue {$_[0]{value}=$_[1]}
package Data;our $AUTOLOAD;sub AUTOLOAD {my$s=shift;(my$n=$AUTOLOAD)=~s/.*:://;return if$n eq 'DESTROY';$s->{$n}=shift if@_;return$s->{$n}}
package App;sub current_data {$_[0]{data}} sub status {} sub modified {}
package UI;use Scalar::Util qw(looks_like_number);
'''+method+r'''
package main;our $app;my$v=JSON::PP->new->decode(do{local$/;<STDIN>});my@out;
for my$c (@{$v->{cases}}){
 my$d=bless{%{$c->{fields}},group=>'g',datatype=>'mu',is_nor=>0},'Data';
 $app=bless{data=>$d},'App';$app->{main}=$app;
 my$w=bless{cal=>bless({value=>$c->{target}},'Field'),e0=>bless({value=>$d->bkg_e0},'Field')},'UI';
 my@phases;
 for my$phase ('preview','saved'){
  $w->OnCalibrate(undef,$app) if$phase eq 'saved';
  my$t=Text::Template->new(TYPE=>'STRING',SOURCE=>$v->{template});
  my$command=$t->fill_in(HASH=>{D=>\$d});die$Text::Template::ERROR if!defined$command;
  push@phases,{phase=>$phase,fields=>{%$d},command=>$command};
 }
 push@out,\@phases;
}
print JSON::PP->new->canonical->encode(\@out);
'''
    driver=args.output/'native.pl';driver.write_text(script)
    env=dict(os.environ,**json.loads(args.environment.read_text()))
    env['PERL5LIB']=str(args.perl_lib)+':'+env['PERL5LIB']
    cases=[];inputs={}
    for name,filename,col in [('Cu','xdi-official-cu_metal_rt.xdi',3),('Fe','xdi-official-fe2o3_rt.xdi',1)]:
        table=np.loadtxt(FIX/filename);x,y=table[:,0],table[:,col];base=Group();pre_edge(x,y,group=base)
        inputs[name]=dict(fixture=filename,sha256=hashlib.sha256((FIX/filename).read_bytes()).hexdigest(),energy=x.tolist(),mu=y.tolist())
        lo,hi=x[0]-base.e0,x[-1]-base.e0
        for shift in [0,2.75,-4.3]:
            for delta in [-3.12345,0,3.12345]:
                for mode in ['pre','post','both']:
                    fields=dict(bkg_e0=float(base.e0+shift+delta),bkg_eshift=shift,
                                bkg_pre1=float(lo-50 if mode in ('pre','both') else .8*lo),
                                bkg_pre2=float(.4*lo),bkg_nor1=25.,
                                bkg_nor2=float(hi+50 if mode in ('post','both') else .8*hi),bkg_nnorm=3)
                    cases.append(dict(name=f'{name}-{shift}-{delta}-{mode}',input=name,fields=fields,target=float(base.e0+1.23456)))
    native=subprocess.run(['perl',str(driver)],input=json.dumps(dict(template=template,cases=cases)),env=env,text=True,capture_output=True,timeout=30)
    if native.returncode:raise RuntimeError(native.stderr)
    dispatch=json.loads(native.stdout);engine=Interpreter();rows=[]
    for case,phases in zip(cases,dispatch,strict=True):
        src=inputs[case['input']]
        for phase in phases:
            g=Group(energy=np.asarray(src['energy']),xmu=np.asarray(src['mu']))
            engine.symtable.set_symbol('g',g);engine.eval(phase['command'])
            assert not engine.error,[e.get_error() for e in engine.error]
            effective={key:float(getattr(g.pre_edge_details,key)) for key in ['pre1','pre2','norm1','norm2','nnorm']}
            effective.update(e0=float(g.e0),edge_step=float(g.edge_step))
            phase.update(effective=effective,arrays={key:np.asarray(getattr(g,key)).tolist() for key in ['norm','flat','pre_edge','post_edge']})
        rows.append(dict(case=case,phases=phases))
    return dict(demeter_revision=REV,sources=hashes,inputs=inputs,rows=rows)


def main():
    p=argparse.ArgumentParser(description=__doc__)
    for name in ['templates','calibration','environment','perl-lib','output']:p.add_argument('--'+name,type=Path,required=True)
    p.add_argument('--record',action='store_true');args=p.parse_args();result=replay(args)
    if args.record:ORACLE.write_bytes(gzip.compress(json.dumps(result,sort_keys=True,allow_nan=False).encode(),mtime=0))
    else:assert result==json.loads(gzip.decompress(ORACLE.read_bytes()))
    print(f'{len(result["rows"])} native calibration cases, {2*len(result["rows"])} original normalization dispatches: PASS')

if __name__=='__main__':main()
