# Driving this app without a browser

Athena Web processes X-ray absorption spectra. This file is for an agent that has to
operate it through its HTTP API rather than through the UI — no browser, no screenshots.

If you are here to *change the code*, read `README.md` and `CONTEXT.md` instead;
`CONTEXT.md` is the domain glossary and the two of us should argue in the same words.

## Start the stack

```
PYTHONPATH=backend backend/.venv/bin/python -m uvicorn xraylarch_web.main:app \
    --port 8006
cd frontend && npm run dev -- --port 3004      # only if you need the UI
```

The API is the whole instrument: `http://127.0.0.1:8006/api/athena`. The frontend at
`3004` proxies the same routes under `/api/backend/...` behind an allowlist. Talk to
`8006` directly unless you are specifically testing the proxy.

## Always pass a view

`GET /api/athena/projects/{id}` returns the project *with every array in it*: about
240,000 tokens for the bundled five-group example, near a million for twenty groups.
`POST .../command` answers with the whole project too, and each preview with the curves
it wants drawn. All three take `?view=summary`.

| request | cost | what you get |
|---|---|---|
| `?view=summary` | ~740 tokens | every group's identity, state, E0, edge step, range, and what it was derived from |
| `POST .../command?view=summary` | ~1,000 tokens | the same summary, plus `last_operation` |
| `POST .../merge/preview?view=summary` | ~900 tokens | the preview with each curve replaced by `<611 numbers, 8786.2 .. 11352.9>` |
| `?view=parameters` | ~2,150 tokens | each group's recipe, requested against effective |
| `.../groups/{gid}/digest` | ~720 tokens | one spectrum characterised in numbers |
| `.../compare?groups=a,b,c` | ~850 tokens for five | each group against the first: shift, XANES and chi(k) differences, shared range, duplicates |
| `.../transcript` | ~120 tokens each | what has already been tried here, failures included |
| `GET /api/artemis/capabilities` | ~1,100 tokens | the fit and FEFF bodies, with their defaults |
| `GET /api/artemis/feff/jobs/{job}?view=summary` | ~170 tokens | a FEFF job's status and its paths, without the files |
| `POST /api/artemis/.../fit?view=summary` | ~800 tokens | one fit's values, per-path distances, `concerns` |
| *(no view)* | ~239,000 tokens | everything, arrays included |

## The loop

1. `GET /api/athena/capabilities`: every action in one line each, `undo` and `redo`
   among them.
2. `GET /api/athena/capabilities/{action}`: one action in full, with its options'
   types, bounds and defaults, its group selection, its preview endpoint, its traps.
3. `GET /api/athena/projects/{id}?view=summary`: what is there now, and the `version`.
4. Preview, if the action has a preview twin, with `?view=summary`. It saves nothing.
5. `POST /api/athena/projects/{id}/command?view=summary` with
   `{version, action, group_ids, options}`.
6. Read the reply. A 200 is not proof: check `processing_error`, `warnings`, and on a
   created group, `derived`. A `parameters` reply carries `last_operation.applied`, the
   value you asked for beside the value Larch used, per group and key.

A stale `version` is a 409 whose `recovery` names the version to resend. A body that
fails validation is a 422 whose `message` says what each field wanted. Nearly every
mutation is undoable with `action: "undo"`.

`GET .../transcript` lists the commands issued against the project, rejected ones with
their errors, and previews marked `preview: true`. It returns the last twenty;
`?since=<seq>` returns those after a seq you have read. Read it before retrying
something that was refused. If a command times out, do not resend it blind: the retry's
version is stale and comes back as a 409. Send an `Idempotency-Key` header instead, and
a retry under a used key is answered from the record, marked
`last_operation.idempotent_replay`.

## Or use the CLI

`larchctl --help`, with the alias below. It fetches the version, resolves groups by
label (in `group_ids` and in `standard_id`, `reference_id` and
`background_standard_id`, which take ids over HTTP), elides arrays, and prints tables.

```
alias larchctl="PYTHONPATH=backend backend/.venv/bin/python -m xraylarch_web.larchctl"
export LARCHCTL_PROJECT=$(larchctl new --name "Cu series" | head -1)
larchctl do example
larchctl summary
larchctl digest "10 K"
larchctl compare "10 K" "50 K" "300 K"
larchctl describe                    # every action
larchctl describe merge              # one action
larchctl do parameters "10 K" -o kmax=12 -o kweight=3
larchctl do merge "10 K" "50 K" -o method=demeter-larch --preview
larchctl do rebin "10 K" --key retry-1
larchctl export "10 K" --space k --out chi.csv
larchctl log --since 4
```

- `--json`, before or after the subcommand, prints JSON. Arrays stay elided unless you
  add `--arrays`.
- `-o key=value` reads the value as JSON, then as a bare string: `-o kmax=18`,
  `-o reference_id=null` and `-o exclude_short_data=false` arrive typed, and
  `-o window=hanning` needs no quotes.
