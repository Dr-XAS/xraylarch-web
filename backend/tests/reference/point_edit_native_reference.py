"""Run original point-removal methods/templates with measured and boundary probes."""
import argparse,gzip,hashlib,json,os,re,subprocess
from pathlib import Path
import numpy as np
from larch import Group,Interpreter
from larch.xafs import pre_edge
ROOT=Path(__file__).resolve().parents[3];REV='06afc8da08a5a7d5a26ee14992170fcf5dc67406'
ORACLE=ROOT/'backend/tests/fixtures/athena-point-edit-native.json.gz'


def replay(args):
    args.output.mkdir(parents=True,exist_ok=True)
    catalog={r['file']:r['sha256'] for r in json.loads((ROOT/'docs/athena-primary-sources.json').read_text())['files']};hashes={}
    def source(name):
        raw=(args.sources/name.replace('/','-')).read_bytes();sha=hashlib.sha256(raw).hexdigest();assert catalog['demeter-'+REV+'/'+name]==sha;hashes[name]=sha;return raw.decode()
    process=source('lib/Demeter/Data/Process.pm')
    names=['deglitch','truncate_before','truncate_after','trun_signal_before','trun_signal_after','margin']
    templates={n:source('lib/Demeter/templates/process/larch/'+n+'.tmpl') for n in names}
    methods='\n'.join(re.search(r'sub '+n+r' \{.*?\n\};',process,re.S).group() for n in ['deglitch','deglitch_margins','Truncate'])
    script=r'''use strict;use warnings;use JSON::PP;use Text::Template;
package Config;sub set {my($s,%v)=@_;@{$s}{keys %v}=values %v} sub get {$_[0]{$_[1]}}
package Plot;sub margin_min {$_[0]{emin}} sub margin_max {$_[0]{emax}} sub margin {$_[0]{tolerance}}
package Data;use Carp;use List::Util qw(reduce);
sub datatype {'xmu'} sub is_larch {1} sub _update {} sub update_norm {} sub update_fft {}
sub group {'g'} sub mo {$_[0]} sub config {$_[0]{config}} sub bkg_e0 {$_[0]{e0}} sub bkg_eshift {$_[0]{shift}}
sub get_array {@{$_[0]{arrays}{$_[1]}}}
sub template {my($s,$type,$name)=@_;my($c,$p,$suffix)=($s->{config},$s->{plot},$s->{suffix});my $t=Text::Template->new(TYPE=>'STRING',SOURCE=>$s->{templates}{$name});my $out=$t->fill_in(HASH=>{D=>\$s,C=>\$c,P=>\$p,suffix=>\$suffix});die $Text::Template::ERROR if !defined $out;return $out;}
sub dispose {push @{$_[0]{commands}},$_[1]}
''' + methods + r'''
package main;
my $v=JSON::PP->new->decode(do{local $/;<STDIN>});my $d=bless {%$v,config=>bless({},'Config'),commands=>[],plot=>bless($v->{options},'Plot')},'Data';
if($v->{margin_only}) {$d->dispose($d->template('process','margin'))}
elsif($v->{options}{mode} eq 'point') {$d->deglitch(@{$v->{points}})}
elsif($v->{options}{mode} eq 'margins') {$d->deglitch_margins}
else {$d->Truncate($v->{options}{side},$v->{options}{value})}
print JSON::PP->new->canonical->encode($d->{commands});
'''
    path=args.output/'native.pl';path.write_text(script)
    env=dict(os.environ,**json.loads(args.environment.read_text()));env['PERL5LIB']=str(args.perl_lib)+':'+env['PERL5LIB']
    def commands(payload):
        r=subprocess.run(['perl',str(path)],input=json.dumps(dict(templates=templates,**payload)),env=env,capture_output=True,text=True,timeout=30)
        if r.returncode:raise RuntimeError(r.stderr)
        return json.loads(r.stdout)
    inputs={}
    for label in ['ORP5.000','ZT20.000']:
        name='demeter-deglitch-'+label;raw=(ROOT/'backend/tests/fixtures'/name).read_bytes();data=np.loadtxt(ROOT/'backend/tests/fixtures'/name,delimiter=',')
        x=data[:,2];mu=np.log(abs(data[:,5]/data[:,6]));g=Group();pre_edge(x,mu,group=g,e0=9659,pre1=-190,pre2=-30,norm1=100,norm2=900,nnorm=2)
        inputs[label]=dict(energy=x.tolist(),xmu=mu.tolist(),pre_edge=g.pre_edge.tolist(),post_edge=g.post_edge.tolist(),e0=9659,fixture=name,sha256=hashlib.sha256(raw).hexdigest())
    x=np.arange(41,dtype=float)+7000;y=np.linspace(1,2,41);y[[2,12,15,33]]+=[-.3,.4,-.4,.3]
    inputs['constructed']=dict(energy=x.tolist(),xmu=y.tolist(),pre_edge=np.linspace(1,2,41).tolist(),post_edge=np.linspace(1,2,41).tolist(),e0=7020,fixture='constructed linear margins and spikes')
    rows=[]
    for label,src in inputs.items():
        x=np.array(src['energy']);e0=src['e0'];middle=len(x)//2
        choices=[dict(mode='point',point=float(x[middle])),dict(mode='point',point=float((x[middle]+x[middle+1])/2)),
                 dict(mode='point',point=float(x[0])),dict(mode='point',point=float(x[-1])),
                 *[dict(mode='truncate',side=side,value=float(v)) for side in ['before','after'] for v in [x[middle],(x[middle]+x[middle+1])/2]],
                 dict(mode='margins',emin=-190 if label!='constructed' else -19,emax=-30 if label!='constructed' else -2,tolerance=.1),
                 dict(mode='margins',emin=100 if label!='constructed' else 2,emax=900 if label!='constructed' else 19,tolerance=.1)]
        for i,options in enumerate(choices):
            arrays={k:src[k] for k in ['energy','xmu','pre_edge','post_edge']};arrays.update(i0=(np.arange(len(x))+1000).tolist(),signal=(np.arange(len(x))*3+17).tolist(),stddev=(np.arange(len(x))*.01+1).tolist())
            engine=Interpreter();g=Group(**{k:np.asarray(v,dtype=float) for k,v in arrays.items()});engine.symtable.set_symbol('g',g)
            payload=dict(arrays=arrays,options=options,e0=e0,shift=0,suffix='pre_edge' if options.get('emin',0)<0 else 'post_edge',points=[options.get('point')])
            script_parts=[]
            if options['mode']=='margins':
                before=commands(dict(payload,margin_only=True));script_parts.extend(before)
                for cmd in before:engine.eval(cmd)
                assert not engine.error,[e.get_error() for e in engine.error]
                payload['arrays']={**arrays,**{k:getattr(g,k).tolist() for k in ['menergy','margin1','margin2']}}
            after=commands(payload);script_parts.extend(after)
            for cmd in after:
                engine.eval(cmd)
                assert not engine.error,[e.get_error() for e in engine.error]
            retained=np.flatnonzero(np.isin(x,g.energy)).tolist()
            row=dict(name=label+'-'+str(i)+'-'+options['mode'],input=label,options=options,commands=script_parts,energy=g.energy.tolist(),mu=g.xmu.tolist(),kept_indices=retained,native_detectors={k:getattr(g,k).tolist() for k in ['i0','signal','stddev']})
            if options['mode']=='margins':row['margins']=dict(x=g.menergy.tolist(),upper=g.margin1.tolist(),lower=g.margin2.tolist())
            rows.append(row)
    return dict(sources=hashes,inputs=inputs,rows=rows)


def main():
    p=argparse.ArgumentParser(description=__doc__)
    for n in ['sources','environment','perl-lib','output']:p.add_argument('--'+n,type=Path,required=True)
    p.add_argument('--record',action='store_true');args=p.parse_args();result=replay(args)
    if args.record:ORACLE.write_bytes(gzip.compress(json.dumps(result,sort_keys=True,allow_nan=False).encode(),mtime=0))
    else:assert result==json.loads(gzip.decompress(ORACLE.read_bytes()))
    print(f'{len(result["rows"])} original native point/truncation/margin cases: PASS')
if __name__=='__main__':main()
