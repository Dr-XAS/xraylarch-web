# Compare spectra against a reference

Open **Edit → Compare spectra…**, choose a comparison reference, and compare
all or marked groups against it. The reference starts as the current group and
doesn't need to be marked. The report excludes the reference from its target
rows and keeps the project's group order.

Use this report alongside the Multiple spectra viewer before merging scans or
investigating differences. It reads saved results and estimates alignment shifts
without changing parameters, moving spectra, or saving an analysis.
**Download comparison JSON** saves the displayed snapshot with the project
revision, reference and scope.

## Reading the numbers

- **Additional fitted shift**, in eV, estimates the change to the target's
  current energy shift that would align its smoothed derivative with the
  reference. The report includes the fit interval and the fit's standard error
  when available. It doesn't apply the shift. A fitted shift can reflect changes
  in spectral shape; it doesn't establish monochromator drift or justify
  aligning chemically different samples.
- **E0 difference** is target E0 minus reference E0 on the saved shifted axes.
  **Edge-step ratio** is the target's saved edge step divided by the reference's.
  Normalized input can have an edge step near one by construction, so the ratio
  isn't a general concentration comparison.
- **XANES maximum difference** is the largest absolute difference between
  normalized spectra on the reference energy grid. The nominal interval is
  reference E0 minus 20 to plus 50 eV, clipped to shared support. The report
  shows the actual interval and reference point count; the upper limit is
  exclusive. Values describe the current axes before any fitted shift is
  applied. A shorter overlap changes what this metric measures.
- **χ(k) amplitude ratio** compares the root-mean-square amplitude of
  k-weighted χ(k) against the reference in successive k intervals. Both use
  the reference's saved k-weight. Intervals start at its effective kmin or the
  start of shared measured support, whichever is higher. They can extend beyond
  either saved Fourier kmax. The report shows each interval and the shared k
  support used. A value below one means a smaller weighted amplitude
  in that interval; it isn't a fitted disorder parameter, a noise estimate,
  or a recommendation for kmax.
- **Identical inputs** names exact array matches elsewhere in the project,
  including unmarked groups. Matching arrays don't establish independent
  acquisition, and the groups can have different processing parameters.

Unavailable values carry a reason. Failed processing results don't contribute
cached scientific metrics. Different coordinate types and unsupported signals
retain their identity and coverage without receiving inapplicable numbers.
Inspect the notes for known differences in edge identity or signal type.

The comparison reference is a choice for this report. It doesn't assign a
linked reference or background standard. Native Athena documents
[alignment and reference-channel use](https://bruceravel.github.io/demeter/aug/process/align.html);
Larch documents the [meaning of k-weight](https://xraypy.github.io/xraylarch/xafs_fourier.html).

## Saved state and limits

The report compares at most 100 target groups per request. For a larger project,
mark a smaller batch. At least one target must remain after excluding the
reference. Group order isn't an acquisition timeline, and the report doesn't
infer radiation damage, drift, sample identity, or fitness for merging.

`POST /api/athena/projects/{id}/comparison-report` takes:

```json
{"version": 7, "reference_id": "group-id", "scope": "marked"}
```

The backend checks the project version before and after the calculation. A
stale version returns 409; reload the project before requesting a new report.
The dialog rejects responses for a different project, revision, reference or
target set. JSON downloads preserve the displayed response. The report also
records the smoothing settings used for the alignment estimate.

This standalone endpoint isn't part of the Dr.XAS integration contract. It
creates no project history or transcript entry. Existing CLI comparisons retain
their interface and share the corrected comparison calculations.
