"""Execute unchanged Demeter beamline helpers, is_true/yesno and find_edge.

Xray::XDI is a recording bridge (not its validator or serializer). INI files
and absorption energies come from the pinned native sources, not web defaults.
Run with --write once to record fixtures; default mode replays and compares.
"""
import argparse
import hashlib
import json
import re
import shutil
import subprocess
from pathlib import Path

FIXTURES = Path(__file__).resolve().parents[1] / 'fixtures'


def cases():
    yield 'x11a-measured', 'X11A', (FIXTURES/'demeter-x11a-cu.012').read_bytes(), ''
    yield 'mx-measured', 'MX', (FIXTURES/'demeter-uhup.101').read_bytes(), ''
    yield 'xdac-measured', 'XDAC', (FIXTURES/'demeter-re4chan.000').read_bytes(), ''
    x11 = (FIXTURES/'demeter-x11a-cu.012').read_bytes()
    yield 'x11a-four-digit-year', 'X11A', x11.replace(b'15-Sep-92', b'15-Sep-1992'), ''
    for char in ['T', 'Y', '2', '0', 'N']:
        yield 'x11a-focus-'+char, 'X11A', x11.replace(b'FOCUS=F TRANSLT=F', f'FOCUS={char} TRANSLT={char}'.encode()), ''
    for beamline in ['X-11A', 'X-11B', 'X-18B', 'X-19A', 'X-23A2', 'X-23B', 'X-24A', 'X-3B', 'U-7A']:
        raw = f'''XDAC V1.4 Datafile V1
"probe" created on 2/28/09 at 2:55:11 PM on {beamline}
Diffraction element= Ge (220) Ring energy= 2.50 GeV
E0= 7112
NUM_REGIONS= 3
SRB= -200 -30 30
SRSS= 10 .5 .05
SPP= 1 2 3
Settling time= 0.2
Offsets= 10 20
Gains= 7 8
Constructed metadata probe
-------
energy I0 It
7000 10 9
'''.encode()
        yield 'ini-'+beamline.lower(), 'XDAC', raw, ''
        if beamline == 'X-11A':
            for clock in ['12:00:00 AM', '12:00:00 PM']:
                yield 'xdac-'+clock[-2:], 'XDAC', raw.replace(b'2:55:11 PM', clock.encode()), ''
    mx = (FIXTURES/'demeter-uhup.101').read_bytes()
    yield 'ini-mx10bm', 'MX', mx.replace(b'10-ID', b'10-BM').replace(b'10ID', b'10BM'), ''
    bl8 = (FIXTURES/'constructed-bl8ar-trans.dat').read_bytes().replace(b'# E0 (eV)  = 1559', b'''# Experiment date: September 11, 2026
# Duration: 09:00:00 - 09:20:00
# E0 (eV) = 1559
# Photon Energy Scan = 1493 - 1703
# Photon Energy Step = 1
# Time Step = 1
# Gain = 8
# Points/scan = 211
# Ar K edge step size = 603.2''')
    for energy, crystal in [(1559, ''), (1839, ''), (1303, ''), (7112, ''), (7112, 'KTP'),
                            (7112, 'InSb'), (7112, 'Si'), (7112, 'Ge'), (1559, 'Ge'), (1839, 'Ge')]:
        yield f'bl8-{energy}-{crystal or "auto"}', 'BL8', bl8.replace(b'E0 (eV) = 1559', f'E0 (eV) = {energy}'.encode()), crystal


