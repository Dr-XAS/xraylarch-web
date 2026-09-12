"""Observe pinned Athena export templates with real Text::Template and Larch.

Arrays and object accessors are explicit constructed probes, not desktop
processing. Templates are unchanged; failed native paths are recorded as such.
Only pinned trusted source is evaluated. This never evaluates uploaded files.
"""
import argparse
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess

import numpy as np
from larch import Group, Interpreter

FIXTURES = Path(__file__).resolve().parents[1] / 'fixtures'
ORACLE = FIXTURES / 'athena-export-templates-native.json'


def cases():
    for name in ('save_xmu', 'save_xmu_xanes'):
        for i0 in (False, True):
            yield dict(id=f'{name}-i0-{int(i0)}', templates=[name], i0=i0)
    for i0 in (False, True):
        yield dict(id=f'save_xmu_xanes-missing-bkg-i0-{int(i0)}', templates=['save_xmu_xanes'],
                   i0=i0, missing_bkg=True)
    for name in ('save_norm', 'save_norm_xanes', 'save_chik', 'save_chir', 'save_chiq'):
        yield dict(id=name, templates=[name], i0=False)
    for weight in ('0', '1', '2', '3', 'kw'):
        yield dict(id=f'save_chikw-{weight}', templates=['save_chikw'], i0=False, weight=weight)
    for which in ('xmu', 'norm', 'der', 'nder', 'sec', 'nsec',
                  'chir_mag', 'chir_re', 'chir_im', 'chir_pha', 'dph',
                  'chiq_mag', 'chiq_re', 'chiq_im', 'chiq_pha'):
        space = 'r' if which.startswith('chir') or which == 'dph' else 'q' if which.startswith('chiq') else 'energy'
        yield dict(id=f'save_many-{which}', templates=['save_many_header', 'save_many'],
                   i0=False, space=space, which=which, suffix='int' if space == 'energy' else which)
    for which in ('chi', 'chik', 'chik2', 'chik3'):
        yield dict(id=f'save_many-{which}', templates=['save_many_header_k', 'save_many_k'],
                   i0=False, space='k', which=which, suffix=which)
    yield dict(id='save_many-chi-unequal-grids', templates=['save_many_header_k', 'save_many_k'],
               i0=False, space='k', which='chi', suffix='chi', unequal_grids=True)
    for ident, templates, products in [
        ('derivatives', ['deriv', 'nderiv'], ['der', 'sec', 'nder', 'nsec']),
        ('phase', ['dphase'], ['dph']),
        ('background', ['post_autobk'], ['nbkg']),
        ('flatten', ['flatten_set'], ['flat', 'fbkg']),
        ('interpolation', ['interpolate'], ['int']),
    ]:
        yield dict(id='products-'+ident, templates=templates, products=products, i0=False)


def render(sources, environment, output, text_template_lib):
    rows = list(cases())
    output.mkdir(parents=True, exist_ok=True)
    catalog = json.loads((FIXTURES.parents[2] / 'docs/athena-primary-sources.json').read_text())
    hashes = {}
    for row in rows:
        row['files'] = []
        for name in row['templates']:
            suffix = f'lib/Demeter/templates/process/larch/{name}.tmpl'
            file = sources / suffix.replace('/', '-')
            digest = hashlib.sha256(file.read_bytes()).hexdigest()
            assert digest == next(f['sha256'] for f in catalog['files'] if f['file'].endswith('/' + suffix))
            hashes[suffix] = digest
            row['files'].append(str(file.resolve()))
    (output / 'cases.json').write_text(json.dumps(rows))
    # Accessor bridge only: no generated expressions or rewritten template bodies.
    script = r'''use strict; use warnings; use Text::Template; use JSON::PP;
package Config;
sub get { $_[0]{$_[1]} }
sub default { $_[0]{$_[2]} }
package Data;
sub group { $_[0]{group} }
sub name { $_[0]{name} }
sub co { $_[0]{config} }
sub bkg_e0 { 8980.5 }
sub bkg_eshift { 2.25 }
sub fit_karb_value { 1.5 }
sub get_kweight { 2 }
sub bkg_z { 'Cu' }
sub fft_edge { 'K' }
sub version { '0.9.26' }
sub bkg_step { 3.2 }
sub y_offset { 0.35 }
sub bkg_int { 0.1 }
sub bkg_slope { 0.001 }
sub bkg_nc0 { 0.2 }
sub bkg_nc1 { 0.003 }
sub bkg_nc2 { 0 }
sub bkg_nc3 { 0 }
sub bkg_fitted_step { 3.2 }
sub bkg_nnorm { 2 }
sub iofx { 4 }
package main;
my $rows = JSON::PP->new->decode(do { local $/; open my $f,'<','cases.json' or die $!; <$f> });
my @out;
for my $row (@$rows) {
 my $config=bless {chik_out=>$row->{weight}//'all', many_space=>$row->{space}//'energy',
   many_which=>$row->{which}//'xmu', many_suffix=>$row->{suffix}//'int', many_file=>'output.dat'}, 'Config';
 my $data=bless {group=>'g', name=>'Cu foil 1', config=>$config}, 'Data';
 my $second=bless {group=>'h', name=>'Cu foil 2', config=>$config}, 'Data';
 $config->{many_list}=[$data,$second];
 my $text='';
 for my $file (@{$row->{files}}) {
  my $t=Text::Template->new(TYPE=>'file', SOURCE=>$file) or die $Text::Template::ERROR;
  my $s=$t->fill_in(HASH=>{S=>\$data,D=>\$data,C=>\$config,DS=>\$second,suffix=>'xmu',filename=>'output.dat'},
    PACKAGE=>'Demeter::Templates') // die $Text::Template::ERROR;
  $s =~ s{^\s+}{}; $s =~ s{\n(?:[ \t]+\n)+}{\n}; $s =~ s{\s+$}{\n};
  $s =~ s{<<nl>>}{\n}g; $s =~ s{<<( +)>>}{$1}g;
  $text.=$s;
 }
 push @out,{id=>$row->{id}, code=>$text};
}
print JSON::PP->new->canonical->encode({version=>$Text::Template::VERSION, cases=>\@out});
'''
    path = output / 'render.pl'; path.write_text(script)
    env = dict(os.environ, **json.loads(environment.read_text()))
    env['PERL5LIB'] = str(text_template_lib.resolve()) + os.pathsep + env.get('PERL5LIB', '')
    result = subprocess.run(['perl', str(path.resolve())], cwd=output, env=env,
                            capture_output=True, check=True, timeout=60)
    rendered = json.loads(result.stdout)
    return rows, rendered, hashes


