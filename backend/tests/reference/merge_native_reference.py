"""Run original Demeter merge/mergeE/mergek methods and their Larch templates.

Object storage/update calls are explicit bridges. Raw transmission, normalized
mu and chi are prepared independently with Larch before native merge dispatch.
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
from larch.xafs import pre_edge, autobk

ROOT=Path(__file__).resolve().parents[3];FIX=ROOT/'backend/tests/fixtures'
ORACLE=FIX/'athena-merge-native.json.gz';REV='06afc8da08a5a7d5a26ee14992170fcf5dc67406'


def replay(args):
    args.output.mkdir(parents=True,exist_ok=True)
    catalog={r['file']:r['sha256'] for r in json.loads((ROOT/'docs/athena-primary-sources.json').read_text())['files']};hashes={}
    def source(root,name):
        b=(root/name.replace('/','-')).read_bytes();sha=hashlib.sha256(b).hexdigest()
        assert catalog['demeter-'+REV+'/'+name]==sha
        hashes[name]=sha;return b.decode()
    process=source(args.sources,'lib/Demeter/Data/Process.pm')
    conf=source(args.config_sources,'lib/Demeter/Config.pm')
    configuration=args.output/'process.demeter_conf';configuration.write_text(source(args.sources,'lib/Demeter/configuration/process.demeter_conf'))
    templates={name:source(args.sources,'lib/Demeter/templates/process/larch/'+name+'.tmpl') for name in
        ['merge_subarray','merge_start','merge_interp','merge','merge_norm','merge_stddev','merge_stddev_end','merge_end','chi_noise']}
    def method(s,n):return re.search(r'sub '+n+r' \{.*?\n\};',s,re.S).group()
    config_methods='\n'.join(method(conf,n) for n in ['set','get','Push','_read_config_file','set_this_param','set_default','default'])
    script=r'''use strict;use warnings;use JSON::PP;use Text::Template;
package Config;use File::Basename;use File::Spec;use Cwd qw(abs_path);use Carp;
use Scalar::Util qw(looks_like_number);use Regexp::Assemble;my(%ini,%params_of);
sub is_windows {0} sub push_all_config_files {} sub mo {$_[0]} sub ui {'athena'} sub is_true {$_[1]=~/\A(?:true|1)\z/i}
''' + config_methods + r'''
package Mode;our$AUTOLOAD;sub AUTOLOAD{my$s=shift;(my$n=$AUTOLOAD)=~s/.*:://;return if$n eq'DESTROY';$s->{$n}=shift if @_;return$s->{$n}}
package Demeter;sub xdi_exists{0}
package Data;use Carp;use List::MoreUtils qw(uniq);use Storable qw(dclone);my$NULLFILE='';our$AUTOLOAD;
sub AUTOLOAD{my$s=shift;(my$n=$AUTOLOAD)=~s/.*:://;return if$n eq'DESTROY';$s->{$n}=shift if @_;return$s->{$n}//0}
sub co{$main::config} sub mo{$main::mode} sub standard{$main::mode->{standard}=$_[0]} sub unset_standard{$main::mode->{standard}=undef}
sub get_array{my($s,$n)=@_;return wantarray?@{$s->{arrays}{$n}}:scalar@{$s->{arrays}{$n}}}
sub _update{push@{$_[0]{updates}},$_[1]} sub initialize_e0{} sub get_kweight{$_[0]{fft_kweight}}
sub Clone{my$n=dclone($_[0]);$n->{group}='merged';return$n}
sub template{my($s,$kind,$name)=@_;return'' if$name eq'deriv';my$c=$s->co;my$ds=$s->mo->standard;
 my$t=Text::Template->new(TYPE=>'STRING',SOURCE=>$main::v->{templates}{$name});my$out=$t->fill_in(HASH=>{D=>\$s,DS=>\$ds,C=>\$c});die$Text::Template::ERROR if !defined$out;return$out}
sub dispose{push@main::commands,$_[1]}
'''+'\n'.join(method(process,n) for n in ['merge','mergeE','mergek'])+r'''
package main;our$v=JSON::PP->new->decode(do{local$/;<STDIN>});our@commands;
our$config=bless{},'Config';$config->_read_config_file($v->{configuration});
my$defaults={map{$_=>$config->default('merge',$_)}qw(weightby exclude_short_data short_data_margin push_metadata)};
$config->set_default('merge','exclude_short_data',$v->{exclude}?'true':'false');$config->set_default('merge','short_data_margin',$v->{margin});
our$mode=bless{config=>$config,merge=>$v->{weightby}},'Mode';my@data=map{bless{%$_},'Data'}@{$v->{groups}};
my$merged=$data[0]->merge($v->{how},@data);
print JSON::PP->new->canonical->encode({commands=>\@commands,defaults=>$defaults,noise_commands=>[map{$_->template('process','chi_noise')}@data],
 members=>[map{{group=>$_->group,weight=>$_->merge_weight,updates=>$_->{updates}}}@data],
 merged=>{map{$_=>$merged->$_()}qw(bkg_e0 bkg_eshift datatype is_merge annotation provenance)},
 config=>{map{$_=>$config->get($_)}qw(merge_min merge_max ndata weight)}});
'''
    driver=args.output/'native.pl';driver.write_text(script)
    env=dict(os.environ,**json.loads(args.environment.read_text()));env['PERL5LIB']=str(args.perl_lib)+':'+env['PERL5LIB']
    def render(payload):
        proc=subprocess.run(['perl',str(driver)],input=json.dumps(dict(configuration=str(configuration),templates=templates,**payload)),env=env,text=True,capture_output=True,timeout=30)
        if proc.returncode:raise RuntimeError(proc.stderr)
        return json.loads(proc.stdout)
    inputs={}
    for name in ['060','061','062']:
        path=FIX/f'demeter-merge-fe.{name}';lines=path.read_text().splitlines()
        a=np.asarray([list(map(float,l.split())) for l in lines if re.match(r'^\s+\d+\.\d+\s+\d',l)])
        x=a[:,0];mu=np.log(a[:,1]/a[:,2]);g=Group();pre_edge(x,mu,group=g)
        autobk(x,mu,group=g,e0=g.e0,edge_step=g.edge_step,rbkg=1,kmin=0,kmax=18,kweight=1)
        inputs[name]=dict(fixture=path.name,sha256=hashlib.sha256(path.read_bytes()).hexdigest(),
            arrays=dict(energy=x.tolist(),xmu=mu.tolist(),norm=g.norm.tolist(),k=g.k.tolist(),chi=g.chi.tolist()),
            bkg_e0=float(g.e0),bkg_step=float(g.edge_step),bkg_eshift=0.,fft_kmin=3.,fft_kmax=12.,fft_dk=1.,fft_kwindow='hanning',fft_kweight=2)
    rows=[]
    cases=[dict(how=how,weightby=weightby,exclude=True,margin=10,trim=0,shifts=[0,0,0]) for how in ['e','n','k'] for weightby in ['importance','step','noise']]
    cases += [dict(how=how,weightby='importance',exclude=exclude,margin=10,trim=trim,shifts=[2.75,-1.25,.5]) for how in ['e','n','k'] for exclude in [False,True] for trim in [10,11]]
    cases += [dict(how=how,weightby='importance',exclude=False,margin=10,trim=0,shifts=[0,0,0],weights=weights) for how in ['e','n','k'] for weights in [[1,1,1],[1,0,3],[.2,2,5]]]
    for i,case in enumerate(cases):
        engine=Interpreter();groups=[];noise_commands=[]
        for j,(name,src) in enumerate(inputs.items()):
            src=json.loads(json.dumps(src));arrays=src.pop('arrays')
            if j==2 and case['trim']:
                names=['k','chi'] if case['how']=='k' else ['energy','xmu','norm']
                for key in names:arrays[key]=arrays[key][:-case['trim']]
            group=Group(**{k:np.asarray(a) for k,a in arrays.items()});engine.symtable.set_symbol('g'+str(j),group)
            groups.append(dict(src,arrays=arrays,group='g'+str(j),name=name,importance=case.get('weights',[1,2,3])[j],
                bkg_eshift=case['shifts'][j],epsk=1.,datatype='xmu'))
        proto=render(dict(case,groups=groups));noise_commands=proto['noise_commands']
        for group,noise_cmd in zip(groups,noise_commands):
            engine.eval(noise_cmd);assert not engine.error,[e.get_error() for e in engine.error]
            group['epsk']=float(f"{engine.symtable.get_symbol(group['group']).epsilon_k:.3e}")
        native=render(dict(case,groups=groups));engine.symtable.set_symbol('merged',Group())
        for command in native['commands']:
            engine.eval(command.replace('<<nl>>',''));assert not engine.error,[e.get_error() for e in engine.error]
        merged=engine.symtable.get_symbol('merged');x=merged.k if case['how']=='k' else merged.energy;y=merged.chi if case['how']=='k' else merged.xmu
        rows.append(dict(name=f'{i}-{case["how"]}-{case["weightby"]}-trim{case["trim"]}',case=case,groups=groups,native=native,
            x=x.tolist(),y=y.tolist(),stddev=merged.stddev.tolist(),noise_commands=noise_commands))
    return dict(sources=hashes,inputs=inputs,rows=rows)


def main():
    p=argparse.ArgumentParser(description=__doc__)
    for name in ['sources','config-sources','environment','perl-lib','output']:p.add_argument('--'+name,type=Path,required=True)
    p.add_argument('--record',action='store_true');args=p.parse_args();value=replay(args)
    if args.record:ORACLE.write_bytes(gzip.compress(json.dumps(value,sort_keys=True,allow_nan=False).encode(),mtime=0))
    else:assert value==json.loads(gzip.decompress(ORACLE.read_bytes()))
    print(f'{len(value["rows"])} original merge dispatch/template observations: PASS')
if __name__=='__main__':main()
