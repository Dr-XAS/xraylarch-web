"""Execute pinned native plot dispatch, templates and Data::points.

Object accessors and processing updates are bridges; original Perl methods
choose/transform the independently supplied measured Larch arrays and write
the actual gnuplot point files. No uploaded code is executed.
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
from larch import Group
from larch.xafs import pre_edge

ROOT=Path(__file__).resolve().parents[3]
FIX=ROOT/'backend/tests/fixtures'
ORACLE=FIX/'athena-merge-plot-native.json.gz'


def observe(args):
    args.output.mkdir(parents=True,exist_ok=True)
    catalog={r['file']:r['sha256'] for r in json.loads((ROOT/'docs/athena-primary-sources.json').read_text())['files']}
    hashes={}
    def source(p):
        b=(args.sources/p.replace('/','-')).read_bytes();sha=hashlib.sha256(b).hexdigest()
        assert next(v for k,v in catalog.items() if k.endswith('/'+p))==sha
        hashes[p]=sha;return b.decode()
    def method(s,n):return re.search(r'^sub '+n+r' \{.*?^\};',s,re.S|re.M).group()
    data=source('lib/Demeter/Data.pm');plots=source('lib/Demeter/Data/Plot.pm')
    mu=source('lib/Demeter/Data/Mu.pm');arrays=source('lib/Demeter/Data/Arrays.pm')
    templates={n:source('lib/Demeter/templates/plot/gnuplot/'+n+'.tmpl') for n in ['newe','newk','stddeve','stddevn','stddevk','variancee','variancek']}
    code=r'''use strict;use warnings;use Text::Template;use JSON::PP;
package Access;our$AUTOLOAD;sub AUTOLOAD{my$s=shift;(my$n=$AUTOLOAD)=~s/.*:://;return if$n eq'DESTROY';$s->{$n}=shift if @_;return$s->{$n}//0}
sub get{my$s=shift;return wantarray?map{$s->{$_}//0}@_:$s->{$_[0]}//0}
sub set{my$s=shift;my%v=@_;@{$s}{keys%v}=values%v;return$s}
package Config;our@ISA=('Access');sub default{'lines'}
package Mode;our@ISA=('Access');
package Plot;our@ISA=('Access');sub start_plot{$_[0]{New}=1;$_[0]{increm}=0}
sub increment{$_[0]{increm}++}sub reinitialize{}sub after_plot_hook{}
sub tempfile{my$p='points-'.scalar(@main::files).'.dat';push@main::files,$p;return$p}
package Data;our@ISA=('Access');use Carp;use List::Util qw(max);use List::MoreUtils qw(zip pairwise);
my$ETOK=.2624682917;sub is_DataPart{0}sub data{$_[0]}
sub _update{push@main::updates,$_[1]}sub get_mode{'gnuplot'}
sub get_array{my($s,$n)=@_;return wantarray?@{$s->{arrays}{$n}}:scalar@{$s->{arrays}{$n}}}
sub dispose{push@main::commands,$_[1]}
sub template{my($s,$kind,$name)=@_;my$c=$s->co;my$p=$s->po;
 push@main::used,$name;my$t=Text::Template->new(TYPE=>'STRING',SOURCE=>$main::v->{templates}{$name})or die$name;
 my$out=$t->fill_in(HASH=>{D=>\$s,S=>\$s,C=>\$c,P=>\$p,PT=>undef},PACKAGE=>'Render');die$Text::Template::ERROR if !defined$out;return$out}
'''
    for s,names in [(data,['get_kweight','nsuff']),(plots,['plot','_plot_command','_plotk_command','stddevplot','varianceplot']),
                    (mu,['_plotE_command','_plotE_string']),(arrays,['points'])]:
        code+='\n'+'\n'.join(method(s,n) for n in names)
    code+=r'''
package main;our$v=JSON::PP->new->decode(do{local$/;<STDIN>});our(@files,@commands,@updates,@used);
my$p=bless{New=>1,e_mu=>1,e_norm=>$v->{e_norm},showlegend=>1,xlabel=>'',ylabel=>'',kweight=>$v->{weight}},'Plot';
my$c=bless{},'Config';my$m=bless{plot=>$p},'Mode';
my$d=bless{%{$v->{data}},po=>$p,co=>$c,mo=>$m},'Data';
my$error='';eval{$d->plot($v->{view})};$error=$@ if$@;
my@curves=map{open my$f,'<',$_ or die$!;[map{[map{0+$_}split]}<$f>]}@files;
print JSON::PP->new->canonical->encode({curves=>\@curves,error=>$error?'native error':undef,templates=>\@used,updates=>\@updates});
'''
    (args.output/'native.pl').write_text(code)
    env=dict(os.environ,**json.loads(args.environment.read_text()));env['PERL5LIB']=str(args.perl_lib)+':'+env['PERL5LIB']
    base=json.loads(gzip.decompress((FIX/'athena-merge-native.json.gz').read_bytes()))
    records=[]
    for how in ['e','n','k']:
        row=next(r for r in base['rows'] if r['case']['how']==how and r['case']['weightby']=='importance' and r['case']['trim']==0)
        x,y,sigma=map(np.asarray,[row['x'],row['y'],row['stddev']])
        a=dict(energy=x.tolist(),xmu=y.tolist(),stddev=sigma.tolist())
        if how=='k':a.update(k=x.tolist(),chi=y.tolist())
        else:
            g=Group();pre_edge(x,y,group=g);a.update(norm=g.norm.tolist(),flat=g.flat.tolist())
        for view in ['stddev','variance']:
            displays=['norm','flat'] if how=='n' else ['mu','norm','flat'] if how=='e' and view=='variance' else ['mu']
            modifiers=[(1,0,2),(2.5,.375,1.5),(-1.2,-.2,3),(0,.4,0)]+([(1,0,w) for w in [1,4]] if how=='k' else [])
            for display in displays:
                for scale,offset,weight in modifiers:
                    records.append(dict(how=how,view=view,display=display,scale=scale,offset=offset,weight=weight,arrays=a))
    for view in ['stddev','variance']:
        row=json.loads(json.dumps(records[0]));row.update(view=view,zero=True);row['arrays']['stddev']=[0.]*len(row['arrays']['energy']);records.append(row)
    for i,row in enumerate(records):
        a=row['arrays'];data=dict(arrays=a,is_merge=row['how'],group='g',name='Measured merge',datatype='chi' if row['how']=='k' else 'xmu',
             plottable=1,bkg_flatten=int(row['display']=='flat'),bkg_eshift=2.375 if row['how']!='k' else 0,bkg_e0=7112,plot_multiplier=row['scale'],y_offset=row['offset'])
        payload=dict(data=data,view=row['view'],e_norm=int(row['display']!='mu'),weight=row['weight'],templates=templates)
        proc=subprocess.run(['perl','native.pl'],input=json.dumps(payload),cwd=args.output,env=env,text=True,capture_output=True,timeout=30)
        if proc.returncode:raise RuntimeError(proc.stderr)
        row.update(id=i,native=json.loads(proc.stdout))
    return dict(sources=hashes,rows=records)


def main():
    p=argparse.ArgumentParser(description=__doc__)
    for n in ['sources','environment','perl-lib','output']:p.add_argument('--'+n,type=Path,required=True)
    p.add_argument('--record',action='store_true');args=p.parse_args();value=observe(args)
    if args.record:ORACLE.write_bytes(gzip.compress(json.dumps(value,sort_keys=True,allow_nan=False).encode(),mtime=0))
    else:assert value==json.loads(gzip.decompress(ORACLE.read_bytes()))
    print(f'{len(value["rows"])} native plot dispatch/template/points observations: PASS')
if __name__=='__main__':main()
