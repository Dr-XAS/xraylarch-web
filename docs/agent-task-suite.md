# Task suite: the first version of the experiment

Written 2026-09-18. Companion to `agent-interface-scope.md`, which argues that without
this file the interface work "is a nice API and proves nothing."

Four tasks, phrased the way someone with spectra would phrase them. Each carries two
kinds of assertion. A **state** assertion is machine-checkable from `?view=summary`,
`?view=parameters` or a group digest, so it can be run unattended. An **answer**
assertion is on the prose the arm returns, and needs a grader, though most of it
reduces to a number that either matches the project or doesn't.

Every task starts from a fresh project with the bundled copper series loaded, which is
one command: `example`. The three foil scans are Cu foil at 10 K, 50 K and 300 K. The
300 K scan differs from the other two in three ways that matter, and the suite leans
on all of them.

Since 2026-10-01 the example has five groups, not three. Beside the foils it loads a
Cu₂O reference and an unmarked "Cu foil · shared reference", and all three foils carry a
`reference_id` that points at that shared reference. The state counts below are for the
five-group fixture. Runs from before that date used three groups and are not directly
comparable on turns or tokens.

## Metrics

Recorded per task, per arm.

| metric | where it comes from |
|---|---|
| success | the state assertions, run against the final project |
| turns | HTTP requests issued, `GET` included |
| commands rejected | transcript records with `ok: false`, previews included since they carry `preview: true` and can be counted out |
| recovered without help | a rejected command followed by a successful one, same action |
| silent wrong state | a failed state assertion that the answer does not admit to |
| tokens | response bytes over four, summed |
| wall clock | measured around the run |

The transcript gives four of these six for free, which is what it was built for.

## T1 — Which one is the odd one out

> I have three copper foil scans taken at different temperatures. Before I do anything
> with them, tell me whether they're comparable, and if one of them isn't, why.

Read-only. It measures whether the digest and the summary carry enough grounding to
substitute for looking at a plot, which is open question 2 asked empirically.

**State:** the project is at the version it started at, with five groups and no
transcript record whose `ok` is false.

**Answer:** names Cu foil · 300 K, and gives at least two of these three facts with
numbers: its E0 is about 3 eV above the others (8980.5 against 8977.6), its edge step
is about 19% larger (2.73 against 2.29), its energy axis stops at 10146 eV where the
others run past 11360.

## T2 — Align, merge, and quantify the spread

> Align all three scans to the 10 K one, merge them, and tell me how much the edge step
> varies across the three originals.

The scope document's own example task, cut down. It's the shortest path that touches a
multi-group action, a derived number, and an action whose required option isn't
guessable from its name.

**State:** six groups; the new one's `derived.parents` in `?view=summary` is exactly
the three originals; the 50 K and 300 K groups carry a nonzero `energy_shift` and the
10 K group does not.

The foils are linked to the shared reference, so align refuses them as one family until
the arm unlinks them with `assign_reference` and `reference_id: null`. That refusal is
expected, and recovering from it is what the "recovered without help" metric counts.
After unlinking, the shifts come out as before: −0.018 eV for 50 K and −2.959 eV for
300 K.

The default merge drops the 300 K scan as too short (see "After the second run" below),
so passing means the arm noticed and merged again with `exclude_short_data: false`. Do
not read the parents off the transcript: it records the selection that was sent, and
that is the check both earlier runs got wrong. An arm that leaves the two-group merge in
place but says the 300 K scan was excluded still fails, and it is counted as a reported
failure rather than a silent one.

**Answer:** reports a spread within 0.005 of `max(edge_step) - min(edge_step)` over the
three originals, which is 0.439 on the current fixture. Reporting the spread after
alignment instead is also acceptable if the arm says that's what it did.

## T3 — The transform is using noise

> The EXAFS Fourier transform on the 10 K scan is running out to k = 24, and the data up
> there is noise. Bring the k range in to where the data is real, then tell me where the
> first shell sits.

