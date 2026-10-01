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

## The one rule that will bite you

`GET /api/athena/projects/{id}` returns the project *with every array in it*. For the
bundled five-group copper example that is 957 KB, about 239,000 tokens. A twenty-group
project approaches a million. It stays the default because the browser needs it.

The writes are no better. `POST .../command` answers with the whole project too, about
a megabyte after a merge, and each preview answers with the curves it wants drawn,
120–220 KB of them.

**Always pass a view.** `?view=summary` works on all three: the project read, the
command, and every preview.

| request | example cost | what you get |
|---|---|---|
| `?view=summary` | ~740 tokens | every group's identity, state, E0, edge step, range, and what it was derived from |
| `POST .../command?view=summary` | ~1,000 tokens after a merge | the same summary, plus `last_operation` |
| `POST .../merge/preview?view=summary` | ~900 tokens | the preview with each curve replaced by `<611 numbers, 8786.2 .. 11352.9>` |
| `?view=parameters` | ~2,150 tokens | each group's recipe, requested against effective |
| `.../groups/{gid}/digest` | ~720 tokens | one spectrum characterised in numbers |
| `.../compare?groups=a,b,c` | ~850 tokens for five | each group against the first: shift, XANES and chi(k) differences, shared range, duplicates |
| `POST /api/artemis/.../fit?view=summary` | ~800 tokens | one fit's values, per-path distances |
| `.../transcript` | ~120 tokens each | what has already been tried here, failures included |
| *(no view)* | ~239,000 tokens | everything, arrays included |

## The loop

1. `GET /api/athena/capabilities` — 36 actions under `actions`, one line each,
   ~1,650 tokens. `undo` and `redo` are among them.
2. `GET /api/athena/capabilities/{action}` — one action in full: its options with types,
   bounds and defaults, its group selection, its preview endpoint, its traps.
3. `GET /api/athena/projects/{id}?view=summary` — what is there now, and the `version`.
4. Preview if the action has a preview twin, with `?view=summary`. It changes nothing
   and costs no version.
5. `POST /api/athena/projects/{id}/command?view=summary` with
   `{version, action, group_ids, options}`.
6. Read the reply. Do not trust that it worked because the POST returned 200: check
   `processing_error`, `warnings`, and on a created group, `derived`. A `parameters`
   reply also carries `last_operation.applied`: for each selected group and each key you sent, the
   value you asked for and the value Larch used.

`version` must be the project's current version. A stale one is a 409 whose `recovery`
names the version to resend with. Nearly every mutation is undoable: `action: "undo"`.

## What you have already tried

`GET /api/athena/projects/{id}/transcript` returns every command issued against this
project, with its action, its groups by label, its options, the version either side,
and what it created or skipped. Rejected commands are in there too, carrying their
error, which is the part worth reading. Finding out why `deglitch` refused last time
costs less than being refused again.

Previews are recorded as well, marked `preview: true` and carrying no version_after
because they saved nothing. Count them out if you want the commands alone; read them
if you want to know which bodies were already refused.

It defaults to the last twenty records. `?since=<seq>` returns the records after that
seq, not including it: pass the last seq you have read, which is how a long run stays
cheap.

If a command times out and you cannot tell whether it landed, don't resend it blind.
The retry carries a version that is now stale, so it comes back as a 409 blaming
another tab for your own write. Send an `Idempotency-Key` header instead: a retry under
a key already used is answered from the record rather than run a second time, and the
reply says so in `last_operation.idempotent_replay`.

## Or just use the CLI

```
python -m xraylarch_web.larchctl --help
```

It does steps 3 and 5 for you — fetches the version, resolves groups by label (in
`group_ids` and in the options that name a group: `standard_id`, `reference_id`,
`background_standard_id`; over HTTP those take ids), strips
plotting arrays out of previews, and prints tables instead of JSON. `--json` gives the
response as JSON and still elides the arrays; `--arrays` is how you ask for them.

```
export LARCHCTL_PROJECT=$(python -m xraylarch_web.larchctl new --name "Cu series" | head -1)
python -m xraylarch_web.larchctl do example
python -m xraylarch_web.larchctl summary
python -m xraylarch_web.larchctl digest "10 K"
python -m xraylarch_web.larchctl compare "10 K" "50 K" "300 K"
python -m xraylarch_web.larchctl describe            # step 1: every action
python -m xraylarch_web.larchctl describe merge      # step 2: one action
python -m xraylarch_web.larchctl do parameters "10 K" -o kmax=12 -o kweight=3
python -m xraylarch_web.larchctl do merge "10 K" "50 K" -o method=demeter-larch --preview
python -m xraylarch_web.larchctl do rebin "10 K" --key retry-1
python -m xraylarch_web.larchctl export "10 K" --space k --out chi.csv
python -m xraylarch_web.larchctl log --since 4
```

