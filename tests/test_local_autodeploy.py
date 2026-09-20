"""Verify committed-source packaging and local deployment queue without network."""
import importlib.util
import json
from pathlib import Path
import plistlib
import shutil
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

MODULE = Path(__file__).resolve().parents[1] / 'deploy/digitalocean/local_autodeploy.py'
spec = importlib.util.spec_from_file_location('local_autodeploy', MODULE)
auto = importlib.util.module_from_spec(spec)
spec.loader.exec_module(auto)
A, B = 'a' * 40, 'b' * 40


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = self.root / 'repo'
        self.repo.mkdir()
        self.config = {'repo': str(self.repo), 'enabled': True, 'host': auto.HOST,
                       'ssh_key': str(self.root / 'dedicated-key')}
        auto.atomic_json(self.root / 'queue.json', {'revision': A, 'checksum': 'c' * 64})

    def git(self, *args):
        return subprocess.check_output(['git', '-C', str(self.repo),
            '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Test',
            '-c', 'user.email=test@example.invalid', *args], stderr=subprocess.DEVNULL).decode().strip()

    def repository(self):
        self.git('init', '-b', auto.BRANCH)
        for path in auto.ARCHIVE_PATHS:
            target = self.repo / path
            if path in {'larch', 'backend', 'frontend', 'examples/xafsdata', 'deploy'}:
                target.mkdir(parents=True, exist_ok=True)
                (target / 'source.txt').write_text('committed')
            else:
                target.write_text('fixture')
        for name in ['backend/.env', 'backend/private.key', 'frontend/node_modules/test.js',
                     'backend/data/upload.dat', 'backend/__pycache__/cached.pyc']:
            target = self.repo / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text('must not be uploaded')
        self.git('add', '.')
        self.git('commit', '-m', 'Fixture')
        return self.git('rev-parse', 'HEAD')

    def test_archive_uses_only_committed_source_and_excludes_runtime_files(self):
        sha = self.repository()
        (self.repo / 'backend/source.txt').write_text('dirty')
        (self.repo / 'frontend/untracked.js').write_text('untracked')
        target = self.root / 'source.tar.gz'
        auto.make_archive(self.repo, sha, target)
        with tarfile.open(target) as archive:
            self.assertEqual(archive.extractfile('backend/source.txt').read(), b'committed')
            names = archive.getnames()
            for excluded in ['backend/.env', 'backend/private.key', 'frontend/untracked.js',
                             'frontend/node_modules/test.js', 'backend/data/upload.dat',
                             'backend/__pycache__/cached.pyc']:
                self.assertNotIn(excluded, names)
        self.assertEqual((self.repo / 'backend/source.txt').read_text(), 'dirty')
        self.assertEqual(self.git('rev-parse', 'HEAD'), sha)

    def test_archive_checksum_is_stable_across_retry_filenames(self):
        sha = self.repository()
        self.assertEqual(auto.make_archive(self.repo, sha, self.root / 'one.tgz'),
                         auto.make_archive(self.repo, sha, self.root / 'two.tgz'))
        with self.assertRaises(ValueError):
            auto.make_archive(self.repo, 'HEAD; unsafe', self.root / 'bad.tgz')

    def test_other_branch_commits_do_not_trigger_deployment(self):
        sha = self.repository()
        self.git('checkout', '-b', 'unrelated')
        (self.repo / 'backend/source.txt').write_text('other branch')
        self.git('commit', '-am', 'Unrelated')
        state = {'deployed_sha': sha}
        auto.atomic_json(self.root / 'queue.json', {'revision': sha, 'checksum': 'c' * 64})
        with patch.object(auto, 'make_archive') as archive:
            auto.enqueue(self.repo, self.root)
            archive.assert_not_called()
        with patch.object(auto, 'remote_status') as remote, patch.object(auto, 'submit') as submit:
            auto.work(self.config, state, self.root)
        remote.assert_not_called()
        submit.assert_not_called()
        self.assertEqual(self.git('branch', '--show-current'), 'unrelated')

    def test_pending_job_serializes_then_latest_commit_is_submitted(self):
        state = {'pending_sha': A}
        auto.atomic_json(self.root / 'queue.json', {'revision': B, 'checksum': 'c' * 64})
        with patch.object(auto, 'git', return_value=B), patch.object(auto, 'remote_status',
                return_value={'service_state': 'active', 'status': 'building', 'phase': 'candidate'}), \
                patch.object(auto, 'submit') as submit:
            auto.work(self.config, state, self.root)
            submit.assert_not_called()
        with patch.object(auto, 'git', return_value=B), patch.object(auto, 'remote_status', side_effect=[
                {'service_state': 'inactive', 'status': 'succeeded', 'active_revision': A},
                {'service_state': 'inactive', 'active_revision': A}]), \
                patch.object(auto, 'make_archive', return_value='c' * 64), patch.object(auto, 'submit') as submit:
            auto.work(self.config, state, self.root)
            self.assertEqual(submit.call_args.args[1], B)
        self.assertEqual(state['deployed_sha'], A)
        self.assertEqual(state['pending_sha'], B)

    def test_failed_commit_is_not_retried_without_request(self):
        state = {'pending_sha': A}
        with patch.object(auto, 'git', return_value=A), patch.object(auto, 'remote_status',
                return_value={'status': 'failed', 'service_state': 'inactive', 'message': 'build failed'}), \
                patch.object(auto, 'submit') as submit:
            auto.work(self.config, state, self.root)
            submit.assert_not_called()
        self.assertEqual(state['failed_sha'], A)
        with patch.object(auto, 'git', return_value=A), patch.object(auto, 'remote_status') as remote:
            auto.work(self.config, state, self.root)
            remote.assert_not_called()

    def test_dispatch_recovery_does_not_submit_duplicate_job(self):
        state = {}
        with patch.object(auto, 'git', return_value=A), patch.object(auto, 'remote_status',
                return_value={'status': 'building', 'service_state': 'active'}), \
                patch.object(auto, 'submit') as submit:
            auto.work(self.config, state, self.root)
            submit.assert_not_called()
        self.assertEqual(state['pending_sha'], A)

    def test_historical_success_is_not_mistaken_for_current_release(self):
        state = {}
        with patch.object(auto, 'git', return_value=A), patch.object(auto, 'remote_status',
                return_value={'status': 'succeeded', 'service_state': 'inactive', 'active_revision': B}), \
                patch.object(auto, 'make_archive', return_value='c' * 64), patch.object(auto, 'submit') as submit:
            auto.work(self.config, state, self.root)
            submit.assert_called_once()
        self.assertEqual(state['pending_sha'], A)

    def test_network_failure_backoff_and_disabled_worker(self):
        auto.atomic_json(self.root / 'config.json', self.config)
        error = subprocess.CalledProcessError(255, ['ssh'], stderr='Network unavailable')
        with patch.object(auto, 'git', return_value=A), patch.object(auto.time, 'time', return_value=1000), \
                patch.object(auto, 'remote_status', side_effect=error) as remote:
            auto.run_once(self.root)
            state = auto.read_json(self.root / 'state.json')
            self.assertEqual(state['retry_after'], 1060)
            auto.run_once(self.root)
            self.assertEqual(remote.call_count, 1)
        self.config['enabled'] = False
        auto.atomic_json(self.root / 'config.json', self.config)
        with patch.object(auto, 'work') as work:
            auto.run_once(self.root)
            work.assert_not_called()

    def test_remote_status_parses_actual_release_and_service(self):
        with patch.object(auto, 'ssh', return_value='{"status":"succeeded"}\n\ninactive\n' + A):
            result = auto.remote_status(self.config, A)
        self.assertEqual(result['active_revision'], A)
        self.assertEqual(result['service_state'], 'inactive')

    def test_enqueue_exports_committed_revision_without_background_repo_access(self):
        sha = self.repository()
        (self.repo / 'backend/source.txt').write_text('not committed')
        auto.enqueue(self.repo, self.root)
        request = auto.read_json(self.root / 'queue.json')
        self.assertEqual(request['revision'], sha)
        with tarfile.open(self.root / 'archives' / (sha + '.tar.gz')) as archive:
            self.assertEqual(archive.extractfile('backend/source.txt').read(), b'committed')
        state = {}
        with patch.object(auto, 'git', side_effect=AssertionError('Background worker must not read Git')), \
                patch.object(auto, 'remote_status', return_value={'service_state': 'inactive'}), \
                patch.object(auto, 'submit') as submit:
            auto.work(self.config, state, self.root)
            self.assertEqual(submit.call_args.args[1], sha)

    def test_actual_post_commit_hook_queues_local_commit(self):
        self.repository()
        runtime = self.root / 'state with spaces'
        runtime.mkdir()
        shutil.copyfile(MODULE, runtime / 'controller.py')
        auto.install_hooks(self.repo, runtime)
        (self.repo / 'backend/source.txt').write_text('next committed version')
        subprocess.run(['git', '-C', str(self.repo), '-c', 'user.name=Test',
                        '-c', 'user.email=test@example.invalid', 'commit', '-am', 'Trigger'],
                       check=True, capture_output=True)
        sha = self.git('rev-parse', 'HEAD')
        request = auto.read_json(runtime / 'queue.json')
        self.assertEqual(request['revision'], sha)
        with tarfile.open(runtime / 'archives' / (sha + '.tar.gz')) as archive:
            self.assertEqual(archive.extractfile('backend/source.txt').read(), b'next committed version')

    def test_existing_hook_is_preserved(self):
        self.repository()
        hook = self.repo / '.git/hooks/post-commit'
        hook.write_text('#!/bin/sh\necho existing\n')
        with self.assertRaises(ValueError):
            auto.install_hooks(self.repo, self.root)
        self.assertEqual(hook.read_text(), '#!/bin/sh\necho existing\n')

    def test_install_uses_local_launchagent_and_private_runtime_copy(self):
        fake_home = self.root / 'home'
        state = self.root / 'git-state'
        with patch.object(auto.Path, 'home', return_value=fake_home), \
                patch.object(auto, 'command') as command, patch.object(auto.subprocess, 'run'), \
                patch.object(auto, 'install_hooks'), patch.object(auto, 'enqueue'):
            auto.install(self.repo, state, self.root / 'key')
        agent = fake_home / 'Library/LaunchAgents' / (auto.LABEL + '.plist')
        with agent.open('rb') as stream:
            config = plistlib.load(stream)
        self.assertEqual(config['StartInterval'], 60)
        self.assertTrue(config['RunAtLoad'])
        self.assertEqual(config['ProgramArguments'][1], str(state / 'controller.py'))
        self.assertEqual((state / 'config.json').stat().st_mode & 0o777, 0o600)
        self.assertEqual((state / 'controller.py').stat().st_mode & 0o777, 0o700)
        self.assertEqual(auto.read_json(state / 'config.json')['branch'], auto.BRANCH)
        self.assertEqual(command.call_args.args[0][:2], ['launchctl', 'bootstrap'])


if __name__ == '__main__':
    unittest.main()
