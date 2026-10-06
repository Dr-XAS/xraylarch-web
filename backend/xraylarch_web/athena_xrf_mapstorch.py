"""The MAPS line model, as MapsTorch implements it, as a second fitting engine.

MapsTorch (https://pypi.org/project/mapstorch/) is a differentiable PyTorch
re-implementation of the spectral model used by MAPS, the XRF fitting program
of the Advanced Photon Source. It draws the same objects as Larch's model --
Gaussian lines of a Fano-broadened width, a low-energy tail, a step, an
elastic peak and a Compton peak -- but from a different line table, with a
different width law and a different tail parameterisation, and with the K, L
and M lines of an element merged into one component each.

Two engines are worth having because a disagreement between them is
informative in a way that a single fit is not: a second spectral model, drawn
from an independent line table, says how sensitive the extracted edge step is
to the model. It does not bound the error of either.

MapsTorch is an alternative spectral model, not the same model with other peak
shapes: its line tables, its detector response (Fano law and tails), its
response under the continuum and its escape treatment all differ from Larch's.
What this module keeps from the Larch engine is everything around the model:
the line families fitted, the incident energies their gates open at, the
continuum family, the Poisson-weighted amplitude solve, the deadtime and I0
handling, the normalisation and every quality check, reached through the same
helpers. MapsTorch is used for one thing: the unit-amplitude columns. The
detector thickness and the scatter tail length do not enter its columns.

What it does not carry is detector escape; see ESCAPE_NOTE below.
docs/athena-xrf-mapstorch.md records the method and the failure each test is
named for.
"""
from __future__ import annotations

import numpy as np
from lmfit import Parameters

from .athena_science import ScientificError
from .athena_xrf_xas import (channel_energy, continuum_shapes, gate_plan,
                             reference_energy, solve_amplitudes, subshell_edges)

# MapsTorch names a component for a whole line family: 'Mn' is every K line of
# manganese, 'Pb_L' every L line, 'Au_M' every M line. Larch's columns here
# are split by the subshell the line falls from, so a family maps onto the
# lowest edge that feeds it -- the one whose crossing brings the family in.
FAMILIES = (('K', 'K', ''), ('L', 'L3', '_L'), ('M', 'M5', '_M'))

# The shape parameters stage A fits, with their bounds. Where a parameter
# means the same thing as one of the Larch engine's it carries the same name,
# so the two calibration reports can be read side by side.
MAPSTORCH_PARAMETERS = (
    ('cal_offset', -0.5, 0.5),            # ENERGY_OFFSET, keV
    ('cal_slope', 1e-4, 0.1),             # ENERGY_SLOPE, keV per channel
    ('det_noise', 1e-3, 0.5),             # FWHM_OFFSET, keV FWHM at zero energy
    ('det_fano', 1e-6, 1e-2),             # FWHM_FANOPRIME
    ('peak_step', 0.0, 0.5),              # F_STEP_OFFSET
    ('peak_tail', 0.0, 2.0),              # F_TAIL_OFFSET
    ('kb_tail', 0.0, 2.0),                # KB_F_TAIL_OFFSET
    ('compton_angle', 60.0, 175.0),       # COMPTON_ANGLE, degrees
    ('compton_sigmax', 1.0, 12.0),        # COMPTON_FWHM_CORR
    ('compton_tail', 0.0, 8.0),           # COMPTON_F_TAIL
    ('compton_hi_tail', 0.0, 8.0),        # COMPTON_HI_F_TAIL
)

ESCAPE_NOTE = (
    'Detector escape peaks are not modelled by this engine. Larch scales them '
    'by an escape fraction computed from the detector material and thickness, '
    'and MapsTorch takes a bare factor instead; the two numbers are not the '
    'same quantity, so escape_amp is not carried across.')

# The detector fluorescence line an escaping photon leaves with, keV. Above
# the top of the fit window there is no parent intensity for escape to move,
# so below these the omission above is exactly zero rather than approximately.
ESCAPE_KEV = {'Si': 1.73998, 'Ge': 9.886}


def available() -> bool:
    """Whether this server can run the MapsTorch engine at all."""
    import importlib.util

    return (importlib.util.find_spec('mapstorch') is not None
            and importlib.util.find_spec('torch') is not None)


def _mapstorch():
    try:
        import torch
        from mapstorch import default, map as model
    except ImportError as exc:
        raise ScientificError(
            'The MapsTorch fitting engine is not installed on this server. '
            'Choose the Larch engine instead.') from exc
    return torch, model, default