`--json` on any command prints it as JSON instead of a table, before or after the
subcommand. It does not turn the array elision off; `--arrays` does that.

## Reading numbers correctly

**Requested is not effective.** You ask for `kmax`; Larch clips it to the measured
support and processes with something else. Both are reported, separately, everywhere —
`?view=parameters` and the digest keep them in adjacent fields, and the CLI prints
`auto->25.019` when nothing was asked for versus `3.000` when it was honoured. If you
compare against the requested value you will conclude the wrong thing.

**The digest's |chi(R)| peaks are not bond lengths.** No phase correction is applied, so
each peak sits roughly 0.2–0.5 Å below the true shell distance. Copper foil's first
shell reports at 2.30 Å against a true Cu–Cu distance of 2.55 Å. Fit if you need
distances (below); the peaks are for recognising structure, not measuring it.

**Ranges are reported on the shifted axis.** For energy spectra the reported range
already has `energy_shift` folded in. `energy_shift` is reported alongside, so the
measured axis can be recovered.

**Check `available_kmax` against `kmax`.** A large gap means the transform is using data
that a plot would show as noise. This is obvious visually and invisible otherwise.

**Read the digest's `signal_to_noise` before choosing a kmax.** It bins rms chi(k) in
2 Å⁻¹ windows against a noise floor measured over the whole k support, so the ratios
do not move when you move the transform range. A window whose ratio is near 1 is noise.
On the bundled 10 K copper scan it reads 130 at k 3–5 and 0.3 at k 23–25, which is the
whole argument for cutting a default kmax of 24 back to about 18. The `epsilon_k` under
`noise` is a different number: Larch measures it over the current transform range, so
it moves when that range does.

**What you selected is not what a merge used.** With `method: "demeter-larch"`,
`exclude_short_data` defaults to true, and any group more than 10 points shorter than
the *first* one selected is dropped without failing the command. Merging the three
copper foil scans leaves out the 300 K one, which is 204 points short. The new group's
`derived` field names the parents it actually used and lists each `excluded` group with
its reason, and so does `last_operation.merge.outputs[].excluded` in the command reply;
`larchctl` prints them as `EXCLUDED`. To keep a short scan, send
`exclude_short_data: false` or select it first. Truncating the long scans to the same
energy range is not enough, because it does not equalise their point counts. Keeping
it has a cost of its own: the merge covers only the energy range every member shares,
so here it stops at 10134 eV where the cold scans alone run to 11362. That also means
there is no need to truncate the long scans to the short one's range before merging:
the merge already does it. On the example, truncating the cold scans at 10146 eV first
gives the same merged values point for point, one point shorter at the top.

**Preview a merge to see whether its members agree.** Under `?view=summary` each output
of the merge preview carries `agreement`: the median and largest scatter, and each
member's rms distance from the merge, all as fractions of the merged curve's range. One
member far above the others is the one that does not belong. On the example's three
foils merged as `norm`, the 300 K scan reads 0.038 against 0.019 for the cold ones,
and the largest scatter is 0.20 of the range, at the edge, because the 300 K scan has
not been aligned. Merged as `mu`, every member reads 0.23 or more, because the scans
differ in absolute mu; compare shapes with `array: "norm"`. `larchctl do merge ...
--preview` prints this as a table.

Always send `method: "demeter-larch"` to merge. Without it the command takes an older
plain average that excludes nothing, and the preview refuses, because it cannot show
that average.

**The same file twice is the same measurement.** The summary's `same_data` lists the
groups whose raw arrays are identical, one list per measurement; `larchctl summary`
prints it as `same data: A = B`. Each group also carries the `file` it was read from,
and the digest carries its `citation`. In the example, "Cu foil · 300 K" and "Cu foil ·
shared reference" are one measurement from `cu_rt01.xmu`, so the foils' shared reference
is a copy of the 300 K scan, and the citation says the 300 K scan was taken at a
different beamline, nine years after the other two.

**To ask whether groups are comparable, compare them.** `GET .../compare?groups=<id>,<id>,...`
(`larchctl compare "10 K" "50 K" "300 K"`) measures every group after the first against
the first, with no arrays:

- `energy_shift`: the shift align would fit now, relative to the group's current one.
  It is read, not applied, so it works on linked groups that align refuses to move.
