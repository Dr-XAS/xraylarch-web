"""Execute original Athena shortcut methods and gnuplot point writers.

Wx controls/accessors and processing updates are bridges. Measured arrays are
prepared independently with Larch; original k123 process expressions run in
Python. The original marked-plot handlers, plotting methods, Text::Template
and Data::points run unchanged. This does not execute the full native GUI.
"""
import argparse
import copy
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess

import numpy as np
from larch import Group
from larch.xafs import xftf
from special_plot_native_reference import measured

ROOT = Path(__file__).resolve().parents[3]
FIX = ROOT / 'backend/tests/fixtures'
ORACLE = FIX / 'athena-shortcut-plot-native.json.gz'


def prepare(index, shift):
    g = measured(index, shift, 2)
    rows = []
    for line in (FIX / f'demeter-merge-fe.06{index}').read_text().splitlines():
        try: row = [float(v) for v in line.split()]
        except ValueError: continue
        if len(row) == 3: rows.append(row)
    x, i0, signal = np.asarray(rows).T
    a = g['arrays']
    a.update(i0=i0.tolist(), signal=signal.tolist(), nder=(np.gradient(a['norm']) / np.gradient(x)).tolist())
    g.update(bkg_step=g['edge_step'], marked=1, i0_string='retained_i0', signal_string='retained_signal',
             i0_scale=abs(max(a['xmu'])) / max(i0), signal_scale=abs(max(a['xmu'])) / max(signal))
    g['transforms'] = {}
    for weight in (1, 2, 3):
        ft = Group()
        k, chi = np.asarray(a['k']), np.asarray(a['chi'])
        xftf(k, chi*k**weight, group=ft, kmin=3, kmax=12, kweight=0, dk=1,
             window='hanning', nfft=2048, kstep=.05, rmax_out=10)
        g['transforms'][str(weight)] = {n: getattr(ft, n).tolist() for n in ('r', 'chir_mag', 'chir_re', 'chir_im')}
        g['transforms'][str(weight)]['chir_pha'] = np.unwrap(np.angle(ft.chir)).tolist()
    return g


