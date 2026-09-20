#!/usr/bin/env python3
"""Local-only committed-branch deployment; no GitHub or remote Git operations."""
import argparse
import fcntl
import gzip
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import plistlib
import re
import shlex
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time

LABEL = 'org.dr-xas.larch-public-deploy'
BRANCH = 'internal_testing'
HOST = 'root@161.35.110.95'
REMOTE = '/opt/xraylarch-autodeploy'
ARCHIVE_PATHS = ['.dockerignore', 'pyproject.toml', 'setup.py', 'MANIFEST.in',
                 'README.md', 'LICENSE', 'INSTALL', 'larch', 'backend',
                 'frontend', 'examples/xafsdata', 'deploy']
SHA = re.compile(r'^[0-9a-f]{40}$')


def command(args, **kwargs):
    return subprocess.run([str(a) for a in args], check=True, **kwargs)


def output(args, **kwargs):
    return command(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                   text=True, **kwargs).stdout.strip()


def git(repo, *args):
    return output(['git', '-C', repo, *args])


def atomic_json(path, value):
    path = Path(path)
    temp = path.with_suffix(path.suffix + '.tmp')
    temp.write_text(json.dumps(value, indent=2) + '\n')
    temp.chmod(0o600)
    temp.replace(path)


def read_json(path):
    return json.loads(Path(path).read_text()) if Path(path).exists() else {}


def included(name):
    path = PurePosixPath(name)
    parts = path.parts
    excluded = {'node_modules', '.git', '.ssh', '.venv', 'venv', '__pycache__',
                'id_rsa', 'id_ed25519', 'id_ecdsa',
                '.pytest_cache', 'backups', 'playwright-report', 'test-results'}
    return (not path.is_absolute() and '..' not in parts
            and not any(p in excluded or p.startswith('.next') or p.startswith('.env')
                        or 'credentials' in p.lower() for p in parts)
            and not name.startswith(('backend/data/', 'larch/bin/darwin64/', 'larch/bin/win64/'))
            and path.suffix not in {'.pem', '.key', '.pyc', '.pyo', '.tsbuildinfo'})


