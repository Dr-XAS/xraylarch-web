"""Run unchanged Demeter XDI clone code with actual Perl Xray::XDI objects.

Only group accessors are bridged. Reading, deep cloning, metadata mutations,
NoClone attribute behavior and serialization use the original native modules.
"""
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess

FIXTURES = Path(__file__).resolve().parents[1] / 'fixtures'
ROOT = FIXTURES.parents[2]
ORACLE = FIXTURES / 'athena-xdi-history-native.json.gz'


def replay(sources, environment, output):
    output.mkdir(parents=True, exist_ok=True)
    source = sources/'lib-Demeter-Data-XDI.pm'
    raw = source.read_bytes(); sha = hashlib.sha256(raw).hexdigest()
    catalog=json.loads((ROOT/'docs/athena-primary-sources.json').read_text())['files']
    assert sha == next(v['sha256'] for v in catalog if v['file'].endswith('/lib/Demeter/Data/XDI.pm'))
    body=re.search(r'sub xdi_make_clone \{.*?\n\};',raw.decode(),re.S).group()
    script=r'''use strict;use warnings;use utf8;use Xray::XDI;use JSON::PP;use Digest::SHA qw(sha256_hex);
package Data;
sub xdi { $_[0]{xdi}=$_[1] if @_>1; return $_[0]{xdi} }
sub fft_edge { $_[0]{edge} } sub bkg_z { $_[0]{element} }
''' + body + r'''
package main;
my $input=JSON::PP->new->decode(do{local $/;<STDIN>});
sub plain { my %v=%{$_[0]}; delete $v{xdifile}; return \%v }
my $x=Xray::XDI->new; $x->file('source.xdi');die $x->errormessage if $x->errorcode<0;
$x->set_item('Scan','start_time','2001-06-26T22:27:31');
$x->set_item('Scan','end_time','2001-06-26T22:31:31');
$x->set_item('Scan','process',$input->{prior}) if defined $input->{prior};
$x->set_item('User','literal',qq{μ 铜 "quoted" \$literal \@array\nsecond line});
$x->push_comment(qq{Preserve μ 铜\ncomments});
my $original=bless{xdi=>$x,element=>$input->{element},edge=>$input->{edge}},'Data';
my $clone=bless{element=>$input->{element},edge=>$input->{edge}},'Data';
my $before=JSON::PP->new->canonical->encode(plain($x));
$clone->xdi_make_clone($original,$input->{process},$input->{remove_times});
my $out=plain($clone->xdi);
my $snapshot=JSON::PP->new->canonical->encode($out);
my $serialized=$clone->xdi->serialize;
my $after=JSON::PP->new->canonical->encode(plain($x));
die 'parent changed' if $before ne $after;
# Mutating one clone family and the nested label list must not alter its source.
$clone->xdi->set_item('User','clone_only','child');
push @{$clone->xdi->array_labels},'clone_only';
die 'aliased metadata' if $x->get_item('User','clone_only');
die 'aliased labels' if grep {$_ eq 'clone_only'} @{$x->array_labels};
my %modules;
for my $name(qw(Xray/XDI.pm Xray/XDIFile.pm Xray/XDI/WriterPP.pm)) {
 open my $f,'<',$INC{$name} or die $!;binmode $f;local $/;$modules{$name}=sha256_hex(<$f>);
}
print JSON::PP->new->canonical->utf8->encode({original=>JSON::PP->new->decode($before),
 clone=>JSON::PP->new->decode($snapshot),serialized=>$serialized,
 modules=>\%modules,version=>$Xray::XDI::VERSION});
'''
    path=output/'native.pl';path.write_text(script)
    # Data::Dumper follows Perl hash iteration order; stabilize the process,
    # without changing the native serializer or any recorded field values.
    env=dict(os.environ,**json.loads(environment.read_text()), PERL_HASH_SEED='0', PERL_PERTURB_KEYS='0')
    cases=[]
    for fixture in ('xdi-official-cu_metal_rt.xdi','xdi-official-fe2o3_rt.xdi'):
        shutil.copyfile(FIXTURES/fixture,output/'source.xdi')
        for prior in (None,'Earlier processing','0'):
            for name,process,remove_times in [('copy','',0),('correction','Removed multi-electron excitation',0),
                    ('merge','Merge of 3 scans',-1),('difference','Difference spectrum',0),
                    ('remove_times','Explicit removal of acquisition times',1)]:
                row=dict(fixture=fixture,prior=prior,process=process,remove_times=remove_times,element='Cu',edge='k')
                result=subprocess.run(['perl',str(path.resolve())],input=json.dumps(row),text=True,
                    capture_output=True,cwd=output,env=env,check=True,timeout=60)
                actual=json.loads(result.stdout)
                for module, digest in actual['modules'].items():
                    assert digest == next(v['sha256'] for v in catalog if v['file'].endswith('/languages/perl/lib/'+module))
                cases.append(dict(id=f'{fixture}:{prior}:{name}',input=row,**actual))
    return dict(source_sha256=sha,cases=cases)


def check_web_clones(result, environment, output):
    """Execute only literals emitted by this test, never uploaded PRJ code."""
    from xraylarch_web.athena_xdi import from_native, project_statement, _attributes
    from xraylarch_web.athena_xdi_history import clone_metadata
    env=dict(os.environ, **json.loads(environment.read_text()))
    for row in result['cases']:
        request=row['input']
        metadata=from_native(dict(__perl_class__='Xray::XDI', __perl_value__=row['original']))
        cloned=clone_metadata(metadata, request['element'], request['edge'], request['process'], request['remove_times'])
        assert cloned['attributes'] == _attributes(row['clone']['metadata'])
        statement=project_statement({'xdi_metadata': cloned}, {'element': 'Cu', 'edge': 'K'})
        path=output/'web.pl'
        path.write_text('use strict; use warnings; use Xray::XDI; use JSON::PP; our $xdi;\n'+statement+r'''
my $text=$xdi->serialize;
print JSON::PP->new->canonical->utf8->encode({metadata=>$xdi->metadata,comments=>$xdi->comments,
 labels=>$xdi->array_labels,data=>$xdi->data,element=>$xdi->element,edge=>$xdi->edge,serialized=>length($text)>0?1:0});
''')
        actual=json.loads(subprocess.run(['perl',str(path.resolve())],env=env,cwd=output,
            capture_output=True,check=True,timeout=60).stdout)
        assert actual == dict(metadata=row['clone']['metadata'], comments=metadata['comments_text'],
            labels=row['clone']['array_labels'], data={}, element='Cu',edge='K',serialized=1)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    for key in ('sources','environment','output'):parser.add_argument('--'+key,type=Path,required=True)
    parser.add_argument('--record',action='store_true');args=parser.parse_args()
    result=replay(args.sources,args.environment,args.output)
    if args.record: ORACLE.write_bytes(gzip.compress(json.dumps(result,sort_keys=True,allow_nan=False).encode(),mtime=0))
    else: assert result==json.loads(gzip.decompress(ORACLE.read_bytes()))
    check_web_clones(result,args.environment,args.output)
    print(f'{len(result["cases"])} native XDI clone cases and web literals read by actual Perl Xray::XDI: PASS')


if __name__=='__main__':main()
