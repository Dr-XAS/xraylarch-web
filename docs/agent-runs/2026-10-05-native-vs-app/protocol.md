# Matched native-tool and app-agent protocol

Five independent task pairs use the copper T1-T5 prompts from `docs/agent-task-suite.md`.
Each arm gets a fresh conversation, the same explicit model alias `gpt56luna`,
`parallel_tool_calls=false`, and a maximum of 30 SDK turns. All ten model attempts
are retained. No prompt revision or scientific retry follows an answer failure.

Native Dr.XAS source is `fb40964f5aab0242a8519190bd05adf4f468633b`, in the local
`codex/native-app-comparison` branch. App source is `6e5acda87`, and fixture exporter
is `c8ef41de37dc05d0730b5b876819e360c9367806` in xraylarch-web. The evaluator is
`backend/eval/native_app_comparison.py` in Dr.XAS. `run_pair.py` starts an isolated
app backend and one agent process per arm. No deployed services are changed.

The native agent receives its production scientific policy and twelve unchanged tool
schemas. Storage is redirected to private immutable artifacts, plots, FEFF and SQLite.
Online search, feedback and shared-storage tools are excluded. The app agent receives
the app operating guide and one generic HTTP tool restricted to its assigned loopback
project and science routes. This compares these configured agent systems, including
their instructions and tools; it does not isolate tool schema design as a single cause.

`fixture/` contains measured energy and absorption arrays, labels, requested processing
parameters, task prompts, and the same copper CIF 11145. It contains no app-derived
scientific arrays or answer keys. Native Larch processes its own inputs. Starting
E0 and edge steps agree. Native uses ordinary artifacts with pre_edge/autobk recipes
and explicit metadata.ft; the full resolved staging recipe is retained as evidence.
Normal native reconstruction may choose different FT defaults later.

Both arms run in the same private Python 3.12.13 environment on drxas. Native imports
installed Larch 2026.2.2; app imports its own source tree. Exact library and provider
metadata are captured. The locally generated app version string is
2026.3.1.post293+g6e5acda87; source revision is the authoritative identifier.

Before each app agent starts, the driver compares its measured inputs with the native
fixture. Foil arrays match exactly. Linux reconstruction of the bundled Cu2O has three
absorption values differing by at most 3.47e-18 from the Mac export, so the guard uses
an absolute 1e-14 tolerance with zero relative tolerance. Distinct hashes are preserved.
The initial T1 app setup stopped at this check before any model call. The completed
native T1 attempt was retained and only app setup was repeated under `t1-app`.

App state checks use project snapshots and the existing suite. Native state checks use
original immutability and actual derived artifact lineage. They are workflow checks,
not proof of scientifically correct values. Final-answer grading is separate and uses
the suite's literal rubric. Unsupported statements outside that rubric are listed too.

`compare_science.py` reports numerical agreement separately. Missing evidence stays
unknown. Original E0 tolerance is 0.1 eV; edge-step tolerance 0.005; alignment shift 0.1 eV;
merged endpoint 15 eV; FT peak 0.1 Å. A changed k window is recorded as an agent
choice. The fit comparison takes the first successful 10 K fit with 12 Cu neighbours,
uses a 0.02 Å distance tolerance, and retains settings and later fits so no best
fit is selected after seeing the answers.

SDK input/output token counts are actual provider usage across calls, including repeated
context. API response bytes are a separate interface metric. Wall time is one observed
run, affected by provider and host load. One attempt per task cannot estimate reliability
or establish a general model-performance ranking. The earlier Codex CLI/HTTP baseline
has no exact model identity and is not included in these token comparisons.

Command transcripts replay app mutations only. FEFF and read-only fits remain in the
HTTP event evidence; replay does not reproduce them. Private payloads, databases,
sessions and server logs are excluded from the committed evidence.
