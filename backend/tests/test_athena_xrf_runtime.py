"""Scheduling and reuse must not alter the science or retain stale recipes."""
import json
from concurrent.futures import ThreadPoolExecutor
from threading import Event

import numpy as np
import pytest
from threadpoolctl import threadpool_info

from xraylarch_web import athena_xrf_xas as engine
from xraylarch_web.athena_xrf_runtime import XrfRuntime
from test_athena_xrf_xas import CHANNELS, small_scan

pytestmark = pytest.mark.xrf_slow


@pytest.fixture(scope='module')
def measured():
    scan, counts, options, _ = small_scan(preview_point=7)
    lo, hi = options.channel_range
    counts = counts[:, :, lo-CHANNELS[0]:hi-CHANNELS[0]]
    options, windows = engine.resolve_windows(scan, options)
    return scan, counts, options, windows


def test_parallel_fits_and_cached_views_are_identical_to_serial(measured, monkeypatch):
    if XrfRuntime(2).workers < 2:
        pytest.skip('The process-pool check needs two available CPUs')
    scan, counts, options, windows = measured
    serial = engine.extract(scan, counts, options, windows)
    strided = options.model_copy(update=dict(point_stride=3, preview_point=11,
                                             preview_detector=1, include_window_sum=True))
    expected_view = engine.extract(scan, counts, strided, windows)
    # Children must enforce one thread even when the server environment does
    # not. Already-loaded libraries in this parent retain their original limit.
    monkeypatch.setenv('OPENBLAS_NUM_THREADS', '2')
    monkeypatch.setenv('OMP_NUM_THREADS', '2')
    runtime = XrfRuntime(2)
    try:
        # A request thread can retire while the server and pool stay alive.
        with ThreadPoolExecutor(1) as request:
            parallel = request.submit(runtime.extract, scan, counts, options,
                                      windows, 'synthetic-content').result()
        # JSON float representations also distinguish positive/negative zero.
        assert json.dumps(parallel, sort_keys=True) == json.dumps(serial, sort_keys=True)
        pools = runtime._pool.submit(threadpool_info).result()
        assert pools and all(item['num_threads'] == 1 for item in pools)
        def unexpected(*args, **kwargs):
            raise AssertionError('A matching preview must not recalibrate')
        monkeypatch.setattr(engine, 'calibrate', unexpected)
        # Turn off dispatch so an accidental cache miss cannot hide in a child.
        runtime.workers = 1
        assert runtime.extract(scan, counts, strided, windows, 'synthetic-content') == expected_view
        parallel['fit_over_i0'][0] = 123456.
        assert runtime.extract(scan, counts, options, windows, 'synthetic-content') == serial
        rebound = options.model_copy(update=dict(version=12, scan_id='another-upload-0001'))
        reused = runtime.extract(scan, counts, rebound, windows, 'synthetic-content')
        assert reused['metadata']['request'] == rebound.model_dump()
        assert reused['fit_over_i0'] == serial['fit_over_i0']
    finally:
        runtime.close()


def test_every_result_option_and_content_change_invalidates_reuse(measured, monkeypatch):
    scan, counts, options, windows = measured
    runtime = XrfRuntime(1)
    try:
        runtime.extract(scan, counts, options, windows, 'original-content')
        def cold(*args, **kwargs):
            raise RuntimeError('Uncached extraction requested')
        monkeypatch.setattr(engine, 'extract', cold)
        changes = dict(detector='other', target='Fe', matrix_elements=['Cr'], open_gates=['Fe'],
                       i0_channel='other', engine='mapstorch', channel_range=[381,771],
                       roi_range=[567,608], elements=[0], channel_shifts=[[0,1]],
                       detector_material='Si', detector_thickness=2., cal_offset=.01,
                       cal_slope=.011, compton_angle=120., scatter_beta=1., calibration_points=4,
                       point_stride=2, include_window_sum=True, background='smooth',
                       background_terms=3, ridge=.001, escape_amp=0., e0=6540.,
                       pre1=-160., pre2=-30., norm1=110., norm2=550., nnorm=1,
                       preview_point=8, preview_detector=1)
        # Cover every declared scientific/display option, including future additions.
        assert set(changes) == set(engine.XrfXasOptions.model_fields)-{'version','scan_id'}
        for name, value in changes.items():
            assert value != getattr(options, name), name
            changed = options.model_copy(update={name:value})
            with pytest.raises(RuntimeError, match='Uncached extraction'):
                runtime.extract(scan, counts, changed, windows, 'original-content')
        with pytest.raises(RuntimeError, match='Uncached extraction'):
            runtime.extract(scan, counts, options, windows, 'changed-content')
        with pytest.raises(RuntimeError, match='Uncached extraction'):
            runtime.extract(scan, counts, options, dict(windows, automatic=['channel_range']), 'original-content')
    finally:
        runtime.close()


def test_unavailable_workers_fall_back_to_the_same_serial_result(measured, monkeypatch, caplog):
    if XrfRuntime(2).workers < 2:
        pytest.skip('The process-pool check needs two available CPUs')
    from xraylarch_web import athena_xrf_runtime as module
    scan, counts, options, windows = measured
    expected = engine.extract(scan, counts, options, windows)
    attempts = []
    def unavailable(*args, **kwargs):
        attempts.append(1)
        raise PermissionError('Process creation unavailable')
    monkeypatch.setattr(module, 'ProcessPoolExecutor', unavailable)
    runtime = XrfRuntime(2, cache_bytes=0)
    try:
        for _ in range(5):
            assert runtime.extract(scan, counts, options, windows, 'content') == expected
        assert len(attempts) == 3
        assert 'using serial extraction' in caplog.text
        assert 'Retry limit reached' in caplog.text
        assert runtime._size == 0
    finally:
        runtime.close()


def test_cache_evicts_old_results_and_never_exceeds_its_byte_budget():
    runtime = XrfRuntime(1, cache_bytes=2000)
    for index in range(20):
        runtime._put(str(index), np.ones(50)*index)
    assert runtime._size <= 2000 and len(runtime._cache) <= 8
    assert runtime._get('0') is None
    np.testing.assert_array_equal(runtime._get('19'), np.full(50,19.))
    runtime._put('too-large', np.ones(1000))
    assert runtime._get('too-large') is None


def test_cached_result_does_not_wait_for_an_unrelated_extraction(measured, monkeypatch):
    scan, counts, options, windows = measured
    runtime = XrfRuntime(1)
    entered, release = Event(), Event()
    try:
        expected = runtime.extract(scan, counts, options, windows, 'warm-content')
        def slow(*args, **kwargs):
            entered.set()
            assert release.wait(15), 'Cold extraction was not released'
            return expected
        monkeypatch.setattr(engine, 'extract', slow)
        with ThreadPoolExecutor(2) as requests:
            cold = requests.submit(runtime.extract, scan, counts, options, windows, 'cold-content')
            try:
                assert entered.wait(5)
                warm = requests.submit(runtime.extract, scan, counts, options, windows, 'warm-content')
                assert warm.result(timeout=5) == expected
            finally:
                release.set()
            cold.result(timeout=5)
    finally:
        runtime.close()
