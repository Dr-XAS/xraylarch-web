"""Run unchanged Demeter Zip is/fix/suggest/clean with real Archive::Zip.

Only the Moose object/accessors and random stash suffix are bridged. Archive
parsing, extraction, member ordering and cleanup execute native Perl bodies.
Run only the pinned official flat fixture: native extraction trusts paths.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import zipfile


def execute(source, raw, output):
    output.mkdir(parents=True, exist_ok=True)
    script=output/'native.pl'
    script.write_text('''use Archive::Zip qw(:ERROR_CODES :CONSTANTS);
use File::Spec; use File::Path qw(remove_tree); use Scalar::Util qw(looks_like_number);
use JSON::PP; use Digest::SHA qw(sha256_hex);
package Demeter; sub randomstring { 'oracle' }
package main;
sub file { $ARGV[0] } sub stash_folder { $ARGV[1] }
sub folder { my ($self,@value)=@_; $self->{folder}=$value[0] if @value; $self->{folder} }
sub fixed { my ($self,@value)=@_; $self->{fixed}=$value[0] if @value; $self->{fixed} }
''' + source[source.index('sub is {'):source.index('__PACKAGE__')] + '''
my $obj=bless {},'main'; my $recognized=$obj->is;
die 'Fixture was not recognized' unless $recognized;
my $list=$obj->fix; my @members;
for my $path (@$list) {
  open my $fh,'<:raw',$path or die $!; local $/; my $bytes=<$fh>; close $fh;
  push @members,{name=>File::Spec->abs2rel($path,$obj->folder),bytes=>length($bytes),sha256=>sha256_hex($bytes)};
}
my %suggestion=$obj->suggest; $obj->clean;
print JSON::PP->new->canonical->encode({recognized=>$recognized,members=>\\@members,
  suggestion=>\\%suggestion,cleaned=>(-d $obj->folder ? 0 : 1),archive_zip_version=>$Archive::Zip::VERSION});
''')
    result=subprocess.run(['perl',str(script),str(raw.resolve()),str(output.resolve())],
                          capture_output=True,text=True,check=True,timeout=30)
    assert not result.stderr,result.stderr
    return json.loads(result.stdout)


def classifications(source, output):
    """Native Files::is_zipproj gate used by Athena before file plugins."""
    output.mkdir(parents=True,exist_ok=True)
    script=output/'classify.pl'
    script.write_text('use Archive::Zip qw(:ERROR_CODES :CONSTANTS);\n'+
        source[source.index('sub is_zipproj {'):source.index('sub is_xdi {')]+
        "print is_zipproj(bless({},'main'),$ARGV[0],0,'guess');\n")
    result={}
    for n,name in enumerate(['data','order','gds.yaml','HORAE','notes/order']):
        path=output/f'probe-{n}.zip'
        with zipfile.ZipFile(path,'w') as archive:archive.writestr(name,b'classification probe')
        response=subprocess.run(['perl',str(script),str(path)],check=True,capture_output=True,text=True,timeout=30)
        assert not response.stderr,response.stderr
        result[name]=int(response.stdout)
    return result


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-root',type=Path,required=True)
    parser.add_argument('--output-dir',type=Path,required=True)
    args=parser.parse_args(); fixtures=Path(__file__).resolve().parents[1]/'fixtures'
    manifest=json.loads((fixtures/'athena-zip-fixture.json').read_text())
    raw=fixtures/manifest['file']; source=args.source_root/'lib-Demeter-Plugins-Zip.pm'
    assert hashlib.sha256(raw.read_bytes()).hexdigest()==manifest['sha256']
    assert hashlib.sha256(source.read_bytes()).hexdigest()==manifest['plugin_sha256']
    expected=json.loads((fixtures/manifest['oracle']).read_text())
    classification=expected.pop('project_classification')
    assert execute(source.read_text(),raw,args.output_dir)==expected
    gate=args.source_root/'lib-Demeter-Files.pm'
    assert hashlib.sha256(gate.read_bytes()).hexdigest()==manifest['classification_source']['sha256']
    assert classifications(gate.read_text(),args.output_dir/'classification')==classification
    print('Native Zip is/fix/suggest/clean: all three member hashes/order and cleanup match.')
    print('Native Athena project gate: three root fitting markers rejected; ordinary and nested names accepted.')


if __name__=='__main__': main()
