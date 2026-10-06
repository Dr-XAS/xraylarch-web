# Scope: making xraylarch-web drivable by an agent

Status: Phase 1 built, Phase 2 partly built. Written 2026-09-18, updated 2026-10-05.

## What this is for

Dr.XAS today answers scientific questions through native tool calling: the model is
handed a fixed set of XAS tools and the Dr.XAS backend does the work. We want to test
a second architecture against it, where the model is given no XAS tools at all and
instead **operates xraylarch-web** from instructions the user writes in ordinary
language. Two arms, one task suite, measured head to head.

That framing decides everything below. The bar is not "an agent can reach the
endpoint" — it already can. The bar is that the app-driving arm arrives at the same
scientific answer as the native arm, at a token cost and turn count close enough that
the comparison is about architecture rather than about plumbing. Every item here earns
its place by moving one of those numbers.

Headless only. No browser, no Playwright, no screen. The HTTP API is the whole
instrument.

## What already works

More than you would expect. The backend is the source of truth — projects live on
disk as JSON, mutations go through one lock, and `version` gives optimistic
concurrency with undo/redo stacks behind it. The frontend is a view, not a second
brain, so an agent that never opens a browser is not missing state.

Three things are close to purpose-built for this:

- **A command bus already exists.** `POST /api/athena/projects/{ident}/command` takes
  `{version, action, group_ids, options}` and covers thirty-five actions — merge,
  align, calibrate, rebin, deglitch, convolve, set_e0, parameters, freeze, and the
  rest. One verb, a discriminating name, and a group selection. That is the right
  shape for an agent.
- **Almost every mutation has a `/preview` twin.** `merge/preview`,
  `alignment/preview`, `calibration/preview`, `point-edit/preview`, `rebin/preview`,
  `convolve/preview`, `smooth/preview`, `mee/preview`, `difference/preview`. Look
  before you leap is already a first-class idea in this codebase, and it is exactly
  what keeps an agent from destroying a project by guessing.
- **Errors are structured.** `ErrorEnvelope` carries `code`, `message`, `fields` and
  `recovery`. A field whose entire job is telling the caller what to do next is a
  better error contract than most APIs written for humans have.

The domain vocabulary is settled too, in `CONTEXT.md`, and around fifty reference
documents in `docs/` record the native-Athena behaviour each module reproduces. An
agent operating this app can be taught to speak the same language the code speaks.

## The four blockers

### 1. Responses are too large to read

`GET /projects/{ident}` returns `store.load(ident)` verbatim. Every group carries its
raw `energy` and `mu`, plus twenty-four result arrays — `norm`, `flat`, `bkg`,
`dmude`, `d2mude`, `k`, `chi`, `chir_mag`, `chir_re`, `q`, `chiq_pha`, and so on.

For the bundled Cu foil example — three groups, 612 points each, the smallest
realistic project in the repo — that is a measured 590 KB of JSON, about **147,000
tokens**, to answer "what is in this project." A twenty-group EXAFS project runs to
roughly a million. The native arm gets curated tool returns measured in hundreds of
tokens. The app-driving arm cannot lose this comparison on plumbing.

There is no summary view, no projection, no way to ask for less.

*Addressed.* `?view=summary` takes the same example to 1,673 bytes (~418 tokens), a
353× reduction, and `?view=parameters` to 5,174 bytes for the full recipe of every
group. `full` remains the default, so the browser and the integration seam are
untouched. See `backend/xraylarch_web/agent_views.py`.

The writes had the same problem and the second task-suite run measured it: `/command`
answered with the whole project, a megabyte after a merge, and each preview with its
curves. *Addressed* on 2026-10-01. `/command` and all ten preview routes now take
`?view=summary` as well, which brings a merge reply from 1,002,160 bytes to 4,166.
The summary also gives each derived group a `derived` field, with the parents it used
and anything it excluded. That field exposed a merge default that had invalidated two
of the four task-suite results; see `agent-task-suite.md`.

### 2. The thirty-five actions have no discoverable schema

