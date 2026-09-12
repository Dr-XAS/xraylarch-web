"""Construct labelled analytic probes. These are not beamline acquisitions."""
from pathlib import Path
import numpy as np


def generate(folder):
    energy = np.arange(1493., 1704.)
    distance = energy - 1603
    base = 10000 + 2*distance + .04*distance**2
    i0 = base + 600/(1 + np.exp(-distance/.4))
    mu = .1 + .9/(1 + np.exp(-(energy-1559)/1.5))
    i1 = base*np.exp(-mu)
    for mode, header, count in [('trans', 'Transmission-mode XAS', 1), ('sidrift', 'Si Drift 4-Array', 4), ('ge', 'Ge 13-array', 13)]:
        cols = [energy, energy/100, np.ones(len(energy)), i0, i1, np.log(i0/i1)]
        if count > 1:
            cols[5] = base*mu/i0
            cols += [(1 + .02*(i - (count-1)/2))*base*mu for i in range(count)]
        data = ('# BL8: X-ray Absorption Spectroscopy\n# Constructed probe, not a measured acquisition\n# ' +
            header + '\n# E0 (eV)  = 1559\nEnergy BraggAngle TimeStep I0 I1 mu\n' +
            ''.join(' '.join(f'{v:.12g}' for v in row)+'\n' for row in np.array(cols).T)).encode()
        (folder/f'constructed-bl8ar-{mode}.dat').write_bytes(data)
    table = np.array([energy] + [(i+1)*(2+np.sin(energy/100)) for i in range(1, 60)]).T
    table[:, 55] = i0; table[:, 56] = i1
    data = ('#F constructed SPEC probe\r\n#S 1 ascan energy 1493 1703 210 1\r\n#N 60\r\n#L ' +
        '  '.join(f'detector_{i:02d}' for i in range(1, 61)) + '\r\n' +
        ''.join(' '.join(f'{v:.12g}' for v in row)+'\r\n' for row in table)).encode()
    (folder/'constructed-spec-long.dat').write_bytes(data)


if __name__ == '__main__':
    generate(Path(__file__).resolve().parents[1]/'fixtures')
