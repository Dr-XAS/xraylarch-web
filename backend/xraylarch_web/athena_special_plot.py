"""Read-only Quad, Bi-Quad and k/q diagnostics from processed Larch data.

Panel membership and display modifiers follow the pinned Demeter templates.
The Bi-Quad template's use of the first group's shift for the second group is
intentionally corrected: each spectrum retains its own calibrated axis.
"""
from typing import Literal

import numpy as np
from larch import Group
from pydantic import BaseModel, ConfigDict, Field, model_validator

from .athena_science import AthenaParameters, ScientificError, _pair, _transforms


class SpecialPlotOptions(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True, allow_inf_nan=False)
    version: int = Field(ge=0)
    view: Literal['quad', 'biquad', 'kq'] = 'quad'
    group_ids: list[str] = Field(min_length=1, max_length=2)
    kweight: float | None = Field(default=None, ge=0, le=4)
    q_component: Literal['re', 'im', 'mag'] = 're'

    @model_validator(mode='after')
    def scope(self):
        if len(set(self.group_ids)) != len(self.group_ids):
            raise ValueError('Select distinct groups.')
        if len(self.group_ids) != (2 if self.view == 'biquad' else 1):
            raise ValueError('Bi-Quad needs exactly two groups; Quad and k/q need one.')
        return self


def _arrays(group, weight, notes):
    result = group.get('result') or {}
    if group.get('processing_error') or not result.get('effective', {}).get('exafs'):
        raise ScientificError(f'{group["label"]}: apply valid EXAFS processing parameters before making this plot.')
    a = dict(result['arrays'])
    k, chi = _pair(a.get('k', []), a.get('chi', []), name=group['label'], minimum=4)
    if np.any(k < 0):
        raise ScientificError('The processed k grid must be nonnegative.')
    if weight != result['effective']['kweight']:
        p = AthenaParameters.model_validate({**group['parameters'], 'kweight': weight})
        probe = Group(k=k, chi=chi)
        # AUTOBK's measured support can extend past the last uniform k bin.
        probe.autobk_details = Group(kmax=result['effective'].get('bkg_kmax') or k[-1])
        _transforms(probe, p, {}, notes)
        for key in ('r', 'chir_mag', 'chir_re', 'q', 'chiq_re', 'chiq_im', 'chiq_mag'):
            a[key] = getattr(probe, key).tolist()
    a['weighted_chi'] = (chi * k ** weight).tolist()
    return a


def special_plot(groups, options):
    if [g['id'] for g in groups] != options.group_ids:
        raise ScientificError('The plot groups do not match the requested selection.')
    if options.view != 'kq' and any(g['data_type'] in ('chi', 'xanes', 'detector') for g in groups):
        raise ScientificError('Quad and Bi-Quad need energy spectra with EXAFS processing, including all four plot spaces.')
    weight = groups[0]['parameters']['kweight'] if options.kweight is None else options.kweight
    if not np.isfinite(weight) or not 0 <= weight <= 4:
        raise ScientificError('Choose a finite plot k weight from zero to four.')
    notes = []
    arrays = [_arrays(g, weight, notes) for g in groups]
    panels = []

    def panel(ident, title, x_label, y_label, specs, x_range=None):
        curves = []
        for index, xkey, ykey, label in specs:
            g, a = groups[index], arrays[index]
            x, y = _pair(a.get(xkey, []), a.get(ykey, []), name=f'{g["label"]} · {label}')
            if xkey == 'energy':
                expected = np.asarray(g['energy']) + g['parameters']['energy_shift']
                if x.shape != expected.shape or not np.allclose(x, expected, rtol=0, atol=1e-9):
                    raise ScientificError(f'{g["label"]}: processed energy is out of date. Apply parameters and retry.')
            if options.view == 'kq':
                multiplier, offset = float(g['multiplier']), float(g['offset'])
                if not np.isfinite([multiplier, offset]).all():
                    raise ScientificError('The group needs finite plot scale and offset values.')
                y = (multiplier or 1.) * y + offset
                if multiplier == 0 and not notes:
                    notes.append('Native Athena plotting treats a zero plot scale as one.')
            if not np.isfinite(y).all():
                raise ScientificError('Plot scaling overflowed. Reduce the group multiplier or plot k weight.')
            curves.append(dict(group_id=g['id'], name=f'{g["label"]} · {label}', x=x.tolist(), y=y.tolist()))
        panels.append(dict(id=ident, title=title, x_label=x_label, y_label=y_label, x_range=x_range, curves=curves))

    k_label = 'χ(k)' if weight == 0 else f'k^{weight:g} χ(k)'
    if options.view == 'kq':
        component = {'re': 'Re', 'im': 'Im', 'mag': '|χ(q)|'}[options.q_component]
        q_label = component if options.q_component == 'mag' else f'{component}[χ(q)]'
        panel('kq', 'k / q comparison', 'Wavenumber (Å⁻¹)', f'{k_label} / {q_label}',
              [(0, 'k', 'weighted_chi', k_label), (0, 'q', f'chiq_{options.q_component}', q_label)])
        notes.append('χ(q) already contains the forward-transform k weight; it is not weighted again on the q axis.')
    else:
        biquad = options.view == 'biquad'
        if biquad:
            e0 = float(groups[0]['result']['effective']['e0'])
            panel('E', 'Energy', 'Energy (eV)', 'Flattened μ(E)',
                  [(i, 'energy', 'flat', 'Flattened μ(E)') for i in range(2)], [e0 - 60, e0 + 180])
            if groups[0]['parameters']['energy_shift'] != groups[1]['parameters']['energy_shift']:
                notes.append('Each spectrum uses its own calibrated energy shift. This corrects the native Bi-Quad template, which applies the first group’s shift to both spectra.')
        else:
            panel('E', 'Energy', 'Energy (eV)', 'μ(E)',
                  [(0, 'energy', key, label) for key, label in
                   [('bkg', 'Background'), ('mu', 'μ(E)'), ('pre_edge', 'Pre-edge'), ('post_edge', 'Post-edge')]])
        panel('k', 'k space', 'k (Å⁻¹)', k_label,
              [(i, 'k', 'weighted_chi', k_label) for i in range(len(groups))])
        panel('R', 'R space', 'R (Å)', 'χ(R)',
              [(i, 'r', 'chir_mag', '|χ(R)|') for i in range(len(groups))] +
              ([] if biquad else [(0, 'r', 'chir_re', 'Re[χ(R)]')]))
        panel('q', 'Back-transform', 'q (Å⁻¹)', 'Re[χ(q)]',
              [(i, 'q', 'chiq_re', 'Re[χ(q)]') for i in range(len(groups))])
        notes.append('Quad and Bi-Quad use unscaled spectra without group plot offsets, following Athena’s templates.')
    notes.append('Plot k weight applies to every displayed group. Larch recalculates the transforms when this differs from the saved weight; saved processing and project data stay unchanged.')
    return dict(group_ids=options.group_ids, kweight=weight, panels=panels, notes=notes)
