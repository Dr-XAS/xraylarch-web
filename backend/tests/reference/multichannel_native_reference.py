"""Execute native plugin control flow and make_data expressions with real Larch.

Moose construction, RPC, project serialization and metadata hooks are bridged,
not represented as desktop execution. Native is/fix/make_data and the Ifeffit
branch of sort_data remain unchanged. Larch evaluates their captured array
expressions independently of the web converter. Set LARCHDIR to a scratch
directory when running this standalone script.
"""
import argparse
import contextlib
import gzip
import hashlib
import io
import json
from pathlib import Path
import re
import subprocess

import numpy as np
from larch import Interpreter
from larch.io import read_ascii


def driver(plugin, helper, reader, data_source):
    defaults = {}
    for name, text, number in re.findall(r"has '([a-z0-9_]+)'\s*=>\s*\([^;]*?default\s*=>\s*(?:'([^']*)'|(\d+))", plugin):
        defaults[name] = int(number) if number else text
    prefix = r'''
use strict; use warnings; use JSON::PP; use File::Spec;
our ($arrays, $labels, $titles, $parameters, $defaults, $written, $journal);
open my $J, '<', $ARGV[2] or die $!; local $/; my $request=decode_json(<$J>); close $J;
($arrays, $labels, $titles, $parameters, $defaults)=@{$request}{qw(arrays labels titles parameters defaults)};
$/="\n";
package NativeObject;
our $AUTOLOAD;
sub AUTOLOAD { my $self=shift; (my $key=$AUTOLOAD)=~s{.*::}{}; return if $key eq 'DESTROY'; $self->{$key}=shift if @_; return $self->{$key}; }
sub _update {}
sub dispense {}
sub dispose {}
sub template { '' }
sub fetch_scalar { 1 }
sub initialize_e0 {}
sub resolve_defaults {}
sub DEMOLISH {}
sub set { my $self=shift; my %args=@_; @{$self}{keys %args}=values %args; }
sub get_array { my ($self,$key)=@_; $key='energy' if $key eq 'nergy'; return @{$main::arrays->{$key} || []}; }
sub get_titles { @{$main::titles} }
sub find_edge { ('Re','L3') }
sub e0 { 10535 }
sub write_athena { my ($self,$path,@objects)=@_; $main::written=[map {+{%$_}} grep {ref($_) eq 'Demeter::Data'} @objects]; }
package NativeConfiguration;
sub default { $main::parameters->{$_[2]} }
package Demeter;
sub co { bless {}, 'NativeConfiguration' }
package Demeter::Journal;
our @ISA=('NativeObject');
sub new { bless {}, shift }
sub text { $main::journal=$_[1] }
package Demeter::Data;
our @ISA=('NativeObject');
sub new { my $class=shift; my $self=bless {@_},$class; return $self; }
package Demeter::Data::MultiChannel;
our @ISA=('NativeObject');
our ($EPSILON3, $EPSILON6) = (0.001, 0.000001);
sub new { my $class=shift; bless { @_, columns=>join(' ',@{$main::labels}), group=>'raw', is_col=>1, is_larch=>0, is_kev=>0 }, $class; }
sub _update { my $self=shift; return if $self->{sorted}++; $self->sort_data; }
sub place_array { my ($self,$name,$values)=@_; $name=~s/^raw\.//; $main::arrays->{$name}=$values; }
'''
    prefix += data_source[data_source.index('sub sort_data {'):data_source.index('sub _read_data_command {')]
    prefix += helper[helper.index('sub make_data {'):helper.index("override 'discard'")]
    prefix += r'''
package NativePlugin;
our @ISA=('NativeObject');
use File::Basename qw(basename);
# This accessor receives Perl's $1 directly. AUTOLOAD's name substitution
# would clear that capture during first dispatch, unlike Moose's accessor.
sub edge_energy { my $self=shift; $self->{edge_energy}=shift if @_; return $self->{edge_energy}; }
sub firstidx (&@) { my $f=shift; for my $i (0..$#_) { local $_=$_[$i]; return $i if $f->(); } return -1; }
'''
    end = plugin.index("after 'add_metadata'") if reader == '10BMMultiChannel' else plugin.index('sub suggest')
    prefix += plugin[plugin.index('sub is {'):end]
    prefix += r'''
package main;
my $obj=bless {%{$defaults},file=>$ARGV[0],stash_folder=>$ARGV[1]},'NativePlugin';
my $recognized=$obj->is;
$obj->fix if $recognized;
print JSON::PP->new->canonical->encode({recognized=>$recognized?1:0,groups=>$written || [],journal=>$journal || '',arrays=>$arrays});
'''
    return prefix, defaults


