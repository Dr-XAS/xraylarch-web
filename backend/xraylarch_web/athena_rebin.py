"""Demeter's Larch three-region rebin, including PDL boxcar semantics."""
import numpy as np
from typing import Literal
from larch.math import interp, remove_dups
from pydantic import BaseModel, ConfigDict, Field, model_validator

from .athena_science import ScientificError, _edge

# Constants.pm in Demeter 06afc8da; use its grid constant, not a rounded 3.81.
DEMETER_ETOK = 0.262468292
MAX_REBIN_POINTS = 100_000


class ImportRebin(BaseModel):
    model_config = ConfigDict(extra='forbid', allow_inf_nan=False)
    e0: float | None = Field(default=None, strict=True, gt=0, le=1e7)
    emin: float = Field(default=-30., strict=True)
    emax: float = Field(default=50., strict=True)
    pre: float = Field(default=10., strict=True, gt=0)
    xanes: float = Field(default=.5, strict=True, gt=0)
    exafs: float = Field(default=.05, strict=True, gt=0)
    width: int = Field(default=3, strict=True, ge=1, le=11)


class PostRebin(ImportRebin):
    plot_space: Literal['E', 'k'] = 'E'
    skip_ineligible: bool = Field(default=False, strict=True)

    @model_validator(mode='before')
    @classmethod
    def old_grid_names(cls, values):
        # Existing web clients used these names for the same region controls.
        if isinstance(values, dict):
            values = dict(values)
            for old, new in [('pre2', 'emin'), ('exafs1', 'emax'), ('pre_step', 'pre'),
                             ('xanes_step', 'xanes'), ('exafs_kstep', 'exafs')]:
                if old in values:
                    if new in values:
                        raise ValueError(f'Supply {new} once, without its older alias {old}.')
                    values[new] = values.pop(old)
        return values


def rebin_unavailable(group):
    if group['data_type'] == 'detector':
        return 'Three-region rebinning needs an absorption edge; correct the detector data type first.'
    if group['data_type'] == 'chi':
        return 'Three-region rebinning requires energy data, not chi(k).'
    source = group.get('source', {})
    native = source.get('native', {}).get('args', {})
    if source.get('rebin') or source.get('operation') == 'rebin' or str(native.get('rebinned', '0')).lower() in ('1', 'true'):
        return 'This group is already rebinned. Choose its original source to change the grid.'
    return None


def grid_e0(x, y, request):
    """Grid construction precedes final import normalization and alignment."""
    if request.rebin.e0 is not None:
        return request.rebin.e0, 'manual'
    if request.edge_policy is not None:
        from .athena_import_policy import initialize_import
        prepared = initialize_import(x, y, policy=request.edge_policy.model_dump(),
                                     data_type=request.data_type, _for_rebin=True)
        return prepared['e0_selection']['e0'], 'enforced-fraction'
    return rebin_edge(x, y), 'derivative'


def rebin_edge(x, y):
    # find_e0 internally adjusts duplicates on a temporary axis. Do the same
    # for _edge's short-scan derivative fallback, never for retained/grid data.
    return _edge(remove_dups(x) if len(x) < 100 else x, y)


