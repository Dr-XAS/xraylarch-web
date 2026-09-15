"""Execute pinned Athena Quad/Bi-Quad methods, k/q command and point writers.

The display oracle runs original Perl methods and Text::Template. Processing
updates/accessors are bridges to independently prepared measured Larch arrays;
it does not run Wx, gnuplot or Athena's complete processing state machine.
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
from larch.xafs import pre_edge, autobk, xftf, xftr

ROOT = Path(__file__).resolve().parents[3]
FIX = ROOT / 'backend/tests/fixtures'
ORACLE = FIX / 'athena-special-plot-native.json.gz'


def measured(index, shift, weight):
    rows = []
    for line in (FIX / f'demeter-merge-fe.06{index}').read_text().splitlines():
        try: row = [float(v) for v in line.split()]
        except ValueError: continue
        if len(row) == 3: rows.append(row)
    x, i0, it = np.asarray(rows).T
    mu = np.log(i0 / it)
    g = Group()
    pre_edge(x + shift, mu, group=g, e0=7112 + shift, pre1=-150, pre2=-30, norm1=150, norm2=800, nnorm=2)
    autobk(x + shift, mu, group=g, e0=g.e0, edge_step=g.edge_step, rbkg=1, kmin=0, kmax=14,
           kweight=2, dk=1, win='hanning', nfft=2048, kstep=.05)
    xftf(g.k, g.chi * g.k ** weight, group=g, kmin=3, kmax=12, kweight=0, dk=1,
         window='hanning', nfft=2048, kstep=.05, rmax_out=10)
    xftr(g.r, g.chir, group=g, rmin=1, rmax=3, dr=0, window='hanning', nfft=2048, kstep=.05, qmax_out=g.k[-1])
    arrays = {k: getattr(g, k).tolist() for k in ['norm', 'flat', 'pre_edge', 'post_edge', 'bkg', 'k', 'chi',
              'r', 'chir_mag', 'chir_re', 'q', 'chiq_re', 'chiq_im', 'chiq_mag']}
    arrays.update(energy=x.tolist(), xmu=mu.tolist())
    return dict(arrays=arrays, name=f'Measured Fe {index}', bkg_eshift=shift, bkg_e0=float(g.e0),
                edge_step=float(g.edge_step), group=f'g{index}', plottable=1, datatype='xmu')


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
    templates = {n: source(f'lib/Demeter/templates/plot/gnuplot/{n}.tmpl') for n in ['quad', 'biquad', 'newk', 'newq', 'overq']}
    code = r'''use strict;use warnings;use Text::Template;use JSON::PP;
package Access;our$AUTOLOAD;sub AUTOLOAD{my$s=shift;(my$n=$AUTOLOAD)=~s/.*:://;return if$n eq'DESTROY';$s->{$n}=shift if @_;return$s->{$n}//0}
sub get{my$s=shift;return wantarray?map{$s->{$_}//0}@_:$s->{$_[0]}//0}
sub set{my$s=shift;my%v=@_;@{$s}{keys%v}=values%v;return$s}
package Config;our@ISA=('Access');sub default{'lines'}sub set_default{}
package Mode;our@ISA=('Access');
package Plot;our@ISA=('Access');sub start_plot{$_[0]{increm}=0}sub New{$_[0]{increm}==0}
sub increment{$_[0]{increm}++}sub reinitialize{}sub after_plot_hook{}
sub tempfile{my$p='points-'.scalar(@main::files).'.dat';push@main::files,$p;return$p}
package Data;our@ISA=('Access');use Carp;use List::Util qw(max);use List::MoreUtils qw(zip pairwise);
my$ETOK=.2624682917;sub is_DataPart{0}sub data{$_[0]}sub get_mode{'gnuplot'}
sub _update{push@main::updates,[$_[0]->group,$_[1]]}sub get_array{my($s,$n)=@_;return wantarray?@{$s->{arrays}{$n}}:scalar@{$s->{arrays}{$n}}}
sub standard{$main::standard=$_[0]}sub unset_standard{$main::standard=undef}
sub chart{my($s,@v)=@_;return$s->template(@v)}
sub template{my($s,$kind,$name)=@_;my$c=$s->co;my$p=$s->po;my$ds=$main::standard;
 push@main::used,$name;my$t=Text::Template->new(TYPE=>'STRING',SOURCE=>$main::v->{templates}{$name})or die$name;
 my$error;my$out=$t->fill_in(HASH=>{D=>\$s,DS=>\$ds,S=>\$s,C=>\$c,P=>\$p,PT=>undef},PACKAGE=>'Render',BROKEN=>sub{$error=$_[0]{error};return''});die$error if$error;die$Text::Template::ERROR if !defined$out;return$out}
'''
    for s, names in [(data, ['get_kweight']), (plots, ['quadplot', 'biquadplot', '_plotkq_command', '_plotk_command', '_plotq_command']), (arrays, ['points'])]:
        code += '\n' + '\n'.join(method(s, n) for n in names)
    code += r'''
package main;our$v=JSON::PP->new->decode(do{local$/;<STDIN>});our(@files,@updates,@used,$standard);
my$p=bless{increm=>0,kweight=>$v->{weight},q_pl=>$v->{q_component},xlabel=>'',ylabel=>'',showlegend=>1},'Plot';
my$c=bless{},'Config';my$m=bless{plot=>$p,template_plot=>'gnuplot'},'Mode';
my@d=map{bless{%$_,po=>$p,co=>$c,mo=>$m},'Data'}@{$v->{groups}};
if($v->{view} eq'quad'){$d[0]->quadplot}elsif($v->{view} eq'biquad'){$d[0]->biquadplot($d[1])}else{$d[0]->_plotkq_command}
my@curves=map{open my$f,'<',$_ or die$!;[map{[map{0+$_}split]}<$f>]}@files;
print JSON::PP->new->canonical->encode({curves=>\@curves,templates=>\@used,updates=>\@updates});
'''
    driver = args.output / 'native.pl'
    driver.write_text(code)
    env = dict(os.environ, **json.loads(args.environment.read_text()))
    env['PERL5LIB'] = str(args.perl_lib) + ':' + env['PERL5LIB']
    rows = []
    for weight in [0, 1, 1.5, 2, 3, 4]:
        prepared = [measured(0, 2.375, weight), measured(1, -1.125, weight)]
        for view, component in [('quad', 'r'), ('biquad', 'r'), ('kq', 'r'), ('kq', 'i'), ('kq', 'm')]:
            for scale, offset in [(1, 0), (-1.2, .375), (0, -.2)]:
                row = dict(id=len(rows), view=view, q_component=component, weight=weight,
                           groups=[dict(g, plot_multiplier=scale, y_offset=offset) for g in prepared[:2 if view == 'biquad' else 1]])
                folder = args.output / f'case-{row["id"]}'
                folder.mkdir(exist_ok=True)
                for old in folder.glob('points-*.dat'): old.unlink()
                proc = subprocess.run(['perl', str(driver.resolve())], input=json.dumps(dict(row, templates=templates)),
                                      cwd=folder, env=env, text=True, capture_output=True, timeout=30)
                if proc.returncode: raise RuntimeError(proc.stderr)
                row['native'] = json.loads(proc.stdout)
                rows.append(row)
    return dict(sources=hashes, rows=rows)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['sources', 'environment', 'perl-lib', 'output']: parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--record', action='store_true')
    args = parser.parse_args()
    value = observe(args)
    if args.record: ORACLE.write_bytes(gzip.compress(json.dumps(value, sort_keys=True, allow_nan=False).encode(), mtime=0))
    else: assert value == json.loads(gzip.decompress(ORACLE.read_bytes()))
    print(f'{len(value["rows"])} original Athena diagnostic template/points observations: PASS')


if __name__ == '__main__': main()
