# Legacy Athena detector records

Source contract and verification, 2026-09-10. This adds detector-record handling
to the partial UI-04, IM-02 and IM-11 requirements; it does not certify the full
[107-row Athena matrix](athena-parity.md). Artemis remains excluded.

## Source evidence and fidelity boundary

The [column manual](https://bruceravel.github.io/demeter/documents/Athena/import/columns.html)
mentions detector records among the energy-valued types that can be corrected.
However, the pinned current column dialog offers μ(E), XANES, normalized μ(E),
χ(k), and FEFF xmu.dat; it has no detector import choice. The type-correction
dialog offers three energy destinations. The web retains those choices.

At Demeter `06afc8da08a5a7d5a26ee14992170fcf5dc67406`:

- [Data.pm](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/Data.pm) names detector as a record type and describes its plot domain as energy.
- [Data/Mu.pm](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/Data/Mu.pm) refuses normalization and AUTOBK for detector records. [Data/FT.pm](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/Data/FT.pm) refuses forward/reverse Fourier transforms; its SHA-256 is `25d69df750d8c7f76b3f9f0bc38a7cdd6504d288c47ab2885b214e7dca9ef0d7`.
- [Data/Plot.pm](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/Data/Plot.pm) rejects detector plots outside energy; SHA-256 `f22bd9d5206b179180b4ee6cfd88693a667ca8b1ffba1bc60e9c069cfd9d46eb`. Its energy path ultimately calls Mu.pm's `_plotE_command`, which still has an xmu/xanes-only guard. Thus the pinned native implementation is internally incomplete here.
- [Data/JSON.pm](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/Data/JSON.pm) and [Data/Prj.pm](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/Data/Prj.pm) exclude detector records from lists that must plot χ(k).
- [Data/Athena.pm](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/Data/Athena.pm) documents unfinished detector serialization. Its legacy writer's array branches cover xmu/xanes and chi, leaving detector support incomplete.

All seven inspected detector-related source files match the pinned tree's Git
blob hashes. Two previously unregistered files, Plot.pm and FT.pm, bring the
[primary manifest](athena-primary-sources.json) to 87 sources. Displaying a
usable count trace and serializing its arrays in the web application is an
explicit implementation of the record's declared semantics, not a claim that
the native incomplete paths have been replayed successfully.

## Implemented behavior

Native JSON and Perl project records with `datatype=detector` retain that type,
even if deprecated absorption flags also exist. Previously they fell through
to μ(E). Complete web JSON and PRJ exports preserve detector identity; PRJ
without its web sidecar retains the explicit datatype and arrays as well.

The backend represents these as Larch groups with energy and detector signal
only. It does not find an edge, fit normalization, run AUTOBK, or compute
Fourier products. Constant and negative counts remain valid signals. E0 and
edge-step readouts are empty; normalization and Fourier arrays are unavailable.
Dormant native processing parameters remain saved, including their original
native metadata. Malformed dormant settings can be inspected with the counts
and will need repair if the record is later used as an absorption spectrum.

Project preview offers only the detector signal and labels its energy/count
axes. The workbench shows Detector signal, uses the raw plot while this group
is current, disables absorption/EXAFS parameter sections, and keeps an explicit
energy shift available. Returning to an absorption group restores its selected
energy plot form. Mixed raw plots identify detector/absorption units in the
legend. Plotting rejects normalized or Fourier detector curves even if stale
arrays are supplied. CSV output uses `energy,detector_signal`; unavailable k/R/q
exports return the established API error.

Explicit observed/target calibration shifts the axis without detecting an
edge. Automatic edge finding, absorption alignment, AUTOBK standards,
three-region edge-based rebinning, and absorption-specific corrections do not
reinterpret counts. Direct and remembered import preprocessing standards also
exclude detector records. Same-type original-data merge/sum and raw smoothing,
truncation, convolution and dispersive-axis mapping preserve detector identity.
All originals remain unchanged by derived transformations.

Group → Change data type accepts detector sources for μ(E), XANES, or norm(E),
including frozen groups. It preserves counts and saved state and supports
undo/redo. This correction changes how the existing y values are interpreted;
it does not reconstruct a detector ratio. The Ctrl+Alt shortcut remains the
native μ(E)/XANES toggle and does not toggle detector records.

## Measured probe and verification

[athena-detector-probe.prj](../backend/tests/fixtures/athena-detector-probe.prj)
is a **constructed native-format compatibility probe**, not an Athena-produced
detector export. Its 327 paired energy/I0 values are copied exactly, without
resampling, from record `mslu` in the downloaded official
[athena_json.prj fixture](../backend/tests/fixtures/demeter-athena-json.prj).
The [original source manifest](../backend/tests/fixtures/athena-official-manifest.json)
records that project's upstream URL, pinned revision, SHA-256 and Git blob hash.
The first two source records have unmatched energy/I0 lengths; the probe uses
the third record's complete paired arrays. Its journal identifies its origin.

[Backend tests](../backend/tests/test_athena_detector.py) verify the exact probe
values, traps against all absorption/FT functions, raw and processed previews,
restart, native/web/sidecar-free roundtrips, frozen type correction, undo/redo,
operation eligibility, manual calibration, derived count operations, dormant
native recipes and HTTP CSV/FT behavior. Existing column-memory tests now
include an ineligible detector standard.

Frontend tests cover counts-only controls, preservation of the user's ordinary
plot selection, type correction, project-preview labels, mixed units, stale
array exclusion and preprocessing eligibility.
[Chromium](../frontend/tests/e2e/athena-detector.spec.ts) imports the measured
probe, compares complete rendered preview/workbench arrays, checks parameter
availability and missing k-space data, corrects and undoes the type, downloads
and reopens PRJ, and reloads the project. Run counts and screenshot review are
recorded in [verification](athena-verification.md).

Native desktop replay, historical detector flags/formats beyond this explicit
datatype, complete detector diagnostic views (I0/signal overlays and marked I0
plots), and exhaustive operation/type combinations remain open. These are still
part of the original Athena objective.