def make_archive(repo, revision, destination):
    if not SHA.fullmatch(revision):
        raise ValueError('Expected a full commit SHA')
    with tempfile.TemporaryFile() as raw:
        command(['git', '-C', repo, 'archive', '--format=tar', revision, '--', *ARCHIVE_PATHS], stdout=raw)
        raw.seek(0)
        with open(destination, 'wb') as target, gzip.GzipFile(filename='', mode='wb', fileobj=target, mtime=0) as zipped:
            with tarfile.open(fileobj=raw, mode='r:') as source, tarfile.open(fileobj=zipped, mode='w|') as archive:
                for member in source:
                    if included(member.name):
                        archive.addfile(member, source.extractfile(member) if member.isfile() else None)
    digest = hashlib.sha256()
    with open(destination, 'rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def ssh_options(config):
    return ['-i', config['ssh_key'], '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes',
            '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=15',
            '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3']


def ssh(config, script):
    return output(['ssh', *ssh_options(config), config['host'], script], timeout=75)


def remote_status(config, revision):
    if not SHA.fullmatch(revision):
        raise ValueError('Invalid pending revision')
    # Status and service state are read together to recover an interrupted local client.
    script = (f'if test -f {REMOTE}/{revision}.status; then cat {REMOTE}/{revision}.status; '
              'else printf "{}"; fi; printf "\\n"; '
              f'systemctl is-active larch-deploy-{revision}.service || true; '
              'basename "$(readlink -f /opt/xraylarch-current)"')
    response = ssh(config, script)
    payload, service, active_revision = response.rsplit('\n', 2)
    status = json.loads(payload)
    status['service_state'] = service
    status['active_revision'] = active_revision
    return status


def submit(config, revision, archive, checksum):
    # An atomic rename prevents the server from seeing an incomplete upload.
    incoming = '/opt/xraylarch-incoming/' + revision + '.tar.gz'
    command(['scp', *ssh_options(config), archive,
             config['host'] + ':' + incoming + '.upload'], timeout=600,
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    script = (f'set -e; mv -- {incoming}.upload {incoming}; '
              f'systemctl reset-failed larch-deploy-{revision}.service 2>/dev/null || true; '
              f'systemd-run --unit=larch-deploy-{revision} --collect '
              '--property=Type=exec --property=RuntimeMaxSec=3600 --property=TimeoutStopSec=240 '
              f'{REMOTE}/remote-release.sh {revision} {checksum}')
    ssh(config, script)


def note(state, message):
    state['message'] = message
    state['updated_at'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    print(state['updated_at'], message, flush=True)


def work(config, state, directory):
    now = time.time()
    request = read_json(directory / 'queue.json')
    if not request:
        return
    desired = request['revision']
    if not SHA.fullmatch(desired):
        raise ValueError('Branch must resolve to a commit SHA')
    if state.get('retry_after', 0) > now and state.get('desired_sha') == desired:
        return
    state['desired_sha'] = desired
    if state.get('pending_sha'):
        pending = state['pending_sha']
        remote = remote_status(config, pending)
        if remote.get('status') == 'succeeded' and remote.get('active_revision') == pending:
            state['deployed_sha'] = pending
            state.pop('pending_sha', None)
            state.pop('failed_sha', None)
            state['failures'] = 0
            note(state, 'Deployed ' + pending)
        elif remote.get('status') == 'failed' or remote['service_state'] not in {'active', 'activating', 'reloading'}:
            state['failed_sha'] = pending
            state.pop('pending_sha', None)
            note(state, 'Deployment failed for ' + pending + ': ' + remote.get('message', 'Remote job stopped; inspect server journal'))
        else:
            state['phase'] = remote.get('phase', 'queued')
            return
    if desired in {state.get('deployed_sha'), state.get('failed_sha')}:
        return
    # Recover jobs dispatched before local state was persisted, without duplicate builds.
    remote = remote_status(config, desired)
    if remote.get('status') == 'succeeded' and remote.get('active_revision') == desired:
        state['deployed_sha'] = desired
        note(state, 'Already deployed ' + desired)
        return
    if remote['service_state'] in {'active', 'activating', 'reloading'}:
        state['pending_sha'] = desired
        return
    if remote.get('status') == 'failed' and state.get('retry_sha') != desired:
        state['failed_sha'] = desired
        note(state, 'Previous deployment failed for ' + desired + '; use retry after fixing the cause')
        return
    archive = directory / 'archives' / (desired + '.tar.gz')
    checksum = request['checksum']
    if not re.fullmatch(r'[0-9a-f]{64}', checksum):
        raise ValueError('Invalid queued archive checksum')
    note(state, 'Uploading committed revision ' + desired)
    submit(config, desired, archive, checksum)
    state['pending_sha'] = desired
    state.pop('retry_sha', None)
    state['failures'] = 0
    state['retry_after'] = 0
    note(state, 'Server is building ' + desired)


def run_once(directory):
    config = read_json(directory / 'config.json')
    if not config.get('enabled'):
        return
    with open(directory / 'worker.lock', 'a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        state = read_json(directory / 'state.json')
        try:
            work(config, state, directory)
        except (OSError, ValueError, subprocess.SubprocessError) as error:
            state['failures'] = state.get('failures', 0) + 1
            state['retry_after'] = time.time() + min(900, 60 * 2 ** min(state['failures'] - 1, 4))
            details = getattr(error, 'stderr', None)
            if isinstance(details, bytes):
                details = details.decode(errors='replace')
            note(state, 'Will retry: ' + (details.strip() if details else str(error)))
        finally:
            atomic_json(directory / 'state.json', state)


def enqueue(repo, directory):
    # Runs in the Git client's user context; launchd never reads the Desktop repo.
    if git(repo, 'branch', '--show-current') != BRANCH:
        return
    archives = directory / 'archives'
    archives.mkdir(parents=True, exist_ok=True, mode=0o700)
    with open(directory / 'queue.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        revision = git(repo, 'rev-parse', 'refs/heads/' + BRANCH)
        previous = read_json(directory / 'queue.json')
        target = archives / (revision + '.tar.gz')
        if previous.get('revision') == revision and target.exists():
            return
        with tempfile.TemporaryDirectory(prefix='pack-', dir=directory) as temp:
            archive = Path(temp) / 'source.tar.gz'
            checksum = make_archive(repo, revision, archive)
            archive.chmod(0o600)
            archive.replace(target)
        atomic_json(directory / 'queue.json', {'revision': revision, 'checksum': checksum})
        print('Queued internal_testing commit', revision[:12], 'for automatic beta deployment')


def install_hooks(repo, directory):
    configured = subprocess.run(['git', '-C', str(repo), 'config', '--get', 'core.hooksPath'],
                                capture_output=True, text=True).stdout.strip()
    if configured:
        raise ValueError('Existing core.hooksPath needs a reviewed hook integration')
    common = Path(git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'))
    hooks = common / 'hooks'
    hooks.mkdir(exist_ok=True)
    marker = '# Larch local internal_testing deployment hook'
    names = ['post-commit', 'post-merge', 'post-rewrite']
    for name in names:
        path = hooks / name
        if path.exists() and marker not in path.read_text():
            raise ValueError('Preserve existing Git hook before installation: ' + str(path))
    executable = shlex.quote(sys.executable)
    controller = shlex.quote(str(directory / 'controller.py'))
    state = shlex.quote(str(directory))
    for name in names:
        path = hooks / name
        drain = 'cat >/dev/null\n' if name == 'post-rewrite' else ''
        path.write_text('#!/bin/sh\n' + marker + '\n' + drain
                        + f'if ! {executable} {controller} enqueue --repo "$PWD" --state-dir {state}; then\n'
                        + '  echo "Larch beta deployment could not be queued; commit is saved. Check local deployment status." >&2\n'
                        + 'fi\nexit 0\n')
        path.chmod(0o700)


def install(repo, directory, ssh_key):
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    directory.chmod(0o700)
    previous = read_json(directory / 'config.json')
    config = {**previous, 'enabled': True, 'repo': str(repo), 'branch': BRANCH,
              'host': HOST, 'ssh_key': str(ssh_key)}
    # Install reviewed controller outside the checkout so uncommitted edits cannot deploy.
    runtime = directory / 'controller.py'
    if Path(__file__).resolve() != runtime.resolve():
        shutil.copyfile(__file__, runtime)
        runtime.chmod(0o700)
    install_hooks(repo, directory)
    atomic_json(directory / 'config.json', config)
    enqueue(repo, directory)
    agent = Path.home() / 'Library/LaunchAgents' / (LABEL + '.plist')
    agent.parent.mkdir(parents=True, exist_ok=True)
    spec = {'Label': LABEL, 'ProgramArguments': [sys.executable, str(runtime), 'run-once', '--state-dir', str(directory)],
            'StartInterval': 60, 'RunAtLoad': True,
            'StandardOutPath': str(directory / 'worker.log'),
            'StandardErrorPath': str(directory / 'worker.log'),
            'EnvironmentVariables': {'PATH': '/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin'},
            'ProcessType': 'Background', 'LowPriorityIO': True}
    with agent.open('wb') as stream:
        plistlib.dump(spec, stream)
    agent.chmod(0o600)
    domain = 'gui/' + str(os.getuid())
    subprocess.run(['launchctl', 'bootout', domain + '/' + LABEL], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    command(['launchctl', 'bootstrap', domain, agent])
    print('Enabled local-only deployment for', BRANCH)
    print('State:', directory)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['install', 'enqueue', 'run-once', 'status', 'disable', 'enable', 'retry'])
    parser.add_argument('--repo', type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument('--state-dir', type=Path)
    parser.add_argument('--ssh-key', type=Path, default=Path.home() / '.ssh/id_ed25519_larch_web_do')
    args = parser.parse_args()
    repo = args.repo.resolve()
    directory = args.state_dir or Path.home() / 'Library/Application Support/LarchWebDeploy'
    if args.action == 'install':
        if git(repo, 'branch', '--show-current') != BRANCH:
            parser.error('Install from the internal_testing worktree')
        install(repo, directory, args.ssh_key)
    elif args.action == 'enqueue':
        enqueue(repo, directory)
    elif args.action == 'run-once':
        run_once(directory)
    elif args.action == 'status':
        print(json.dumps({'config': read_json(directory / 'config.json'), 'state': read_json(directory / 'state.json')}, indent=2))
    else:
        with open(directory / 'worker.lock', 'a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            if args.action in {'enable', 'disable'}:
                config = read_json(directory / 'config.json')
                config['enabled'] = args.action == 'enable'
                atomic_json(directory / 'config.json', config)
            else:
                state = read_json(directory / 'state.json')
                state['retry_sha'] = read_json(directory / 'queue.json')['revision']
                state.pop('failed_sha', None)
                state['retry_after'] = 0
                atomic_json(directory / 'state.json', state)
        print(args.action, 'saved; the worker checks every 60 seconds')


if __name__ == '__main__':
    main()
