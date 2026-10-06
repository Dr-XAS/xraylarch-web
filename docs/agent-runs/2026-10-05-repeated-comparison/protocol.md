# Three repeated native/app comparisons

Preregistered before the first model call on 2026-10-05. Exactly three fresh attempts
per task (T1–T5) and arm (native/app): 30 scheduled attempts. No answer-dependent
reruns, prompt revisions, or replacement attempts. Failures and missing evidence remain
in the denominator. Technical launch errors are recorded, not silently replaced.

The frozen fixture and prompts are ../2026-10-05-native-vs-app/fixture. Native source
is Dr.XAS 19a0dfc90ff1a843f1b35c60a2cc3f1c574689ff; app source is xraylarch-web
7f82058f312d2e7f48df64a0f38dfdcfc0c7cbe7. The pinned native evaluator and existing
run_pair.py preserve production tool policy, the explicit gpt56luna alias, disabled
parallel tool calls, and a maximum of 30 SDK turns. Exact served model and SDK usage
are captured per attempt. The prior isolated Python 3.12 environment is reused;
private source snapshots, projects, databases, artifact stores, FEFF, and conversations
are new. Deployed processes and shared stores are untouched.

Schedule is repeat 1 through 3, each T1 through T5. The first arm is native when
(repeat + task number) is even and app when odd. This alternates order within each
repeat and reverses order for each task in successive repeats (8 native-first and 7
app-first pairs). Every model arm has its own process and each app has a fresh server.

State assertions come from the frozen suite and native evaluator. Scientific checks
are separate: initial foil E0 and edge steps agree within 0.1 eV and 0.005; alignment
shifts are within 0.1 eV of -0.018 and -2.959 eV; T3 preserves kmin=3 and uses
kmax<24 with a phase-uncorrected peak near 2.30 A (0.1 A tolerance); T4 ends within
15 eV of 10140 eV and includes all three parents; T5 uses the first chronological
successful 10 K fit with twelve copper neighbours and r in [2.52, 2.58] A. Native
species provenance is the pinned copper structure fixture. Cross-arm fit agreement
uses 0.02 A and preserves differing recipes. Missing checks are unknown, never passes.
Answer grading uses the literal task-suite rubric, with a recorded reason per answer;
unsupported extra claims are separate caveats. Answers cannot override failed state
or missing scientific evidence.

Deterministic aggregation reports per-task/arm observed pass counts out of three,
missing/failure counts, numeric ranges, median actual SDK input/output usage and wall
time. It makes no population reliability or general model-ranking claim from n=3.
Complete bounded answers, configurations, provider metadata, tool events, state/science
summaries, and command transcripts are retained. Databases, private payloads, sessions,
raw process/server logs, and credentials are excluded from repository evidence.
