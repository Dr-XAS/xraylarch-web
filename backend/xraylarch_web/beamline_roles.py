"""Name the detector channels of a column file from their labels.

Athena guesses roles with substring patterns -- ``i(0$|o)`` for the incident
beam -- which is faithful to Demeter and stays the default everywhere. Real
beamline files defeat substrings: the APS 20-ID label ``Caldiode`` contains
"io", and so does the APS 9-BM label ``SIS Scaler Integratio``, so both files
import a diode or a scaler timer as I0 and the imported spectrum is wrong.

Splitting a label into word tokens -- ``PreKB-I0`` into ``prekb`` and ``i0``,
``I0-32`` into ``i0`` and ``32`` -- names the same channels without the
accidents. Emission lines are read the same way: ``XSP3:PbLa_Sum`` names Pb La,
``Mn_Ka_mca1`` names Mn Ka. A fluorescence channel is only suggested when the
file measures exactly one element, because a file holding eight element sums
does not say which edge was scanned.

Nothing here changes Athena's own suggestion. The beamline registry calls it
when it recognizes the beamline that wrote the file, and only then.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

import numpy as np
from xraydb import atomic_symbol, xray_edges

# Word tokens, not substrings: 'i0' survives '-32' and 'PreKB-', and no
# amount of prose can grow one by accident.
I0_TOKENS = frozenset({'i0', 'io', 'izero', 'iz', 'i_0'})
TRANSMISSION_TOKENS = frozenset({'it', 'i1', 'itrans', 'trans'})
REFERENCE_TOKENS = frozenset({'iref', 'ir', 'i2', 'iref1', 'irefer'})
# A Lytle detector is a fluorescence ion chamber by construction, so its name
# is as good a role statement as 'if' is.
FLUORESCENCE_TOKENS = frozenset({'if', 'iff', 'ifl', 'ifluo', 'ifluor', 'iy',
                                 'fluo', 'fluor', 'fluorescence', 'lytle'})
# A file may carry more than one measured absorption, so the names are tried
# in order rather than taken from whichever column happens to come first.
# 'mutrans' leads because the raw channels beside it reproduce it exactly,
# which is what the transmission suggestion already offers; a file that holds
# only 'mufluor' still gets its spectrum.
MU_ORDER = ('mutrans', 'mut', 'mu', 'xmu', 'mufluor')
MU_TOKENS = frozenset(MU_ORDER)
# XDI spells the reference absorption as one word, so it carries no separate
# 'ref' token for the mark below to find.
MU_REFERENCE_TOKENS = frozenset({'murefer', 'muref'})
REFERENCE_MARKS = frozenset({'ref', 'reference', 'refer'})

ELEMENTS = frozenset(atomic_symbol(z).lower() for z in range(1, 99))
_LINE = re.compile(r'^(k|l|m)(a|b|alpha|beta)?[0-9]?$')
_ELEMENT_LINE = re.compile(r'^([a-z]{1,2})(k|l|m)(a|b|alpha|beta)[0-9]?$')
# A detector writes the same photons several times over: the summed channel,
# the per-element dead-time corrected channels, and the raw counts. Summing
# across tiers would count the signal twice, so the most finished tier present
# wins and the rest are left for the user to pick by hand.
_RAW = frozenset({'raw', 'unc', 'uncorrected'})
_CORRECTED = frozenset({'corr', 'corrected', 'dtc', 'dtcorr'})
_TOTAL = frozenset({'sum', 'total'})
# Columns a detector's bookkeeping produces rather than a monitor measures.
_DERIVED = frozenset({'corr', 'corrected', 'dt', 'dtc', 'dtcorr'})
# Energy a beamline asked the monochromator for, as opposed to the energy it
# reached. Both are written; only the achieved one is the scan's abscissa.
_REQUESTED_TOKENS = frozenset({'requested', 'request', 'req', 'setpoint', 'set',
                               'target', 'nominal', 'demand'})
# The same words inside a run-together label. 'set' and 'req' are left out:
# as substrings they also appear in 'offset' and 'frequency'.
_REQUESTED_IN_LABEL = ('setpoint', 'requested', 'request', 'nominal', 'demand')
# A 'DTC3' column is the dead-time corrected count rate of fluorescence
# detector element 3; nothing else in an XAS file is written that way.
_DEADTIME = re.compile(r'^dtc[0-9]*$')


def tokens(name: str) -> list[str]:
    """Split a column label into lowercase word tokens."""
    return [token for token in re.split(r'[^A-Za-z0-9]+', name.lower()) if token]


def emission_line(words: list[str]) -> str | None:
    """Return the element whose emission line this label names, if any.

    Both spellings a detector writes are read: one token ('mnka', 'pbla') and
    two ('mn', 'ka'). The element symbol is checked against the periodic table
    so that 'ir' stays the reference channel rather than becoming iridium.
    """
    found = _emission(words)
    return found[0] if found else None


def _emission(words: list[str]) -> tuple[str, str] | None:
    """The element and line ('ka', 'kb', 'la', 'k') a label names, if any."""
    for index, word in enumerate(words):
        combined = _ELEMENT_LINE.fullmatch(word)
        if combined and combined.group(1) in ELEMENTS:
            return combined.group(1), combined.group(2) + combined.group(3)[0]
        line = _LINE.fullmatch(words[index + 1]) if index + 1 < len(words) else None
        if word in ELEMENTS and line:
            return word, line.group(1) + (line.group(2) or '')[:1]
    return None


def _alpha_lines(channels, words):
    """Keep the alpha-line windows when a detector also wrote beta windows.

    Below the edge a K-beta window holds mostly scattered incident photons
    (at APS 20-BM the Cr K-beta sum reads several times the K-alpha sum before
    the edge), so adding it to K-alpha adds a background that is not the
    element's fluorescence. A file with only one line keeps it.
    """
    lines = {channel: (_emission(words[channel]) or ('', ''))[1] for channel in channels}
    alpha = [channel for channel in channels if lines[channel].endswith('a')]
    return tuple(alpha) if alpha and len(alpha) < len(channels) else tuple(channels)


@dataclass(frozen=True)
class ChannelRoles:
    """The channels a beamline file offers, named by what they measure."""

    energy: str | None = None
    energy_units: str | None = None
    i0: str | None = None
    # An incident-beam column a detector system has already scaled by its own
    # live time ('XMAP12B:DT Corr I0'): the denominator that dead-time
    # corrects raw fluorescence windows, and never a transmission monitor.
    i0_corrected: str | None = None
    transmission: str | None = None
    reference: str | None = None
    mu: str | None = None
    mu_reference: str | None = None
    fluorescence: tuple[str, ...] = ()
    fluorescence_element: str | None = None
    labels: dict = field(default_factory=dict)
    # Roles whose columns are in the file but whose choice the labels do not
    # settle. This is not the same as a role the file simply does not have:
    # a declined choice is one somebody must still make, and the caller uses
    # it to decide whether leaving the import blank is an answer or a loss.
    declined: tuple[str, ...] = ()

    def named(self) -> dict:
        """The roles that were found, as column id lists, for display."""
        found = {name: value for name, value in (
            ('energy', self.energy), ('i0', self.i0), ('transmission', self.transmission),
            ('reference', self.reference), ('mu', self.mu), ('mu_reference', self.mu_reference),
        ) if value}
        if self.fluorescence:
            found['fluorescence'] = list(self.fluorescence)
        return found


def _energy_column(columns, words):
    """The column holding the scan's energy axis.

    A beamline that writes both the requested and the achieved energy offers
    two columns named 'energy'; the achieved one is the axis the spectrum was
    measured against, so a requested column is taken only when it is the only
    one on offer. Some beamlines run the two words together --
    'EnergySetpoint' beside 'EnergyReadback' -- so the same test is made
    against the whole label as well as against its separated words.
    """
    explicit = next((c['column_id'] for c in columns if c.get('role_hint') == 'energy'), None)
    if explicit:
        return explicit
    named = [c['column_id'] for c in columns if 'energy' in words[c['column_id']]]
    if not named:
        named = [c['column_id'] for c in columns
                 if 'energy' in c['name'].lower() or 'enrg' in c['name'].lower()]
    labels = {c['column_id']: c['name'].lower() for c in columns}
    achieved = [c for c in named if not _REQUESTED_TOKENS & set(words[c])
                and not any(word in labels[c] for word in _REQUESTED_IN_LABEL)]
    return (achieved or named)[0] if named else None


def scanned_element(candidates, energy_range):
    """Of the elements a detector watches, the one whose edge was scanned.

    A multi-element detector at APS 20-ID writes As, Fe, Ti, Mn, Cu, Zn, Cr and
    Ni sums in every file; the labels alone cannot say which edge the scan
    measured. The energy axis can: exactly one of those elements has an
    absorption edge inside the scanned range (As K at 11867 eV), and that is
    the element whose fluorescence is the spectrum.
    """
    low, high = energy_range
    found = [element for element in candidates
             if any(low - 30. <= edge.energy <= high for edge in xray_edges(element).values())]
    return found[0] if len(found) == 1 else None


def _one_representation(channels, words):
    """One non-overlapping reading of a detector's signal, out of several.

    A file often carries the same photons more than once: per element of the
    detector and summed over them, raw and dead-time corrected. Adding a raw
    sum to its own corrected version counts those photons twice, and the
    error grows with count rate, so it bends the spectrum where the sample
    absorbs most. Aggregation is settled first -- a total stands for the
    channels it already contains -- and the correction state after it, within
    whichever level survived, so that a corrected total is never added to the
    uncorrected total of the same photons.
    """
    processed = [c for c in channels if not _RAW & set(words[c])]
    channels = processed or channels
    totals = [c for c in channels if _TOTAL & set(words[c])]
    channels = totals or channels
    corrected = [c for c in channels if _CORRECTED & set(words[c])]
    return tuple(corrected or channels)


def _one_of(candidates, words, like=frozenset()):
    """The column that holds a role, or None when the file cannot say which.

    More than one column answers to the same name more often than it looks:
    an ion chamber called ``I0`` beside a dead-time-corrected detector sum
    called ``XMAP4:DT Corr I0``, or ``I0_EH1`` and ``I1_EH2`` belonging to
    two experimental hutches. Three readings of the labels settle most of
    those, in order: a measured channel beats a derived one, a column named
    exactly after the role beats one carrying extra words, and a column
    sharing the qualifier of an already-named channel ('EH1') beats one that
    does not. What none of them settles is left unassigned for the user to
    choose, because the order the columns happen to appear in says nothing
    about what they measure.
    """
    if len(candidates) < 2:
        return candidates[0] if candidates else None
    measured = [c for c in candidates if not _DERIVED & set(words[c])]
    candidates = measured or candidates
    exact = [c for c in candidates if len(words[c]) == 1]
    if len(exact) == 1:
        return exact[0]
    candidates = exact or candidates
    shared = [c for c in candidates if like & set(words[c])]
    if len(shared) == 1:
        return shared[0]
    return candidates[0] if len(candidates) == 1 else None


def _fluorescence_channels(columns, words, energy_range=None):
    """Choose the fluorescence channels that hold the measured spectrum."""
    by_element: dict[str, list[str]] = {}
    for column in columns:
        element = emission_line(words[column['column_id']])
        if element is not None:
            by_element.setdefault(element, []).append(column['column_id'])
    if not by_element:
        return (), None
    if len(by_element) == 1:
        element = next(iter(by_element))
    elif energy_range is None:
        return (), None
    else:
        element = scanned_element(sorted(by_element), energy_range)
        if element is None:
            return (), None
    return _alpha_lines(_one_representation(by_element[element], words), words), element


def assign_roles(columns, column_units=None, overrides=None, energy_range=None) -> ChannelRoles:
    """Name the channels of one inspected file.

    ``columns`` are inspection column dictionaries; ``column_units`` is the
    unit map Athena's own suggestion produced, reused rather than re-derived.
    ``energy_range`` is the first and last energy of the scan, in eV, which
    decides which element a multi-element detector was watching. ``overrides``
    maps a role name to a column label (or a list of labels) and comes from the
    registry entry for a beamline whose labels say less than its documentation.
    """
    words = {c['column_id']: tokens(c['name']) for c in columns}
    by_label = {c['name'].lower(): c['column_id'] for c in columns}

    def all_of(candidates, *, reference=False):
        return [c['column_id'] for c in columns
                if candidates & set(words[c['column_id']])
                and bool(REFERENCE_MARKS & set(words[c['column_id']])) == reference]

    def first(candidates, *, reference=False, like=frozenset()):
        return _one_of(all_of(candidates, reference=reference), words, like)

    def in_order(names):
        """The first of these names the file carries, in the order given."""
        for name in names:
            found = first({name})
            if found:
                return found
        return None

    i0 = first(I0_TOKENS)
    corrected_i0 = [c for c in all_of(I0_TOKENS) if _DERIVED & set(words[c])]
    # Beamlines that run two experimental stations label every channel with
    # the station it stands in, so I0's qualifier says which transmission
    # chamber shares its beam path.
    station = set(words[i0]) - I0_TOKENS if i0 else frozenset()
    found = {
        'energy': _energy_column(columns, words),
        'i0': i0,
        'transmission': first(TRANSMISSION_TOKENS, like=station),
        'reference': first(REFERENCE_TOKENS),
        'mu': in_order(MU_ORDER),
        'mu_reference': first(MU_TOKENS, reference=True) or first(MU_REFERENCE_TOKENS),
    }
    declined = tuple(role for role, candidates in (('i0', all_of(I0_TOKENS)),
                                                   ('transmission', all_of(TRANSMISSION_TOKENS)))
                     if candidates and not found[role])
    fluorescence, element = _fluorescence_channels(columns, words, energy_range)
    # Channels named for the signal rather than for an emission line are all
    # the same detector's, so they are summed rather than chosen between.
    named = all_of(FLUORESCENCE_TOKENS)
    if named:
        fluorescence, element = _one_representation(named, words), None
    elif not fluorescence:
        fluorescence = tuple(c['column_id'] for c in columns
                             if any(_DEADTIME.fullmatch(word) for word in words[c['column_id']]))

    for role, labels in (overrides or {}).items():
        wanted = [labels] if isinstance(labels, str) else list(labels)
        chosen = [by_label[label] for label in wanted if label in by_label]
        if len(chosen) != len(wanted):
            continue  # the file does not carry the labels the override names
        if role == 'fluorescence':
            fluorescence, element = tuple(chosen), element
        elif wanted:
            found[role] = chosen[0]
        else:
            # An empty override is the beamline saying this role is not in
            # the file at all -- a counter the labels would otherwise claim
            # measured something else. Leaving it unfilled is the answer, so
            # it is not a choice withheld from the user either.
            found[role] = None

    declined = tuple(role for role in declined if not found[role])  # an override can settle one
    units = (column_units or {}).get(found['energy']) if found['energy'] else None
    # A detector sum already corrected for dead time must not be divided by a
    # dead-time-scaled monitor as well; that corrects the same loss twice.
    raw_windows = bool(fluorescence) and not any(_CORRECTED & set(words[c]) for c in fluorescence)
    return ChannelRoles(energy_units=units, declined=declined, fluorescence=fluorescence,
                        fluorescence_element=element, labels={c['column_id']: c['name'] for c in columns},
                        i0_corrected=corrected_i0[0] if len(corrected_i0) == 1 and raw_windows and found['i0'] else None,
                        **found)


def suggestions_from_roles(roles: ChannelRoles) -> dict:
    """Athena-shaped import suggestions for the channels that were named.

    The keys are the measurement modes the file supports. Each value has the
    six fields ``athena_suggestion`` carries, so the browser can apply one
    without knowing it came from the registry.
    """
    if roles.energy is None:
        return {}
    units = roles.energy_units or 'eV'
    base = {'energy_column': roles.energy, 'units': units, 'data_type': 'mu'}
    suggestions = {}
    if roles.mu:
        suggestions['mu'] = {**base, 'numerator': [roles.mu], 'denominator': None, 'mode': 'mu'}
    if roles.i0 and roles.transmission:
        suggestions['transmission'] = {**base, 'numerator': [roles.i0],
                                       'denominator': roles.transmission, 'mode': 'transmission'}
    if roles.fluorescence and roles.i0:
        suggestions['fluorescence'] = {**base, 'numerator': list(roles.fluorescence),
                                       'denominator': roles.i0_corrected or roles.i0, 'mode': 'fluorescence'}
    return suggestions


def reference_from_roles(roles: ChannelRoles) -> dict | None:
    """The reference channel to import beside the sample, if the file has one.

    A reference foil sits behind the transmission detector, so its signal is
    ln(It/Iref); a beamline that already wrote a reference mu column gives it
    directly and needs no logarithm.
    """
    if roles.mu_reference:
        return {'numerator': roles.mu_reference, 'denominator': None, 'log': False}
    if roles.transmission and roles.reference:
        return {'numerator': roles.transmission, 'denominator': roles.reference, 'log': True}
    return None


def preferred(suggestions: dict, measured: str | None = None) -> dict | None:
    """The mode to offer first: the one whose signal shows the edge (see
    choose_measurement), else a measured mu, then transmission, then yield."""
    for mode in (measured, 'mu', 'transmission', 'fluorescence'):
        if mode in suggestions:
            return suggestions[mode]
    return None


# Below this edge-step-to-noise ratio a signal shows no edge at all.
NO_EDGE = 5.
# Between NO_EDGE and this ratio an edge is measured but marginal. In I0/It
# beside a reference edge (itself at least NO_EDGE) that is ambiguous: a dilute
# sample and a foil scan whose trace reaches It look alike, so the user is
# asked which it was. The boundary is a heuristic that decides only whether to
# ask: above it I0/It is imported by default, with a note on how to choose
# It/Iref, but an edge's size does not say which geometry was measured.
CLEAR_EDGE = 20.
# Transmission is offered first while its edge is at least this fraction of
# the fluorescence edge (both measure the same sample): a capillary measured in
# fluorescence still writes I0 and It, with a far weaker edge in I0/It.
TRANSMISSION_SHARE = .1


def edge_step(energy, signal, edge) -> tuple[float, float] | None:
    """The edge step of a signal at a known edge and its pre-edge noise.

    A straight line through the pre-edge (edge - 120 to edge - 15 eV) is
    extended under the post-edge (edge + 25 to edge + 150 eV); the median
    distance above it is the step, and the scatter about the line in the
    pre-edge is the noise. None when either window holds under four points.
    """
    energy, signal = np.asarray(energy, float), np.asarray(signal, float)
    ok = np.isfinite(signal) & np.isfinite(energy)
    energy, signal = energy[ok], signal[ok]
    pre = (energy > edge - 120) & (energy < edge - 15)
    post = (energy > edge + 25) & (energy < edge + 150)
    if pre.sum() < 4 or post.sum() < 4:
        return None
    line = np.polyfit(energy[pre], signal[pre], 1)
    step = float(np.median(signal[post] - np.polyval(line, energy[post])))
    noise = float(np.std(signal[pre] - np.polyval(line, energy[pre])))
    return step, noise


def edge_contrast(energy, signal, edge) -> float | None:
    """The edge step over its pre-edge noise (see edge_step). The ratio has no
    units, so a log ratio and a count ratio can be compared."""
    found = edge_step(energy, signal, edge)
    if found is None:
        return None
    step, noise = found
    return step / noise if noise > 0 else (np.inf if step > 0 else 0.)


def choose_measurement(suggestions: dict, reference: dict | None, arrays, edge) -> dict | None:
    """Pick the measurement whose signal shows the edge, from the data.

    The labels say which channels a file has, not which one holds this
    sample's edge: an in-situ capillary measured in fluorescence still writes
    I0 and It, and a foil scanned on its own sits behind It, in the reference
    position. Returns the chosen mode, every candidate's edge contrast, notes
    for the user, and the suggestions and reference to offer.

    A reference never displaces by default an I0/It edge at least CLEAR_EDGE
    times its noise, however much stronger the foil's edge is: I0/It is
    imported with its reference, and a note says how to take It/Iref instead.
    A marginal I0/It edge beside a reference edge (at least NO_EDGE) is
    ambiguous, and ``ambiguous`` asks the user to choose between the sample
    with its reference and It/Iref as the spectrum (``suggestions['foil']``);
    the data cannot tell a dilute sample from a foil scan's trace in It. Only
    when I0/It shows no edge (and no fluorescence either) is It/Iref offered as
    the spectrum by default. A reference channel with no edge (an Iref reading
    only its offset) is offered but not by default.
    """
    if edge is None or not arrays or not suggestions:
        return None
    first = next(iter(suggestions.values()))
    energy = np.asarray(arrays[first['energy_column']], float) * (1000. if first['units'] == 'keV' else 1.)

    def ratio(numerator, denominator, logarithm):
        with np.errstate(all='ignore'):
            value = np.sum([np.asarray(arrays[k], float) for k in numerator], axis=0)
            if denominator:
                value = value / np.asarray(arrays[denominator], float)
            return np.log(value) if logarithm else value

    signals = {mode: ratio(choice['numerator'], choice['denominator'], mode == 'transmission')
               for mode, choice in suggestions.items()}
    if reference is not None and reference.get('denominator'):
        signals['reference'] = ratio([reference['numerator']], reference['denominator'], reference['log'])
    contrast = {key: edge_contrast(energy, value, edge) for key, value in signals.items()}
    score = {key: -np.inf if value is None else value for key, value in contrast.items()}
    suggestions, notes = dict(suggestions), []
    has_reference = score.get('reference', -np.inf) >= NO_EDGE
    if 'reference' in score and not has_reference:
        notes.append('The reference channel shows no edge here, so it is not imported unless you choose it.')
    transmission = score.get('transmission', -np.inf)
    fluorescence = score.get('fluorescence', -np.inf)
    step = edge_step(energy, signals['transmission'], edge) if 'transmission' in signals else None
    sample_edge = transmission >= NO_EDGE
    marginal = sample_edge and transmission < CLEAR_EDGE and has_reference
    foil = ({**first, 'numerator': [reference['numerator']], 'denominator': reference['denominator'],
             'mode': 'transmission'} if has_reference else None)
    ambiguous = foil_spectrum = False
    if score.get('mu', -np.inf) >= NO_EDGE:
        measured = 'mu'
    elif sample_edge and not marginal and transmission >= TRANSMISSION_SHARE * max(fluorescence, 0.):
        measured = 'transmission'
        if has_reference and transmission < TRANSMISSION_SHARE * score['reference']:
            notes.append(f'I0/It shows a weak edge (step {step[0]:.3g} in ln(I0/It), {transmission:.0f} times its noise) '
                         'and the reference It/Iref a much stronger one. The sample is imported as I0/It with It/Iref '
                         'as its reference. If this was a foil scan, choose It as numerator and Iref as '
                         'denominator instead.')
    elif fluorescence >= NO_EDGE and fluorescence > transmission:
        measured = 'fluorescence'
        if sample_edge:
            notes.append('Transmission (I0/It) shows an edge too, but a smaller one relative to its noise than '
                         'fluorescence, so fluorescence is offered first; transmission stays one click away.')
        elif 'transmission' in score:
            notes.append('Transmission (I0/It) shows no edge here and fluorescence does, so fluorescence is offered first.')
    elif marginal:
        # A dilute sample, or a foil whose trace reaches It: the user knows.
        measured, ambiguous = 'transmission', True
        suggestions['foil'] = foil
        notes.append(f'I0/It shows only a marginal edge (step {step[0]:.2g} in ln(I0/It), {transmission:.0f} times '
                     f'its noise) and It/Iref one {score["reference"]:.0f} times its noise. The data fit a dilute sample '
                     'with a foil reference and a foil scanned in the reference position equally well: choose which '
                     'this scan was.')
    elif has_reference:
        # No edge in I0/It, one in It/Iref: the signals of a foil scanned
        # in the reference position, imported as the spectrum.
        measured, foil_spectrum = 'transmission', True
        suggestions['transmission'] = foil
        notes.append('I0/It shows no edge above its noise and It/Iref does, as when a foil is scanned in the '
                     'reference position: It/Iref is offered as the spectrum. If a sample was in the beam, choose '
                     'I0 as numerator and It as denominator instead.')
        reference = None
    elif sample_edge:
        measured = 'transmission'
    else:
        measured = None
        notes.append('No candidate signal shows a clear edge near the expected energy; check the channels and the energy range.')
    # JSON carries no infinity: a noiseless pre-edge (a calculated spectrum)
    # is reported as no number, though it still ranks first above.
    shown = {key: round(float(value), 1) if value is not None and np.isfinite(value) else None
             for key, value in contrast.items()}
    if reference is not None and 'reference' in score:
        # Offered either way; imported by default only when it shows an edge.
        reference = {**reference, 'default': has_reference}
    return {'mode': measured, 'edge_energy': float(edge), 'contrast': shown, 'notes': notes,
            'suggestions': suggestions, 'reference': reference, 'ambiguous': ambiguous,
            'foil_spectrum': foil_spectrum}
