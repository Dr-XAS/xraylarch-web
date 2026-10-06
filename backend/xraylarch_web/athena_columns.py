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
        values = [v for v in c['preview'][:5] if v is not None]
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


# Rows an import may drop -- non-finite values or a zero monitor in the
# selected columns, from a beam dump or an interrupted point -- before the
# file is refused instead. Losing more than this is not a glitch to step over.
MAX_DROPPED_FRACTION = .2


def _rows(indices, limit=10):
    """File data rows, one-based as a user counts them, for a message."""
    shown = ', '.join(str(int(i) + 1) for i in indices[:limit])
    return shown + (f' and {len(indices) - limit} more' if len(indices) > limit else '')


def map_columns(arrays, request, names=None):
    """Athena's column arithmetic over the rows the selected columns can use.

    Before any ratio is formed, rows are planned once for every column: rows
    whose selected columns hold a non-finite value or a zero monitor are
    dropped (named in a warning), the rest are sorted when asked, and rows
    measured at one repeated energy are averaged. Averaging the detector
    columns before dividing is the count-weighted mean of the ratio, and it
    keeps the axis strictly increasing without inventing energies. The
    returned 'arrays' hold every file column in that planned row order;
    'row_order' maps them back to the file only while they are a pure
    permutation of it.
    """
    count = len(next(iter(arrays.values())))
    if count < 8:
        fail(f"This file holds {count} data row{'' if count == 1 else 's'}; a spectrum needs at least 8.")
    def column(key, *, constant=True):
        if constant and key == '1':
            return np.ones(count)
        if key not in arrays:
            fail("Choose columns from the inspected file.")
        return np.asarray(arrays[key], dtype=float)

    unit =1000 if request.units == 'keV' and request.data_type != 'chi' else 1
    mode = 'mu' if request.data_type == 'chi' else request.mode
    scale = 1. if request.data_type == 'chi' else request.signal_multiplier * (-1 if request.invert else 1)
    denominator_keys = request.denominator if isinstance(request.denominator, list) else [request.denominator] if request.denominator else []
    if mode == 'mu':
        denominator_keys = []
    if len(set(request.numerator)) != len(request.numerator):
        fail('Select each numerator channel only once.')
    if len(set(denominator_keys)) != len(denominator_keys):
        fail("Select each denominator channel only once.")
    has_reference = bool(request.reference_numerator or request.reference_denominator)
    if has_reference and request.data_type == 'chi':
        fail('Reference detector channels need an energy axis; they cannot be imported with chi(k).')
    reference_keys = [key for key in (request.reference_numerator, request.reference_denominator) if key and key != '1']
    names = names or {}

    # Plan the rows from the selected columns only: an unused detector channel
    # that reads NaN at a beam dump must not cost the file.
    selected = [request.energy_column, *request.numerator, *denominator_keys, *reference_keys]
    keep = np.ones(count, dtype=bool)
    warnings = []
    with np.errstate(over='ignore', invalid='ignore'):
        nonfinite = [key for key in dict.fromkeys(selected) if key != '1' and not np.isfinite(column(key)).all()]
        for key in nonfinite:
            keep &= np.isfinite(column(key))
        if nonfinite:
            bad = np.flatnonzero(~keep)
            label = ', '.join(f"'{names.get(key, key)}'" for key in nonfinite)
            warnings.append(f'Dropped {len(bad)} rows where {label} is not a finite number (file data rows {_rows(bad)}).')
        monitors = []
        if denominator_keys:
            monitors.append((np.sum([column(key) for key in denominator_keys], axis=0), 'denominator'))
        if mode == 'transmission' and request.numerator:
            # Each channel saved as its own group takes its own logarithm.
            channels = [[key] for key in request.numerator] if request.individual_channels else [request.numerator]
            monitors.extend((np.sum([column(key) for key in keys], axis=0),
                             f"numerator '{names.get(keys[0], keys[0])}'" if request.individual_channels else 'numerator')
                            for keys in channels)
        if has_reference:
            monitors.append((column(request.reference_denominator or '1'), 'reference denominator'))
            if request.reference_log:
                monitors.append((column(request.reference_numerator or '1'), 'reference numerator'))
    for values, role in monitors:
        zero = keep & (values == 0)
        if zero.any():
            # A ratio needs a nonzero divisor, and its logarithm a nonzero
            # ratio: a point where the beam was lost has neither.
            keep &= ~zero
            warnings.append(f'Dropped {int(zero.sum())} rows where the {role} reads zero counts '
                            f'(file data rows {_rows(np.flatnonzero(zero))}).')
    dropped = count - int(keep.sum())
    if dropped > MAX_DROPPED_FRACTION * count:
        fail(f'{dropped} of {count} rows have non-finite values or zero detector counts in the selected columns '
             f'(file data rows {_rows(np.flatnonzero(~keep))}). Choose other columns or repair the file.')
    if keep.sum() < 2:
        fail('The selected columns leave fewer than two usable rows.')

    rows = np.flatnonzero(keep)
    x_rows = column(request.energy_column, constant=False)[rows] * unit
    order = rows[np.argsort(x_rows, kind='stable')] if request.sort else rows
    x_file = column(request.energy_column, constant=False)[order] * unit
    steps = np.diff(x_file)
    # An import rebin grid absorbs repeated energies itself, as Athena's does.
    starts = np.r_[0, np.flatnonzero(steps != 0) + 1] if getattr(request, 'rebin', None) is None else np.arange(len(order))
    merged = len(starts) < len(order)
    if merged:
        if np.any(steps < 0):
            # Only an increasing axis says which rows belong together.
            fail('The horizontal axis repeats energies and runs backwards. '
                 'Turn on sorting by energy so rows at one energy can be averaged, or choose another energy column.')
        counts = np.diff(np.r_[starts, len(order)])
        repeated = int(np.sum(counts > 1))
        warnings.append(f'Averaged {len(order) - len(starts)} rows that repeat an energy into the row before them '
                        f'({repeated} energies were measured more than once); detector columns are averaged before forming ratios.')

    def planned(values):
        values = np.asarray(values, dtype=float)[order]
        if merged:
            with np.errstate(over='ignore', invalid='ignore'):
                values = np.add.reduceat(values, starts) / counts
        return values

    planned_arrays = {key: planned(values) for key, values in arrays.items()}
    npoints = len(starts)

    def operand(key, *, constant=True):
        if constant and key == '1':
            return np.ones(npoints)
        if key not in planned_arrays:
            fail("Choose columns from the inspected file.")
        return planned_arrays[key]

    def summed(keys, name):
        with np.errstate(over='ignore', invalid='ignore'):
            values = np.sum([operand(key) for key in keys], axis=0) if keys else np.ones(npoints)
        if not np.isfinite(values).all():
            fail(f"The {name} sum produces non-finite values; check signal magnitudes.")
        return values

    def signal(numerator, divisor, logarithm=False, reference=False):
        divisor = np.ones(npoints) if divisor is None else divisor
        who = 'Reference' if reference else 'Sample'
        with np.errstate(over='ignore', divide='ignore', invalid='ignore'):
            out = numerator / divisor
            if logarithm:
                negative = np.flatnonzero(out < 0)
                if 0 < len(negative) < len(out):
                    # ln|ratio| through a change of sign passes through zero:
                    # there the curve is the detector's offset, not absorption.
                    warnings.append(f'{who}: the detector ratio changes sign ({len(negative)} of {len(out)} points are negative, '
                                    f'plotted rows {_rows(negative)}). Athena takes the log of its absolute value, which has '
                                    'no meaning as absorption near those points; check that these channels saw the beam.')
                elif len(negative):
                    warnings.append(f'{who}: every detector ratio is negative, so the natural log of its absolute value is used, '
                                    'as in Athena. A detector with inverted polarity does this; so does a dead channel '
                                    'reading only its offset. Check the plotted curve before using it.')
                # Native Athena explicitly evaluates ln(abs(numerator/denominator)).
                out = np.log(np.abs(out))
        if not np.isfinite(out).all():
            fail("Selected detector arithmetic produces non-finite values; check signal magnitudes and denominators.")
        return out

    x = x_file[starts]
    denominator = summed(denominator_keys, 'denominator') if mode != 'mu' else None
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
    if has_reference:
        a, b = operand(request.reference_numerator or '1'), operand(request.reference_denominator or '1')
        reference = {'numerator': a, 'denominator': b, 'y': signal(a, b, request.reference_log, True)}
    return {'x': x, 'samples': samples, 'denominator': denominator, 'reference': reference,
            'arrays': planned_arrays, 'row_order': order.tolist() if not merged and not dropped else None,
            'mode': mode, 'scale': scale, 'warnings': list(dict.fromkeys(warnings))}


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