- A label matches a whole group label first, then a whole part between its `·`s
  ("300 K" is "Cu foil · 300 K", not a merge whose label lists 300 K), then any
  unambiguous part.
- After a command it prints `+` for a group created, `-` for one removed, and `~` for
  each field moved on a group it kept, such as `energy_shift 0.000->-2.959`.

## Reading numbers correctly

**Requested is not effective.** You ask for `kmax`; Larch clips it to the data and uses
something else. `?view=parameters` and the digest report both side by side, and the CLI
prints `auto->25.019` when nothing was asked for and `18.000` when a value was honoured.
Compare against the effective value.

**Ranges are on the shifted axis.** An energy range already has `energy_shift` folded
in, and `energy_shift` is reported beside it.

**|chi(R)| peaks are not bond lengths.** The digest applies no phase correction, so a
peak sits roughly 0.2–0.5 Å below the true distance. Peaks are for recognising
structure; fit for distances (below).

**Choosing a kmax.** A wide gap between `kmax` and `available_kmax` means the transform
runs into data a plot would show as noise. The digest's `signal_to_noise` bins rms chi(k)
in 2 Å⁻¹ windows against a floor measured over the whole k support, so it does not move
when the transform range does; a window near 1 is noise. The ratios compare windows
within one group, not groups with each other, since each group has its own floor.
`noise.epsilon_k` and `noise.recommended_kmax` are Larch's, measured over the current
transform range: the first moves with that range, and the second runs pessimistic.
When `noise.recommended_kmax_applicable` is false, the `parameters` command would refuse
that kmax as it stands; `noise.warnings` says whether it lies past the measured k or below
the saved kmin.

**To ask whether groups are comparable, compare them.** `GET .../compare?groups=a,b,...`
measures each group after the first against the first, reading and never applying:

- `energy_shift`: the shift align would fit now, relative to the group's current one.
  It works on linked groups that align refuses to move.
- `e0_difference` and `edge_step_ratio`.
- `xanes_max_difference`: the largest |norm difference| from E0 −20 to +50 eV.
- `common_range`: the energy support the two share.
- `chi_amplitude`: rms of k-weighted chi(k) against the first group, per 2 Å⁻¹ window.
  A ratio falling with k is Debye–Waller damping.
- `same_data_as`: groups holding the identical measurement.

**The same file twice is the same measurement.** The summary's `same_data` lists groups
whose raw arrays are identical. Each group carries the `file` it was read from, and the
digest its `citation`, which says where and when it was measured.

### Aligning

**Linked groups move together, so align refuses them.** Groups whose `reference_id`
points at one reference are one family; a shift to one shifts them all. Align will not
move a group in the standard's family, and refuses the command when nothing else is
left: "The alignment standard and its linked references stay fixed." `larchctl summary`
shows the link as `ref:<label>`. Unlink first with `assign_reference` and
`reference_id: null`, which is undoable, or measure the shift without moving anything
with `compare`.

Send `operation: "auto"` to the preview and the command alike; `/command` refuses
`'inspect'`, the preview's default. The standard never moves, so it can be in
`group_ids` or not.

**Alignment does not move E0.** As in native Athena, it changes `energy_shift` and pins
each moved group's E0 where it was, which leaves E0 the shift away from the edge, and
the edge step can move slightly. Send `parameters` with `e0: null` afterwards to find
E0 again. Read the original edge steps before aligning if you will be asked about them.

### Merging

**Always send `method: "demeter-larch"`.** Without it the command takes an older plain
average, and the preview refuses.

**What you selected is not what a merge used.** `exclude_short_data` defaults to true:
any group more than 10 points shorter than the *first* selected is dropped, and the
command still succeeds. The new group's `derived` names the parents it used, each
`excluded` group with its reason, and the `array` it averaged; so does
`last_operation.merge.outputs[].excluded`, and `larchctl` prints `EXCLUDED`. To keep a
short scan, send `exclude_short_data: false` or select it first.

**Do not truncate before merging.** The merge covers only the energy range every member
shares, so cutting the longer scans to the shorter one's range first gives the same
values. It does not equalise point counts either, so it does not stop the exclusion.

**`mu` or `norm`.** `array: "mu"` averages absolute absorption, so members with
different edge steps pull the average towards the larger. `array: "norm"` averages
after each member is normalized, and the merge's edge step reads about 1. The label is
"merge" either way, so say which you chose.

**Preview to see whether the members agree.** Under `?view=summary` each output carries
`agreement`: the median and largest scatter, and each member's rms from the merge, as
fractions of the merged range. A member far above the others is the one that does not
belong. Compare shapes as `norm`; as `mu`, differing absolute absorption swamps them.

If no member is linked to a reference, there is no reference channel to merge, and the
reply says "Reference channels were not merged".