class MapsTorchFitter:
    """Builds the MAPS basis and solves one detector's spectra, like Fitter."""

    def __init__(self, channels, incident_kev, target, matrix_elements, options):
        self._torch, self._model, self._default = _mapstorch()
        self.channels = np.asarray(channels, dtype=float)
        self.incident = np.asarray(incident_kev, dtype=float)
        self.target = target
        self.symbols = [target, *matrix_elements]
        self.options = options
        low, high = float(self.incident.min()), float(self.incident.max())

        self.notes = []
        top = channel_energy(self.channels[-1], options.cal_offset, options.cal_slope)
        if options.escape_amp > 0:
            escape = ESCAPE_KEV.get(options.detector_material, 0.0)
            if top > escape:
                # Loud only where the omission could show: a parent line has to
                # sit above the escape energy for an escape peak to exist.
                self.notes.append(ESCAPE_NOTE)

        edges = {symbol: subshell_edges(symbol) for symbol in self.symbols}
        opened = {target, *options.open_gates}
        self.reference_kev = reference_energy(edges, opened, low, high)

        catalogue = {'K': set(self._default.default_K_lines),
                     'L': set(self._default.default_L_lines),
                     'M': set(self._default.default_M_lines)}
        self._component = {}
        for symbol in self.symbols:
            for family, level, suffix in FAMILIES:
                if symbol + suffix in catalogue[family] and level in edges[symbol]:
                    self._component[(symbol, level)] = symbol + suffix
        if not self._component:
            raise ScientificError(
                'MapsTorch has no line table for ' + ', '.join(self.symbols) +
                '. Choose the Larch engine, or fit different elements.')

        # Fixed here, once, from the starting calibration, for the same reason
        # the Larch engine fixes its column set: a fitted calibration moves the
        # window by a channel or so, and the basis may not change shape
        # underneath the amplitude solve when it does.
        start = self.initial_parameters().valuesdict()
        columns = self._element_columns(start)
        present = [key for key, column in columns.items() if np.any(column > 0)]
        self.keys, self.gates, self.target_keys = gate_plan(
            edges, self.symbols, target, opened, low, high, present)

        self.names = [f'{symbol} {level}' for symbol, level in self.keys]
        self.names += ['elastic', 'compton']
        self.background_terms = (0 if options.background == 'none'
                                 else options.background_terms)
        self.names += [f'continuum {term + 1}' for term in range(self.background_terms)]
        self.target_indices = [self.keys.index(key) for key in self.target_keys]
        self.free_mask = np.zeros(len(self.names), dtype=bool)
        self.free_mask[self.target_indices] = True

    def initial_parameters(self):
        """MapsTorch's own starting values, with the three the request sets."""
        shipped = self._default.default_param_vals
        start = dict(cal_offset=self.options.cal_offset,
                     cal_slope=self.options.cal_slope,
                     det_noise=shipped['FWHM_OFFSET'],
                     det_fano=shipped['FWHM_FANOPRIME'],
                     # MapsTorch ships a zero step, which is a bound here; the
                     # Larch engine's small positive start keeps it off one.
                     peak_step=1e-3,
                     peak_tail=shipped['F_TAIL_OFFSET'],
                     kb_tail=shipped['KB_F_TAIL_OFFSET'],
                     compton_angle=self.options.compton_angle,
                     compton_sigmax=shipped['COMPTON_FWHM_CORR'],
                     compton_tail=shipped['COMPTON_F_TAIL'],
                     compton_hi_tail=shipped['COMPTON_HI_F_TAIL'])
        params = Parameters()
        for name, low, high in MAPSTORCH_PARAMETERS:
            value = float(np.clip(start[name], low, high))
            params.add(name, value=value, min=low, max=high)
        return params

    # ------------------------------------------------------------- the basis

    def _params(self, values, incident_kev):
        """MapsTorch's parameter dictionary, as tensors, for one or many points.

        Every amplitude is set to zero because MapsTorch holds them as base-ten
        logarithms: 10**0 is one, so each component comes out at unit amplitude
        and the linear solve outside can scale it.
        """
        torch = self._torch
        tensor = lambda x: torch.as_tensor(x, dtype=torch.float64)  # noqa: E731
        params = {name: tensor(float(value))
                  for name, value in self._default.default_param_vals.items()}
        params.update(
            ENERGY_OFFSET=tensor(values['cal_offset']),
            ENERGY_SLOPE=tensor(values['cal_slope']),
            # Held at zero: the panel, the viewer and the Larch engine all
            # read the axis as offset plus slope times channel, and a fitted
            # quadratic term would make the two engines disagree about what
            # the calibration of the same detector is.
            ENERGY_QUADRATIC=tensor(0.0),
            FWHM_OFFSET=tensor(values['det_noise']),
            FWHM_FANOPRIME=tensor(values['det_fano']),
            F_STEP_OFFSET=tensor(values['peak_step']),
            F_TAIL_OFFSET=tensor(values['peak_tail']),
            KB_F_TAIL_OFFSET=tensor(values['kb_tail']),
            COMPTON_ANGLE=tensor(values['compton_angle']),
            COMPTON_FWHM_CORR=tensor(values['compton_sigmax']),
            COMPTON_F_TAIL=tensor(values['compton_tail']),
            COMPTON_HI_F_TAIL=tensor(values['compton_hi_tail']),
            COHERENT_SCT_ENERGY=tensor(incident_kev),
            COHERENT_SCT_AMPLITUDE=tensor(0.0),
            COMPTON_AMPLITUDE=tensor(0.0),
        )
        return params

    def _element_columns(self, values):
        """One unit-amplitude column per line family, at the reference energy.

        MapsTorch gates each line itself, against the incident energy in
        COHERENT_SCT_ENERGY: below an edge the lines it feeds come out as
        zeros. That gate cannot be used here. The target's column has to stay
        in the model below its own edge, or the pre-edge of the extracted
        mu(E) would be zero by construction and the null test that checks it
        would pass without measuring anything. So the columns are built once
        at the reference energy, which clears the edges in play, and the
        per-point gating is applied afterwards -- the same gates, from the
        same table, as the Larch engine's.
        """
        energy = channel_energy(self.channels, values['cal_offset'], values['cal_slope'])
        ev = self._torch.as_tensor(energy, dtype=self._torch.float64)
        params = self._params(values, self.reference_kev)
        columns = {}
        for key, component in self._component.items():
            params[component] = self._torch.as_tensor(0.0, dtype=self._torch.float64)
            lines = self._default.default_energy_consts[component]
            groups = {key: lines}
            if key == (self.target, 'K'):
                # Match the extraction's K-alpha observable, without changing
                # MapsTorch's own line energies, strengths or response shapes.
                groups = {key: [line for line in lines if not line.ptype.startswith('Kb')],
                          (self.target, 'Kbeta'): [line for line in lines if line.ptype.startswith('Kb')]}
            for family, subset in groups.items():
                spectrum = self._model.model_elem_spec(
                    params, component, ev, True, True, device='cpu',
                    e_consts={component: subset})
                columns[family] = np.nan_to_num(spectrum.numpy(), nan=0.0,
                                                posinf=0.0, neginf=0.0)
        return columns

    def basis(self, values, indices):
        energy = channel_energy(self.channels, values['cal_offset'], values['cal_slope'])
        columns = self._element_columns(values)
        incident = self.incident[indices]
        basis = np.zeros((len(indices), len(self.names), energy.size))
        for position, key in enumerate(self.keys):
            live = incident > self.gates[key]
            basis[:, position, :] = np.where(live[:, None], columns[key][None, :], 0.0)

        # The scatter peaks move with the incident energy, so these are built
        # per point -- batched, which MapsTorch supports by broadcasting a
        # per-spectrum incident energy over the channel axis.
        torch = self._torch
        ev = torch.as_tensor(energy, dtype=torch.float64)
        ev = ev[None, :].expand(incident.size, energy.size)
        params = self._params(values, incident)
        gain = params['ENERGY_SLOPE']
        elastic = self._model.elastic_peak(params, ev, gain).numpy()
        compton = self._model.compton_peak(params, ev, gain, True, True).numpy()
        basis[:, len(self.keys), :] = np.nan_to_num(elastic, nan=0.0, posinf=0.0,
                                                    neginf=0.0)
        basis[:, len(self.keys) + 1, :] = np.nan_to_num(compton, nan=0.0, posinf=0.0,
                                                        neginf=0.0)

        if self.background_terms:
            # The same continuum family as the Larch engine, without the
            # detector absorbance Larch multiplies onto it: MapsTorch's model
            # carries no such factor, and a column that went through one while
            # the lines beside it did not would be the wrong shape.
            basis[:, -self.background_terms:, :] = continuum_shapes(
                energy, self.background_terms)[None, :, :]
        return energy, basis

    def solve(self, values, indices, counts, *, variance=None):
        energy, basis = self.basis(values, indices)
        solved = solve_amplitudes(basis, counts, ridge=self.options.ridge,
                                  free_mask=self.free_mask, variance=variance)
        return dict(solved, energy=energy, basis=basis)

    def target_area(self, solved):
        """The target signal, using K-alpha alone when a K edge is measured."""
        return solved['areas'][:, self.target_indices].sum(axis=1)
