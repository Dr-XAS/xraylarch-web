"""Replay actual Perl Xray::XDI and Demeter's unchanged PRJ record writer.

Requires a compiled official Perl/XDI runtime, supplied as --environment JSON
of environment variables, and the checksum-verified flattened Demeter source
cache. The Data bridge supplies already-read arrays and arguments; it does not
implement the GUI, normalization, or the XDI reader/serializer. No input PRJ
is evaluated. Only pinned code and the web emitter's own test literal run.
"""
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess

FIXTURES = Path(__file__).resolve().parents[1] / 'fixtures'
ROOT = FIXTURES.parents[2]
ORACLE = FIXTURES / 'athena-xdi-native.json.gz'
SPECIAL = ' μ 铜 "quoted" $variable @array \\path\nsecond line\t<script>text</script>'


def run_perl(script, directory, environment):
    path = directory / 'probe.pl'
    path.write_text(script)
    result = subprocess.run(['perl', str(path)], cwd=directory, env=environment,
                            capture_output=True, check=True, timeout=60)
    return json.loads(result.stdout)


def execute(source_root, output, environment):
    catalog = json.loads((ROOT/'docs/athena-primary-sources.json').read_text())
    # Verify the modules actually loaded by Perl, not merely a source cache.
    output.mkdir(parents=True, exist_ok=True)
    modules = run_perl(r'''use Xray::XDI; use JSON::PP; use Digest::SHA qw(sha256_hex);
my %hash;
for my $module (qw(Xray/XDI.pm Xray/XDIFile.pm Xray/XDI/WriterPP.pm)) {
    open my $f,'<',$INC{$module} or die $!; binmode $f; local $/;
    $hash{'languages/perl/lib/'.$module}=sha256_hex(<$f>);
}
print JSON::PP->new->canonical->encode(\%hash);
''', output, environment)
    for module, checksum in modules.items():
        assert checksum == next(v['sha256'] for v in catalog['files'] if v['file'].endswith('/'+module))
    source = source_root/'lib-Demeter-Data-Athena.pm'
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    assert digest == next(v['sha256'] for v in catalog['files'] if v['file'].endswith('/lib/Demeter/Data/Athena.pm'))
    text = source.read_text()
    start = text.index('sub _write_record_athena {')
    writer = text[start:text.index('\n};', start)+3]
    manifest = json.loads((FIXTURES/'athena-xdi-fixtures.json').read_text())
    records = []
    for item in manifest['inputs']:
        raw = (FIXTURES/item['fixture']).read_bytes()
        assert hashlib.sha256(raw).hexdigest() == item['sha256']
        for special in ([False, True] if 'cu_metal' in item['fixture'] else [False]):
            name = Path(item['fixture']).stem + ('-escaped' if special else '')
            directory = output/name; directory.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(FIXTURES/item['fixture'], directory/'source.xdi')
            (directory/'special.json').write_text(json.dumps(SPECIAL if special else ''))
            script = r'''use strict; use warnings; use utf8;
use Xray::XDI; use JSON::PP; use Data::Dumper;
package Demeter::Data::XDIProbe;
use Carp qw(croak);
sub _update {} # Already-read observations; no science is claimed by this bridge.
sub datatype { 'xmu' }
sub get_array { my $a=$_[0]{arrays}{$_[1]}; return () unless $a; return @$a; }
sub i0_string { 'i0' }
sub get { exists $_[0]{arrays}{signal} ? 'itrans' : '' }
sub _clean_up_args { @{$_[0]{args}} }
sub group { 'native_xdi' }
sub xdi { $_[0]{xdi} }
__WRITER__
package main;
my $x=Xray::XDI->new(); $x->file('source.xdi');
die $x->errormessage if $x->errorcode < 0;
my $special=JSON::PP->new->decode(do {local $/; open my $f,'<','special.json' or die $!; <$f>});
if ($special ne '') { $x->set_item('User','Literal',$special); $x->push_comment($special); }
my %arrays=(energy=>$x->data->{energy},xmu=>$x->data->{mutrans},i0=>$x->data->{i0});
$arrays{signal}=$x->data->{itrans} if exists $x->data->{itrans};
my $data=bless {xdi=>$x,arrays=>\%arrays,args=>[label=>'Native '.$x->element,datatype=>'xmu',bkg_z=>$x->element,fft_edge=>$x->edge]}, 'Demeter::Data::XDIProbe';
my $prj="# Athena project file -- Demeter version 0.9.26\n".$data->_write_record_athena."\@journal = ();\n1;\n";
my $clone=$x->clone; $clone->data({}); my %object=%$clone; delete $object{xdifile};
print JSON::PP->new->canonical->utf8->encode({prj=>$prj,object=>\%object,arrays=>\%arrays});
'''.replace('__WRITER__', writer)
            native = run_perl(script, directory, environment)
            records.append(dict(name=name, input_sha256=item['sha256'], fixture=item['fixture'],
                                demeter_writer_sha256=digest, native=native))
    return records