The requested-against-effective trap, live. Nothing was asked for, so `kmax` reports as
`auto->24.000` against an `available_kmax` of 25.00, and an arm that reads only the
first number concludes the transform is fine.

**State:** the 10 K group's effective `kmax` is below 24 and at most `available_kmax`;
`kmin` is unchanged at 3.0; no other group's parameters moved.

**Answer:** gives the first |chi(R)| peak position, which sits near 2.30 Å, and says
that it is below the true Cu–Cu distance because no phase correction is applied. An
answer that reports 2.30 Å as the bond length fails, regardless of state.

## T4 — Make them comparable first

> The 300 K scan is shorter than the other two. Cut the long ones down to match before
> merging, so the merge isn't averaging three points against two at the top end.

A numeric feedback loop. The arm has to read a number out of one group, feed it into an
action on two others, then confirm it landed. `truncate` has a preview, so an arm that
uses the preview should reach this in fewer rejected commands than one that doesn't.

**State:** the three original groups' energy ranges end within 15 eV of each other; four
groups; the merge's `derived.parents` is exactly the three truncated originals.

This one has a second trap behind the first. Matching the energy ranges does not match
the point counts: the truncated scans keep 460 and 468 points against the 300 K scan's
408, so the default merge still drops it. Passing needs `exclude_short_data: false`, a
`short_data_margin` of at least 60, or the 300 K scan selected first. Groups are only
measured against the first one selected, so with the shortest scan first nothing is
excluded and the merge lands on its grid, ending at 10139 eV. The threshold was 10 eV when this
was drafted, and the first run missed it at 11.54 eV because `truncate` snaps to the
nearest measured point and the two long scans are on a coarser grid up there than the
300 K one. Fifteen is the honest number for a cut that lands on real data.

**Answer:** states the energy it truncated at, within 15 eV of 10146.

## What this suite does not cover

No fitting, no LCF or PCA, no import of anything that isn't the bundled example, and
nothing touching the twelve actions that exist for file-format repair. That's deliberate
for a first run. If the app-driving arm can't do these four, widening the suite measures
nothing new, and if it can, the next version should add a task per analysis route.

## First run, 2026-09-18

One arm only. I drove the suite by hand through `larchctl` against a local backend,
using nothing but `describe`, `summary`, `digest`, `log`, the previews and one array
export. No backend source was read while running. This is a shakedown of the interface
rather than a measurement of anything, since there's no second arm to compare against
yet, but it found more than I expected.

| task | state assertions | turns | rejected | response bytes |
|---|---|---|---|---|
| T1 odd one out | pass | 5 | 0 | 1,903 |
| T2 align and merge | pass | 14 | 1 | 181,577 |
| T3 transform | pass | 8 | 0 | 35,963 |
| T4 truncate and merge | pass after loosening the threshold | 10 | 0 | 7,090 |

T1 is the number worth looking at. Two reads answered "are these comparable", at 1,357
bytes, against the 590 KB that the same question costs without a view. The 300 K scan
is visibly the outlier from the summary table alone: E0 8980.50 against 8977.58, edge
step 2.729 against 2.290, and an axis that stops at 10146 eV where the others run past
11360. Nothing needed a picture.

T2's 181,577 bytes are almost entirely one mistake, described below. Without it the
task cost 11,103.

### What the run found

**`--json` on a preview skips the array elision.** One command, `--json do align ...
--preview`, returned 170,474 bytes, roughly 42,000 tokens. The same preview without
`--json` returns 1,459 bytes with every array replaced by `<620 numbers, 8782.35 ..
11362.5>`. `--json` is documented as the raw response and it is behaving as documented,
but a flag that silently multiplies a response by 117 is the worst thing an arm can
reach for by accident in a tool whose entire purpose is protecting a context window.
Elide under `--json` too, or refuse the combination.

