"""Run the real Bash release state machine with fake Docker and a private /opt.

These tests exercise failure sequencing and filesystem safety without network,
containers, or modifying the real deployment. Run with python3 -m unittest
 tests.test_digitalocean_remote_release (or pytest on this file).
"""
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'deploy/digitalocean/remote-release.sh'
REVISION = 'a' * 40
FAKE_COMMAND = r'''#!PYTHON
import gzip,hashlib,json,os,pathlib,signal,subprocess,sys
name=pathlib.Path(sys.argv[0]).name
args=sys.argv[1:]
log=pathlib.Path(os.environ['FAKE_EVENTS'])
def event(value):
    with log.open('a') as f: f.write(value+'\n')
def finish(code=0): sys.exit(code)
if name=='hostname': print('larch-web-beta'); finish()
if name=='flock': finish()
if name=='sha256sum':
    digest, filename = sys.stdin.read().strip().split('  ',1)
    finish(0 if hashlib.sha256(pathlib.Path(filename).read_bytes()).hexdigest()==digest else 1)
if name=='readlink': print(pathlib.Path(args[-1]).resolve()); finish()
if name=='mv': os.replace(args[-2],args[-1]); finish()
if name=='timeout': os.execvp(args[1],args[1:])
if name=='python3':
    if args and args[0].endswith('smoke_test.py'):
        target='public' if args[-1].startswith('https:') else 'candidate'
        event('smoke '+target)
        finish(1 if os.environ.get('FAIL_STAGE')==target+'-smoke' else 0)
    os.execv('PYTHON',['PYTHON']+args)
assert name=='docker', name
rev=os.environ['FAKE_REVISION']
fail=os.environ.get('FAIL_STAGE','')
if args[:2]==['image','inspect']:
    event('image revision')
    print('b'*40 if fail=='image-revision' else rev); finish()
if args[0]=='inspect':
    if '.Mounts' in args[2]: print('wrong-volume' if fail=='wrong-volume' else 'xraylarch-beta_app_data')
    else: print('sha256:previous-image')
    finish()
if args[0]=='run':
    event('backup')
    assert 'compresslevel=1' in args[-1], 'Use fast, lossless compression while production is stopped'
    assert args[args.index('--log-driver')+1]=='none', 'Do not duplicate binary backups into Docker logs'
    if fail=='backup': finish(1)
    sys.stdout.buffer.write(gzip.compress(b'protected-backup')); finish()
assert args[0]=='compose', args
project=args[args.index('-p')+1]
composefile=pathlib.Path(args[args.index('-f')+1])
remaining=args[args.index('-f')+2:]
command=remaining[0]
candidate=project.startswith('larch-candidate-')
old='previous-release' in str(composefile)
target='candidate' if candidate else ('old' if old else 'new')
event(target+' '+ ' '.join(remaining))
if command=='config':
    assert not old
    services={
      'backend': {'image':'xraylarch-beta-backend:'+rev,'build':{'args':{'XRAYLARCH_GIT_REVISION':rev}},
        'environment':{'XRAYLARCH_GIT_REVISION':rev,'XRAYLARCH_PUBLIC_MODE':'true'},
        'volumes':[{'type':'volume','source':'app_data','target':'/data'}]},
      'frontend': {'image':'xraylarch-beta-frontend:'+rev,'build':{'args':{'XRAYLARCH_GIT_REVISION':rev}},
        'environment':{'XRAYLARCH_PUBLIC_MODE':'true','BACKEND_URL':'http://backend:8006'}},
      'caddy': {'environment':{'DOMAIN':'larch-web.dr-xas.org'}}}
    volumes={name:{'name':'xraylarch-beta_'+name} for name in ['app_data','caddy_data','caddy_config']}
    if fail=='config-volume': volumes['app_data']['name']='changed_app_data'
    print(json.dumps({'services':services,'volumes':volumes})); finish()
if command=='build': finish(1 if fail=='build' else 0)
if command=='exec': finish(1 if fail==target+'-health' else 0)
if command=='ps': print('old-container'); finish()
if command=='up' and target=='new':
    if fail=='activation': finish(1)
    if fail=='signal': os.kill(os.getppid(),signal.SIGTERM)
finish()
'''.replace('PYTHON', sys.executable)


class RemoteReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.fakebin = self.root/'bin'
        self.fakebin.mkdir()
        for name in ['docker', 'hostname', 'flock', 'sha256sum', 'readlink', 'mv', 'timeout', 'python3']:
            p = self.fakebin/name
            p.write_text(FAKE_COMMAND)
            p.chmod(0o755)
        self.previous = self.root/'previous-release'
        previous_config = self.previous/'deploy/digitalocean'
        previous_config.mkdir(parents=True)
        (previous_config/'compose.yml').write_text('previous compose fixture\n')
        (previous_config/'.env').write_text('DOMAIN=larch-web.dr-xas.org\nCUSTOM_SETTING=retained\n')
        (self.root/'xraylarch-current').symlink_to(self.previous)
        incoming = self.root/'xraylarch-incoming'
        incoming.mkdir()
        self.archive = incoming/f'{REVISION}.tar.gz'
        self.create_archive()
        self.env = dict(os.environ, PATH=str(self.fakebin)+os.pathsep+os.environ['PATH'],
                        LARCH_DEPLOY_ROOT=str(self.root), FAKE_EVENTS=str(self.root/'events'),
                        FAKE_REVISION=REVISION)

    def create_archive(self, unsafe=False):
        with tarfile.open(self.archive, 'w:gz') as archive:
            for name in ['compose.yml', 'Dockerfile.backend', 'Dockerfile.frontend', 'smoke_test.py']:
                data = b'test source\n'
                member = tarfile.TarInfo('deploy/digitalocean/'+name)
                member.size = len(data)
                archive.addfile(member, io.BytesIO(data))
            if unsafe:
                member = tarfile.TarInfo('../escape')
                member.size = 6
                archive.addfile(member, io.BytesIO(b'unsafe'))

    def run_release(self, stage='', revision=REVISION, digest=None):
        digest = digest or hashlib.sha256(self.archive.read_bytes()).hexdigest()
        env = dict(self.env, FAIL_STAGE=stage)
        return subprocess.run(['/bin/bash', str(SCRIPT), revision, digest], env=env,
                              capture_output=True, text=True, timeout=30)

    def events(self):
        p = self.root/'events'
        return p.read_text().splitlines() if p.exists() else []

    def status(self):
        return json.loads((self.root/'xraylarch-autodeploy'/f'{REVISION}.status').read_text())

    def assert_previous_still_active(self):
        self.assertEqual((self.root/'xraylarch-current').resolve(), self.previous)

    def test_build_failure_does_not_stop_or_replace_production(self):
        result = self.run_release('build')
        self.assertNotEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.status()['status'], 'failed')
        self.assertEqual(self.status()['phase'], 'building')
        self.assertFalse(any(event.startswith('old ') for event in self.events()))
        self.assert_previous_still_active()

    def test_candidate_smoke_failure_cleans_only_candidate(self):
        result = self.run_release('candidate-smoke')
        self.assertNotEqual(result.returncode, 0, result.stderr)
        self.assertIn('candidate down --volumes --remove-orphans', self.events())
        self.assertFalse(any(event.startswith('old ') for event in self.events()))
        self.assert_previous_still_active()

    def test_activation_and_public_validation_failures_restore_previous(self):
        for stage in ['activation', 'public-smoke', 'new-health']:
            with self.subTest(stage=stage):
                result = self.run_release(stage)
                self.assertNotEqual(result.returncode, 0, result.stderr)
                self.assertIn('old up -d --no-build --wait --wait-timeout 180', self.events())
                self.assertEqual(self.status()['status'], 'failed')
                self.assertIn('previous production release restored', self.status()['message'])
                self.assert_previous_still_active()

    def test_signal_after_stop_rolls_back(self):
        result = self.run_release('signal')
        self.assertNotEqual(result.returncode, 0, result.stderr)
        self.assertIn('terminated', self.status()['message'])
        self.assertIn('old up -d --no-build --wait --wait-timeout 180', self.events())
        self.assert_previous_still_active()

    def test_configuration_or_revision_mismatch_never_stops_production(self):
        for stage in ['config-volume', 'image-revision', 'candidate-health', 'wrong-volume']:
            with self.subTest(stage=stage):
                result = self.run_release(stage)
                self.assertNotEqual(result.returncode, 0, result.stderr)
                self.assertNotIn('old stop frontend backend', self.events())
                self.assert_previous_still_active()

    def test_invalid_identifier_and_checksum_fail_closed(self):
        result = self.run_release(revision='../wrong')
        self.assertEqual(result.returncode, 64)
        self.assertEqual(self.events(), [])
        result = self.run_release(digest='0'*64)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.events(), [])
        self.assert_previous_still_active()

    def test_source_directories_are_traversable_by_non_root_image_users(self):
        result = self.run_release()
        self.assertEqual(result.returncode, 0, result.stderr)
        source = self.root / 'xraylarch-releases' / REVISION
        for directory in source.rglob('*'):
            if directory.is_dir():
                self.assertEqual(directory.stat().st_mode & 0o777, 0o755, str(directory))
        self.assertEqual((source/'deploy/digitalocean/.env').stat().st_mode & 0o777, 0o600)

    def test_archive_traversal_fails_before_docker(self):
        self.create_archive(unsafe=True)
        result = self.run_release()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.events(), [])
        self.assertFalse((self.root/'xraylarch-releases/escape').exists())
        self.assert_previous_still_active()

    def test_success_checks_candidate_then_backup_then_public_then_switch(self):
        result = self.run_release()
        self.assertEqual(result.returncode, 0, result.stdout+result.stderr)
        events = self.events()
        self.assertLess(events.index('smoke candidate'), events.index('old stop frontend backend'))
        self.assertLess(events.index('backup'), events.index('new up -d --no-build --wait --wait-timeout 180'))
        self.assertLess(events.index('backup'), events.index('smoke public'))
        self.assertEqual(self.status()['status'], 'succeeded')
        self.assertTrue(Path(self.status()['backup']).is_file())
        release = self.root/'xraylarch-releases'/REVISION
        self.assertEqual((self.root/'xraylarch-current').resolve(), release)
        self.assertIn('CUSTOM_SETTING=retained', (release/'deploy/digitalocean/.env').read_text())
        candidate = json.loads((self.root/'xraylarch-autodeploy'/f'{REVISION}.candidate.json').read_text())
        self.assertEqual(candidate['services']['frontend']['ports'], ['127.0.0.1:13004:3000'])
        self.assertEqual(candidate['services']['backend']['volumes'], ['candidate_data:/data'])
        self.assertEqual(candidate['services']['backend']['environment']['XRAYLARCH_SESSION_COOKIE_SECURE'], 'false')
        # Replaying an already-active commit does not stop, build, or back up again.
        before = len(events)
        result = self.run_release()
        self.assertEqual(result.returncode, 0, result.stderr)
        new_events = self.events()[before:]
        self.assertFalse(any('build' in event or 'stop' in event or event=='backup' for event in new_events))


if __name__ == '__main__':
    unittest.main()