def seed(i0):
    # Distinct arrays reveal column ordering and mutation without claiming
    # pre-edge/AUTOBK/FT equivalence. All grids here have the same length.
    fields = ('energy', 'xmu', 'bkg', 'pre_edge', 'post_edge', 'der', 'sec',
              'norm', 'nbkg', 'flat', 'fbkg', 'nder', 'nsec', 'k', 'chi',
              'kwin', 'r', 'chir_re', 'chir_im', 'chir_mag', 'chir_pha',
              'rwin', 'dph', 'q', 'chiq_re', 'chiq_im', 'chiq_mag', 'chiq_pha',
              'int', 'chik', 'chik2', 'chik3')
    values = {key: np.arange(1, 10, dtype=float) + index * 10 for index, key in enumerate(fields)}
    values['energy'] = np.arange(9, dtype=float) * 10 + 8970
    values['k'] = np.arange(9, dtype=float) * .05
    if i0:
        values['i0'] = np.arange(9, dtype=float) + 1000
    values['myheader'] = ['Constructed native export template probe']
    return Group(**values)


def execute(rows, rendered, output):
    results = []
    for row, native in zip(rows, rendered['cases'], strict=True):
        assert row['id'] == native['id']
        directory = output / row['id']; directory.mkdir(exist_ok=True)
        target = directory / 'output.dat'
        if target.exists():
            target.unlink()
        code = native['code'].replace('"output.dat"', json.dumps(str(target.resolve())))
        (directory / 'native.lar').write_text(native['code'])
        stdout = io.StringIO()
        interpreter = Interpreter(writer=stdout)
        g, h = seed(row['i0']), seed(row['i0'])
        if row.get('products'):
            g.prex = g.xmu-g.pre_edge
            g.norm = g.prex/3.2
            h.energy = h.energy+5
        if row.get('missing_bkg'):
            del g.bkg
        if row.get('unequal_grids'):
            h.chi = h.chi[:-1]
        h.int = h.int + 100
        inputs = {name: {key: value.tolist() for key, value in vars(obj).items() if isinstance(value, np.ndarray)}
                  for name, obj in [('g', g), ('h', h)]} if row.get('products') else None
        interpreter.symtable.set_symbol('g', g); interpreter.symtable.set_symbol('h', h)
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stdout):
            interpreter(code)
        result = dict(id=row['id'], code=native['code'], errors=[error.get_error()[0] for error in interpreter.error])
        if row.get('products'):
            result.update(inputs=inputs, products={key: getattr(g, key).tolist() for key in row['products']})
        if target.exists():
            text = target.read_text()
            lines = text.splitlines()
            numeric = np.loadtxt(io.StringIO(text), ndmin=2)
            result.update(data=numeric.tolist(), columns=numeric.shape[1],
                          labels=next(line[1:].strip().split() for line in reversed(lines) if line.startswith('#')),
                          header=[line for line in lines if line.startswith('#')])
        results.append(result)
    return results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sources', type=Path, required=True)
    parser.add_argument('--environment', type=Path, required=True)
    parser.add_argument('--text-template-lib', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--write', action='store_true')
    args = parser.parse_args()
    rows, rendered, hashes = render(args.sources, args.environment, args.output, args.text_template_lib)
    results = execute(rows, rendered, args.output)
    report = dict(basis='Constructed arrays; actual Perl Text::Template and actual Larch interpreter/write_ascii',
                  text_template_version=rendered['version'], source_sha256=hashes, cases=results)
    if args.write:
        ORACLE.write_text(json.dumps(report, indent=2) + '\n')
    else:
        assert report == json.loads(ORACLE.read_text())
    print(f"{len(results)} native template observations replayed; "
          f"{sum('data' in r and not r['errors'] for r in results)} error-free tables; "
          f"{sum(bool(r['errors']) for r in results)} native execution errors "
          f"({sum('data' in r and bool(r['errors']) for r in results)} still wrote files)")


if __name__ == '__main__':
    main()