**The `align` capability note steers you into a wall.** It says to preview with
`operation='inspect'` first. Doing that refuses a two-group selection outright, and
when narrowed to one group it returns `energy_shift: 0` for both scans, including the
one that needs -2.959 eV. An arm that trusted it would conclude the series is already
aligned. Previewing with `operation='auto'` accepts the whole selection and reports the
real shifts. The note should say so.

**A rejected preview leaves no trace.** The transcript for T2 holds four records, all
successful, because previews don't go through `/command`. So "commands rejected" as a
metric misses every rejection in the look-before-you-leap path, which is exactly where
an arm that's guessing will spend its time. Either previews get recorded or the metric
gets renamed to something it can actually count.

**`energy_shift` is in the summary JSON and not in the CLI table.** After aligning, the
table shows the 300 K scan's E0 unchanged at 8980.50 and its range moved by three eV,
with nothing saying why. The one field that proves the alignment happened is reachable
only through `--json`.

**A merge doesn't record what it merged.** No field in the project names the
contributing groups, so the T2 assertion about the merge covering three originals is
uncheckable from project state. It's checkable from the transcript, which stores the
selection by label. That's a point for the transcript and a warning against writing
assertions that assume project state is self-describing.

**`truncate` has eight modes and no per-value meaning.** `describe truncate` lists
`inspect | point | indices | points | range | margins | truncate | interval` and three
overlapping coordinate pairs (`xmin/xmax`, `emin/emax`, `point/value`) with no
indication of which goes with which. `mode=truncate, side=after, value=10146` worked on
the first guess, and I don't think that was skill.

### T3 partly answers open question 2

The scope document asks whether the experimental arm is a vision model, on the grounds
that if it isn't, `render` matters less and the digest carries the grounding alone. T3
says the digest can't carry it, for a reason that has nothing to do with vision.

Deciding where to cut the k range means knowing where chi(k) stops being signal. The
digest reports `epsilon_k`, one number averaged over the whole transform range, and it
moves when the range moves: 0.000436 at kmax 24, and 0.00111 after I cut to 16. It
cannot locate the crossing. The only way through was `GET .../groups/{gid}/export?
space=k`, 28,949 bytes of CSV, which also has no `larchctl` subcommand, so it took a
raw curl. Binned against the noise, the answer is clear enough:

```
 k window   rms chi   rms/eps
  8-10      0.03825      87.7
 12-14      0.00733      16.8
 16-18      0.00151       3.5
 18-20      0.00067       1.5
 20-22      0.00032       0.7
```

Everything past k = 18 is noise, and the default kmax of 24 was using it.

Six numbers would have answered this in the digest at a cost of maybe forty tokens. A
k-binned signal-to-noise row is cheaper than `render`, works for an arm with no vision
at all, and is the sort of thing a plot is normally used to eyeball. It should go in
before anything is decided about images.

### What to change next

Ranked by what the run actually showed, not by what the scope document predicted.

1. Elide arrays under `--json`, or refuse `--json --preview`.
2. Add the k-binned signal-to-noise to the digest.
3. Fix the `align` note, and say which modes `truncate`'s eight values mean.
4. Put `energy_shift` in the CLI summary table, and give `export` a subcommand.
5. Record preview rejections, or stop claiming the transcript counts rejected commands.

None of these is a day's work, and all five are things no amount of further design would
have turned up.

## Second run, 2026-09-18

Same four tasks against the same fixture, driven through `larchctl` with the backend on
port 8006, after the five changes above went in. Two things about the numbers before
the numbers.

I wrote the fixes, so this isn't the blind run the first one was. Where the first run
paid for guessing, I paid for nothing, and the turn counts below are floors rather than
estimates of what an unprimed arm would spend. What survives the bias is response size,
since three of the four reductions come from one response getting smaller on a path I
didn't shorten.

The byte column needs a correction too. The metrics table calls it response bytes, but
the first run's figures only reconcile against what `larchctl` printed, and T2's 181,577
is recognisably the un-elided `--json` preview and nothing else. So the column below
stays printed bytes, for comparability, with the wire total beside it. Nobody measured
that one the first time, and it's the larger problem.

