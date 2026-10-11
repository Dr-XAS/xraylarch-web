# Compare saved EXAFS fits

Open **EXAFS fitting → Saved fit history → Compare saved fits** after saving at
least two fits for a spectrum. Choose a reference fit and a comparison fit. The
reference initially follows the selected history entry. Changing either choice
leaves the editor and the plotted fit unchanged.

The comparison reads the two archives already loaded with the project. It does
not fit again, evaluate model expressions, parse FEFF files, or save anything.
The current editable model does not supply comparison values.

## Reading the comparison

Each fit retains its timestamp, original project/group identity, Larch version,
engine, input fingerprint, and imported status. Input currentness is checked
against the loaded spectrum. Imported fits remain unverified even when their
input matches. Outdated fits remain available for inspection.

Fitting conditions show the saved k and R ranges, fit space, k-weights, window,
and taper widths. Statistics are displayed separately for each fit. There is no
ranking by R-factor, χ², AIC, or BIC. Changes to fit ranges, weights, and noise
estimates affect those statistics. Larch describes these dependencies in its
[fit-statistics documentation](https://xraypy.github.io/xraylarch/xafs_feffit.html#fit-statistics-and-goodness-of-fit-meassures-for-feffit).

Parameter rows match unique names and retain each fit's kind, expression,
bounds, value, and saved standard error. Differences use comparison minus
reference. Changed definitions or ambiguous identities prevent a numeric delta.
Standard errors belong to individual fits; they are not combined into an error
on the difference. A difference between fits is not a confidence interval or a
measurement of total uncertainty.

Paths match only when their saved IDs and FEFF contents agree, with consistent
identities in each archived model and result. A changed file under the same ID
does not receive a distance delta. Renamed or separately imported paths with
different IDs are not paired automatically. Distances use the saved evaluated
ΔR plus the FEFF reference distance. For a two-leg path this is the scattering
distance; for a multiple-scattering path it is half the total path length.
Unmatched or incomplete paths remain visible with an explanation.

The saved εk statistic describes the plotted k-weight. It is not a complete
record of all noise weights in a multi-weight fit. Older archives can lack it.
An equal displayed εk does not establish that two fits' statistics are directly
comparable.

## Export and scope

**Download fit comparison JSON** exports the displayed comparison, including
the loaded project revision, group identity, both archive IDs, provenance,
values, and interpretation notes. It excludes spectrum arrays and FEFF text.
Use the complete project export to preserve reproducible models and curves.

The report describes the loaded project snapshot. Reload the project to include
changes saved by another browser. Controls are unavailable while a project
update is pending. The feature is available in the standalone fitting editor;
it does not extend the mounted integration API.

This view compares saved results. To examine sensitivity to a fitting choice,
save fits with the intended change and inspect their differences. It does not
launch a parameter sweep or estimate systematic uncertainty automatically.
