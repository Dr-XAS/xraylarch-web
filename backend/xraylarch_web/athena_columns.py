"""Athena's full-data column arithmetic and import suggestions.

Oracle: Demeter Data/Mu.pm put_data/guess_columns/guess_units and
UI/Athena/ColumnSelection.pm, revision 06afc8da08a5a7d5a26ee14992170fcf5dc67406.
"""
import re

import numpy as np

from .errors import WebInputError


def fail(message):
    raise WebInputError("athena_invalid", message, recovery="Check the selected columns and measurement mode, then retry.")


def suggest_columns(columns, filename):
    """Suggest choices only; explicit selections and matching-batch reuse win."""
    units = {}
    for c in columns:
        values = c['preview'][:5]
        explicit = str(c.get('unit') or '').lower()
        if explicit in ('ev', 'kev'):
            units[c['column_id']] = 'keV' if explicit == 'kev' else 'eV'
        elif len(values) == 5 and all(a < b for a, b in zip(values, values[1:])):
            units[c['column_id']] = 'eV' if values[0] > 100 else 'keV'
        else:
            units[c['column_id']] = None
    def match(pattern):
        return next((c['column_id'] for c in columns if re.search(pattern, c['name'], re.I)), None)
    energy = next((c['column_id'] for c in columns if c.get('role_hint') == 'energy'), columns[0]['column_id'])
    # FEFF xmu.dat contains both mu(E) and chi(k). Its absolute photon energy
    # is omega, while e is relative to the Fermi level: recognize it before
    # the generic k/chi pair, which otherwise imports the wrong representation.
    if [c['name'].lower() for c in columns] == ['omega', 'e', 'k', 'mu', 'mu0', 'chi']:
        energy = columns[0]['column_id']
        units[energy] = 'eV'
        return {'energy_column': energy, 'numerator': [columns[3]['column_id']],
                'denominator': None, 'mode': 'mu', 'units': 'eV', 'data_type': 'xmudat'}, units
    chi, k = match(r'^chi(?:k)?$'), match(r'^k$')
    if filename.lower().endswith('.chi') or (chi and k):
        return {'energy_column': k or energy, 'numerator': [chi or columns[min(1, len(columns) - 1)]['column_id']],
                'denominator': None, 'mode': 'mu', 'units': 'eV', 'data_type': 'chi'}, units
    # A named, already computed mu column takes priority over detector guesses.
    mu = match(r'^(?:xmu|mu)$')
    i0, it, fluorescence = match(r'i(0$|o)'), match(r'^i($|1$|t)'), match(r'i[fy]')
    if mu:
        numerator, denominator, mode = [mu], None, 'mu'
    elif it:
        numerator, denominator, mode = [i0] if i0 else [], it, 'transmission'
    elif fluorescence:
        numerator, denominator, mode = [fluorescence], i0, 'fluorescence'
    else:
        numerator, denominator, mode = [columns[1]['column_id']] if len(columns) > 1 else [], None, 'mu'
    return {'energy_column': energy, 'numerator': numerator, 'denominator': denominator,
            'mode': mode, 'units': units[energy] or 'eV', 'data_type': 'mu'}, units


def map_columns(arrays, request):
    count = len(next(iter(arrays.values())))
    def column(key, *, constant=True):
        if constant and key == '1':
            return np.ones(count)
        if key not in arrays:
            fail("Choose columns from the inspected file.")
        return np.asarray(arrays[key], dtype=float)

    def summed(keys, name):
        if len(set(keys)) != len(keys):
            fail(f"Select each {name} channel only once.")
        with np.errstate(over='ignore', invalid='ignore'):
            values = np.sum([column(key) for key in keys], axis=0) if keys else np.ones(count)
        if not np.isfinite(values).all():
            fail(f"The {name} sum produces non-finite values; check signal magnitudes.")
        return values

    x = column(request.energy_column, constant=False) * (1000 if request.units == 'keV' and request.data_type != 'chi' else 1)
    mode = 'mu' if request.data_type == 'chi' else request.mode
    scale = 1. if request.data_type == 'chi' else request.signal_multiplier * (-1 if request.invert else 1)
    denominator_keys = request.denominator if isinstance(request.denominator, list) else [request.denominator] if request.denominator else []
    denominator = summed(denominator_keys, 'denominator') if mode != 'mu' else None
    warnings = []

    def signal(numerator, denominator, logarithm=False, reference=False):
        divisor = np.ones(count) if denominator is None else denominator
        if np.any(divisor == 0):
            fail("Reference denominator contains zero counts." if reference else "The denominator contains zero detector counts.")
        with np.errstate(over='ignore', divide='ignore', invalid='ignore'):
            out = numerator / divisor
            if logarithm:
                if np.any(out == 0):
                    fail("Natural log requires a nonzero detector ratio at every point.")
                if np.any(out < 0):
                    warnings.append(('Reference' if reference else 'Sample') + ': natural log uses the absolute detector ratio, as in Athena. Check detector polarity.')
                # Native Athena explicitly evaluates ln(abs(numerator/denominator)).
                out = np.log(np.abs(out))
        if not np.isfinite(out).all():
            fail("Selected detector arithmetic produces non-finite values; check signal magnitudes and denominators.")
        return out

    if len(set(request.numerator)) != len(request.numerator):
        fail('Select each numerator channel only once.')
    selections = [[key] for key in request.numerator] if request.individual_channels and request.numerator else [request.numerator]
    samples = []
    for keys in selections:
        numerator = summed(keys, 'numerator')
        with np.errstate(over='ignore', invalid='ignore'):
            y = scale * signal(numerator, denominator, mode == 'transmission')
        if not np.isfinite(y).all():
            fail('The multiplicative constant produces non-finite values; reduce it or rescale detector counts.')
        samples.append({'columns': keys, 'numerator': numerator, 'y': y})
    reference = None
    if request.reference_numerator or request.reference_denominator:
        if request.data_type == 'chi':
            fail('Reference detector channels need an energy axis; they cannot be imported with chi(k).')
        a, b = column(request.reference_numerator or '1'), column(request.reference_denominator or '1')
        reference = {'numerator': a, 'denominator': b, 'y': signal(a, b, request.reference_log, True)}
    order = np.argsort(x, kind='stable') if request.sort else np.arange(len(x))
    return {'x': x[order], 'samples': samples, 'denominator': denominator, 'reference': reference,
            'order': order, 'mode': mode, 'scale': scale, 'warnings': list(dict.fromkeys(warnings))}


def preview_trace(x, y, *, label, role, ident, limit=2400):
    # Arithmetic/validation always see all points; plot buckets preserve glitches.
    if len(x) <= limit:
        indices = np.arange(len(x))
    else:
        edges = np.linspace(1, len(x) - 1, (limit - 2) // 2 + 1, dtype=int)
        selected = [0, len(x) - 1]
        for lo, hi in zip(edges[:-1], edges[1:]):
            if hi > lo:
                selected.extend([lo + int(np.argmin(y[lo:hi])), lo + int(np.argmax(y[lo:hi]))])
        indices = np.unique(selected)
    return {'id': ident, 'label': label, 'role': role, 'x': x[indices].tolist(), 'y': y[indices].tolist()}