| task | state | turns | rejected | printed bytes | first run | HTTP bytes |
|---|---|---|---|---|---|---|
| T1 odd one out | pass | 3 | 0 | 1,628 | 1,903 | 5,905 |
| T2 align and merge | pass | 10 | 0 | 7,189 | 181,577 | 1,561,778 |
| T3 transform | pass | 6 | 0 | 2,180 | 35,963 | 600,988 |
| T4 truncate and merge | pass | 10 | 0 | 5,428 | 7,090 | 1,333,275 |

Every answer assertion passes. T1 names the 300 K scan off the summary table alone and
gives all three facts, not the two required. T2 reports 0.439, which is exact. T3 cuts
`kmax` from `auto->24.000` to 18, puts the first shell at 2.27 Å, and says it sits below
the true Cu–Cu distance because nothing corrects for phase. T4 cut at 10146, snapped to
10141.05, and left the two long scans ending at 10134.3 and 10134.5 against the 300 K
scan's 10145.9, an 11.6 eV spread inside the 15 eV threshold.

### Did the five fixes work

The first one did, unambiguously. `--json do merge ... --preview` now prints 4,634 bytes
where the same command with `--arrays` prints 353,504, so the accident that cost the
first run 170 KB is no longer reachable without asking for it by name.

T3 is where the signal-to-noise row earns its place: 6 turns and 2,180 bytes reading the
crossing off the digest, against 8 turns and 35,963 bytes when it took a CSV export and
a spreadsheet. The row puts k 17-19 at 2.8 and k 19-21 at 1.1, which is the same cut the
first run arrived at the long way.

The `align` note works. Previewing with `operation='auto'` took the three-group selection
on the first attempt and reported -2.959 eV for the 300 K scan, and T2 went from one
rejected command to none. The `SHIFT` column works too: after the alignment the table
shows -0.018 and -2.959 while E0 sits unmoved at 8977.58 and 8980.50, which is the thing
the first run couldn't see. `export` got its subcommand, but no task needed it this time,
so the suite doesn't exercise it.

Preview recording works and proves less than I'd like. T2 and T4 each hold one record
with `preview: true`, both successful, so the rejected count didn't move at all. The
metric now counts what it claims to count. Whether it counts anything depends on an arm
that guesses more than I did.

### Where the digest deviates from the numbers above

The ratios in the first run's table come from dividing rms(chi) by the kmax-24 `epsilon_k`
of 0.0004365, and I reproduced them to three figures before deciding against that
denominator. Measuring the floor over the transform range would give the new row the
exact defect it exists to remove: cut `kmax` to 16 and every ratio drops by a factor of
2.5, walking the apparent crossing from k ≈ 19 down to k ≈ 14. So the row divides by a
floor measured over the whole k support instead, 0.000392 for the 10 K scan, which runs
the ratios about 12% above the first run's. The live digest confirms it holds still:
cutting `kmax` to 18 moved `epsilon_k` from 0.000436 to 0.000877 and left all eleven bins
untouched. The crossing lands in the same window either way, but the arithmetic won't
reconcile with the CSV table above, and anyone comparing the two should know why.

### What this run found

**`/command` returns the whole project and no view can stop it.** T2 spent 595 KB on the
align and 835 KB on the merge; T4 spent 502 KB and 683 KB. `larchctl` discards nearly all
of it, which is why the printed column is small, so an arm talking to the API directly
pays 3.5 MB across a run that costs 16 KB through the CLI. The ten preview routes have
the same shape at 127 to 143 KB each. Accepting `?view=` on a POST is a smaller change
than anything in the ranked list above and a larger number.

