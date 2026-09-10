# Athena import preprocessing reference

Baseline: Demeter `06afc8da08a5a7d5a26ee14992170fcf5dc67406`, reviewed
2026-09-10. This extends IM-07 without reducing the full Athena objective.
No Artemis functionality is introduced. Source URLs and hashes are in
[the primary-source manifest](athena-primary-sources.json).

## Source contract and observed inconsistencies

The [preprocessing manual](https://bruceravel.github.io/demeter/documents/Athena/import/preproc.html)
and `ColumnSelection/Preprocess.pm` define independent sample marking,
parameter copying and alignment choices with an existing standard. Reference
spectra remain unmarked. The standard may itself be frozen because it is read
without modification. Chi input has no energy-alignment or parameter-standard
selection in the native column dialog.

`UI/Athena/IO.pm::_group` copies sample parameters before creating a reference,
then aligns. It uses reference channels only when both sides have them.
The MED loop's intent and final assignments share the first channel's shift.
`Data/E0.pm::align` and `align_with_reference` store the fitted shift rounded
to three decimals and retain its uncertainty.

The pinned Larch `align.tmpl` differs from parts of the manual and the Ifeffit
template. Its fitting window is `[standard E0 - 20, standard E0 + 50)`, not
the manual's -50/+100 description. It interpolates moving mu onto the shifted
standard energy grid, then divides index derivatives of mu by those of energy.
Smoothed import fitting uses Larch `savitzky_golay` with the configured defaults
31 points/order 4. Its two free parameters are absolute energy shift and an
amplitude scale for the derivative residual. The Ifeffit branch applies a
three-point smoothing repeatedly instead. This implementation follows the
**Larch template**, consistent with the requested backend.

There is another source/manual inconsistency: the documented copy excludes
energy shift, but pinned `IO.pm::constrain` includes `bkg_eshift` in its
`@all_group` list. This implementation follows the explicit documented user
contract: copying preserves the destination's shift. If both copy and alignment
are requested, copied E0 already refers to the standard's calibrated axis and
is not shifted again; a paired reference preserves its independent E0 plus the
fitted shift. No-copy reference alignment preserves real sample edge offsets.

## Implemented path

`ImportRequest.preprocessing` is an optional, strictly validated object:

```json
{"mark": false, "standard_id": null, "copy_parameters": false, "align": false}
```

The current browser sends it explicitly. Omitting the object preserves the
older API's marked-sample behavior. Successful imports now persist marking and
standard/copy/alignment choices across new file selections and server/browser
restarts, following the pinned implementation. The manual's reset-marking
description differs; see the [remembered-choice contract](athena-column-memory-reference.md).
Matching batch imports and retries reuse the selected choices. A new layout
prompts for columns without silently changing the batch's preprocessing.
Switching to chi clears standard operations but retains the marking choice.

A copy uses the standard's accepted processing recipe, background-standard link,
absorber identity and plot multiplier/offset. It does not copy its raw arrays,
notes, frozen/marked state or reference link. Existing automatic recipe values
remain automatic rather than being silently replaced by effective values.
These web recipe semantics are recorded as a remaining native-equivalence
question below. The copied fields and standard version/label are retained in
`source.import_preprocessing` for later inspection and JSON/PRJ exchange.

`athena_preprocessing.import_alignment` uses local Larch fitting and math
routines with the pinned template's initial E0 difference, derivative ordering,
window, filter and fitted scale. The nuisance scale does not multiply raw mu.
Diagnostics retain the unrounded shift, rounded applied shift, estimated
uncertainty, source/reference choice and fit settings. Native links in either
direction are resolved for existing standards. Imported MED groups reuse the
first detector/reference fit, preserving differences between detector signals.

All processing occurs on the new in-memory project copy before one save. A
bad standard, invalid copied recipe, failed alignment or invalid later MED
channel leaves the project version, history and accepted groups unchanged.
Retry uses the same staged upload. Existing standards and their dependencies
are read, and remain unchanged. The imported source columns and mu remain
unchanged by alignment; the result energy axis uses the saved shift.
References' saved column mappings have preprocessing disabled; their actual
calibration is represented by the linked sample and saved energy shift.

The column plot stays a fast, read-only preview of the chosen detector formula.
When alignment is selected, it explicitly states that it shows the original
energy axis and that alignment occurs on import. It does not pretend to be a
preview of an alignment fit that has not run. The final processed plot and
energy-shift control display the accepted result.

## Verification and remaining scope

The dedicated store tests cover all three energy types, marking in summed and
individual MED modes, references in either link direction, frozen standard
reads, background-standard copying, chemical edge offsets, retry/rollback,
failed later channels, JSON/PRJ exchange and real HTTP version checks.
Known translations/scalings of all 612 measured Cu 10 K points independently
check fitted shift, derivative scale, 0.001 eV rounding and unchanged inputs.
A separate test checks a 6 eV chemical sample offset survives reference fitting.

Frontend tests cover standard eligibility, missing-source recovery, chi guards,
mark restoration, batch reuse and failed-import retry. Chromium imports a standard
with a reference followed by two shifted scans, and checks the actual stored
shifts (-3.5 and -4.5 eV), copied parameters, unmodified standard and mu arrays,
sample/reference marking, reload and new-selection defaults. Actual executed
counts are recorded in [verification](athena-verification.md).

The web checks reject flat derivatives, failed fits and fits whose edge window
would lie outside measured support. These explicit failure checks go beyond
native silent numerical failures. The 31-point filter and range requirements
are not a blanket claim that all short, sparsely sampled or heavily distorted
scans are supported. Shift uncertainties can be absent when Larch cannot
estimate covariance. Analytical zero-residual cases can produce a zero-error
warning in the local uncertainties library.

IM-07 remains **Partial**. Import-time three-region rebinning is now implemented
and tested under the [separate rebin source contract](athena-import-rebin-reference.md).
The [post-import workflow](athena-post-rebin-reference.md) now shares that native
grid plan; its separate remaining obligations are not certified by import tests.
Other remaining work includes
the full native preference tree and YAML/INI exchange, effective-versus-automatic parameter semantics,
parameters not yet represented in the web model (e.g. importance and phase
correction), every unusual reference/type combination and native wx replay.
The separate post-import alignment tool still uses its previous fitter; its
complete native behavior remains a separate open parity obligation.

### Rebin source discovery

The pinned Larch rebin template interpolates the smoothed/cropped source onto
the grid and then removes the first and last **output** points as well. It
also interpolates the retained smoothed i0/signal arrays. The Ifeffit template
keeps the output endpoints and interpolates detector arrays directly from the
standard rather than the temporary smoothed arrays. Those are concrete backend
differences, despite the manual's general boxcar-averaging description. All four
rebin/rebin_prep templates were downloaded, verified against the pinned Git blob
hashes, and added to the source manifest. The subsequent rebin contract links
these observations to numerical, file, browser and exchange tests; full native
desktop parity remains unproven.
