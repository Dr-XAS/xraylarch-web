"""A killed web server must not leave detector processes behind.

Run actual uvicorn and real synthetic XRF requests, not TestClient: abrupt
signals bypass the application shutdown hooks that ordinary HTTP tests use.
"""
import ctypes
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor

import httpx
import psutil
import pytest

from test_athena_xrf_xas import small_scan
from xrf_xas_scan_fixture import scan_file
from xraylarch_web.athena_xrf_runtime import XrfRuntime


pytestmark = [pytest.mark.skipif(sys.platform != 'linux', reason='Linux signal/process lifecycle check'),
              pytest.mark.xrf_slow]
POOL_WORKERS = 2


@pytest.fixture(scope='module')
def synthetic():
    # Lifecycle coverage needs real concurrent fits, not a large detector model.
    scan, counts, options, _ = small_scan(detectors=POOL_WORKERS)
    return scan_file(scan, counts), options.model_dump()


def reap(processes, timeout=10):
    start = time.monotonic()
    while time.monotonic() - start < timeout:
        alive = []
        for process in processes:
            try:
                # The test acts as init for these orphans. Reap zombies too,
                # rather than calling an unreaped process "gone".
                if process.status() == psutil.STATUS_ZOMBIE:
                    try:
                        os.waitpid(process.pid, os.WNOHANG)
                    except ChildProcessError:
                        pass
                if process.is_running():
                    alive.append(process.pid)
            except psutil.NoSuchProcess:
                pass
        if not alive:
            return time.monotonic() - start
        time.sleep(.05)
    pytest.fail(f'Processes still present after {timeout} seconds: {alive}')


@pytest.fixture
def adopt_orphans():
    # Adopt this server's orphans so the test does not depend on how quickly
    # the test container's PID 1 reaps children. Production init does this.
    libc = ctypes.CDLL(None)
    old = ctypes.c_int()
    assert libc.prctl(37, ctypes.byref(old), 0, 0, 0) == 0  # GET_CHILD_SUBREAPER
    assert libc.prctl(36, 1, 0, 0, 0) == 0
    yield
    assert libc.prctl(36, old.value, 0, 0, 0) == 0


