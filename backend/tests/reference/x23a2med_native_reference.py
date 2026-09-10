"""Execute native X23A2MED control flow/correction with real Larch ASCII I/O.

The bridge provides existing Larch arrays to native fetch/place operations and
captures the native output-column/template request. It does not run Moose,
Demeter RPC/template expansion, the XDI hook, or a complete Athena desktop.
"""
import argparse
import contextlib
import gzip
import hashlib
import io
import json
from pathlib import Path
import subprocess

import numpy as np
from larch.io import read_ascii, write_ascii


def driver(source):
    prefix = '''use File::Spec;
use JSON::PP;
open my $J, '<', $ARGV[2] or die $!;
my $input = do { local $/; <$J> }; close $J;
our $context = decode_json($input);
our %params = %{$context->{parameters}};
our %columns = %{$context->{arrays}};
our $capture;
my %attrs = (nelements=>4,dts=>'',maxints=>'');
sub file { $ARGV[0] }
sub filename { 'converted.dat' }
sub stash_folder { $ARGV[1] }
sub fixed {}
sub count_lines { open my $F, '<', $_[0] or die $!; my $n=0; ++$n while <$F>; close $F; return $n }
sub any (&@) { my $f=shift; foreach (@_) { return 1 if $f->() } return 0 }
sub fetch_string { join(' ', @{$context->{labels}}) }
sub fetch_array { my $key=$_[1]; $key =~ s/^native\\.//; return @{$columns{$key} || []} }
sub place_array { my $key=$_[1]; $key =~ s/^native\\.//; $columns{$key} = [@{$_[2]}] }
sub nelements { $attrs{nelements}=$_[1] if @_>1; return $attrs{nelements} }
sub dts { $attrs{dts}=$_[1] if @_>1; return $attrs{dts} }
sub maxints { $attrs{maxints}=$_[1] if @_>1; return $attrs{maxints} }
package Demeter;
sub co { bless {}, 'NativeConfiguration' }
sub mo { bless {}, 'NativeModel' }
sub is_larch { 1 }
sub dispense {}
sub template { JSON::PP::encode_json($_[3]) }
sub dispose { $main::capture=JSON::PP::decode_json($_[1]) }
package NativeConfiguration;
sub default { $main::params{$_[2]} }
package NativeModel;
sub throwaway_group { 'native' }
package main;
'''
    suffix = '''
my $obj=bless {}, 'main'; my $recognized=is($obj); my $fixed=fix($obj);
my @labels= $capture ? map { s/^native\\.//; $_ } split(/,\\s*/, $capture->{columns}) : ();
my @arrays=map { unpack('H*', pack('d<*', @{$columns{$_} || die "missing native output column $_"})) } @labels;
print JSON::PP->new->encode({recognized=>$recognized,produced_output=>$fixed ? 1:0,
  attrs=>\\%attrs,labels=>\\@labels,arrays_hex=>\\@arrays,
  default=>{suggest($obj)},transmission=>{suggest($obj,'transmission')},fluorescence=>{suggest($obj,'fluorescence')}});
'''
    return prefix + source[source.index('sub is {'):source.index("after 'add_metadata'")] + suffix


def execute(source, raw, folder, parameters):
    folder.mkdir(parents=True, exist_ok=True)
    group = read_ascii(str(raw))
    context = {'labels': group.array_labels, 'arrays': {key: getattr(group, key).tolist() for key in group.array_labels},
               'parameters': parameters}
    inp = folder / 'arrays.json'; inp.write_text(json.dumps(context, allow_nan=False))
    script = folder / 'native.pl'; script.write_text(driver(source))
    result = subprocess.run(['perl', str(script), str(raw.resolve()), str(folder.resolve()), str(inp.resolve())],
                            capture_output=True, text=True, check=True, timeout=30)
    assert not result.stderr, result.stderr
    native = json.loads(result.stdout)
    # JSON::PP's decimal encoding can lose the final bits of Perl NVs. Carry
    # the native doubles as bytes so writer rounding is not changed by the bridge.
    native_arrays = [np.frombuffer(bytes.fromhex(value), dtype='<f8') for value in native.pop('arrays_hex')]
    columns = []
    if native['produced_output']:
        # Invoke the actual Larch writer named in the pinned plugin template.
        output = folder / 'larch-output.dat'
        attrs = native['attrs']
        headers = [f'<MED> Deadtime corrected MED data, {attrs["nelements"]} channels',
                   '<MED> Deadtimes (nsec):'+attrs['dts'], '<MED> Maximum iterations:'+attrs['maxints']]
        with contextlib.redirect_stdout(io.StringIO()):
            write_ascii(str(output), *[np.asarray(v) for v in native_arrays], header=headers)
        columns = np.loadtxt(output).tolist()
    return native, columns


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-root', type=Path, required=True)
    parser.add_argument('--output-dir', type=Path, required=True)
    args = parser.parse_args()
    fixtures = Path(__file__).resolve().parents[1] / 'fixtures'
    manifest = json.loads((fixtures / 'athena-x23a2med-fixtures.json').read_text())
    primary = json.loads((Path(__file__).resolve().parents[3] / 'docs/athena-primary-sources.json').read_text())['files']
    source = (args.source_root / 'lib-Demeter-Plugins-X23A2MED.pm').read_bytes()
    entry = next(v for v in primary if v['source'].endswith('/lib/Demeter/Plugins/X23A2MED.pm'))
    assert hashlib.sha256(source).hexdigest() == entry['sha256']
    assert hashlib.sha256(driver(source.decode()).encode()).hexdigest() == manifest['harness_sha256']
    original = fixtures / manifest['file']['file']
    assert hashlib.sha256(original.read_bytes()).hexdigest() == manifest['file']['sha256']
    for ref in manifest['references']:
        encoded = (fixtures / ref['file']).read_bytes()
        assert hashlib.sha256(encoded).hexdigest() == ref['sha256']
        oracle = json.loads(gzip.decompress(encoded))
        folder = args.output_dir / ref['name']; folder.mkdir(parents=True, exist_ok=True)
        raw = original
        if 'input' in oracle:
            raw = folder / 'probe.dat'; raw.write_text(oracle['input'])
        native, columns = execute(source.decode(), raw, folder, ref['values'])
        assert native == ref['native']
        np.testing.assert_array_equal(columns, oracle['columns'])
        print(ref['name'], 'native recognition, control flow, correction and Larch output match')


if __name__ == '__main__':
    main()