## Distances come from a fit

Artemis fits FEFF paths to a group's chi(k). A path's fitted `r` (reff + deltar) is a
distance with the scattering phase accounted for. `POST
/api/artemis/projects/{id}/groups/{gid}/fit?view=summary` takes `{version, parameters,
paths, transform}`, and `GET /api/artemis/capabilities` describes each field with its
default and bounds. The summary gives statistics, each parameter with its stderr,
correlations of 0.1 or more, and per path its scatterers, degeneracy, reff, r and
sigma2. The fit saves nothing.

**"Fit succeeded" means the minimiser stopped.** Read `concerns`: an R-factor above
0.05 (under about 0.02 is good), more variables than independent points, a correlation
above 0.9, or a parameter `at_bound`, whose stderr then means nothing.

**The route's transform is not the group's.** It defaults to k 3–12, kweight
[0,1,2,3], dk 2, R 1–3, fitspace r, whatever the group's kmax. `kweight` is a list even
for one weight. FEFF's paths stop at k 20.

A path is either a FEFF file, `{id, filename, content}`, or a path of a FEFF job named
by reference, `{id, feff_job, feff_path: "feff0001"}`. Paths come from:

- `GET /api/artemis/examples/cuprite`: a complete body for the example's Cu₂O group.
  Send its `paths` (each with an `id` added and `metadata` removed), `parameters` and
  `transform`.
- FEFF on a bundled structure. `GET /api/artemis/structures?q=copper&element=Cu`
  searches them, each result with its `cell` and `measured_at`: the temperature (K)
  and pressure (GPa) its title states, null where it states none. Pick an entry
  measured near your sample's conditions; the fit's `del_r` absorbs a small
  mismatch, but not a different phase. `GET /api/artemis/structures/{amcsd_id}` lists
  the sites, and `POST
  /api/artemis/feff/jobs` with `{amcsd_id, absorber, site_index, path_radius}` runs
  FEFF in about a second. `site_index` counts from 1. Poll `GET
  .../feff/jobs/{job}?view=summary` until `status` is `complete`, then name its
  `paths[].id` in the fit. There is no need to read the 20 KB full reply. Jobs are
  kept 24 hours. Send the POST with `?view=summary` too: a request identical to one
  that completed in the last 23 hours runs no FEFF, and comes back complete, status
  200, marked `reused`.
- Your own `feffNNNN.dat` files.

The CLI does all of it:

```
larchctl fit "Cu2O" --example cuprite
larchctl structures copper --element Cu
larchctl fit "10 K" --structure 11145             # FEFF to 3 Å, then the fit
larchctl fit "10 K" --structure 11145 --fix amp=0.9 -t kmax=14 -t kweight=2
larchctl fit "10 K" --structure 11145 --vary kmax=14,16,18 --vary del_e0=3,9
```

The default guesses are `amp`, `del_e0`, `del_r` and `sig2`; `-p name=value` moves a
guess's start, `--fix name=value` holds it, and `larchctl fit --help` lists their
bounds. Unlike the route, the CLI takes the group's k window once the group's kmax has
been set, cut to FEFF's k 20, and prints where each range came from. `-t` overrides
either.

`--vary` answers "how far to trust it". It runs FEFF once and refits per value, with a
transform key changed or a parameter held, and tabulates the first path's r, sigma2,
S0², E0 and R-factor with the spread of r per key. A distance usually moves more when
del_e0 is held either side of its best value than when the k range changes, because of
the del_e0/del_r correlation. That spread, not the stderr, says how far to trust it.

## Bug reports

`POST /api/bug-reports` (multipart) files a report to the local bug library at
`XRAYLARCH_DATA_ROOT/bug_reports/<report_id>/`. Fields: `description` (required,
≤64 KiB), `type` (`bug` | `feature_request` | `feedback`), `user_email`
(required), optional `project_id` plus `attach_project=true` to have the backend
write the project's `example` export beside the report, optional JSON strings
`project_state` and `client_metadata`, and file lists `screenshots` (≤5, 5 MiB
each) and `attachments` (≤10, 25 MiB each). Invalid input answers 400 with error
code `bug_report_invalid` and the offending field names; the whole body is capped
by `XRAYLARCH_BUG_REPORT_MAX_BYTES` (default 100 MB). The answer is
`{"status": "success", "report_id": ..., "project_export_attached": bool}`.
Reports are never read back through the API; look at `report.json` on disk.
Slack notification is off unless `XRAYLARCH_SLACK_BOT_TOKEN` and
`XRAYLARCH_BUGREPORT_SLACK_CHANNEL` are both set.

## What you cannot get

No arrays, from any view above. `GET .../groups/{gid}/export?space=E|k|R|q` returns a
file, and `larchctl export` writes it to disk rather than into your context. Ask for
the digest first: it usually answers what the arrays were wanted for.