- `e0_difference` and `edge_step_ratio`.
- `xanes_max_difference`: the largest |norm difference| from E0 −20 to +50 eV.
- `common_range`: the energy support the two share.
- `chi_amplitude`: rms of k-weighted chi(k) against the reference, per 2 Å⁻¹ window.
- `same_data_as`: the groups that hold the identical measurement.

On the example, 50 K reads a −0.018 eV shift, a 0.009 XANES difference and chi ratios of
0.87–1.01. 300 K reads −2.959 eV and 0.384, and chi ratios fall from 0.80 at k 3–5 to
0.08 at k 15–17.45: an energy offset and a Debye–Waller damping, on 1200 eV less data.

**Linked groups move together, so align refuses them.** In the example, the three foil
scans all carry `reference_id` pointing at "Cu foil · shared reference", which puts them
in one family. A shift applied to one shifts them all, so align will not move a group
that shares the standard's reference, and when nothing else is left it refuses the
command with "The alignment standard and its linked references stay fixed." `larchctl
summary` shows the link as `ref:<label>`. To align the scans to each other, first send
`assign_reference` on them with `reference_id: null`. The preview refuses linked groups
too; to measure the shift without unlinking, use `compare`. The unlink is undoable.

**Alignment does not move E0.** It changes `energy_shift` and pins each moved group's E0
at the value it had before, as native Athena does. After aligning the 300 K scan by
−2.959 eV its E0 still reads 8980.50, about 3 eV above its edge on the shifted axis, and
its edge step moves from 2.729 to 2.717. If you want E0 found again on the shifted data,
send `parameters` with `e0: null` afterwards.

**Signal-to-noise ratios compare windows within a group, not groups.** Each group's
floor is measured over its own k support, so the 300 K scan reading 269 at k 3–5
against the 10 K scan's 130 does not make it the cleaner scan. Compare where each
group's ratios fall towards 1. The digest's `noise.recommended_kmax` is Larch's own
estimate, measured over the current transform range and pessimistic by Larch's own
account; on the 10 K scan it says 14.6 where the ratios say about 18.

## Distances come from a fit

Artemis fits FEFF paths to a group's chi(k), and a path's fitted `r` (reff + deltar) is a
distance with the scattering phase accounted for. The route is
`POST /api/artemis/projects/{id}/groups/{gid}/fit?view=summary` with
`{version, parameters, paths, transform}`; each path carries the FEFF file's text as
`content`. Without `?view=summary` the reply is about 250 KB of curves; with it, about
2.5 KB: statistics, each parameter with its stderr, correlations of 0.1 or more, and
per path its scatterers, degeneracy, reff, r and sigma2. A parameter that stopped at
its bound is flagged `at_bound`; its stderr then means nothing. The fit saves nothing.

FEFF paths come from one of three places:

- `GET /api/artemis/examples/cuprite` returns a complete setup for the example's Cu₂O
  group: four paths, four guesses, the ranges. Send its `paths` (each with an `id`
  added, `metadata` removed), `parameters` and `transform` as the fit body.
- `GET /api/artemis/structures?q=copper&element=Cu` searches the bundled AMCSD
  structures, and `POST /api/artemis/feff/jobs` with `{amcsd_id, absorber, site_index,
  path_radius}` runs FEFF on one, in about a second. Poll `GET .../feff/jobs/{job}`
  until `status` is `complete`; its `paths` hold the files. The status reply is about
  20 KB because it carries the CIF and the FEFF log as well.
- Your own `feffNNNN.dat` files.

The CLI does all of it:

```
larchctl fit "Cu2O" --example cuprite
larchctl structures copper --element Cu
larchctl fit "10 K" --structure 11145             # FEFF to 3 Å, then the fit
larchctl fit "10 K" --structure 11145 --fix amp=0.9 -t kmax=14
```

On the 10 K copper foil the structure fit gives Cu–Cu at 2.547 Å with sigma2 0.0038 Å²,
where the digest's peak sat at 2.30. The four default guesses are `amp`, `del_e0`,
`del_r` and `sig2`, with the bounds Artemis starts from; `-p name=value` moves a
guess's start and `--fix name=value` holds it.

## What you cannot get

No arrays, by design, from any of the views above. If you genuinely need the numbers,
`GET .../groups/{gid}/export?space=E|k|R|q` gives you a file, and `larchctl export` does
the same and writes it to disk rather than into your context. Ask for the digest first —
it usually answers the question the arrays were going to be used for.