`Command.options` is `dict[str, Any]`. What `align` accepts, which keys `merge`
honours, whether `set_e0` wants `method` or `value` — all of it lives in a four-
thousand-line `if/elif` chain in `AthenaStore._apply_command`, and nowhere else. An agent
either gets the whole thing pasted into its prompt, or it guesses.

Neither is acceptable. Pasting thirty-five schemas into the system prompt *is* native tool
calling wearing a costume, and it would contaminate the experiment. Guessing burns
turns on 400s.

### 3. The agent cannot see

The app's primary output is a plot. An agent with no screen and no arrays in context
has no way to answer "does this normalization look right," "is there a glitch near the
edge," "which of these three has the cleanest EXAFS." It will answer anyway, and it
will be making things up.

### 4. There is no caller identity for a headless agent

The browser path is unauthenticated beyond knowing a project id. The
`/api/integration/v2/**` seam is HMAC-signed and service-only, reserved for the Dr.XAS
backend over loopback, and deliberately unreachable from anything else. An
experimental agent arm fits neither. It needs its own door, and that door must not
touch the v2 contract — Dr.XAS pins this repository's exact revision and fails closed
on a mismatch, so the integration seam is the one place to leave alone.

## Design

Five layers. Layer 0 is the keystone; the CLI, the MCP server and the HTTP discovery
route are all renderings of it and hold no independent knowledge of the domain.

### Layer 0 — the capability catalog

One registry, generated from the code, that is the single source of truth for what
this app can do. Per action: name, one-line purpose, JSON Schema for its options, what
group selection it takes, whether it mutates, whether it has a preview twin, its
preconditions, the `docs/` reference that explains it, and one worked example.

Building it has two stages, and they can ship independently.

*Stage A, a hand-written registry.* **Built**, in `backend/xraylarch_web/agent_actions.py`,
served at `GET /api/athena/capabilities` and `/capabilities/{action}`.

It came out as a hybrid rather than a pure table, and the split is worth keeping. The
prose — what an operation is for, what group selection it takes, which traps it has —
is hand-written, because the dispatcher's branch conditions encode what is *legal* and
never what something is *for*. The option lists mostly are not written down at all:
fifteen actions validate against a Pydantic model, so their fields, types, bounds and
defaults are read back off that model on request and cannot drift. Thirteen more pick
their options apart inline with `options.get(...)` and so carry a written-out table;
the remaining seven take no options.

The parity test reads the dispatcher's syntax tree rather than matching text, because
`smooth` is both an action and an option name of `deconvolve` and no text search can
tell those apart. It found 35 actions against 35 described, and it fails loudly in
either direction. There are four more actions on `/analyze`, named in the catalog so a
caller does not conclude they are missing when `/command` rejects them.

Costs measured on the bundled example: the index is 6.2 KB (~1,560 tokens) for all 35;
the largest single action, `parameters`, is 2.3 KB. So full discovery of the entire
surface runs about 2,000 tokens against the 147,000 that one `GET /projects/{id}` costs
today.

*Stage B, a discriminated union.* Replace `options: dict[str, Any]` with one Pydantic
model per action and `Field(discriminator="action")`. FastAPI then generates the
schemas for free, validation moves to the edge instead of hiding deep in the handler,
and 422s come back naming the offending field. Most of the thirty-five models are two to
five fields and their shapes are already implicit in the handler code.

Stage B is the largest single piece of work here and carries the only real regression
risk, because existing callers — the frontend and Dr.XAS — send options dicts that may
contain keys the handler currently ignores. Mitigation: a compatibility window where
unknown keys warn instead of rejecting, plus a corpus test that replays every options
dict appearing anywhere in `frontend/` and `backend/tests/`.

### Layer 1 — projections, so responses fit in a context window

- `GET /projects/{id}?view=summary` — no arrays at all. Per group: id, label, data
  type, marked, frozen, E0, edge step, element and edge, a parameter fingerprint,
  processing status, point count, energy range. Target: a twenty-group project under
  four kilobytes.
- `view=parameters` for the full processing recipe without data; `view=full` preserves
  today's behaviour for the frontend.
