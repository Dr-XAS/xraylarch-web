"""Execute pinned Athena Report/header/row with real native XLS dependencies.

GUI/file selection and data accessors are explicit bridges. Workbook writing,
column formatting, selection loop, element names and clamp conversion execute
the original sources. No uploaded project text is ever evaluated here.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess

import xlrd

FIXTURES = Path(__file__).resolve().parents[1] / 'fixtures'
ORACLE = FIXTURES / 'athena-parameter-report-native.json'


def inputs():
    base = dict(name='Cu foil', bkg_z=29, fft_edge='k', importance=1.25, bkg_eshift=2.5,
        bkg_e0=8980.5, bkg_algorithm='autobk', bkg_rbkg=1.2, bkg_kw=2, bkg_nnorm=3,
        bkg_pre1=-150., bkg_pre2=-30., bkg_nor1=150., bkg_nor2=700.,
        bkg_spl1=.5, bkg_spl2=14., bkg_spl1e=.25/.2624682917, bkg_spl2e=196/.2624682917,
        bkg_step=3.14159265358979, bkg_stan='None', bkg_clamp1=0, bkg_clamp2=24,
        fft_kmin=3., fft_kmax=13.5, fft_dk=1.5, fft_kwindow='hanning', fit_karb_value=1.25,
        fft_pc=0, bft_rmin=1.1, bft_rmax=3.2, bft_dr=.2, bft_rwindow='kaiser',
        plot_multiplier=.0314159265358979, y_offset=-.2, marked=True, frozen=True)
    return [base, dict(base, name='Iron reference', bkg_z=26, fft_edge='l3', marked=False,
        importance=0, bkg_e0=7112.25, bkg_stan='Cu foil', bkg_clamp1=3, bkg_clamp2=6),
        dict(base, name='Cu foil', bkg_clamp1=12, bkg_clamp2=96, bkg_nnorm=2, importance=2.75)]


def replay(sources, environment, perl_lib, output):
    output.mkdir(parents=True, exist_ok=True)
    catalog = json.loads((FIXTURES.parents[2] / 'docs/athena-primary-sources.json').read_text())['files']
    hashes = {}
    def source(rel):
        data = (sources / rel.replace('/', '-')).read_bytes(); digest = hashlib.sha256(data).hexdigest()
        assert digest == next(r['sha256'] for r in catalog if r['file'].endswith('/' + rel))
        hashes[rel] = digest; return data.decode()
    group = source('lib/Demeter/UI/Athena/Group.pm')
    units = source('lib/Demeter/Data/Units.pm')
    config = source('lib/Demeter/configuration/clamp.demeter_conf')
    body = group[group.index('sub Report {'):group.index('\n1;', group.index('sub Report {'))]
    clamp = re.search(r'sub number2clamp \{.*?\n\};', units, re.S).group()
    clamps = {name: int(value) for name, value in re.findall(r'variable=(\w+)\ntype=[^\n]+\ndefault=(\d+)', config)}
    (output / 'inputs.json').write_text(json.dumps(dict(groups=inputs(), clamps=clamps)))
    script = r'''use strict; use warnings; use JSON::PP; use Spreadsheet::WriteExcel; use Cwd; use Digest::SHA qw(sha256_hex);
use Chemistry::Elements qw(get_name);
$Wx::VERSION='not loaded (headless accessor fixture)';
sub wxFD_SAVE(){0} sub wxFD_CHANGE_DIR(){0} sub wxFD_OVERWRITE_PROMPT(){0}
sub wxID_CANCEL(){0} sub wxDefaultPosition(){0}
package Config;
sub default { $_[0]{$_[2]} }
package Data;
our $AUTOLOAD;
sub AUTOLOAD { my $key=$AUTOLOAD; $key=~s/.*:://; return $_[0]{$key}; }
sub DESTROY {}
sub co { $_[0]{config} }
sub bkg_stan { $_[0]{bkg_stan} eq 'None' ? 'None' : bless({name=>$_[0]{bkg_stan}},'Data') }
sub yesno { $_[1] ? 'yes' : 'no' }
sub identify { 'Pinned report accessor fixture' }
sub now { '2026-09-12 00:00:00 UTC' }
sub environment { ('Constructed report inputs') }
''' + clamp + r'''
package GroupList;
sub GetCount { scalar @{$_[0]{groups}} }
sub IsChecked { $_[0]{groups}[$_[1]]{marked} }
sub GetIndexedData { $_[0]{groups}[$_[1]] }
package App;
sub current_data { $_[0]{main}{list}{groups}[1] }
package Main;
sub status { $_[0]{status}=$_[1] }
package main;
''' + body + r'''
my $input=JSON::PP->new->decode(do{local $/;open my $f,'<','inputs.json' or die $!;<$f>});
my $config=bless $input->{clamps},'Config';
my @groups=map {$_->{config}=$config;bless $_,'Data'} @{$input->{groups}};
our $app=bless {main=>bless({list=>bless({groups=>[@groups]},'GroupList')},'Main')},'App';
Report($app,'all','all.xls'); Report($app,'marked','marked.xls');
my @clamps=map {[$_, $groups[0]->number2clamp($_)]} (0,1,1.5,3,4.5,6,9,12,18,24,60,96,200);
my %hashes;
for my $key (qw(Spreadsheet/WriteExcel.pm Spreadsheet/WriteExcel/Workbook.pm Spreadsheet/WriteExcel/Worksheet.pm Spreadsheet/WriteExcel/Format.pm Chemistry/Elements.pm)) {
 open my $module,'<',$INC{$key} or die $!; binmode $module;
 $hashes{$key}=sha256_hex(do{local $/;<$module>});
}
print JSON::PP->new->canonical->encode({writer=>$Spreadsheet::WriteExcel::VERSION,
 chemistry=>$Chemistry::Elements::VERSION,clamps=>[@clamps],elements=>[map {[$_,get_name($_)]} (1..118)],modules=>{%hashes}});
'''
    path = output / 'report.pl'; path.write_text(script)
    env = dict(os.environ, **json.loads(environment.read_text()))
    env['PERL5LIB'] = str(perl_lib.resolve()) + os.pathsep + env.get('PERL5LIB', '')
    result = subprocess.run(['perl', str(path.resolve())], cwd=output, env=env, capture_output=True, timeout=60)
    if result.returncode:
        raise RuntimeError(result.stderr.decode())
    native = json.loads(result.stdout)
    for scope in ('all', 'marked'):
        book = xlrd.open_workbook(str(output / f'{scope}.xls'), formatting_info=True)
        sheet = book.sheet_by_index(0)
        native[scope] = dict(labels=sheet.row_values(6), rows=[sheet.row_values(i) for i in range(7, sheet.nrows)],
            types=[list(sheet.row_types(i)) for i in range(7, sheet.nrows)], merged=[list(v) for v in sorted(sheet.merged_cells)],
            formats=[book.format_map[book.xf_list[sheet.cell_xf_index(7,c)].format_key].format_str for c in range(32)])
    native.update(inputs=inputs(), sources=hashes)
    return native


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--sources', type=Path, required=True)
    parser.add_argument('--environment', type=Path, required=True)
    parser.add_argument('--perl-lib', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--write', action='store_true')
    args = parser.parse_args()
    record = replay(args.sources, args.environment, args.perl_lib, args.output)
    if args.write:
        ORACLE.write_text(json.dumps(record, indent=2) + '\n')
    else:
        assert record == json.loads(ORACLE.read_text())
    print('Native all/marked XLS reports, 28 parameter columns, typed cells and 13 clamp cases verified.')
