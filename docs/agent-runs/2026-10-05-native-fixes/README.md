# Native alignment and transform fixes, October 5, 2026

Both native Dr.XAS defects are fixed and verified. All 400 focused backend tests
passed with private users databases. Fresh T2/T3 attempts used explicit `gpt56luna`
and both reported served model `gpt-5.6-luna-2026-07-09`.

| Scientific check | Original native result | Fixed native result |
| --- | --- | --- |
| 50 K alignment shift | +11.859897 eV | −0.007455 eV |
| 300 K alignment shift | +8.927755 eV | −2.977284 eV |
| Aligned edge residuals against 10 K | +11.859897 / +11.847755 eV | −0.007455 / −0.057284 eV |
| 10 K transform window | 2–14.6 Å⁻¹ | 3–14.6 Å⁻¹ |
| Window function | Replaced Hanning with Kaiser | Preserved Hanning |
| R output limit | Replaced 10 Å with 6 Å | Preserved 10 Å |
| First-shell apparent FT peak | 2.270292 Å | 2.270292 Å |

The corrected shifts agree within 0.02 eV with the preserved app results,
−0.018 and −2.959 eV. The native and app objectives differ, so exact equality is
not expected. No fixture shifts appear in production code.

## Changes and causes

`alignment.align_to_reference` minimized a multimodal derivative residual with a
single bounded scalar search. It selected a secondary minimum. The unchanged
objective's residual sums of squares drop from 5.083724/5.071275 to
0.008249/0.031168 at the corrected shifts. The new search evaluates the quadratic
minima between interpolation breakpoints, including endpoints and zero-padding
boundaries. Explicit search windows and refinement bounds still apply; bounds below
2 eV are now honored. Featureless constant derivatives return an error.

The alignment wrapper already applied the returned shift correctly. New tests check
its actual saved energy arrays and reported edges. A self-absorption holdout test
now explicitly disables alignment of deliberately corrupted training samples so
it tests the correction guard without depending on the old optimizer's error.

`fourier_transform_xas` previously supplied literal defaults that replaced saved
settings. Its strict SDK schema required the agent to fill those arguments, while
quality output omitted the existing transform. Omitted/null arguments now retain
saved settings, and explicit values override them. The quality response exposes
`current_transform`. Ordinary, editor and filtered-source recipes are covered,
including repeated edits, phase settings and replay after a new forward transform.

T3 preserved kmin=3, dk=dk2=1, kweight=2, Hanning, rmax_out=10, nfft=2048,
kstep=0.05 and with_phase=false. Only kmax changed, from 24 to 14.6 Å⁻¹.

## Verification and evidence

- [Exact test commands and results](tests.json): 94 alignment/utilities/adapter
  tests and 306 Fourier/recipe/quality/action-parity/schema tests. The initial
  alignment cases failed 7/7 before the fix; initial transform cases failed 7/8.
  Additional padding-boundary and filtered-source regressions also failed first.
  The full backend suite was not run locally. No dependencies were installed.
- [Alignment diagnosis](alignment-diagnosis.json) records the original and fixed
  objective values, shifts, implementation hash and timing measurements.
- [Saved-artifact verification](scientific-verification.json) passes both tasks,
  checking scientific values, all saved FT fields, frozen prompts/fixture, model
  identity and original-artifact hashes. Three verifier tests reject the original
  failures and missing/nonfinite values.
- [Full-payload verification](payload-validation.json) confirms every energy
  displacement, unchanged absorption and χ(k), and independently recomputed window,
  R, complex FT components, magnitude and phase arrays. The same validator
  [rejects the original baseline](baseline-payload-validation.json).
- [Fresh attempts](runs/manifest.json), [T2 answer](runs/native-T2/answer.md),
  [T3 answer](runs/native-T3/answer.md), and [exact invocation](invocation.json)
  retain calls, provider identity, settings, runtime packages and source hashes.

There was one completed model attempt per task and no scientific retries. The first
setup stopped before model startup because the selected environment lacked Argo
configuration. Both [setup failures](setup-failure-1/manifest.json) remain available;
after loading the existing provider environment, the runs used fresh output
directories. No credential values are included.

The live runtime used Python 3.12.13, Larch 2026.2.2, NumPy 2.4.6, SciPy 1.16.1
and openai-agents 0.4.2, matching the original native runtime. Local tests used a
different installed Larch revision, recorded in `tests.json`; the fresh remote
attempts and array checks verify the baseline runtime too.

## Revisions and scope

| Component | Exact commit |
| --- | --- |
| Dr.XAS fixes | `b8269f8ca28e54e7f9ec49382b1b6edc11eab085` |
| Original Dr.XAS adapter | `fb40964f5aab0242a8519190bd05adf4f468633b` |
| Original comparison evidence | `dd8169f7d4643e10f8148b1495c4df96f6147543` |

Dr.XAS fixes remain on local branch `codex/native-app-comparison` in
`/tmp/drxas-native-app-comparison-20261005`. This evidence is stored separately
from the baseline. [Integrity hashes](baseline-integrity.json) confirm all 130
original evidence files are unchanged. No push, merge, deployment, shared database
write or service change occurred. Unrelated dirty work remains intact.

## Limits

One attempt per task does not establish agent reliability. The app arm was not
rerun. The provider verified the served model identifier but supplied no revision.
T2's answer rounds its relative span to 19.2%; the recorded values give 19.13%,
or 19.1% to one decimal place. T3's approximately 2.55 Å physical distance is a
contextual estimate, not a fitted bond distance from this attempt.

Alignment still assumes comparable edge shapes and can be misled by glitches or
different chemistry. Exact interval enumeration costs more on dense irregular
grids: the measured foil calls took about 10 ms, while a 1,700-point irregular
test took 1.65 seconds. Private payloads and databases remain in remote scratch;
the committed evidence contains scalar checks and hashes, not those runtime files.

## Recheck

From the xraylarch-web repository root:

```sh
python3 docs/agent-runs/2026-10-05-native-fixes/test_verify_evidence.py -v
python3 docs/agent-runs/2026-10-05-native-fixes/verify_evidence.py \
  --runs docs/agent-runs/2026-10-05-native-fixes/runs \
  --out /tmp/native-fixes-verification.json
```

`runtime_payload_check.py` requires Larch and the private runtime payloads. Its
exact executed command and the fresh evaluator command are in `invocation.json`.
