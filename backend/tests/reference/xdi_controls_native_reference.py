"""Replay real Perl/C XDI validation and unchanged Athena Save-comments code.

The only GUI bridges are GetValue/current_data/status. No Wx GUI is claimed.
Run with a compiled official Perl/XDI environment and pinned Demeter sources.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess

FIXTURES = Path(__file__).resolve().parents[1]/'fixtures'
ORACLE = FIXTURES/'athena-xdi-controls-native.json'


def cases():
    for family, tag, values in [
        ('Element', 'symbol', ['Cu', 'cu', 'CU', 'Wrong', '29']),
        ('Element', 'edge', ['K', 'k', 'L3', 'M5', 'bad']),
        ('Element', 'reference', ['Fe', 'wrong']), ('Element', 'ref_edge', ['L2', 'wrong']),
        ('Mono', 'd_spacing', ['3.1355', '-1', '0', 'bad']),
        ('Facility', 'current', ['100 mA', '0.1 A', 'bad']),
        ('Facility', 'energy', ['7 GeV', '7000 MeV', 'bad']),
        ('Scan', 'start_time', ['2001-06-26T22:27:31', '2026-02-30T12:00:00', 'bad']),
        ('Column', '1', ['energy eV', 'energy keV', 'ENERGY EV', 'bad']),
        ('GSE', 'EXTRA', ['value']), ('Other', 'field', ['value']),
        ('Sample', 'temperature', ['300 K', 'bad']),
    ]:
        for value in values:
            for mode in ['all', 'field']:
                yield dict(family=family, tag=tag, value=value, mode=mode)


def execute(sources, environment, output):
    source = sources/'lib-Demeter-UI-Athena-XDI.pm'
    catalog = json.loads((FIXTURES.parents[2]/'docs/athena-primary-sources.json').read_text())
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    assert digest == next(v['sha256'] for v in catalog['files'] if v['file'].endswith('/lib/Demeter/UI/Athena/XDI.pm'))
    text = source.read_text(); start = text.index('sub OnSaveComments {')
    handler = text[start:text.index('\n};', start)+3]
    output.mkdir(parents=True, exist_ok=True)
    (output/'source.xdi').write_bytes((FIXTURES/'xdi-official-cu_metal_rt.xdi').read_bytes())
    comments = ['', ' μ 铜 "quote" $variable @array\nsecond\tline ', 'first\r\nsecond\n', r'literal\ntext']
    (output/'input.json').write_text(json.dumps(dict(cases=list(cases()), comments=comments)))
    script = r'''use strict; use warnings; use Xray::XDI; use JSON::PP; use Digest::SHA qw(sha256_hex);
my $input=JSON::PP->new->decode(do {local $/;open my $f,'<','input.json' or die $!;<$f>});
my (@results,@comments);
for my $case (@{$input->{cases}}) {
 my $x=Xray::XDI->new();$x->file('source.xdi');
 my $value=$case->{mode} eq 'field' ? lc($case->{value}) : $case->{value};
 my $code=$x->validate($case->{family},$case->{tag},$value);
 push @results,{%$case,code=>$code,message=>$code ? $x->errormessage : ''};
}
package Widget; sub GetValue { $_[0]{text} }
package Data; sub xdi { $_[0]{xdi} }
package App; sub current_data { $_[0]{data} }
package Main; sub status { $_[0]{status}=$_[1] }
package Panel;
__HANDLER__
package main;
our $app=bless {main=>bless({},'Main')},'App';
for my $comment (@{$input->{comments}}) {
 my $x=Xray::XDI->new();$x->file('source.xdi');$app->{data}=bless {xdi=>$x},'Data';
 my $panel=bless {comments=>bless({text=>$comment},'Widget')},'Panel';$panel->OnSaveComments;
 push @comments,{text=>$x->comments,status=>$app->{main}{status}};
}
my $x=Xray::XDI->new();$x->file('source.xdi');
my %modules;
for my $module (qw(Xray/XDI.pm Xray/XDIFile.pm Xray/XDI/WriterPP.pm)) {
 open my $f,'<',$INC{$module} or die $!;binmode $f;local $/;$modules{'languages/perl/lib/'.$module}=sha256_hex(<$f>);
}
print JSON::PP->new->canonical->utf8->encode({cases=>\@results,comments=>\@comments,
 required=>[$x->required_list],recommended=>[$x->recommended_list],module_sha256=>\%modules});
'''.replace('__HANDLER__', handler)
    path = output/'probe.pl'; path.write_text(script)
    result = subprocess.run(['perl', str(path)], cwd=output, env=dict(os.environ, **json.loads(environment.read_text())),
                            capture_output=True, check=True, timeout=60)
    native = json.loads(result.stdout)
    for module, sha in native['module_sha256'].items():
        assert sha == next(v['sha256'] for v in catalog['files'] if v['file'].endswith('/'+module))
    return dict(native=native, handler_sha256=digest,
                input_sha256=hashlib.sha256((output/'source.xdi').read_bytes()).hexdigest())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sources', type=Path, required=True)
    parser.add_argument('--environment', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--write', action='store_true')
    args = parser.parse_args(); result = execute(args.sources, args.environment, args.output)
    if args.write:
        ORACLE.write_text(json.dumps(result, ensure_ascii=True, indent=2)+'\n')
    else:
        assert result == json.loads(ORACLE.read_text())
    print(f"{len(result['native']['cases'])} native validation cases and {len(result['native']['comments'])} unchanged Save-comments cases passed")


if __name__ == '__main__':
    main()
