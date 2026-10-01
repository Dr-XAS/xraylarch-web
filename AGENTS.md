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
bundled four-group copper example that is 765 KB, about 191,000 tokens. A twenty-group
project approaches a million. It stays the default because the browser needs it.

The writes are no better. `POST .../command` answers with the whole project too, about
a megabyte after a merge, and each preview answers with the curves it wants drawn,
120–220 KB of them.

**Always pass a view.** `?view=summary` works on all three: the project read, the
command, and every preview.

| request | example cost | what you get |
|---|---|---|
| `?view=summary` | ~570 tokens | every group's identity, state, E0, edge step, range, and what it was derived from |
| `POST .../command?view=summary` | ~1,000 tokens after a merge | the same summary, plus `last_operation` |
| `POST .../merge/preview?view=summary` | ~900 tokens | the preview with each curve replaced by `<611 numbers, 8786.2 .. 11352.9>` |
| `?view=parameters` | ~1,720 tokens | each group's recipe, requested against effective |
| `.../groups/{gid}/digest` | ~700 tokens | one spectrum characterised in numbers |
| `.../transcript` | ~120 tokens each | what has already been tried here, failures included |
| *(no view)* | ~191,000 tokens | everything, arrays included |

## The loop

1. `GET /api/athena/capabilities` — 35 actions, one line each, ~1,710 tokens.
2. `GET /api/athena/capabilities/{action}` — one action in full: its options with types,
   bounds and defaults, its group selection, its preview endpoint, its traps.
3. `GET /api/athena/projects/{id}?view=summary` — what is there now, and the `version`.
4. Preview if the action has a preview twin, with `?view=summary`. It changes nothing
   and costs no version.
5. `POST /api/athena/projects/{id}/command?view=summary` with
   `{version, action, group_ids, options}`.
6. Read the reply. Do not trust that it worked because the POST returned 200: check
   `processing_error`, `warnings`, and on a created group, `derived`.

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

It defaults to the last twenty records. `?since=<seq>` returns only what you have not
read yet, which is how a long run stays cheap.

If a command times out and you cannot tell whether it landed, don't resend it blind.
The retry carries a version that is now stale, so it comes back as a 409 blaming
another tab for your own write. Send an `Idempotency-Key` header instead: a retry under
a key already used is answered from the record rather than run a second time, and the
reply says so in `last_operation.idempotent_replay`.

## Or just use the CLI

```
python -m xraylarch_web.larchctl --help
```

It does steps 3 and 5 for you — fetches the version, resolves groups by label, strips
plotting arrays out of previews, and prints tables instead of JSON. `--json` gives the
response as JSON and still elides the arrays; `--arrays` is how you ask for them.

```
export LARCHCTL_PROJECT=$(python -m xraylarch_web.larchctl new --name "Cu series" | head -1)
python -m xraylarch_web.larchctl do example
python -m xraylarch_web.larchctl summary
python -m xraylarch_web.larchctl digest "10 K"
python -m xraylarch_web.larchctl describe merge
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
distances; the peaks are for recognising structure, not measuring it.

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
energy range is not enough, because it does not equalise their point counts.

## What you cannot get

No arrays, by design, from any of the views above. If you genuinely need the numbers,
`GET .../groups/{gid}/export?space=E|k|R|q` gives you a file, and `larchctl export` does
the same and writes it to disk rather than into your context. Ask for the digest first —
it usually answers the question the arrays were going to be used for.