class RebinPlan:
    def __init__(self, energy, choice: ImportRebin, e0, method='manual'):
        x = np.asarray(energy, dtype=float)
        if x.ndim != 1 or not 10 <= len(x) <= 250_000 or not np.isfinite(x).all() or np.any(np.diff(x) < 0) or np.count_nonzero(np.diff(x)) < 9:
            raise ScientificError('Rebinning requires 10–250,000 finite, nondecreasing energy values with at least ten distinct energies. Sort the rows first.')
        if not np.isfinite(e0) or not 0 < x[0] < e0 < x[-1] <= 1e7:
            raise ScientificError('Rebin E₀ must lie inside the measured positive energy range in eV.')
        emin, emax = sorted((choice.emin, choice.emax))
        lo, hi = e0 + emin, e0 + emax
        if not x[0] < lo < hi < x[-1] or emax <= 0:
            raise ScientificError('Rebin boundaries must be distinct and inside the measured range; the EXAFS boundary must be above E₀. Adjust the edge region or grid E₀.')
        k0, k1 = np.sqrt(emax * DEMETER_ETOK), np.sqrt((x[-1] - e0) * DEMETER_ETOK)
        if x[0] + choice.pre <= x[0] or lo + choice.xanes <= lo or k0 + choice.exafs <= k0:
            raise ScientificError('Rebin steps are below numerical precision at this energy. Increase the grid steps.')
        estimate = (lo - x[0]) / choice.pre + (hi - lo) / choice.xanes + (k1 - k0) / choice.exafs + 4
        if not np.isfinite(estimate) or estimate > MAX_REBIN_POINTS + 2:
            raise ScientificError('Rebin grid exceeds 100,000 points. Increase the grid steps.')
        grid = []
        # Repeat native scalar additions to preserve region endpoint behavior.
        ee = float(x[0])
        while ee < lo:
            grid.append(ee); ee += choice.pre
        ee = lo
        while ee < hi:
            grid.append(ee); ee += choice.xanes
        ee, kk = hi, k0
        while ee < x[-1]:
            grid.append(ee); kk += choice.exafs; ee = kk * kk / DEMETER_ETOK + e0
        grid.append(float(x[-1]))
        self.energy = np.asarray(grid[1:-1])  # Larch rebin.tmpl trims output endpoints.
        if len(self.energy) < 10 or np.any(np.diff(self.energy) <= 0):
            raise ScientificError('Rebin grid needs at least ten distinct points. Decrease the grid steps.')
        self.x, self.width = x, choice.width
        self.details = {'method': 'demeter-larch-three-region', 'e0': float(e0), 'e0_method': method,
            'emin': emin, 'emax': emax, 'pre': choice.pre, 'xanes': choice.xanes,
            'exafs': choice.exafs, 'width': choice.width, 'etok': DEMETER_ETOK,
            'source_points': len(x), 'output_points': len(self.energy),
            'source_endpoints_removed': 2, 'output_endpoints_removed': 2,
            'boundary': 'periodic', 'warnings': []}
        if np.any(np.diff(x) == 0):
            self.details['warnings'].append('Repeated energy readings are retained during smoothing and saved in the original data. At a repeated energy, interpolation uses the last smoothed reading.')
        if choice.emin > choice.emax:
            self.details['warnings'].append('Reversed edge-region boundaries were exchanged, as in Athena.')
        if choice.width > 3:
            self.details['warnings'].append('Athena’s smoothing uses periodic endpoints. A wide kernel can mix values from opposite ends of the scan near its boundaries.')

    def apply(self, values):
        values = np.asarray(values, dtype=float)
        if values.shape != self.x.shape or not np.isfinite(values).all():
            raise ScientificError('Every rebinned signal must have one finite value per original energy point.')
        # PDL::conv1d uses offsets j - floor((width-1)/2), periodically wrapped.
        # Divide before adding, as PDL does, to avoid overflowing a finite mean.
        smoothed = np.zeros(len(values))
        with np.errstate(over='ignore', invalid='ignore'):
            for j in range(self.width):
                smoothed += np.roll(values, (self.width - 1) // 2 - j) / self.width
            out = interp(self.x[1:-1], smoothed[1:-1], self.energy, fill_value=0.)
        if not np.isfinite(out).all():
            raise ScientificError('Rebinning produced non-finite values. Rescale the selected signals.')
        return out

    def uncertainty(self, sigma):
        """Propagate independent input errors through the exact linear operator.

        Combine repeated input weights before squaring: adjacent smoothed
        samples share observations, so their interpolation is correlated.
        """
        sigma = np.asarray(sigma, dtype=float)
        if sigma.shape != self.x.shape or not np.isfinite(sigma).all() or np.any(sigma < 0):
            raise ScientificError('Input standard deviations must be finite and nonnegative at every point.')
        x = self.x[1:-1]
        # scipy's float64 linear interpolator delegates to numpy.interp:
        # at a repeated abscissa, the last observation supplies the value.
        left = np.clip(np.searchsorted(x, self.energy, side='right') - 1, 0, len(x) - 1)
        right = np.minimum(left + 1, len(x) - 1)
        dx = x[right] - x[left]
        fraction = np.divide(self.energy - x[left], dx, out=np.zeros(len(left)), where=dx != 0)
        weights_by_row = [{int(a + 1): 1 - f, **({int(b + 1): f} if a != b else {})}
                          for a, b, f in zip(left, right, fraction, strict=True)]
        exterior = (self.energy < x[0]) | (self.energy > x[-1])
        if exterior.any():
            # Larch extrapolates using a two-point polynomial, unless its
            # ordering check disables extrapolation. Evaluate the four end
            # basis vectors through Larch itself, including duplicate ends.
            indices = np.flatnonzero(exterior)
            for row in indices:
                weights_by_row[row] = {}
            for idx in (0, 1, len(x) - 2, len(x) - 1):
                basis = np.zeros(len(x)); basis[idx] = 1.
                values = interp(x, basis, self.energy, fill_value=0.)
                for row in indices:
                    weights_by_row[row][idx + 1] = values[row]
        out = []
        for row in weights_by_row:
            weights = {}
            for idx, scale in row.items():
                for j in range(self.width):
                    key = int((idx + j - (self.width - 1) // 2) % len(self.x))
                    weights[key] = weights.get(key, 0.) + scale / self.width
            out.append(np.linalg.norm([value * sigma[idx] for idx, value in weights.items()]))
        if not np.isfinite(out).all():
            raise ScientificError('Rebinned uncertainty is non-finite; rescale the input uncertainties.')
        return np.asarray(out)


def prepare_rebin(mapped, request, standard=None):
    """Shared plan construction for previews and import, without project writes."""
    if request.rebin is None:
        return
    if request.data_type == 'chi':
        raise ScientificError('Import rebinning needs an energy spectrum; chi(k) cannot use an energy-region grid.')
    from .athena_e0 import _infer_atomic, atomic_edge
    x, order = mapped['x'], mapped['order']
    for sample in mapped['samples']:
        y = sample['y'][order]
        # Validate axes before edge selection (which assumes sorted data).
        if not np.isfinite(x).all() or np.any(np.diff(x) < 0):
            raise ScientificError('Rebinning needs nondecreasing energies. Sort the rows first.')
        e0, method = grid_e0(x, y, request)
        plan = sample['rebin'] = RebinPlan(x, request.rebin, e0, method)
        if mapped['reference'] is not None:
            ry = mapped['reference']['y'][order]
            re0, rmethod = rebin_edge(x, ry), 'reference-derivative'
            if request.reference_same_element:
                sample_e0 = _edge(plan.energy, plan.apply(y))
                identity = _infer_atomic(sample_e0)
                if request.edge_policy is not None:
                    identity = request.edge_policy.model_dump()
                if standard is not None and request.preprocessing.copy_parameters:
                    identity = standard['source'].get('edge_identity') or identity
                    sample_e0 = standard['parameters']['e0'] or standard['result']['effective']['e0']
                if abs(sample_e0 - re0) > 25:
                    atom = atomic_edge(identity['element'], identity['edge'])
                    if x[0] < atom['energy'] < x[-1]:
                        re0, rmethod = atom['energy'], 'reference-atomic-safeguard'
            # References find their own E0, even when a sample grid E0 was typed.
            sample['reference_rebin'] = RebinPlan(x, request.rebin, re0, rmethod)