def execute(source_root, reader, raw, output, parameters=None):
    output.mkdir(parents=True, exist_ok=True)
    plugin = (source_root / f'lib-Demeter-Plugins-{reader}.pm').read_text()
    helper = (source_root / 'lib-Demeter-Data-MultiChannel.pm').read_text()
    data_source = (source_root / 'lib-Demeter-Data.pm').read_text()
    code, defaults = driver(plugin, helper, reader, data_source)
    with contextlib.redirect_stdout(io.StringIO()):
        group = read_ascii(str(raw.resolve()))
    request = dict(arrays={name: np.asarray(getattr(group, name)).tolist() for name in group.array_labels},
                   labels=group.array_labels, titles=group.header, parameters=parameters or {}, defaults=defaults)
    request_path = output / 'request.json'; request_path.write_text(json.dumps(request, allow_nan=False))
    script = output / 'native.pl'; script.write_text(code)
    result = subprocess.run(['perl', str(script), str(raw.resolve()), str(output.resolve()), str(request_path.resolve())],
                            capture_output=True, text=True, check=True, timeout=30)
    assert not result.stderr, result.stderr
    native = json.loads(result.stdout)
    for name, values in native['arrays'].items():
        setattr(group, name, np.asarray(values))
    interpreter = Interpreter()
    interpreter.symtable.set_symbol('raw', group)
    records = []
    for record in native['groups']:
        arrays = {}
        for key, field in [('energy','energy_string'), ('mu','xmu_string'), ('i0','i0_string'), ('signal','signal_string')]:
            # Demeter's expression is written in Ifeffit spelling; Larch uses log.
            expression = record[field].replace('ln(', 'log(')
            interpreter.eval('native_result = ' + expression)
            assert not interpreter.error, interpreter.error
            arrays[key] = np.asarray(interpreter.symtable.get_symbol('native_result')).tolist()
        records.append(dict(label=record['name'], data_type=record['datatype'],
                            expressions={k: record[k] for k in ['energy_string','xmu_string','i0_string','signal_string']}, **arrays))
    return dict(recognized=native['recognized'], groups=records, journal=native['journal'],
                source_columns={name: native['arrays'][name] for name in group.array_labels})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-root', required=True, type=Path)
    parser.add_argument('--output-dir', required=True, type=Path)
    args = parser.parse_args()
    fixtures = Path(__file__).resolve().parents[1] / 'fixtures'
    manifest = json.loads((fixtures / 'athena-multichannel-fixtures.json').read_text())
    for item in manifest['sources']:
        assert hashlib.sha256((args.source_root / item['path'].replace('/','-')).read_bytes()).hexdigest() == item['sha256']
    for reference in manifest['references']:
        raw = fixtures / reference['input']; encoded = (fixtures / reference['file']).read_bytes()
        assert hashlib.sha256(raw.read_bytes()).hexdigest() == reference['input_sha256']
        assert hashlib.sha256(encoded).hexdigest() == reference['sha256']
        result = execute(args.source_root, reference['reader'], raw, args.output_dir / reference['name'], reference.get('values'))
        assert result == json.loads(gzip.decompress(encoded)), reference['name']
        print(reference['name'], 'native control flow and Larch-evaluated expressions match')


if __name__ == '__main__':
    main()