def observe(args):
    args.output.mkdir(parents=True, exist_ok=True)
    catalog = {r['file']: r['sha256'] for r in json.loads((ROOT / 'docs/athena-primary-sources.json').read_text())['files']}
    hashes = {}
    def source(path):
        data = (args.sources / path.replace('/', '-')).read_bytes()
        sha = hashlib.sha256(data).hexdigest()
        assert next(v for k, v in catalog.items() if k.endswith('/' + path)) == sha
        hashes[path] = sha
        return data.decode()
    def method(s, name): return re.search(r'^sub ' + name + r' \{.*?^\};', s, re.S | re.M).group()
    data = source('lib/Demeter/Data.pm')
    plots = source('lib/Demeter/Data/Plot.pm')
    arrays = source('lib/Demeter/Data/Arrays.pm')
    mu = source('lib/Demeter/Data/Mu.pm')
    ui = source('lib/Demeter/UI/Athena.pm')
    templates = {n: source(f'lib/Demeter/templates/plot/gnuplot/{n}.tmpl') for n in ['newe', 'overe', 'newk', 'overk', 'newr', 'overr']}
    templates['k123'] = source('lib/Demeter/templates/process/larch/k123.tmpl')
    code = r'''use strict;use warnings;use Text::Template;use JSON::PP;
package Access;our$AUTOLOAD;sub AUTOLOAD{my$s=shift;(my$n=$AUTOLOAD)=~s/.*:://;return if$n eq'DESTROY';$s->{$n}=shift if @_;return$s->{$n}//0}
sub get{my$s=shift;return wantarray?map{$s->{$_}//0}@_:$s->{$_[0]}//0}
sub set{my$s=shift;my%v=@_;@{$s}{keys%v}=values%v;return$s}
package Config;our@ISA=('Access');sub default{my($s,$section,$name)=@_;return {ed_min=>-30,ed_max=>70,ed_scale=>.5}->{$name}//'lines'}sub set_default{}
package Mode;our@ISA=('Access');
package Plot;our@ISA=('Access');sub start_plot{$_[0]{increm}=0}sub New{$_[0]{increm}==0}
sub increment{$_[0]{increm}++}sub reinitialize{}sub after_plot_hook{}
sub tempfile{my$p='points-'.scalar(@main::files).'.dat';push@main::files,$p;return$p}
package Demeter;sub po{$main::p}
package List;sub GetCount{scalar@main::d}sub GetIndexedData{$main::d[$_[1]]}sub IsChecked{$main::d[$_[1]]->marked}
package App;our@ISA=('Access');my$PLOTRANGE0=.001;sub preplot{}sub postplot{}
'''
    code += '\n'.join(method(ui, n) for n in ['plot_e00', 'plot_i0_marked', 'plot_norm_scaled'])
    code += r'''
package Data;our@ISA=('Access');use Carp;use List::Util qw(max);use List::MoreUtils qw(zip pairwise);
my$ETOK=.2624682917;sub is_DataPart{0}sub data{$_[0]}sub get_mode{'gnuplot'}
sub _update{push@main::updates,[$_[0]->group,$_[1],$_[0]->po->kweight]}
sub get_array{my($s,$n)=@_;my$a=$s->{transforms}{$s->po->kweight}{$n}//$s->{arrays}{$n};die"missing $n" unless ref$a eq'ARRAY';return wantarray?@$a:scalar@$a}
sub fetch_array{my($s,$n)=@_;$n=~s/^.*\.//;return$s->get_array($n)}
sub fetch_scalar{$_[0]{scalars}{$_[1]}}
sub dispose{my($s,$text,$kind)=@_;push@main::process,$text if defined$text && $text=~/__123_max1/}
sub _e0_marker_command{push@main::markers,[$_[0]->group,$_[1]];return''}
sub template{my($s,$kind,$name)=@_;my$c=$s->co;my$p=$s->po;
 push@main::used,$name;my$t=Text::Template->new(TYPE=>'STRING',SOURCE=>$main::v->{templates}{$name})or die$name;
 my$error;my$out=$t->fill_in(HASH=>{D=>\$s,S=>\$s,C=>\$c,P=>\$p,PT=>undef,dobkgk=>0},PACKAGE=>'Render',BROKEN=>sub{$error=$_[0]{error};return''});die$error if$error;die$Text::Template::ERROR if !defined$out;return$out}
'''
    for s, names in [(data, ['get_kweight']), (plots, ['plot', '_plot_command', '_plotk_command', '_plotR_command', 'plotk123', 'plotR123']),
                     (mu, ['_plotE_command', '_plotE_string', 'plot_ed']), (arrays, ['points'])]:
        code += '\n' + '\n'.join(method(s, n) for n in names)
    code += r'''
package main;our$v=JSON::PP->new->decode(do{local$/;<STDIN>});our(@files,@updates,@used,@markers,@process);
our$p=bless{increm=>0,kweight=>2,r_pl=>$v->{component},xlabel=>'',ylabel=>'',showlegend=>1,emin=>-200,emax=>900,e_norm=>$v->{energy_norm}},'Plot';
my$c=bless{},'Config';my$m=bless{plot=>$p,template_plot=>'gnuplot'},'Mode';
our@d=map{bless{%$_,po=>$p,co=>$c,mo=>$m},'Data'}@{$v->{groups}};
my$control=bless{},'Access';my$app=bless{current_data=>$d[0],main=>{PlotE=>$control,Other=>{title=>$control},project=>$control,list=>bless({},'List')}},'App';
if($v->{kind} eq'normderiv'){$d[0]->plot('ed')}
elsif($v->{kind} eq'k123'){$d[0]->plot('k123')}
elsif($v->{kind} eq'r123'){$d[0]->plot('r123')}
elsif($v->{kind} eq'i0sig'){$p->set(e_mu=>1,e_i0=>1,e_signal=>1,e_norm=>0);$d[0]->plot('e')}
elsif($v->{kind} eq'i0'){$app->plot_i0_marked}
elsif($v->{kind} eq'e00'){$app->plot_e00}
elsif($v->{kind} eq'normscaled'){$app->plot_norm_scaled}
my@curves=map{open my$f,'<',$_ or die$!;[map{[map{0+$_}split]}<$f>]}@files;
my@restored=map{[$_->group,$_->plot_multiplier,$_->y_offset,$_->bkg_eshift,$_->bkg_e0]}@d;
print JSON::PP->new->canonical->encode({curves=>\@curves,templates=>\@used,updates=>\@updates,markers=>\@markers,process=>\@process,restored=>\@restored});
'''
    driver = args.output / 'native.pl'; driver.write_text(code)
    env = dict(os.environ, **json.loads(args.environment.read_text()))
    env['PERL5LIB'] = str(args.perl_lib) + ':' + env['PERL5LIB']
    prepared = [prepare(0, 2.375), prepare(1, -1.125)]
    cases = []
    for flatten in (False, True):
        for scale, offset in [(1., 0.), (-1.2, .375), (0., -.2)]:
            for kind, component, norm in [('normderiv', 'm', 1), ('i0sig', 'm', 0), ('i0', 'm', 0),
                                          ('normscaled', 'm', 1), ('e00', 'm', 0), ('e00', 'm', 1),
                                          ('k123', 'm', 0)] + [('r123', c, 0) for c in 'mrip']:
                cases.append(dict(kind=kind, component=component, energy_norm=norm,
                                  flatten=flatten, scale=scale, offset=offset, variant='measured'))
    # Controlled point-writer probes make sprintf return the string "0.000".
    # Perl considers that string true, unlike literal numeric zero.
    for kind in ('normderiv', 'k123'):
        cases.append(dict(kind=kind, component='m', energy_norm=1, flatten=True,
                          scale=-1.2, offset=.375, variant='rounded-zero'))
    rows = []
    for row in cases:
        row['id'] = len(rows)
        kind = row['kind']
        groups = copy.deepcopy(prepared[:2 if kind in ('i0','e00','normscaled') else 1])
        for g in groups:
            g.update(plot_multiplier=row['scale'], y_offset=row['offset'], bkg_flatten=int(row['flatten']))
            if row['variant'] == 'rounded-zero':
                if kind == 'normderiv': g['arrays']['nder'] = (np.asarray(g['arrays']['nder'])*1e6).tolist()
                else: g['arrays'].update(k=[0.,10000.,20000.,30000.], chi=[0.,1.,-1.,1.])
            process = '\n'.join(line for line in templates['k123'].splitlines() if line.startswith('__123_'))
            process = process.replace('{$D->group}', g['group'])
            scope = {g['group']: Group(k=np.asarray(g['arrays']['k']), chi=np.asarray(g['arrays']['chi'])), 'max': np.max}
            exec(process, scope)
            g['scalars'] = {k: float(v) for k,v in scope.items() if k.startswith('__123_')}
        folder = args.output / f'case-{row["id"]}'; folder.mkdir(exist_ok=True)
        for old in folder.glob('points-*.dat'): old.unlink()
        proc = subprocess.run(['perl', str(driver.resolve())], input=json.dumps(dict(row, groups=groups, templates=templates)),
                              cwd=folder, env=env, text=True, capture_output=True, timeout=30)
        if proc.returncode: raise RuntimeError(proc.stderr)
        row['native'] = json.loads(proc.stdout)
        if kind == 'k123':
            original = '\n'.join(line for line in row['native']['process'][0].splitlines() if line.startswith('__123_'))
            assert original == process
        rows.append(row)
    return dict(sources=hashes, groups=prepared, rows=rows)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['sources', 'environment', 'perl-lib', 'output']: parser.add_argument('--'+name, type=Path, required=True)
    parser.add_argument('--record', action='store_true')
    args = parser.parse_args(); value = observe(args)
    if args.record: ORACLE.write_bytes(gzip.compress(json.dumps(value, sort_keys=True, allow_nan=False).encode(), mtime=0))
    else: assert value == json.loads(gzip.decompress(ORACLE.read_bytes()))
    print(f'{len(value["rows"])} original Athena shortcut/points observations: PASS')


if __name__ == '__main__': main()
