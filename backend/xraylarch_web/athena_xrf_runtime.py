"""Bounded detector workers and exact, process-local XRF reuse."""
from collections import OrderedDict
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor
from concurrent.futures.process import BrokenProcessPool
import json
import logging
import multiprocessing
import os
import pickle
import signal
import sys
import time
from threading import RLock, Thread


MAX_POOL_FAILURES = 3


def _parent_death_signal():
    if sys.platform == 'linux':
        import ctypes
        libc = ctypes.CDLL(None, use_errno=True)
        prctl = libc.prctl
        prctl.argtypes = [ctypes.c_int, *([ctypes.c_ulong] * 4)]
        prctl.restype = ctypes.c_int
        if prctl(1, signal.SIGTERM, 0, 0, 0) != 0:  # PR_SET_PDEATHSIG
            logging.getLogger(__name__).warning(
                'Could not arm XRF parent-death signal: %s; using parent watcher',
                os.strerror(ctypes.get_errno()))


def _watch_parent(parent_pid):
    parent = multiprocessing.parent_process()
    # The parent sentinel also works on platforms that retain a dead PPID.
    while os.getppid() == parent_pid and (parent is None or parent.is_alive()):
        time.sleep(0.25)
    os._exit(1)


def _initialize_worker(parent_pid):
    signal.signal(signal.SIGTERM, signal.SIG_DFL)
    _parent_death_signal()
    # Compare with the PID passed by the server, not a potentially new parent
    # observed after spawn. This closes the death-before-initialization race.
    if os.getppid() != parent_pid:
        os._exit(1)
    Thread(target=_watch_parent, args=(parent_pid,), daemon=True,
           name='xrf-parent-watch').start()
    # Spawn never inherits the web server's threads or native-library locks.
    # Environment limits cover libraries loaded later; threadpoolctl covers
    # NumPy/SciPy already imported during spawn.
    for name in ('OPENBLAS_NUM_THREADS', 'OMP_NUM_THREADS', 'MKL_NUM_THREADS',
                 'VECLIB_MAXIMUM_THREADS', 'NUMEXPR_NUM_THREADS'):
        os.environ[name] = '1'
    from threadpoolctl import threadpool_limits
    threadpool_limits(limits=1)


def _fit_worker(task):
    from .athena_xrf_xas import make_fitter, fit_detector
    channels, incident, options, spectra, indices, batch_size, preview_index = task
    fitter = make_fitter(channels, incident, options)
    return fit_detector(fitter, spectra, indices, batch_size, preview_index)


