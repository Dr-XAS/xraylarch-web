# Athena FEFF xmu.dat import and preview

Baseline: Demeter `06afc8da08a5a7d5a26ee14992170fcf5dc67406`, reviewed
2026-09-10. This implements an additional part of IM-02 and IM-11 without
changing the full 107-requirement Athena objective. It reads FEFF output as
Athena data; it does not add FEFF execution, path fitting or Artemis workflows.

## Native contract

The [column-selection manual](https://bruceravel.github.io/demeter/documents/Athena/import/columns.html)
lists FEFF `xmu.dat` alongside absorption, XANES, normalized and extracted chi
inputs. Pinned `UI/Athena/ColumnSelection.pm::OnDatatype` assigns
`datatype=xmudat` and `is_nor=1`. Unlike chi, this type retains the energy,
detector arithmetic, reference, rebinning and preprocessing controls.

`Data/Mu.pm::normalize` takes the already-normalized branch when `is_nor` is
true. The Larch `is_nor.tmpl` sets norm and flat to the supplied mu; the branch
sets the step to one. `Data.pm::explain_recordtype` describes FEFF mu(E) as
having all plot spaces. These are the basis for preserving supplied normalized
mu while allowing background subtraction, FT and inverse FT with Larch.

`Data/Athena.pm::_write_args` emits `is_xmudat=1` and, because its xmu regular
expression also matches xmudat, `is_xmu=1`. `is_nor` remains true. The web
export writes these three flags and the web/native import gives the specific
FEFF flag or `datatype=xmudat` precedence over a generic normalized flag.
All input metadata remains inspectable. Note that pinned `Data/Prj.pm` and
`Data/JSON.pm` test `is_xmu` before `is_xmudat`; executing and reconciling that
native reader behavior remains part of desktop exchange verification.

The manual disallows converting chi to an energy type and FEFF to a non-FEFF
type through the group type-change dialog. `ChangeDatatype.pm` exposes current,
marked and all scopes, with mu/XANES/norm destinations. The pinned
`Group.pm::change_datatype` handler does not itself show all of the documented
guards. The full post-import type-change workflow remains an explicit separate
obligation; the new import option does not claim to implement that dialog.

The source URLs, revisions and hashes for these files are retained in
[the primary-source manifest](athena-primary-sources.json). Local source
inspection and direct Larch comparisons are not complete native wx replay.

## Real input and the discovered bug

Two unmodified FEFF 8.50L baseline outputs were downloaded from the official
`xraypy/feff85exafs` repository, revision
`ec8dcb07ca8ee034d0fa7431782074f0f65357a5`:

| Fixture | Readings | Source |
| --- | ---: | --- |
| `feff-copper-xmu.dat` | 401 | [Copper with SCF](https://github.com/xraypy/feff85exafs/blob/ec8dcb07ca8ee034d0fa7431782074f0f65357a5/tests/Copper/baseline/withSCF/xmu.dat) |
| `feff-nio-xmu.dat` | 400 | [NiO with SCF](https://github.com/xraypy/feff85exafs/blob/ec8dcb07ca8ee034d0fa7431782074f0f65357a5/tests/NiO/baseline/withSCF/xmu.dat) |

Their complete bytes, SHA-256, Git blob hash and download URLs are recorded in
[`athena-feff-fixtures.json`](../backend/tests/fixtures/athena-feff-fixtures.json).
The table labels are `omega e k mu mu0 chi`: omega is absolute photon energy,
while e is energy relative to the calculation's Fermi level. All six columns
are retained. The prior generic k/chi heuristic selected columns 3 and 6 and
silently suggested extracted chi instead of the intended FEFF mu(E).

`suggest_columns` now recognizes this six-label FEFF signature first, selects
omega and mu (columns 1 and 4), uses eV and suggests the distinct `xmudat` type.
It recognizes renamed files with the same signature; an arbitrary file named
`xmu.dat` does not alone trigger FEFF interpretation. The eV choice also avoids
the generic low-energy first-value heuristic for light-element simulations.
Other layouts remain manually selectable and require further format coverage.

## Implemented behavior

The column dialog displays **FEFF xmu.dat · normalized μ(E)** and explains the
energy-column distinction. Users can inspect mu0 or deliberately select chi(k),
then return to FEFF mu(E), with actual full-data previews after each selection.
FEFF groups are identified in the group list. Successful selections participate
in the existing remembered-choice and matching-batch mechanisms.

The backend accepts and retains `xmudat` as a distinct type through inspection,
preview, import, processing, project load, export and restore. Norm and flat
equal the supplied signal, with edge step one; normalization windows and
flatten fitting do not refit it. Larch computes the background and E/k/R/q
arrays. E0 fraction/white-line operations use the supplied normalization.
Energy-dependent raw-fluorescence normalization remains inapplicable, as it
does for ordinary pre-normalized input. Supported background standards and
energy difference calculations now recognize FEFF energy data.

Column arithmetic, explicit keV conversion, reference import, marking and
three-region rebinning remain available. Rebinning retains original energy,
mu and all source columns, and uses the same preview/import plan. Project
JSON, compressed web PRJ, bare PRJ with the web extension removed, and native
JSON recognize the type and preserve normalized values. Native specific-type
flags take precedence even when `is_nor=1` is present. Project undo and import
failures keep the existing atomic revision behavior.

These fixtures begin above their tabulated atomic edge and do not contain a
normal 30 eV pre-edge interval. Uncalibrated absorber enforcement therefore
reports that the atomic seed lies outside their support. A tested known energy
calibration brings their normalized half-height onto that seed. Likewise,
default rebin boundaries can fall outside the actual data; choosing an edge
start of zero is valid for these particular tests. Neither failure is repaired
by inventing pre-edge samples, dropping data or silently renormalizing FEFF mu.

## Evidence and remaining scope

`backend/tests/test_athena_feff_import.py` checks both fixture hashes, all source
columns and rows, detection priority, renamed files, low-energy units, actual
preview/import arrays, restart, native flags/type precedence, JSON/PRJ exchange,
fraction E0, calibrated enforcement, keV/reference rebinning and undo. Damaged
first, middle and final observations are rejected rather than treated as header
text. A normalization trap ensures `pre_edge` is not called for FEFF input;
independent direct Larch AUTOBK/FT/inverse-FT calls compare resulting arrays at
explicit matching settings, including the back-transform output range.
Additional store checks apply a FEFF background standard without changing it,
compare the normalized difference of known scaled FEFF signals, and reject
raw-fluorescence functional normalization on FEFF input.

Frontend tests check the real type selector and energy/chi control transitions.
`frontend/tests/e2e/athena-feff.spec.ts` selects both downloaded files through
the browser, compares complete omega/mu, omega/mu0 and k/chi plot arrays with
the input, imports the FEFF representation and compares all four rendered plot
spaces with the processed group. It saves and reopens a PRJ, verifies the FEFF
type and arrays and reloads the project. Signed zero is canonicalized only for
the plot comparison; all nonzero plotted values must match exactly.
Actual executed results and image reviews are in [verification](athena-verification.md).

IM-02 and IM-11 remain Partial. [Group type correction](athena-datatype-reference.md)
now covers the three energy destinations and documents the source/manual
restriction discrepancy. Detector-only types, every historical FEFF layout, full wavelength/pixel handling, all native
processing/analysis eligibility combinations and executable native desktop
round trips still require work. Other pending/partial matrix requirements also
remain active. No claim of full Athena duplication is made by this feature.