**`truncate`'s `snapped` is not the new endpoint.** `side='after'` with `value=10146`
reports `snapped: 10141.05` and leaves an axis ending at 10134.3, because that side drops
the snapped point along with everything above it, while `side='before'` keeps it. One
grid step, 6.75 eV here, in the direction that makes a range comparison look worse than
it is. The note now says which side keeps the point and sends a caller to the last kept
energy instead.

**Project ids could start with a hyphen.** `secrets.token_urlsafe` has `-` in its
alphabet, so roughly one id in 64 began with one, and `--project -AbC...` came back from
argparse as "expected one argument". It broke three tests intermittently before I worked
out why, and it would break any caller passing an id on a command line. `uid()` redraws
now.

A wart rather than a defect: `--json` and `--arrays` had to be accepted after the
subcommand as well as before it, since `larchctl --project X do merge ... --json` is the
order anyone types and argparse only honours a flag where it's declared.

### What to change next, revised

1. Let `/command` and the previews take a `view`. Everything else in this run is rounding
   error against 3.5 MB.
2. Record what a merge merged, in the project and not only in the transcript. T2's state
   assertion is still uncheckable from project state, which was the first run's finding
   and remains true.

The five items from the first run are all closed. There's still only one arm, and it's
now an arm that read the source, so the next run of this suite needs someone who hasn't.

## After the second run, 2026-10-01

Both items on the revised list are in, and the second one turned up a correction to
both earlier runs.

**`/command` and the previews take `?view=summary`.** The command reply becomes the
project summary plus an elided `last_operation`; a preview keeps its shape and loses its
curves. `full` stays the default, so the browser is untouched. On the copper example:

| reply | full | `view=summary` |
|---|---|---|
| merge `/command` | 1,002,160 | 4,166 |
| merge preview | 216,335 | 3,641 |
| align preview | 123,428 | 3,487 |

`larchctl` now asks for the summary instead of eliding locally, so the CLI and an arm
on the raw API pay the same wire cost. `--arrays` still asks for `full`.

**T2 and T4 did not pass.** Recording what a merge merged needed no new field in the
store. Every merged group already carries `source.parents` and `source.merge.excluded`.
They just never reached a view. Once they did, the first merge they described left the
300 K scan out. With `method: "demeter-larch"`, `exclude_short_data` defaults to true,
and a group more than 10 points shorter than the first one selected gets dropped. The
300 K scan has 408 points against 612. The command succeeds, and only the stored source
records the exclusion.

Both runs checked T2's "merge over exactly the three originals" against the transcript.
The transcript records the selection that was sent, not what the merge used, so the
check passed against a two-group merge. T4 has the same problem in a sharper form. The
truncate shortens the long scans' energy range but leaves them at 460 points, still 52
more than the 300 K scan, so the merge drops it again. Truncating to match does not make
the scans merge-compatible under the default options. Comparable energy ranges are not
comparable point counts.

So in both earlier runs T2's state assertion fails, and so does T4's "the merge covers
the three truncated originals". T2's spread answer still stands, since it reads the
originals, not the merge.

The default stays as it is. It is native Athena's behaviour, the browser's merge dialog
already lists exclusions before a person commits, and changing it would change merges
for every caller. The command reply was the only place that kept quiet about it, so
`last_operation.merge.outputs[].excluded` now names each dropped group and its reason,
next to the summary's `derived` field. T2 and T4 above were reworded so passing requires
the arm to notice.

The summary now gives every derived group a `derived` field with its operation, the
parents it actually used, and each excluded group with its reason. `larchctl` flags the
group as `merge of 2,1 EXCLUDED` in the summary table and prints the exclusion under the
command result. The `merge` capability note names the default and the two ways around
it: `exclude_short_data: false`, or selecting the shortest scan first. Truncating the
long scans helps only if it brings the point counts within the margin. The assertions in T2 and T4
should be read off `derived.parents`.

This is the transcript warning from the first run coming back in a worse form. That
finding was that project state could not answer the question and the transcript could.
In fact the transcript gave the wrong answer, and project state had the right one, under
a key no view exposed.