class XrfRuntime:
    """One server-local pool, with an eight-entry / 64 MiB serialized LRU.

    Cached values are our own results, never uploaded pickle data. Deserializing
    on retrieval isolates callers from cache mutation. Concurrent scans share
    one pool; cache hits never wait for unrelated calibration work.
    """

    def __init__(self, workers=8, *, cache_bytes=64*1024*1024):
        available = len(os.sched_getaffinity(0)) if hasattr(os, 'sched_getaffinity') else (os.cpu_count() or 1)
        self.workers = max(1, min(workers, available))
        self.cache_bytes = cache_bytes
        self._cache = OrderedDict()
        self._size = 0
        self._lock = RLock()
        self._pool = None
        self._launcher = None
        self._pool_failures = 0
        self.hits = self.misses = 0

    def close(self):
        """Release resources after requests have drained."""
        with self._lock:
            pool, self._pool = self._pool, None
            launcher, self._launcher = self._launcher, None
            self._cache.clear()
            self._size = 0
        if pool is not None:
            pool.shutdown(wait=True, cancel_futures=True)
        if launcher is not None:
            launcher.shutdown(wait=True)

    def _get(self, key):
        with self._lock:
            payload = self._cache.get(key)
            if payload is None:
                self.misses += 1
                return None
            self.hits += 1
            self._cache.move_to_end(key)
        return pickle.loads(payload)

    def _put(self, key, value):
        if self.cache_bytes <= 0:
            return
        payload = pickle.dumps(value, protocol=pickle.HIGHEST_PROTOCOL)
        if len(payload) > self.cache_bytes:
            return
        with self._lock:
            old = self._cache.pop(key, b'')
            self._size -= len(old)
            while self._cache and (len(self._cache) >= 8 or self._size + len(payload) > self.cache_bytes):
                _, removed = self._cache.popitem(last=False)
                self._size -= len(removed)
            self._cache[key] = payload
            self._size += len(payload)

    def _discard_pool(self, pool, exc):
        with self._lock:
            # Several requests can observe the same crash. Retire that pool
            # once, never a replacement already serving another request.
            if self._pool is not pool:
                return
            self._pool = None
            self._pool_failures += 1
            remaining = self._pool_failures < MAX_POOL_FAILURES
            logging.getLogger(__name__).warning(
                'XRF process pool failed (%d/%d); using serial extraction. %s: %s',
                self._pool_failures, MAX_POOL_FAILURES,
                'Next cold request will recreate the pool' if remaining else
                'Retry limit reached; serial until restart', exc)
        if pool is not None:
            pool.shutdown(wait=True, cancel_futures=True)

    def _start_fits(self, tasks):
        pool = None
        try:
            with self._lock:
                if self._pool_failures >= MAX_POOL_FAILURES:
                    return None, []
                if self._pool is None:
                    if self._pool_failures:
                        logging.getLogger(__name__).warning('Recreating XRF process pool after failure')
                    self._pool = ProcessPoolExecutor(
                        max_workers=self.workers,
                        mp_context=multiprocessing.get_context('spawn'),
                        initializer=_initialize_worker, initargs=(os.getpid(),))
                pool = self._pool
                futures = [pool.submit(_fit_worker, task) for task in tasks]
            return pool, futures
        except (OSError, BrokenProcessPool) as exc:
            self._discard_pool(pool, exc)
            return None, []

    def _parallel_fits(self, tasks):
        with self._lock:
            # Linux PDEATHSIG follows the creating *thread*. A persistent
            # launcher prevents request-thread retirement from killing workers.
            if self._launcher is None:
                self._launcher = ThreadPoolExecutor(1, thread_name_prefix='xrf-launch')
            started = self._launcher.submit(self._start_fits, tasks)
        pool, futures = started.result()
        if pool is None:
            return None
        try:
            fits = [future.result() for future in futures]
        except BrokenProcessPool as exc:
            self._discard_pool(pool, exc)
            return None
        with self._lock:
            if self._pool is pool:
                self._pool_failures = 0
        return fits

    def extract(self, scan, counts, options, windows, digest):
        from . import athena_xrf_xas as engine
        # Include new options automatically. Only transport identity is omitted
        # from the result key; request provenance is rebound on every hit.
        recipe = options.model_dump(exclude={'version', 'scan_id'})
        result_key = ('result', digest, scan['filename'],
                      json.dumps([recipe, windows], sort_keys=True))
        fit_recipe = {key: value for key, value in recipe.items() if key not in
                      ('point_stride', 'preview_point', 'preview_detector', 'include_window_sum')}
        fit_key = ('detectors', digest, json.dumps(fit_recipe, sort_keys=True))

        def provide(fitter, ordered_counts, indices, batch_size, preview_index, preview_detector):
            fits = self._get(fit_key)
            if fits is not None:
                return fits
            ndet = ordered_counts.shape[1]
            if self.workers > 1 and ndet > 1:
                tasks = [(fitter.channels, fitter.incident, options,
                          ordered_counts[:, detector, :], indices, batch_size,
                          preview_index if detector == preview_detector else None)
                         for detector in range(ndet)]
                fits = self._parallel_fits(tasks)
            if fits is None:
                fits = [engine.fit_detector(fitter, ordered_counts[:, detector, :],
                                            indices, batch_size,
                                            preview_index if detector == preview_detector else None)
                        for detector in range(ndet)]
            self._put(fit_key, fits)
            return fits

        result = self._get(result_key)
        if result is None:
            result = engine.extract(scan, counts, options, windows, fit_provider=provide)
            self._put(result_key, result)
        result['metadata']['request'].update(version=options.version, scan_id=options.scan_id)
        return result