- `GET /projects/{id}/groups/{gid}/digest` — the scientific character of one spectrum
  without sending the spectrum. E0 and the method that found it, edge step, pre- and
  post-edge ranges as *effectively* used against those requested, k range with the
  usable kmax, the R-space peak positions and magnitudes, a noise estimate, glitch
  candidates, and any processing warnings. This is the answer to "what does this
  spectrum look like," and today it exists only as a picture.
- Arrays become explicit and opt-in: `GET .../arrays?names=k,chi&decimate=200&format=csv`.
  Never in a default response, ever again.

The digest is the highest-value item in this document. It is what lets the agent reason
about a spectrum instead of about a project tree.

*Built.* `GET /projects/{id}/groups/{gid}/digest`, in
`backend/xraylarch_web/agent_digest.py`, at about 560 tokens for a full
characterization. On the copper example it reports the first shell at R = 2.30 A
against a true Cu-Cu distance of 2.55 A, which is the phase shift the note beside the
peaks warns about, and it surfaces a recommended kmax of 14.6 against the 24.0 that
automatic resolution chose — the kind of discrepancy that is obvious on a plot and
otherwise invisible to a caller without one. Noise comes from the existing Demeter
chi_noise wrapper rather than a second implementation.

### Layer 2 — grounding

Two paths, because the right one depends on whether the experimental arm is a vision
model.

`POST /projects/{id}/render` returns a server-side matplotlib PNG of any plot the UI
can draw — μ(E), normalized, derivative, χ(k), |χ(R)|, the wavelet. matplotlib is
already a dependency, so this is a rendering function and a route, not a new stack.
Fixed size, deterministic styling, no interactivity.

For a text-only arm, the digest above plus a compact per-curve characterization covers
the same ground less precisely. Worth building both and measuring which the agent
actually uses well.

### Layer 3 — session semantics

- **An agent capability token.** Scoped to a set of project ids, read or write, with
  an expiry and a rate limit. A separate door from both the browser path and the v2
  integration seam, so the pinned-revision contract with Dr.XAS is untouched.
- **A transcript.** Every command an agent issues — action, options, version before
  and after, the resulting message, and the skipped-group reasons — appended and
  retrievable at `GET /projects/{id}/transcript`. This is the experiment's primary
  data. It doubles as the agent's own memory of what it has already tried, which is
  worth having on its own.

  *Built*, in `backend/xraylarch_web/agent_transcript.py`. JSON Lines beside the
  project, one record per attempted command, appended under a lock of its own so it
  never contends with the project lock. A record runs about 120 tokens; the selection
  is labelled as well as identified, so it stays legible after the opaque ids stop
  meaning anything, and point-index lists collapse to `<40 numbers, 0 .. 39>`.

  Three decisions worth knowing. It records a rejected command exactly as carefully as
  one that worked, because the error rate *is* the measurement and a log of only what
  succeeded would flatter both arms equally. The append is wrapped so that it can never
  itself be why a command fails; a dropped record shows up as a gap in the seq numbers,
  which is the honest way to find out. And an integration project keeps no transcript
  at all. That seam snapshots every file in its workspace and restores them if the
  mutation raises, so a transcript there would count against the caller's byte quota
  and be rolled back for exactly the failures most worth keeping.

