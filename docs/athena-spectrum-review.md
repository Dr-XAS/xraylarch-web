# Review spectra before combining them

Open **Edit → Review spectra…** to inspect the saved processing of all or marked
groups. The report lists processing failures, saved warnings, explicit range
settings that Larch adjusted, and other groups with identical input arrays.
**Download review JSON** saves the exact displayed snapshot with its project ID,
revision and scope. It contains no spectral arrays.

Use the report before merging a batch or choosing spectra for analysis. Inspect
the curves and acquisition records when a finding needs explanation. The report
doesn't change parameters, mark groups, reprocess data or certify scientific
quality. A processed group can still have unsuitable normalization or a poor
signal-to-noise ratio.

## What the report means

- Identical inputs are exact matches of the stored coordinate and signal arrays.
  Processing settings and energy shifts can differ. A marked group's matches
  include unmarked groups elsewhere in the project, such as a shared reference.
  Check the acquisition record before treating matching groups as independent
  repeat scans. Matching arrays alone cannot establish acquisition history.
- Requested and effective ranges appear together only when an explicit setting
  changed. Automatic defaults don't count as adjustments. Normalization ranges
  are in eV relative to E0, k ranges are in Å⁻¹, and R ranges are in Å. The
  background-removal k range and the Fourier-transform k range are separate.
- Energy coverage includes the saved energy shift. Imported chi(k) groups use
  k for their coordinate and don't receive an energy shift. Available kmax
  describes measured support, not a recommendation for the usable signal range.
- Failed groups retain their error text; the report omits previous effective
  results that could be mistaken for a successful current calculation. XANES,
  detector, normalized, difference and calculated groups carry applicability
  notes. Detector counts, difference signals and calculated data don't take
  part in the duplicate-input check.

Larch documents the [normalization ranges](https://xraypy.github.io/xraylarch/xafs_preedge.html)
and the separate [AUTOBK transform parameters](https://xraypy.github.io/xraylarch/xafs_autobk.html).
The review reports this app's saved effective values rather than recommending a
universal range for every sample.

## Duplicate inputs in a merge

The merge preview warns when multiple contributing groups have identical input
arrays. The check runs after short-scan exclusion and ignores zero-weight
groups. It uses the same equality rule as Review spectra. Weights, interpolation,
the merged signal and the native scatter calculation remain unchanged. Saving
the merge retains the warning with its source record.

## API and revision handling

`POST /api/athena/projects/{id}/quality-report` takes:

```json
{"version": 7, "scope": "marked"}
```

The response includes `project_id`, `project_name`, `version`, `scope`, `counts`,
`groups` and explanatory `notes`. Each group includes its status, coordinate
coverage, effective E0 and edge step, warnings, adjustments and duplicate-input
IDs and labels. An empty marked scope returns an empty report. Invalid options
are rejected; a stale revision returns 409. The endpoint creates no history or
transcript entry and cannot operate on Dr.XAS integration projects.

The dialog checks the response identity, revision and selected group IDs before
displaying or downloading it. A downloaded review remains a snapshot of that
revision, even if the project changes later. Refresh the review to request new
results; reload the project first if another window has changed its revision.

## Verification

Backend tests cover exact matching, coordinate types, applicability, real Larch
normalization clipping, version conflicts and saved-project immutability. Merge
regressions check warnings alongside unchanged numerical output and native
reference comparisons. Frontend tests cover scope changes, stale responses,
error recovery and downloads. Browser checks exercise the bundled copper
spectra, desktop/mobile layouts and revision recovery through the real proxy.

## Possible follow-up work

Acquisition-order drift review would help identify changes across a scan series,
but needs reliable timestamps and a user-chosen reference. A separate EXAFS fit
sensitivity report could compare distances across k ranges and fixed E0 values.
Neither is inferred from duplicate detection or the number of processing notices.
