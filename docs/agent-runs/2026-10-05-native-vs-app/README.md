# Native tools versus app driving, October 5, 2026

All ten runs completed with the same served model, `gpt-5.6-luna-2026-07-09`.
The app passed all five workflow checks. Native tools passed four; the transform
agent changed the lower k limit from 3 to 2 Å⁻¹. A separate numerical comparison
also exposed native alignment shifts about 11.9 eV away from the app results.
Both approaches fitted the nearest Cu–Cu distance near 2.55 Å.

| Task | Native state | App state | Numerical finding |
| --- | --- | --- | --- |
| T1, compare scans | Pass | Pass | Starting E0 and edge steps match exactly for all three foils. |
| T2, align and merge | Pass | Pass | Native shifts +11.860 and +8.928 eV; app −0.018 and −2.959 eV. Original edge-step spread agrees at 0.439816. |
| T3, reduce transform range | Fail | Pass | Native uses 2–14.6 Å⁻¹; app uses 3–18 Å⁻¹. Both phase-uncorrected peaks are about 2.270 Å. |
| T4, include short scan | Pass | Pass | Both include three scans and end at 10134.32 eV. Native merges mu; app chooses norm, so equal endpoints do not mean equal absorption arrays. |
| T5, fit distance | Pass | Pass | First returned twelve-neighbour distances are 2.552083 and 2.549000 Å, a difference of 0.003083 Å. |

A workflow pass checks requested operations and lineage. It cannot establish that an
alignment is correct. Native T2 passes that check but has a large scientific discrepancy
that its answer does not acknowledge. The native tool itself reports post-alignment
edges near 8989.44 and 8989.43 eV against the reference at 8977.58 eV, evidence
the agent should have checked. The default derivative optimizer may have selected
a bad minimum; the exact numerical cause is not established. Native T3 also fails
to acknowledge its changed
lower limit. These need numerical checks as well as operation-history checks.

The literal answer rubric passes native T1, T2, T4 and T5. Native T3 names an
uncorrected peak but does not explain that it lies below the true bond distance, as
the rubric requires. All five app answers pass. These narrow grades do not certify
every sentence. Both T2 answers contain extra percentage arithmetic errors, and
app T1 over-interprets the duplicated reference as evidence that the 300 K scan is
not independent. The fixture deliberately duplicates that scan into the reference.

The T5 fits use different settings. Native's returned robust-fit candidate uses
k 3–10 and R 1–3 Å; the app's first fit uses k 3–18 and R 1.5–3 Å. Native runs a
window sweep inside one tool call; app makes explicit k-window and fixed-E0 fits.
Both discuss systematic uncertainty. Twelve is the supplied FEFF path degeneracy;
these fits do not independently establish a coordination number of twelve. The comparison retains the first qualifying
returned fit and all subsequent evidence, without selecting a closer later result.

## Work and cost observed

| Metric, summed over five tasks | Native | App |
| --- | ---: | ---: |
| SDK input tokens | 273,115 | 327,813 |
| SDK output tokens | 3,139 | 7,300 |
| Model-visible tool calls | 14 | 37 |
| Rejected tool calls | 0 | 1 |
| Agent wall time | 41.08 s | 71.34 s |

A native tool can perform several scientific operations internally. The one native
T5 call includes multiple fits, so tool-call counts are not scientific-work counts.
App T4 recovered from one rejected preview request. These are one-run observations,
not reliable speed or cost estimates. Different instructions, schemas, numerical
libraries and defaults prevent attribution to the interface alone.

All five app command transcripts replayed with no divergence and no final snapshot
differences. Read-only FEFF and fit requests are preserved in the event logs; command
replay does not rerun them. The native adapter passed 18 focused tests. The fixture
export passed one test, and offline comparison/input guards passed eight tests.

## Evidence and reproduction

- [Protocol and limitations](protocol.md), [shared fixture](fixture/fixture.json), and [app guide](fixture/app-guide.md).
- [Per-run grades and usage](results.json) retain the independently reviewed literal rubric grades.
- [Numerical comparison](science-comparison.json) records tolerances, source values, fit settings and missing-data policy.
- [Native T1](runs/t1/native-T1/answer.md) and [app T1](runs/t1-app/app-T1/answer.md); T2–T5 are under [the remaining runs](runs/t2-t5/manifest.json).
- Each arm directory retains its exact configuration, events, provider identity, answer and usage. Each app runtime retains initial/final project state, meters, transcript, state report and replay result.
- Adapter commit `fb40964f5aab0242a8519190bd05adf4f468633b` is on Dr.XAS branch `codex/native-app-comparison`. App source is `6e5acda87`; fixture export is `c8ef41de3`. Nothing was pushed or deployed.

```sh
backend/.venv/bin/python docs/agent-runs/2026-10-05-native-vs-app/test_compare_science.py -v
python3 docs/agent-runs/2026-10-05-native-vs-app/compare_science.py \
  --runs docs/agent-runs/2026-10-05-native-vs-app/runs \
  --out /tmp/native-app-comparison.json
```

For another live run, use `run_pair.py --help` and the pinned Dr.XAS evaluator with
fresh output directories. Preserve failed attempts. Native alignment and lower-bound
preservation are the next fixes to investigate; this comparison leaves their scientific
implementations unchanged.