- **Replay.** A transcript replays deterministically onto a fresh project. That is how
  regression evals work and how two agent runs get compared.

  *Built* on 2026-10-04, in `backend/xraylarch_web/agent_replay.py`, driven by
  `agent_suite replay transcript.jsonl --out run.json`, after which `check` and
  `report` read the replayed project like any other run. A new project mints fresh
  group ids, and a run that merged twice has two groups called `merge` with nothing in
  a label to say which one the next command meant. Nothing new had to be recorded:
  each successful record already lists the groups it `created`, in project order, and
  creation order is project order on the replay side too, so the driver keeps a map
  from recorded id to replayed id and extends it as each command creates groups. The
  selection and the options that name a group (`standard_id`, `reference_id`,
  `source_id`) go through the map before sending. What it cannot resolve it names
  rather than guesses: a record whose options were condensed to a shape, a group it
  never saw created, a command accepted then and rejected now, or a command that
  creates a different number of groups, or one under a different label, is a
  divergence, and the first one stops the replay unless told to keep going. Previews,
  rejected commands and retries answered from the record are skipped and counted. A
  gap between one record's `version_after` and the next one's `version_before` is
  reported as a change the transcript did not see, such as an import. Original
  rejections remain in the saved run for task grading. Eleven tests in
  `test_agent_replay.py`.

  `agent_suite replay-http` now handles saved HTTP FEFF/fit evidence in a private
  temporary backend. It uses the explicit setup transcript prefix, correlates
  concurrent results by call sequence, remaps group/job IDs and checks versions at
  each operation. It reruns bundled AMCSD FEFF jobs and compares their completed
  path metadata, then checks fit distances, disorder, parameter uncertainties,
  statistics, settings and concerns. Condensed inputs, missing scientific fields,
  unsupported mutations and unavailable job/setup inputs fail. The report lists
  skipped observations and distinguishes zero fitted comparisons from a fit pass.
  Athena coverage in this mode is limited to summary checkpoints; `diff` still
  provides final effective-parameter comparisons. See the
  [replay instructions and tolerances](agent-task-suite.md#replaying-feff-calculations-and-fits).

- **Idempotency keys** on `/command`, so a retry after a timeout does not merge twice.

  *Built*, as an `Idempotency-Key` header. The version check already stops the double
  merge on its own; what it cannot do is tell the caller which of the two things
  happened, because a retry after a timeout carries a version that is now stale and
  comes back as a stale-revision error blaming another tab for the caller's own write.
  A keyed retry is answered from the record instead, and says so in
  `last_operation.idempotent_replay`, which reports the project's *current* state and
  admits it may have moved on rather than pretending to be the original reply.

`version` already provides the concurrency primitive. What was missing is only that a
stale-version rejection should say what to do in the `recovery` field. *Done*: it now
names the version to resend with, in place of the generic "review the selected groups
and values", which sent a caller hunting for a mistake it had not made.

### Layer 4 — the three surfaces

All generated from Layer 0.

**Self-describing HTTP.** `GET /api/athena/capabilities` returns the catalog;
`?action=merge` returns one action's schema and examples. `GET /api/athena/agent-guide`
returns a compact operating manual — the loop to follow, the vocabulary from
`CONTEXT.md`, the preview-then-commit discipline, the version rule.

**`larchctl`.** **Built**, in `backend/xraylarch_web/larchctl.py`:

    python -m xraylarch_web.larchctl [--project ID] [--json] \
        projects | new | summary | params | digest GROUP | describe [ACTION] \
        | do ACTION [GROUP...] [-o KEY=VALUE]... [--preview]

Human-readable by default, `--json` for machines. Four things it does that the raw API
does not, each of which removes a whole class of failed turn:

- *The version is never asked for.* It is fetched immediately before the write. That
  narrows the race rather than closing it; a genuine 409 still surfaces with its message.
- *Groups are named by label.* `digest "10 K"` instead of a 24-character opaque id. An
  ambiguous prefix is refused rather than resolved, because silently picking one of two
  spectra is the kind of mistake that survives into a result.
- *`--preview` elides plotting arrays.* The ten preview endpoints return the curves they
  want drawn; a merge preview is over 200 KB raw and 4.6 KB (~1,160 tokens) after
  elision. The elision is visible — each array becomes `<611 numbers, 8786.2 .. 11352.9>`
  — so a caller can tell something was left out and ask for it another way.
- *A misremembered action is named as the problem.* `/command` validates the selection
  before it looks the action up, so `do sharpen` comes back complaining about groups and
  sends the caller off fixing something that was never wrong.

Options are JSON-typed before sending (`-o kmax=12` is the number 12), which matters
because the parameter models run Pydantic in strict mode and would reject `"12"`.

Tests are in `backend/tests/test_larchctl.py`, run against the ASGI app through
`TestClient` rather than a mocked HTTP layer — mocking here would only prove the CLI can
format a dict it was handed, which is not the part that breaks.

**A domain MCP server.** Worth separating two things you may have meant by wanting to
avoid MCP. A browser-automation MCP is a different animal from a domain one, and the
objection to the former does not carry to the latter. But for *this experiment
specifically* there is a sharper constraint: an MCP exposing thirty-five XAS tools **is** the
native-tool-calling arm, and shipping it would collapse the comparison.

The shape that preserves the experiment is roughly six generic tools — `describe`,
`inspect`, `do`, `preview`, `render`, `export` — where the agent discovers the actions
at runtime through `describe`. That keeps "the agent operates the app" true while
giving the transport ergonomics of MCP. Build it last, once the catalog has proven
itself through the CLI.

### Layer 5 — in-repo documentation

The root `AGENTS.md` covers stack startup, ports, workflow recipes and scientific
interpretation. `CONTEXT.md` defines the shared domain vocabulary.

## The harness that makes this an experiment

Without this part, the work above is a nice API and proves nothing.

- **A task suite.** Tasks phrased the way a user would phrase them, each with a
  machine-checkable assertion on the final project state: see `agent-task-suite.md`.
  Five tasks. The first run was by hand; the third and fourth ran eight blind subagent
  arms each, one CLI-only and one HTTP-only per task, and every run found interface
  defects that no amount of further design would have surfaced.
- **Two adapters** over one suite: native-tools Dr.XAS, app-driving Dr.XAS.
- **Metrics**: task success, tokens in and out, turns, wall clock, invalid commands
  issued, errors recovered from without help, and a numerical equivalence check with a
  tolerance per quantity, since the two arms run different Larch revisions (question 3).

The app-driving half of the harness exists: `backend/xraylarch_web/agent_suite.py`
sets a fresh example project up behind a metering proxy, runs each task's state
assertions with `report`, and totals requests and wire bytes up to the moment `finish`
stamps, and keeps a snapshot of the final project in the run file. `replay` rebuilds a
recorded run's project from its transcript on whatever code is checked out, so a run
that passed can be checked again after a change without paying for the arm again.
`diff` compares two final projects quantity by quantity with the tolerances the answer
assertions use (`backend/xraylarch_web/agent_diff.py`: energies within 0.1 eV, edge
steps within 0.005, k within 0.01 Å⁻¹), groups matched by label and ids compared
through label and occurrence, so duplicate names remain distinct. Dr.XAS now has
the native-tools adapter in `backend/eval/native_app_comparison.py`. The
[matched native/app comparison](agent-runs/2026-10-05-native-vs-app/README.md)
records five task pairs, and the
[native-fix verification](agent-runs/2026-10-05-native-fixes/README.md) records the
alignment and Fourier corrections it prompted. These compare configured systems,
including their libraries and instructions; they do not isolate interface design.
The [three-repeat comparison](agent-runs/2026-10-05-repeated-comparison/README.md)
retains 30 attempts and separate state, scientific and answer checks. Combined
passes were 14/15 native and 13/15 app. The
[HTTP replay verification](agent-runs/2026-10-05-artemis-replay/README.md) checks
the retained fits and final projects without new model calls.

The [October 5 baseline](agent-runs/2026-10-05/README.md) retains all ten arms'
transcripts, final snapshots and API evidence. All state checks and replay comparisons
passed; strict answer grading passed nine of ten. Read-only FEFF and fit responses
are retained for review. Command replay does not reproduce them; `replay-http`
reruns FEFF and fits from complete HTTP evidence and an explicit setup prefix.

Fixtures are already here. `examples/xafsdata` holds the Cu foil series, and the
`example` command action builds the five-group benchmark project in a single call: the
three foils, a Cu₂O reference, and the foils' shared reference.

## Sequencing

**Phase 1 — foundation.** Summary projections, the group digest, the hand-written
capability registry, `larchctl`. Nothing existing changes shape. This alone takes the
app from unusable-by-agent to usable, and it is enough to run a first version of the
experiment.

**Phase 1 is complete.** Projections, the digest, the capability registry and
`larchctl`, with 44 tests across `test_agent_views.py`, `test_agent_digest.py`,
`test_agent_actions.py` and `test_larchctl.py`, plus two proxy-allowlist tests in
`frontend/app/api/backend/[...path]/route.test.ts`. Nothing existing changed shape:
`GET /projects/{id}` still defaults to `full`, so the browser and the integration
seam's sealed snapshots are untouched.

A note on running the suite locally: on an arm64 Mac, 79 of the 4,082 backend tests
fail before any of this work, and they stay failing after it. 76 are
`test_athena_xdi_controls.py` failing because the checked-in
`larch/bin/darwin64/libxdifile.dylib` is an x86_64 build that will not load; 3 are
alignment parity tests comparing MINPACK covariance at rtol 2e-8, the roundoff class
already described in `athena-numerical-reference-portability.md`. Neither is a
regression, and CI does not see either, but anyone verifying work here should diff the
failure set against a clean tree rather than read a green/red total.

**Phase 2 — fidelity.** The render endpoint, the transcript, agent capability tokens,
idempotency keys.

**Phase 2 is partly complete.** The transcript, idempotency keys and the stale-revision
recovery hint are built, with 14 tests in `test_agent_transcript.py`, three more in
`test_larchctl.py`, and one more proxy-allowlist test. Two Phase 2 items are left.
`render` is waiting on whether the experimental arm is a vision model (question 2).
The capability token was waiting on question 1, which is now answered: loopback, so the
token need not survive a proxy hop. Replay was built on 2026-10-04; see Layer 3.

Two existing tests changed shape, both deliberately. `test_agent_actions` reads the
dispatcher through the syntax tree and had to be pointed at its new name — its
`assert dispatched` guard caught the rename, which is what it was for. And
`test_athena_difference_store`'s disk snapshot now ignores the transcript files
alongside `workspace.lock`: what a rejected command must leave unchanged is the
project, not the record of what was attempted on it.

**Phase 3 — consolidation.** Migrate `Command.options` to the discriminated union so
the catalog generates itself, build the six-tool MCP server, build the eval harness.

## Open questions

1. ~~Does the app-driving Dr.XAS arm reach this backend over loopback in one deployment,
   or across the public ingress?~~ **Loopback**, decided 2026-10-01. The Dr.XAS backend
   already reaches this one through `XrayLarchTransport` at its `internal_url`, which
   its settings validate as loopback (`backend/xraylarch_settings.py`, `allow_non_loopback`
   off by default), and the deploy refuses a host where 8006 is bound anywhere else. The
   arm runs in that backend and calls `/api/athena` and `/api/artemis` over the same
   path. The capability token therefore never crosses the ingress and can follow the
   v2 seam's HMAC design. The browser's ingress route stays as it is and is not the
   arm's door.
2. Is the experimental arm a vision model? If not, `render` drops down the list and the
   digest has to carry the whole grounding burden alone. Partly answered by the first
   task-suite run, and in a direction that sidesteps the question: T3 needed to know
   where chi(k) stops being signal, the digest's single range-averaged `epsilon_k`
   cannot say, and a k-binned signal-to-noise row would answer it in about forty tokens
   for an arm with no vision at all. Add that before deciding anything about images.
3. ~~Does the native arm compute on this same Larch backend?~~ **No**, checked
   2026-10-01. Dr.XAS's native tools call `larch.xafs` in-process, pinned to upstream
   xraylarch `c21c0a59b` (2025.2.2-26, August 2025). This backend runs its own fork of
   Larch at 2026.3.1 and later, and `larch/` has changed in 97 files between the two,
   feffit included. Dr.XAS's align is its own numpy/scipy code, not Larch's. So
   scientific equivalence is scored with a tolerance per quantity, as the task suite's
   answer assertions already are (an edge-step spread within 0.005, a distance between
   2.52 and 2.58 Å), never by matching arrays. Each run records both Larch revisions,
   and an alignment shift is compared to within 0.1 eV. A difference beyond tolerance
   is a finding about the numerics, not a failure of either arm.
4. ~~How much of the surface does the experiment actually need?~~ Moot for Phase 1. The
   worry was that describing forty actions would be too much work to do before knowing
   which ones matter; deriving the option tables from the validators made describing all
   35 cheap enough that scoping it down would have saved nothing. The question returns
   for Phase 3: the discriminated union is per-action work that does *not* collapse this
   way, so knowing the task suite would genuinely bound it.
