"""Validate fresh native T2/T3 actual arrays; emit only scalar/hash evidence."""
import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
from larch import Group
from larch.math import complex_phase
from larch.xafs import find_e0, xftf


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'),
        ensure_ascii=False, allow_nan=False).encode()).hexdigest()


def read(path):
    return json.loads(path.read_text())


def validate(root):
    result = {'checks': {}, 'tasks': {}}
    for task in ('T2', 'T3'):
        directory = root / f'native-{task}'
        initial = read(directory / 'initial-science.json')
        final = read(directory / 'final-science.json')
        payloads = {p.stem: read(p) for p in (directory / 'private' / 'payloads').glob('*.json')}
        originals = final['originals']
        labels = {ref: label for label, ref in originals.items()}
        original_checks = {}
        for label, ref in originals.items():
            actual = digest(payloads[ref])
            original_checks[label] = {'initial_sha256': initial[label]['payload_sha256'],
                'final_sha256': actual, 'unchanged': initial[label]['payload_sha256'] == actual}
        result['checks'][f'{task}_originals_unchanged'] = all(r['unchanged'] for r in original_checks.values())
        result['tasks'][task] = {'originals': original_checks}
        events = [json.loads(line) for line in (directory / 'events.jsonl').read_text().splitlines()]
        success = [e for e in events if e.get('kind') == 'tool_result'
            and e.get('output', {}).get('success') is True]
        if task == 'T2':
            alignments = []
            expected = {'Cu foil · 50 K': -0.018, 'Cu foil · 300 K': -2.959}
            for event in success:
                if event.get('tool') != 'align_xas_spectra':
                    continue
                out = event['output']
                derived = payloads[out['xas_ref']]
                source_ref = derived['metadata']['alignment']['source_ref']
                source = payloads[source_ref]
                reference = payloads[out['reference_ref']]
                label = labels[source_ref]
                delta = np.asarray(derived['energy']) - np.asarray(source['energy'])
                shift = out['energy_shift_ev']
                target_edge = float(find_e0(np.asarray(derived['energy']), np.asarray(derived['mu'])))
                ref_edge = float(find_e0(np.asarray(reference['energy']), np.asarray(reference['mu'])))
                checks = {'energy_delta_matches_shift': bool(np.allclose(delta, shift, rtol=0, atol=1e-9)),
                    'mu_unchanged': derived['mu'] == source['mu'],
                    'edge_residual_below_0_15_ev': abs(target_edge-ref_edge) < .15,
                    'shift_within_0_1_ev_app_expected': label in expected and abs(shift-expected[label]) < .1}
                alignments.append({'label': label, 'xas_ref': out['xas_ref'], 'source_ref': source_ref,
                    'reported_shift_ev': shift, 'actual_delta_min_ev': float(delta.min()),
                    'actual_delta_max_ev': float(delta.max()), 'sampled_edge_ev': target_edge,
                    'reference_sampled_edge_ev': ref_edge, 'edge_residual_ev': target_edge-ref_edge,
                    'app_expected_shift_ev': expected.get(label), 'checks': checks,
                    'source_mu_sha256': digest(source['mu']), 'derived_mu_sha256': digest(derived['mu'])})
            result['tasks'][task]['alignments'] = alignments
            result['checks']['T2_alignment_science'] = (set(r['label'] for r in alignments) == set(expected)
                and all(all(r['checks'].values()) for r in alignments))
        else:
            transforms = []
            fields = ('kmin', 'dk', 'dk2', 'kweight', 'window', 'rmax_out', 'nfft', 'kstep', 'with_phase')
            for event in success:
                if event.get('tool') != 'fourier_transform_xas':
                    continue
                out = event['output']
                derived = payloads[out['xas_ref']]
                settings = derived['metadata']['ft']
                source_ref = settings['source_ref']
                source = payloads[source_ref]
                prior = source['metadata']['ft']
                group = Group(k=np.asarray(derived['k']), chi=np.asarray(derived['chi']))
                missing_fields = [key for key in fields if key not in settings]
                # Legacy FT omitted these metadata keys; record absence as failure.
                # Defaults below reconstruct the legacy output only, never certify preservation.
                recompute_settings = {key: settings[key] for key in ('kmin','kmax','dk','kweight','window','rmax_out')}
                recompute_settings.update(dk2=settings.get('dk2', settings['dk']),
                    nfft=settings.get('nfft', 2048), kstep=settings.get('kstep', .05),
                    with_phase=settings.get('with_phase', True))
                xftf(group, **recompute_settings)
                # The tool exposes phase as a diagnostic even when xftf phase output is disabled.
                group.chir_pha = complex_phase(group.chir)
                recomputed = {}
                for key in ('kwin', 'r', 'chir_mag', 'chir_re', 'chir_im', 'chir_pha'):
                    if key not in derived or not hasattr(group, key):
                        recomputed[key] = {'matched': False, 'actual_present': key in derived,
                            'recomputed_present': hasattr(group, key), 'reason': 'missing array'}
                        continue
                    actual, rebuilt = np.asarray(derived[key]), np.asarray(getattr(group, key))
                    matched = actual.shape == rebuilt.shape and bool(np.allclose(actual, rebuilt, rtol=1e-11, atol=1e-12))
                    recomputed[key] = {'matched': matched, 'actual_sha256': digest(derived[key]),
                        'max_absolute_error': float(np.max(np.abs(actual-rebuilt))) if actual.shape == rebuilt.shape else None}
                checks = {'source_is_10k': labels.get(source_ref) == 'Cu foil · 10 K',
                    'chi_unchanged': derived['chi'] == source['chi'], 'k_unchanged': derived['k'] == source['k'],
                    'upper_limit_reduced': 3 < settings['kmax'] < prior['kmax'],
                    'other_ft_settings_preserved': all(key in settings and key in prior and settings[key] == prior[key] for key in fields),
                    'recomputed_ft_matches': all(row['matched'] for row in recomputed.values())}
                transforms.append({'xas_ref': out['xas_ref'], 'source_ref': source_ref,
                    'initial_settings': {key: prior[key] for key in (*fields, 'kmax')},
                    'actual_settings': {key: settings.get(key) for key in (*fields, 'kmax')},
                    'missing_metadata_fields': missing_fields, 'recompute_settings': recompute_settings,
                    'checks': checks, 'source_chi_sha256': digest(source['chi']),
                    'derived_chi_sha256': digest(derived['chi']), 'recomputed_arrays': recomputed})
            result['tasks'][task]['transforms'] = transforms
            result['checks']['T3_transform_science'] = bool(transforms) and all(all(r['checks'].values()) for r in transforms)
    result['passed'] = all(result['checks'].values())
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runs', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    result = validate(args.runs)
    args.out.write_text(json.dumps(result, indent=2, ensure_ascii=False) + '\n')
    print(json.dumps({'passed': result['passed'], 'checks': result['checks']}))
    raise SystemExit(0 if result['passed'] else 1)
