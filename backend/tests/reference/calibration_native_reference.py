"""Replay native calibration UI methods, raw derivatives and smoothing.

wx widgets and data access are explicit bridges. Original Perl methods and
templates run unchanged; normalization is supplied by independent Larch.
The original compiled Ifeffit three-point opcode supplies its display filter.
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
from larch.xafs import pre_edge

ROOT=Path(__file__).resolve().parents[3]
FIX=ROOT/'backend/tests/fixtures'
ORACLE=FIX/'athena-calibration-native.json.gz'


def replay(args):
    args.output.mkdir(parents=True,exist_ok=True)
    catalog={r['file']:r['sha256'] for r in json.loads((ROOT/'docs/athena-primary-sources.json').read_text())['files']}
    hashes={}
    def source(name):
        raw=(args.sources/name.replace('/','-')).read_bytes();sha=hashlib.sha256(raw).hexdigest()
        assert sha==catalog['demeter-06afc8da08a5a7d5a26ee14992170fcf5dc67406/'+name]
        hashes[name]=sha;return raw.decode()
    ui=source('lib/Demeter/UI/Athena/Calibrate.pm');e0=source('lib/Demeter/Data/E0.pm')
    data_plot=source('lib/Demeter/Data/Plot.pm')
    templates={name:source('lib/Demeter/templates/process/'+kind+'/'+file+'.tmpl') for name,kind,file in
               [('deriv','larch','deriv'),('larch','larch','smoothed'),('ifeffit','ifeffit','smoothed')]}
    def method(text,name):return re.search(r'sub '+name+r' \{.*?\n\};',text,re.S).group()
    script=r'''use strict;use warnings;use JSON::PP;use Text::Template;
package Field;sub GetValue {$_[0]{value}} sub GetSelection {$_[0]{value}} sub SetValue {$_[0]{value}=$_[1]}
package Plot;sub new {bless{space=>'e',e_smooth=>8},shift} sub set {my$s=shift;my%v=@_;@{$s}{keys%v}=values%v} sub start_plot {}
our $AUTOLOAD;sub AUTOLOAD {my$s=shift;(my$n=$AUTOLOAD)=~s/.*:://;return if $n eq 'DESTROY';$s->{$n}=shift if @_;return $s->{$n}//0}
package Config;sub default {$_[0]{$_[2]}} sub get {$_[0]{$_[1]}}
package Data;use Carp;our $AUTOLOAD;
sub AUTOLOAD {my$s=shift;(my$n=$AUTOLOAD)=~s/.*:://;return if $n eq 'DESTROY';$s->{$n}=shift if @_;return $s->{$n}}
sub get_array {@{$_[0]{arrays}{$_[1]}}} sub po {$_[0]{plot}} sub plot {my$s=shift;$s->{draw}={%{$s->po}}}
sub e0 {my$s=shift;$s->bkg_e0($s->e0_zero_crossing)}
''' + method(data_plot,'suffix')+method(e0,'e0_zero_crossing')+r'''
package App;sub current_data {$_[0]{data}} sub status {} sub cursor {return(1,$_[0]{cursor},0)} sub modified {$main::modified=1}
package main;our $app;our $modified=0;sub modified {$modified=1}
package UI;use Scalar::Util qw(looks_like_number);
'''+'\n'.join(method(ui,n) for n in ['plot','Pluck','OnCalibrate','OnFindZeroCrossing'])+r'''
package main;
my$v=JSON::PP->new->decode(do{local$/;<STDIN>});my$p=Plot->new;
my$d=bless{arrays=>$v->{arrays},bkg_e0=>$v->{observed},bkg_eshift=>$v->{shift},bkg_flatten=>$v->{flatten},plot=>$p},'Data';
$app=bless{data=>$d,cursor=>$v->{observed},lastplot=>['E','single']},'App';$app->{main}=$app;
my$w=bless{e0=>bless({value=>$v->{observed}},'Field'),cal=>bless({value=>$v->{target}},'Field'),display=>bless({value=>$v->{display}},'Field'),smooth=>bless({value=>$v->{smoothing}},'Field')},'UI';
$w->plot($d);
if($v->{action} eq 'calibrate'){$w->OnCalibrate(undef,$app)}
elsif($v->{action} eq 'zero'){$w->OnFindZeroCrossing(undef,$app)}
elsif($v->{action} eq 'pluck'){$w->Pluck(undef,$app)}
my$draw=$d->{draw};my$active=bless{%$draw},'Plot';$d->{plot}=$active;my$suffix=$d->suffix;
my$c=bless{smooth_suffix=>$suffix,sg_size=>31,sg_order=>9},'Config';my@commands;
for my$name ('deriv',($v->{smoothing}?$v->{backend}:())){
 my$t=Text::Template->new(TYPE=>'STRING',SOURCE=>$v->{templates}{$name});$d->{group}='g';$d->{name}='Measured';
 my$out=$t->fill_in(HASH=>{D=>\$d,C=>\$c,P=>\$active});die$Text::Template::ERROR if!defined$out;push@commands,$out;
}
print JSON::PP->new->canonical->encode({e0=>$d->bkg_e0,shift=>$d->bkg_eshift,field=>$w->{e0}->GetValue,draw=>$draw,restored_smoothing=>$p->e_smooth,suffix=>$suffix,modified=>$modified,commands=>\@commands});
'''
    driver=args.output/'native.pl';driver.write_text(script)
    env=dict(os.environ,**json.loads(args.environment.read_text()));env['PERL5LIB']=str(args.perl_lib)+':'+env['PERL5LIB']
    native_smooth=ctypes.CDLL(str(args.smooth_library)).f1mth_
    native_smooth.argtypes=[ctypes.POINTER(ctypes.c_double),*[ctypes.POINTER(ctypes.c_int)]*3];native_smooth.restype=None
    def three_point(values,count):
        y=np.asarray(values,dtype=np.float64).copy();n,opcode,error=ctypes.c_int(len(y)),ctypes.c_int(-1220),ctypes.c_int()
        for _ in range(count):native_smooth(y.ctypes.data_as(ctypes.POINTER(ctypes.c_double)),ctypes.byref(n),ctypes.byref(opcode),ctypes.byref(error));assert error.value==0
        return y
    def run(payload):
        output=subprocess.run(['perl',str(driver)],input=json.dumps(dict(templates=templates,**payload)),env=env,text=True,capture_output=True,timeout=30)
        if output.returncode:raise RuntimeError(output.stderr)
        result=json.loads(output.stdout);result['stderr']=output.stderr
        return result
    inputs={};rows=[]
    for name,filename,col in [('Cu','xdi-official-cu_metal_rt.xdi',3),('Fe','xdi-official-fe2o3_rt.xdi',1)]:
        table=np.loadtxt(FIX/filename);g=Group();pre_edge(table[:,0],table[:,col],group=g)
        arrays=dict(energy=table[:,0].tolist(),xmu=table[:,col].tolist(),norm=g.norm.tolist(),flat=g.flat.tolist())
        engine=Interpreter();group=Group(**{k:np.asarray(v) for k,v in arrays.items()});engine.symtable.set_symbol('g',group)
        # Render and execute the original raw derivative template first.
        proto=run(dict(arrays=arrays,observed=float(g.e0),shift=0,flatten=True,target=float(g.e0)+2,display=2,smoothing=0,backend='larch',action='plot'))
        engine.eval(proto['commands'][0]);assert not engine.error,[e.get_error() for e in engine.error]
        arrays.update(der=group.der.tolist(),sec=group.sec.tolist())
        inputs[name]=dict(arrays=arrays,e0=float(g.e0),parameters={key:getattr(g.pre_edge_details,key) for key in ['pre1','pre2','norm1','norm2','nnorm']},fixture=filename,sha256=hashlib.sha256((FIX/filename).read_bytes()).hexdigest())
        cases=[dict(display=view,smoothing=n,backend=backend,action='plot',shift=0,observed=float(g.e0),target=float(g.e0)+2)
               for view in range(4) for n in [0,1,10] for backend in ['larch','ifeffit']]
        cases += [dict(display=3,smoothing=n,backend='larch',action='zero',shift=2.75,observed=float(g.e0)+2.5,target=float(g.e0)+3) for n in [0,1,10]]
        cases += [dict(display=2,smoothing=0,backend='larch',action='calibrate',shift=shift,observed=float(g.e0)+shift+.12345,target=float(g.e0)+delta)
                  for shift in [0,2.75,-4.3] for delta in [0,2.0004]]
        cases += [dict(display=2,smoothing=0,backend='larch',action='pluck',shift=2.75,observed=float(g.e0)+2.125,target=float(g.e0))]
        for i,case in enumerate(cases):
            out=run(dict(arrays=arrays,flatten=True,**case));base=np.asarray(arrays[out['suffix']]);y=base.copy()
            if case['smoothing']:
                if case['backend']=='ifeffit':y=three_point(base,case['smoothing'])
                else:
                    engine.eval(out['commands'][-1]);assert not engine.error,[e.get_error() for e in engine.error];y=group.smooth
            rows.append(dict(name=f'{name}-{i}-{case["action"]}',input=name,case=case,native=out,plot_y=np.asarray(y).tolist()))
    return dict(sources=hashes,inputs=inputs,rows=rows,fortran_library_sha256=hashlib.sha256(args.smooth_library.read_bytes()).hexdigest())


def main():
    p=argparse.ArgumentParser(description=__doc__)
    for name in ['sources','environment','perl-lib','smooth-library','output']:p.add_argument('--'+name,type=Path,required=True)
    p.add_argument('--record',action='store_true');args=p.parse_args();result=replay(args)
    if args.record:ORACLE.write_bytes(gzip.compress(json.dumps(result,sort_keys=True,allow_nan=False).encode(),mtime=0))
    else:assert result==json.loads(gzip.decompress(ORACLE.read_bytes()))
    print(f'{len(result["rows"])} original calibration UI/derivative/smoothing observations: PASS')
if __name__=='__main__':main()