@pytest.fixture
def server(tmp_path, adopt_orphans):
    backend = Path(__file__).resolve().parents[1]
    env = {key: value for key, value in os.environ.items() if not key.startswith('XRAYLARCH_')}
    env.update(XRAYLARCH_DATA_ROOT=str(tmp_path/'store'), OPENBLAS_NUM_THREADS='1',
               XRAYLARCH_XRF_WORKERS=str(POOL_WORKERS),
               PYTHONPATH=os.pathsep.join((str(backend), str(backend.parent))))
    log = tmp_path/'server.log'
    children = {}
    with socket.socket() as listener, log.open('w') as output:
        listener.bind(('127.0.0.1', 0))
        listener.listen()
        port = listener.getsockname()[1]
        assert port not in (3000, 8006)
        process = subprocess.Popen(
            [sys.executable, '-m', 'uvicorn', 'xraylarch_web.main:app', '--fd', str(listener.fileno())],
            cwd=backend, env=env, pass_fds=(listener.fileno(),),
            stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
        def descendants():
            try:
                found = psutil.Process(process.pid).children(recursive=True)
            except psutil.NoSuchProcess:
                found = []
            children.update({p.pid: p for p in found})
            return found
        try:
            with httpx.Client(base_url=f'http://127.0.0.1:{port}', timeout=90) as client:
                deadline = time.monotonic()+30
                while True:
                    assert process.poll() is None, log.read_text()
                    try:
                        if client.get('/health', timeout=.2).status_code == 200:
                            break
                    except httpx.TransportError:
                        pass
                    assert time.monotonic() < deadline, log.read_text()
                    time.sleep(.1)
                yield process, client, descendants, log
        finally:
            descendants()
            if process.poll() is None:
                process.kill()
            process.wait(timeout=10)
            # Also clean up if a regression leaves workers alive and the test fails.
            for child in children.values():
                try:
                    child.kill()
                except psutil.NoSuchProcess:
                    pass
            reap(list(children.values()))


def uploaded(client, synthetic):
    data, options = synthetic
    project = client.post('/api/athena/projects').json()
    route = f"/api/athena/projects/{project['id']}/xrf-xas"
    response = client.post(route+'/inspect', files={'file': ('synthetic.h5', data)})
    assert response.status_code == 200, response.text
    return route, dict(options, version=project['version'], scan_id=response.json()['upload_id'])


def pool_children(descendants):
    children = descendants()
    workers = [p for p in children if 'multiprocessing.spawn' in ' '.join(p.cmdline())]
    trackers = [p for p in children if 'multiprocessing.resource_tracker' in ' '.join(p.cmdline())]
    expected = XrfRuntime(POOL_WORKERS).workers
    if expected < 2:
        pytest.skip('The pool check needs at least two CPUs')
    assert len(workers) == expected
    assert len(trackers) == 1
    return workers, trackers


@pytest.mark.parametrize('death', [signal.SIGHUP, signal.SIGKILL], ids=['sighup', 'sigkill'])
def test_abrupt_server_death_removes_workers_and_resource_tracker(server, synthetic, tmp_path, death):
    process, client, descendants, _ = server
    route, options = uploaded(client, synthetic)
    response = client.post(route+'/preview', json=options)
    assert response.status_code == 200, response.text
    workers, trackers = pool_children(descendants)
    killed = time.monotonic()
    os.kill(process.pid, death)
    assert process.wait(timeout=10) == -death
    reap(workers+trackers)
    elapsed = time.monotonic()-killed
    assert elapsed < 10
    (tmp_path/'cleanup.json').write_text(json.dumps(dict(
        signal=death.name, workers=len(workers), trackers=len(trackers), exit_seconds=elapsed)))


def test_worker_killed_mid_fit_is_replaced_for_the_next_cold_request(server, synthetic, tmp_path):
    process, client, descendants, log = server
    route, options = uploaded(client, synthetic)
    response = client.post(route+'/preview', json=options)
    assert response.status_code == 200, response.text
    workers, _ = pool_children(descendants)
    cpu = {p.pid: p.cpu_times().user for p in workers}
    with ThreadPoolExecutor(1) as requests:
        pending = requests.submit(client.post, route+'/preview', json=dict(options, cal_offset=.001))
        deadline = time.monotonic()+15
        while True:
            active = [p for p in workers if p.cpu_times().user > cpu[p.pid]+.02]
            if active:
                assert not pending.done(), 'Fit finished before the crash was injected'
                active[0].kill()
                break
            assert not pending.done(), 'Fit finished before the crash was injected'
            assert time.monotonic() < deadline, 'Workers did not start the cold fit'
            time.sleep(.02)
        recovered = pending.result(timeout=90)
    assert recovered.status_code == 200, recovered.text
    assert 'using serial extraction' in log.read_text()
    following = client.post(route+'/preview', json=dict(options, cal_offset=.002))
    assert following.status_code == 200, following.text
    replacement, _ = pool_children(descendants)
    assert {p.pid for p in replacement}.isdisjoint(p.pid for p in workers)
    assert 'Recreating XRF process pool' in log.read_text()
    assert process.poll() is None
    (tmp_path/'recovery.json').write_text(json.dumps(dict(
        interrupted_status=recovered.status_code, following_status=following.status_code,
        replaced_workers=len(replacement))))


def test_parent_watcher_exits_without_linux_parent_death_signal(tmp_path, adopt_orphans):
    ready = tmp_path/'ready'
    worker_code = (
        'import sys,time; from pathlib import Path; '
        'from xraylarch_web import athena_xrf_runtime as runtime; '
        'runtime._parent_death_signal = lambda: None; '
        'runtime._initialize_worker(int(sys.argv[1])); '
        f'Path({str(ready)!r}).write_text("ready"); time.sleep(60)')
    parent_code = (
        'import os,subprocess,sys,time; '
        f'subprocess.Popen([sys.executable,"-c",{worker_code!r},str(os.getpid())]); '
        'time.sleep(60)')
    parent = subprocess.Popen([sys.executable, '-c', parent_code])
    children = []
    try:
        deadline = time.monotonic()+15
        while not ready.exists():
            assert parent.poll() is None
            assert time.monotonic() < deadline, 'Portable worker did not initialize'
            time.sleep(.05)
        children = psutil.Process(parent.pid).children(recursive=True)
        assert len(children) == 1
        killed = time.monotonic()
        parent.kill()
        parent.wait(timeout=10)
        reap(children)
        elapsed = time.monotonic()-killed
        assert elapsed < 10
        (tmp_path/'cleanup.json').write_text(json.dumps(dict(native_signal=False, exit_seconds=elapsed)))
    finally:
        if parent.poll() is None:
            children = psutil.Process(parent.pid).children(recursive=True)
            parent.kill()
        parent.wait(timeout=10)
        for child in children:
            try:
                child.kill()
            except psutil.NoSuchProcess:
                pass
        reap(children)