def check_web_literals(records, output, environment):
    """Run only literals emitted here from the recorded, known test objects."""
    from xraylarch_web.athena_xdi import from_native, project_statement
    for row in records:
        obj = row['native']['object']
        metadata = from_native({'__perl_class__': 'Xray::XDI', '__perl_value__': obj})
        statement = project_statement({'xdi_metadata': metadata})
        directory = output/(row['name']+'-web'); directory.mkdir(parents=True, exist_ok=True)
        script = '''use strict; use warnings; use Xray::XDI; use JSON::PP;
our $xdi;
''' + statement + r'''
my $comments=$xdi->comments; $comments =~ s{\\n}{\n}g; $xdi->comments($comments);
# Exercise real Moose methods and serialize, including the data-clearing clone.
my $serialized=$xdi->serialize;
print JSON::PP->new->canonical->utf8->encode({metadata=>$xdi->metadata, comments=>$xdi->comments,
    labels=>$xdi->array_labels, element=>$xdi->element, edge=>$xdi->edge, serialized=>length($serialized)>0 ? 1 : 0});
'''
        actual = run_perl(script, directory, environment)
        assert actual == dict(metadata=obj['metadata'], comments=metadata['comments_text'],
                              labels=obj['array_labels'], element=obj['element'], edge=obj['edge'], serialized=1)

    # Fresh objects emitted from Larch/beamline metadata must also work with
    # actual Moose methods; they have no original native object to copy.
    from xraylarch_web.parsing import parse_upload
    from xraylarch_web.athena_beamline_metadata import identify
    from xraylarch_web.athena_xdi import identity
    cases = [('larch', parse_upload((FIXTURES/records[0]['fixture']).read_bytes(), 'source.xdi').xdi_metadata),
             ('beamline', identify((FIXTURES/'demeter-x11a-cu.012').read_bytes()))]
    for name, metadata in cases:
        statement = project_statement({'xdi_metadata': metadata}, identity(metadata))
        directory = output/name; directory.mkdir(parents=True, exist_ok=True)
        actual = run_perl('use strict; use warnings; use Xray::XDI; use JSON::PP; our $xdi;\n'+statement+r'''
my $serialized=$xdi->serialize;
print JSON::PP->new->canonical->utf8->encode({metadata=>$xdi->metadata, comments=>$xdi->comments,
    data=>$xdi->data, serialized=>length($serialized)>0 ? 1 : 0});
''', directory, environment)
        assert {f.lower(): {k.lower(): v for k, v in fields.items()} for f, fields in actual['metadata'].items()} == metadata['attributes']
        assert actual['comments'] == metadata.get('comments_text', '\n'.join(metadata['comments']))
        assert actual['data'] == {} and actual['serialized'] == 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sources', type=Path, required=True)
    parser.add_argument('--environment', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--write', action='store_true')
    args = parser.parse_args()
    environment = dict(os.environ, **json.loads(args.environment.read_text()), PERL_HASH_SEED='0', PERL_PERTURB_KEYS='0')
    records = execute(args.sources, args.output, environment)
    if args.write:
        ORACLE.write_bytes(gzip.compress(json.dumps(records, ensure_ascii=True, indent=2).encode(), mtime=0))
    else:
        assert records == json.loads(gzip.decompress(ORACLE.read_bytes()))
    check_web_literals(records, args.output, environment)
    print(f'{len(records)} native XDI reader/PRJ writer cases and 5 actual Perl web-literal round trips passed')


if __name__ == '__main__':
    main()
