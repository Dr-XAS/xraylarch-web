"""Calibration references for metal foils, separate from atomic E0 tables.

Kraft, Stümpel, Becker and Kuetgens, Rev. Sci. Instrum. 67, 681–687
(1996), Table I, E1 (p. 686), https://doi.org/10.1063/1.1146657.
These are the authors' measured energies, not the older E2 column.
Section IV defines the edge as the lowest-energy inflection point.
"""

from .athena_e0 import atomic_edge


# eV; retain the E1 precision. Unlisted element/edge pairs use XrayDB/Elam.
_KRAFT_E1 = {
    ('V', 'K'): 5463.76,
    ('Cr', 'K'): 5989.02,
    ('Mn', 'K'): 6537.67,
    ('Fe', 'K'): 7110.75,
    ('Co', 'K'): 7708.78,
    ('Ni', 'K'): 8331.49,
    ('Cu', 'K'): 8980.48,
    ('Zn', 'K'): 9660.76,
    ('Y', 'K'): 17036.62,
    ('Zr', 'K'): 17995.88,
    ('Nb', 'K'): 18982.97,
    ('Mo', 'K'): 20000.36,
    ('Rh', 'K'): 23222.0,
    ('Pd', 'K'): 24352.6,
    ('Ag', 'K'): 25515.6,
    ('Cd', 'K'): 26713.3,
    ('In', 'K'): 27940.4,
    ('Sn', 'K'): 29200.4,
    ('Sb', 'K'): 30490.5,
    ('Hf', 'L3'): 9558.29,
    ('Pt', 'L3'): 11562.76,
    ('Au', 'L3'): 11919.70,
    ('Pb', 'L3'): 13035.07,
    ('Hf', 'L2'): 10735.88,
    ('Pt', 'L2'): 13271.90,
    ('Au', 'L2'): 13734.20,
    ('Pb', 'L2'): 15199.0,
    ('Hf', 'L1'): 11268.59,
    ('Pt', 'L1'): 13880.7,
    ('Au', 'L1'): 14355.3,
    ('Pb', 'L1'): 15858.0,
}


def calibration_target(element, edge):
    """Return the preferred reference and its provenance; validate via XrayDB."""
    atom = atomic_edge(element, edge)
    energy = _KRAFT_E1.get((atom['element'], atom['edge']))
    if energy is None:
        return dict(atom, source='xraydb', citation='XrayDB / Elam', doi=None)
    return dict(
        atom, energy=energy, source='kraft1996', table='I', column='E1',
        citation='S. Kraft, J. Stümpel, P. Becker and U. Kuetgens, '
                 'Rev. Sci. Instrum. 67, 681–687 (1996), Table I, E₁.',
        doi='10.1063/1.1146657',
        convention='Metal foil; lowest-energy inflection point.',
    )
