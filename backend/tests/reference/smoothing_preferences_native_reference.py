"""Execute original Config parser/defaults, Apply/Save and native SG template."""
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
ORACLE = ROOT/'backend/tests/fixtures/athena-smoothing-preferences-native.json.gz'
REV = '06afc8da08a5a7d5a26ee14992170fcf5dc67406'


def replay(args):
    args.output.mkdir(parents=True, exist_ok=True)
    catalog = {r['file']:r['sha256'] for r in json.loads((ROOT/'docs/athena-primary-sources.json').read_text())['files']}
    hashes = {}
    def source(root, name):
        raw = (root/name.replace('/','-')).read_bytes(); sha = hashlib.sha256(raw).hexdigest()
        assert catalog['demeter-'+REV+'/'+name] == sha
        hashes[name] = sha
        return raw.decode()
    config = source(args.sources, 'lib/Demeter/Config.pm')
    ui = source(args.sources, 'lib/Demeter/UI/Wx/Config.pm')
    ini = source(args.sources, 'lib/Demeter/IniReader.pm')
    process = source(args.smoothing_sources, 'lib/Demeter/configuration/process.demeter_conf')
    template = source(args.smoothing_sources, 'lib/Demeter/templates/process/larch/smooth.tmpl')
    methods = ['set','get','Push','_read_config_file','set_this_param','set_default','default','attribute','read_ini','write_ini']
    bodies = '\n'.join(re.search(r'sub '+name+r' \{.*?\n\};', config, re.S).group() for name in methods)
    apply = re.search(r'sub apply \{.*?\n\};', ui, re.S).group()
    module = args.output/'lib/Demeter/IniReader.pm'; module.parent.mkdir(parents=True, exist_ok=True); module.write_text(ini)
    configuration = args.output/'process.demeter_conf'; configuration.write_text(process)
    script = r'''use strict; use warnings; use JSON::PP; use Text::Template; use Digest::SHA qw(sha256_hex);
package NativeConfig;
use File::Basename; use File::Spec; use Cwd qw(abs_path); use Carp;
use Scalar::Util qw(looks_like_number); use Regexp::Assemble; use Config::INI::Writer; use Demeter::IniReader;
my(%ini,%params_of);
sub is_windows {0} sub push_all_config_files {} sub mo {$_[0]} sub ui {'athena'}
sub ini_file {$_[0]{file}} sub Type {$_[0]->attribute('type',$_[1],$_[2])}
sub reset_runtime {%ini=();%params_of=()}
''' + bodies + r'''
package Demeter; our $configuration; sub co {$configuration}
package Widget;
sub GetSelection {$_[0]{parameter}} sub GetItemText {$_[1]} sub GetItemParent {'smooth'}
sub GetValue {$_[0]{value}} sub SetLabel {$_[0]{label}=$_[1]}
package NativePanel; my $cdb; sub wxC2S_HTML_SYNTAX () {0}
sub accepted {my $self=shift;push @{$self->{callbacks}},[@_]}
''' + apply + r'''
package Data; sub group {$_[0]{group}} sub datatype {'xmu'} sub name {'Measured Cu'}
package main;
my $v=JSON::PP->new->decode(do{local $/;<STDIN>});
my $c=bless{file=>$v->{ini}},'NativeConfig';$Demeter::configuration=$c;
unlink $v->{ini} if -e $v->{ini};$c->_read_config_file($v->{configuration});$c->read_ini('smooth');
my $panel=bless{params=>bless({},'Widget'),Set=>bless({},'Widget'),Value=>bless({},'Widget'),callbacks=>[]},'NativePanel';
my @rows;
sub snapshot {
 my($name)=@_;$c->set(smooth_suffix=>'xmu');
 my $d=bless{group=>'h'},'Data';my $ds=bless{group=>'g'},'Data';
 my $t=Text::Template->new(TYPE=>'STRING',SOURCE=>$v->{template});
 my $call=$t->fill_in(HASH=>{C=>\$c,D=>\$d,DS=>\$ds});die $Text::Template::ERROR if !defined $call;
 push @rows,{name=>$name,values=>{window=>$c->default('smooth','sg_size'),order=>$c->default('smooth','sg_order')},
 declared=>{map {$_=>$c->attribute('demeter','smooth',$_)} qw(sg_size sg_order)},
 bounds=>{map {$_=>[$c->attribute('minint','smooth',$_),$c->attribute('maxint','smooth',$_)]} qw(sg_size sg_order)},
 saved=>Demeter::IniReader->read_file($v->{ini})->{smooth},template=>$call,callback_count=>scalar @{$panel->{callbacks}}};
}
snapshot('factory');
for my $step(@{$v->{steps}}) {
 if($step->{restart}) {$c->reset_runtime;$c->_read_config_file($v->{configuration});$c->read_ini('smooth')}
 else {$panel->{params}{parameter}=$step->{parameter};$panel->{Set}{value}=$step->{value};$panel->apply('accepted',$step->{save}//0)}
 snapshot($step->{name});
}
my %modules;
for my $name(qw(Regexp/Assemble.pm Config/INI/Reader.pm Config/INI/Writer.pm Demeter/IniReader.pm Text/Template.pm)) {
 open my $f,'<',$INC{$name} or die $!;binmode $f;local $/;$modules{$name}=sha256_hex(<$f>);
}
print JSON::PP->new->canonical->encode({rows=>\@rows,modules=>\%modules,callbacks=>$panel->{callbacks}});
'''
    path = args.output/'native.pl'; path.write_text(script)
    steps = [dict(name='apply-window',parameter='sg_size',value=13), dict(name='apply-order',parameter='sg_order',value=11),
             dict(name='restart-discards-applied',restart=True), dict(name='apply-even-window',parameter='sg_size',value=12),
             dict(name='save-includes-earlier-window',parameter='sg_order',value=11,save=1), dict(name='restart-loads-saved',restart=True),
             dict(name='factory-order-clamps',parameter='sg_order',value=4), dict(name='large-window-clamps',parameter='sg_size',value=100),
             dict(name='large-order-clamps',parameter='sg_order',value=100), dict(name='small-window',parameter='sg_size',value=3),
             dict(name='zero-window',parameter='sg_size',value=0), dict(name='negative-order-clamps',parameter='sg_order',value=-1)]
    env = dict(os.environ, **json.loads(args.environment.read_text()))
    env['PERL5LIB'] = str(args.output/'lib')+':'+str(args.perl_lib)+':'+env['PERL5LIB']
    env.update(PERL_HASH_SEED='0',PERL_PERTURB_KEYS='0')
    values = dict(steps=steps,configuration=str(configuration),template=template,ini=str(args.output/'demeter.ini'))
    result = subprocess.run(['perl',str(path)],env=env,input=json.dumps(values),capture_output=True,text=True,timeout=60)
    if result.returncode:
        raise RuntimeError(result.stderr)
    native = json.loads(result.stdout)
    fixture = ROOT/'backend/tests/fixtures/xdi-official-cu_metal_rt.xdi'
    table = np.loadtxt(fixture)
    for row in native['rows']:
        engine = Interpreter(); engine.symtable.set_symbol('g',Group(xmu=table[:,3].copy())); engine.symtable.set_symbol('h',Group())
        engine.eval(row['template'])
        if engine.error:
            row['error_type'] = engine.error[0].get_error()[0]
        else:
            row['smoothed_mu'] = engine.symtable.get_symbol('h.xmu').tolist()
    return dict(sources=hashes,fixture_sha256=hashlib.sha256(fixture.read_bytes()).hexdigest(),input_mu=table[:,3].tolist(),**native)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('sources','smoothing-sources','environment','perl-lib','output'):
        parser.add_argument('--'+name,type=Path,required=True)
    parser.add_argument('--record',action='store_true'); args=parser.parse_args()
    result = replay(args)
    if args.record: ORACLE.write_bytes(gzip.compress(json.dumps(result,sort_keys=True,allow_nan=False).encode(),mtime=0))
    else: assert result == json.loads(gzip.decompress(ORACLE.read_bytes()))
    print(f'{len(result["rows"])} native configuration/UI Apply/Save/Larch observations: PASS')


if __name__ == '__main__': main()