def execute(root, output, reader, raw, crystal):
    output.mkdir(parents=True, exist_ok=True)
    (output/'input.dat').write_bytes(raw)
    constants = output/'Demeter/Constants.pm'; constants.parent.mkdir(exist_ok=True)
    hc = re.search(r'const our \$HC\s*=>\s*([0-9.]+);', (root/'lib-Demeter-Constants.pm').read_text())[1]
    constants.write_text("package Demeter::Constants; use Exporter 'import'; our @EXPORT_OK=qw($HC); our $HC="+hc+"; 1;\n")
    ini_dir = output/'Demeter/share/xdi'; ini_dir.mkdir(parents=True, exist_ok=True)
    for p in root.glob('lib-Demeter-share-xdi-*.ini'):
        shutil.copyfile(p, ini_dir/p.name.removeprefix('lib-Demeter-share-xdi-'))
    # Independent resource extraction: unchanged find_edge calls these values.
    energies, symbols = {}, {}
    for line in (root/'lib-Xray-data-elam.data').read_text().splitlines():
        fields = line.split()
        if fields and fields[0] == 'Element':
            symbol, z = fields[1], fields[2]; symbols[z] = symbol; energies[z] = {}
        elif fields and fields[0] == 'Edge':
            energies[z][fields[1]] = float(fields[2])
    (output/'edges.json').write_text(json.dumps({'energies': energies, 'symbols': symbols}))
    demeter = (root/'lib-Demeter.pm').read_text()
    is_true = demeter[demeter.index('sub is_true {'):demeter.index('\n};', demeter.index('sub is_true {'))+3]
    yesno = demeter[demeter.index('sub yesno {'):demeter.index('\n};', demeter.index('sub yesno {'))+3]
    mu = (root/'lib-Demeter-Data-Mu.pm').read_text()
    find_edge = mu[mu.index('sub find_edge {'):mu.index('\n};', mu.index('sub find_edge {'))+3]
    script = r'''use JSON::PP; use File::Basename;
BEGIN { $INC{'Xray/XDI.pm'}=1; $INC{'Demeter.pm'}=$ARGV[1].'/Demeter.pm'; }
our $edges=JSON::PP->new->decode(do {local $/; open my $f,'<',$ARGV[1].'/edges.json'; <$f>});
$ENV{XDIBL8}=$ARGV[2];
package Xray::Absorption;
sub in_resource { exists $main::edges->{energies}{$_[1]} }
sub get_energy { $main::edges->{energies}{$_[1]}{$_[2]} // 0 }
package Xray::XDI;
sub new { bless {attributes=>{},comments=>[],extra_version=>''}, shift }
sub set_item { $_[0]{attributes}{lc($_[1])}{lc($_[2])}="$_[3]"; }
sub push_comment { push @{$_[0]{comments}},$_[1] }
sub extra_version { $_[0]{extra_version}=$_[1] if @_>1; $_[0]{extra_version} }
sub xdi_version {}
package Demeter;
use List::Util qw(any);
our $NUMBER=qr{[+-]?(?:\d+\.?\d*|\.\d+)(?:[Ee][+-]?\d+)?};
sub meta { bless {}, 'Meta' }
__IS_TRUE__
__YESNO__
package Meta; sub get_attribute_list { () }
package Probe;
sub new { bless {daq=>'',beamline=>'',ini_files=>[]}, shift }
sub xdi { $_[0]{xdi}=$_[1] if @_>1; $_[0]{xdi} }
sub daq { $_[0]{daq}=$_[1] }
sub beamline { $_[0]{beamline}=$_[1] }
sub beamline_identified { $_[0]{identified}=$_[1] }
sub clear_ifeffit_titles {}
sub metadata_from_ini {
 my($s,$path)=@_; return unless -f $path; push @{$s->{ini_files}},File::Basename::basename($path);
 open my $fh,'<',$path; my $section='';
 while(<$fh>) { chomp; if (/^\s*\[(\w+)\]/) { $section=$1; }
 elsif (/^\s*([^=;#]+?)\s*=\s*(.*?)\s*$/) { $s->xdi->set_item($section,$1,$2) if $section ne 'labels'; } }
}
sub xdi_attribute { $_[0]->xdi->{attributes}{element}{$_[1] eq 'element' ? 'symbol' : 'edge'} // '' }
sub is_Element { my $v=shift; scalar(grep {$_ eq $v} values %{$main::edges->{symbols}}) }
sub is_Edge { $_[0]=~/^(K|L1|L2|L3)$/ }
sub get_symbol { $main::edges->{symbols}{$_[0]} }
__FIND_EDGE__
package main;
__READER__
package main;
my $p=Probe->new; my $recognized=__CLASS__->is($p,$ARGV[0]);
my $x=$p->{xdi} // {}; delete $p->{xdi};
print JSON::PP->new->canonical->encode({%$p,%$x,recognized=>$recognized});
'''.replace('__IS_TRUE__', is_true).replace('__YESNO__', yesno).replace('__FIND_EDGE__', find_edge)
    script = script.replace('__READER__', (root/f'lib-Demeter-Plugins-Beamlines-{reader}.pm').read_text()).replace('__CLASS__', f'Demeter::Plugins::Beamlines::{reader}')
    (output/'probe.pl').write_text(script)
    result = subprocess.run(['perl', '-I'+str(output.resolve()), str(output/'probe.pl'), str(output/'input.dat'), str(output), crystal], capture_output=True, check=True, text=True)
    return json.loads(result.stdout)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-root', type=Path, required=True)
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--write', action='store_true')
    args = parser.parse_args()
    sources = json.loads((FIXTURES.parents[2]/'docs/athena-primary-sources.json').read_text())['files']
    for p in [*args.source_root.glob('lib-Demeter-Plugins-Beamlines-*.pm'), *args.source_root.glob('lib-Demeter-share-xdi-*.ini'),
              *[args.source_root/n for n in ['lib-Demeter.pm','lib-Demeter-Constants.pm','lib-Demeter-Data-Mu.pm','lib-Xray-data-elam.data']]]:
        # Every input dependency must have an independently recorded checksum.
        assert any(s['sha256'] == hashlib.sha256(p.read_bytes()).hexdigest() for s in sources), p
    records = []
    for name, reader, raw, crystal in cases():
        native = execute(args.source_root, args.output_dir/name, reader, raw, crystal)
        records.append(dict(name=name, reader=reader, input_sha256=hashlib.sha256(raw).hexdigest(), crystal=crystal, native=native))
        print(name, native['recognized'])
    path = FIXTURES/'athena-beamline-native.json'
    if args.write: path.write_text(json.dumps(records, indent=2)+'\n')
    else: assert json.loads(path.read_text()) == records


if __name__ == '__main__': main()
