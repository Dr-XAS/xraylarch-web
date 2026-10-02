# Task suite: the first version of the experiment

Written 2026-09-18. Companion to `agent-interface-scope.md`, which argues that without
this file the interface work "is a nice API and proves nothing."

Five tasks, phrased the way someone with spectra would phrase them; T5 was added on
2026-10-01. Each carries two kinds of assertion. A **state** assertion is
machine-checkable from `?view=summary`, `?view=parameters` or a group digest, so it can
be run unattended. An **answer** assertion is on the prose the arm returns, and needs a
grader, though most of it reduces to a number that either matches the project or
doesn't.

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

## T4 — Does the short scan need cutting first

> The 300 K scan is shorter than the other two, and I want all three in one merge. Do I
> need to cut the long ones down to match first? Do whatever it takes, merge them, and
> tell me where the merged spectrum ends.

Reworded on 2026-10-01; see "The old T4" below. The question now has a right answer the
arm has to find, rather than an instruction it can follow without understanding. The
`demeter-larch` merge covers only the energy range every member shares, so truncating
the two long scans first changes nothing: cutting them at 10146 eV gives the same merged
values point for point, one point shorter at the top.

**State:** six groups; one merge whose `derived.parents` is exactly the three
originals. Truncating first is allowed and not checked.

The trap behind the question is still there. The 300 K scan is 204 points shorter than
the others, so the default merge drops it, and truncating does not save it either: the
cut scans keep 460 and 468 points against its 408. Passing needs
`exclude_short_data: false`, a `short_data_margin` of at least 60 after a cut, or the
300 K scan selected first. Groups are measured only against the first one selected.

**Answer:** says the cut is unnecessary, because the merge covers only the shared range
(or, having cut, that the cut changed nothing), and gives the merged spectrum's end
within 15 eV of 10140. It ends at 10134.3 eV with a cold scan selected first and at
10139.2 eV with the 300 K scan first, on whose grid it then lands.

### The old T4

Runs one to four used this wording:

> The 300 K scan is shorter than the other two. Cut the long ones down to match before
> merging, so the merge isn't averaging three points against two at the top end.

It also asserted that the three foils' ranges end within 15 eV of each other, and its
answer was the energy truncated at, within 15 eV of 10146. The premise is false for
`demeter-larch`, as the fourth run's CLI arm pointed out, and the range assertion
rewarded an arm for doing what it was told rather than for being right. T4 results from
before the rewording are not comparable with later ones.

## T5 — A distance, not a peak

> How far apart are the copper atoms in the 10 K foil? I need the nearest-neighbour
> distance to a couple of hundredths of an angstrom, and how far to trust it.

Added 2026-10-01, after the fit route took `?view=summary`. T3 ends on a |chi(R)| peak
that is not a bond length. This task asks for the bond length, which can come only from
fitting FEFF paths: from the bundled AMCSD structures through a FEFF job, or with
`larchctl fit "10 K" --structure 11145`.

**State:** the project is at the version it started at, with five groups. A fit saves
nothing.

**Answer:** between 2.52 and 2.58 Å, from a fit with twelve Cu neighbours, with an
uncertainty or a stated reason to doubt it. The structure fit gives 2.547 Å with
sigma2 0.0038 Å². An answer of 2.30 Å, the peak, fails.

## What this suite does not cover

No LCF or PCA, fitting only in T5, no import of anything that isn't the bundled example, and
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

## Third run, 2026-10-01

The first run with two blind arms per task: a subagent with only `larchctl`, and one
with only HTTP. Neither read backend source. The harness in
`backend/xraylarch_web/agent_suite.py` makes the run repeatable:

- `setup` loads the example into a fresh project behind a metering proxy.
- `report` runs the state assertions and prints the meter's totals.
- `finish` stamps the end of the arm's run. Without it, the meter also counted my own
  reads after the run, one of which was a 957 KB full project GET.

Wire bytes are what the backend sent, whether or not the arm printed them. Tool calls
and end context are read from the subagent's transcript.

| arm | task | result | requests | rejected | wire bytes | tool calls | end context |
|---|---|---|---|---|---|---|---|
| CLI | T1 | FAIL: one align preview refused | 29 | 1 | 440,540 | 8 | 33,401 |
| CLI | T2 | pass | 58 | 4 | 172,270 | 22 | 49,267 |
| CLI | T3 | pass | 12 | 0 | 27,337 | 5 | 23,406 |
| CLI | T4 | pass | 28 | 0 | 81,914 | 11 | 34,778 |
| HTTP | T1 | FAIL: one preview refused | 12 | 1 | 37,419 | 7 | 40,474 |
| HTTP | T2 | pass | 23 | 0 | 87,527 | 17 | 48,467 |
| HTTP | T3 | pass | 7 | 0 | 17,615 | 4 | 26,653 |
| HTTP | T4 | pass | 18 | 0 | 63,612 | 11 | 42,246 |

The CLI T1 arm's wire bytes are about 370 KB of CSV exports, which it wrote to disk.
To decide whether the scans were comparable it rebuilt the overlay in numpy. The HTTP
arm did the same through the export route.

Answers: T2 reported a spread of 0.44. T3 cut kmax to 18 and put the first shell at
2.27 Å, saying that it is not the bond length. T4 merged with `exclude_short_data:
false`.

What it found, and what changed in `2bf6abf01` and `a83a21bf8`:

- **Both T1 arms tried to measure a shift with the align preview**, and both were
  refused because the foils are linked. Reading a number should not need a write's
  permissions. `GET .../compare` now measures every group against the first: the shift
  align would fit, the E0 and edge-step differences, the XANES difference, chi(k)
  amplitude per k window, and the shared range. It is read-only, so it works on linked
  groups.
- **Neither arm could tell that the shared reference is a copy of the 300 K scan**
  without comparing exports byte for byte. The summary's `same_data` and compare's
  `same_data_as` now say it outright.
- **The CLI T2 arm's four rejections** came from two sources. One was the legacy align
  path, reached when `method` was omitted. The other was a label passed as
  `standard_id`. Align now takes the native path unless only a `reference_id` is sent,
  and larchctl resolves labels in every option that names a group.
- **A parameters reply did not say what Larch did with the value.** Under
  `?view=summary` it now carries `applied`, requested beside effective.

## Fourth run, 2026-10-01

Same eight arms on the new code, same harness.

| arm | task | result | requests | rejected | wire bytes | tool calls | end context |
|---|---|---|---|---|---|---|---|
| CLI | T1 | pass | 23 | 0 | 71,052 | 5 | 25,627 |
| CLI | T2 | pass | 39 | 0 | 127,437 | 11 | 35,614 |
| CLI | T3 | pass | 10 | 0 | 32,999 | 4 | 25,413 |
| CLI | T4 | FAIL: ranges not matched | 26 | 0 | 84,350 | 10 | 39,228 |
| HTTP | T1 | pass | 7 | 0 | 23,291 | 6 | 37,376 |
| HTTP | T2 | pass | 16 | 0 | 50,681 | 11 | 38,939 |
| HTTP | T3 | pass | 10 | 0 | 42,845 | 7 | 30,067 |
| HTTP | T4 | pass | 12 | 0 | 37,623 | 8 | 43,018 |

Against the third run:

- Both T1 arms pass, on 84% and 38% fewer wire bytes, with no exports.
- The CLI T2 arm went from 22 tool calls and 4 rejections to 11 and none.
- The HTTP T2 arm went from 23 requests to 16.

The T1 answers say more than before. Both name the 300 K scan's energy offset and its
damped chi(k), and attribute the damping to Debye–Waller. One reads the beamline and
year from the citation. Both notice that the shared reference is the 300 K scan.

**The one failure is the task's fault.** The CLI T4 arm declined to truncate. It said
that the merge already restricts itself to the range every member covers, so cutting
first changes nothing. That is correct: truncating the cold scans at 10146 eV gives the
same merged values point for point, one point shorter at the top. T4's premise ("so the
merge isn't averaging three points against two") is false for `demeter-larch`, and the
assertion "ranges end within 15 eV" rewards an arm for doing what it was told rather
than for being right. I have left the task as it is, because rewording it breaks
comparison with the earlier runs. The CLI T4 result should be read as a correct refusal.
AGENTS.md and the truncate note now say the cut is unnecessary. T4 was reworded after the
fifth run anyway; see "The old T4".

**The arms were reading a stale AGENTS.md.** Subagents receive the project's AGENTS.md
as an attachment cached when the session started, not the file on disk. So no arm in
this run saw the compare section, and the gains came from the catalog and the CLI.
Future runs should tell each arm to Read AGENTS.md from disk.

Friction from this run, fixed in `bbfc52e6d` and `c0d15d193`:

- **The HTTP T3 arm looked for `applied` under `last_operation`**, where the rest of
  what a command did is reported, and did not find it. It has moved there.
- **The digest table had no file or citation.** The CLI T1 arm needed `--json` to find
  out where a scan came from. The table now prints both, and the same-data line names
  the file.
- **compare's SHIFT column read as the summary's SHIFT**, which is a different number.
  It is now ALIGN BY.
- **compare's `same_data_as` covered only the selection.** The duplicate worth knowing
  about is usually the one nobody selected, so it now looks across the project.
- **Naming a merge "… 300 K …" made "Cu foil · 300 K" ambiguous** under substring
  matching. A whole-label match now wins.
- **The merge preview said nothing about agreement.** `agreement` now gives the merge's
  scatter and each member's rms from it as fractions of the merged range. The CLI
  prints the preview as a table.
- **"Fit if you need distances" led nowhere.** The Artemis fit route takes
  `?view=summary`, which is 2.5 KB rather than 250 KB. `larchctl fit` builds a fit from
  the Cuprite example, from FEFF run on a bundled structure, or from path files. T5
  above tests it.
- **The truncate note did not say that interval bounds are inclusive**, or that a bound
  outside the data is refused. It now says both.


## Fifth run, 2026-10-01

Six arms: T5, the new distance task, on both interfaces, and T2 and T3 again to check
the fourth run's fixes. Each arm was told to Read AGENTS.md from disk rather than trust
the cached attachment, so this is the first run that saw the compare and fit sections.

| arm | task | result | requests | 422s | wire bytes | tool calls | end context |
|---|---|---|---|---|---|---|---|
| CLI | T5 | pass, 2.547 ± 0.005 Å | 109 | 3 | 755,252 | 8 | 41,783 |
| HTTP | T5 | pass, 2.548 ± 0.01 Å | 33 | 10 | 118,950 | 11 | 49,340 |
| CLI | T2 | pass | 37 | 0 | 122,294 | 12 | 45,556 |
| HTTP | T2 | pass | 15 | 0 | 50,077 | 12 | 47,839 |
| CLI | T3 | pass, kmax 18 | 20 | 0 | 98,077 | 8 | 35,374 |
| HTTP | T3 | pass, kmax 18 | 12 | 0 | 80,436 | 10 | 43,278 |

No command was rejected in any arm. The 422s are fit and FEFF bodies refused by the
Artemis validators, which the transcript does not record.

**Both T5 arms got the distance, and both said how far to trust it.** Each fitted the
first shell of FEFF run on fcc copper and landed within 0.001 Å of the other. Each then
went past the stderr. The HTTP arm refitted eleven times over kmax, kmin, R window, k
weight and a second structure, held del_e0 either side of its best value, and put the
uncertainty in the 0.86 del_e0/del_r correlation rather than in the 0.002 Å stderr. It
also checked the result against copper's lattice constant. Neither quoted the 2.30 Å
peak.

**Context rose by 9–13 K tokens per arm, and AGENTS.md is the likeliest cause.** Against
the fourth run, the T2 arms take about the same requests, wire bytes and tool calls,
and finish about 10 K tokens higher. Each arm still received the stale attachment, then
Read the current file on top of it: about 16 KB, some 4 K tokens, with line numbers
added. That accounts for under half of the rise; the rest I cannot attribute from these
numbers. Either way the guide is now a cost every arm pays before it starts. At 313
lines after this run's additions, it is the next thing to watch.

**Both T3 arms fitted a distance they were not asked for.** T3 asks only for a better
transform range. Having read "the peaks are not bond lengths", both arms ran FEFF and a
fit and reported 2.547–2.549 Å. That is correct and costs about 50 KB of wire. Whether
it is welcome depends on the user.

**The CLI T5 arm's 755 KB is FEFF, run twenty times.** Each `larchctl fit --structure`
reran FEFF and polled a 20 KB status reply, and the arm ran twenty fits to test the
ranges. None of that reached its context, since the CLI printed only tables, but it is
server work and wall time.

Friction from this run, fixed after it:

- **A refused field did not say why.** `site_index: 0` came back as "invalid fields:
  site_index", and both HTTP T5 arms found by trial that it counts from 1. Every 422
  now carries each field's constraint in its message: "site_index: Input should be
  greater than or equal to 1".
- **`GET /api/artemis/capabilities` was a 404**, so the HTTP arms rebuilt the fit body
  from the Cuprite example: which path fields are needed, which parameter kinds exist,
  whether `kweight` is a list. It now describes the fit and FEFF bodies from their
  validators, with defaults, bounds, and the traps in notes.
- **The CLI fit ignored the group's kmax** and fitted k 3–12 after the arm had just set
  18. It now takes the group's k window once its kmax has been set, cuts it to FEFF's
  k 20, and prints where each range came from.
- **`-t kweight=2` was refused**, because the route takes a list. The CLI wraps it, and
  takes `1,2,3`.
- **A fit in k space reported "Fit succeeded" at an R-factor of 0.37.** The fit summary
  now carries `concerns`: R-factor above 0.05, more variables than independent points,
  a parameter at its bound, a correlation above 0.9.
- **Testing the ranges took one invocation, and one FEFF run, per fit.** `larchctl fit
  --vary kmax=14,16,18 --vary del_e0=3,9` runs FEFF once and tabulates r, sigma2, S0²,
  E0 and R-factor per variant, with the spread of r for each key.
- **Polling a FEFF job read 20 KB per poll**, half of it the CIF and the FEFF input.
  `GET .../feff/jobs/{job}?view=summary` answers in under 1 KB with the status and each
  path's scatterers, degeneracy and reff; `larchctl` polls with it and reads the full
  reply once.
- **`fit --help` did not list the default guesses.** It does now, with their bounds,
  and so do the defaults of `-t`.
- **`do align` printed "version 3 -> 4" and nothing else.** A command now prints each
  field it moved on a group it kept (`~ Cu foil · 300 K  energy_shift 0.000->-2.959
  edge_step 2.729->2.717`), with skip reasons, processing errors and warnings by group
  label. Align previews print as a table.
- **"300 K" stopped resolving once a merge was labelled "… 10 K, 50 K, 300 K …".** A
  whole part of a label between its `·`s now wins over a substring.
- **`describe align` read "default 'inspect'"**, which `/command` refuses, and did not
  say whether the standard belongs in `group_ids`. Both options now say.
- **A summary merge preview still carried the new group's forty starting parameters**,
  the longest block left in it. Under `?view=summary` it now keeps E0 alone.
- **AGENTS.md did not say whether to merge `mu` or `norm`** when edge steps differ, that
  unlinking drops the merge's reference channel, how `-o` values are parsed, or that the
  original edge steps should be read before aligning. It says all four.

Not fixed: `structures` lists no cell or temperature, so the CLI T5 arm picked a
high-temperature cell without knowing (the fit's deltar absorbs it). A fit body still
carried every path file's text rather than naming a FEFF job's paths; that was fixed
after the run, below.

## After the fifth run, 2026-10-01

Nine questions were left open after the fifth run. These are the decisions taken.

**Changed:**

- **AGENTS.md is slimmed, from 315 lines to 245.** It keeps every rule and drops
  the worked numbers from the copper example. Those numbers were most of its length, and
  they were also the suite's answers: the 2.547 Å fit, the 2.30 against 2.73 edge
  steps, kmax 18, and the claim that a cut before merging changes nothing. An arm that
  read the guide could pass T2 to T5 by quoting it. Runs after this one measure the
  interface, not the guide, and their context costs are not comparable with runs
  three to five.
- **T4 is reworded**, under "The old T4" above. Its premise was false for
  `demeter-larch`, as the fourth run's CLI arm said.
- **A fit path can name a FEFF job's path** as `{id, feff_job, feff_path}`, and the
  server reads the file out of the job. `larchctl fit --structure` now polls the
  summary view and never reads the 20 KB full reply. Saved Artemis models still carry
  the file text, because a job is deleted after 24 hours and a model has to outlive
  it.
- **A merge's `derived` names the `array` it averaged**, and `larchctl` prints it
  (`merge of 3 (norm)`). The label stays native Athena's "merge". Changing it would
  touch the browser and project files for a fact that belongs in the derivation.
- **The frontend proxy allows `GET .../compare` and forwards `Idempotency-Key`.** The
  Artemis routes were already allowed by prefix. Before this, compare was a 404
  through the proxy, and a keyed retry lost its key on the way through.

**Kept as they are:**

- **Align does not find E0 again.** It matches native Athena, which pins E0 through
  an alignment. The catalog note, AGENTS.md and the CLI's `~` lines already say so,
  and `parameters` with `e0: null` is one command away.
- **The example's shared reference stays a copy of the 300 K scan.** It is the demo's
  documented provenance (`docs/athena-reference-links.md`). It is also a fair trap: two
  labels holding one measurement is a thing real projects do, `same_data` is tested
  against it, and both fourth-run T1 arms caught it.
- **The arm reaches this backend over loopback**, through the Dr.XAS backend's
  existing `internal_url`, never over the ingress. See question 1 in
  `agent-interface-scope.md`.
- **The two arms do not share numerics.** Dr.XAS pins upstream Larch from August 2025,
  and this backend runs a fork 97 files further on. Its align is not Larch's at all.
  Equivalence is scored per quantity with a tolerance, which is how the answer
  assertions are already written. See question 3.


## Sixth run, 2026-10-01

All five tasks on both interfaces: ten arms, the first run since AGENTS.md was slimmed
and T4 reworded.

The harness changed, so this run is a new baseline. Through the fifth run each arm was
a subagent of the session that wrote the code, and it received a cached copy of
AGENTS.md before it read the current one. Here each arm was a headless `claude -p`
(Opus 5.5) in a fresh directory that held only the current AGENTS.md and a link to
`backend/`. Each arm had its own `metered_app` backend and data root, and was allowed
Bash, Read and Write. Context and tool-call counts are not comparable with earlier
runs. Wire bytes and requests are.

| arm | task | result | requests | wire bytes | tool calls | end context | wall | cost |
|---|---|---|---|---|---|---|---|---|
| CLI | T1 | pass | 10 | 28,758 | 4 | 37,088 | 38 s | $0.30 |
| HTTP | T1 | pass | 5 | 15,546 | 3 | 43,568 | 37 s | $0.34 |
| CLI | T2 | pass, spread 0.440 | 20 | 59,752 | 8 | 40,461 | 55 s | $0.39 |
| HTTP | T2 | pass, spread 0.440 | 15 | 46,415 | 11 | 48,534 | 68 s | $0.51 |
| CLI | T3 | pass, kmax 17 | 26 | 73,992 | 6 | 38,227 | 42 s | $0.33 |
| HTTP | T3 | pass, kmax 17 | 19 | 62,377 | 9 | 53,596 | 56 s | $0.51 |
| CLI | T4 | pass, ends 10134.3 eV | 28 | 84,755 | 10 | 43,116 | 70 s | $0.46 |
| HTTP | T4 | pass, ends 10134.32 eV | 9 | 25,950 | 5 | 46,004 | 48 s | $0.40 |
| CLI | T5 | pass, 2.547 ± 0.01 Å | 65 | 171,529 | 6 | 41,009 | 54 s | $0.36 |
| HTTP | T5 | pass, 2.549 ± 0.005 Å | 29 | 71,052 | 7 | 48,740 | 55 s | $0.45 |

Every arm passed both its state assertions and its answer. No command was rejected and
no request drew a 4xx, including the 422s that the fifth run's HTTP T5 arm hit ten
times. The ten arms cost $4.05 in all.

**The slim guide did not cost the answers.** Without the copper numbers to quote,
every arm read its facts off the tools. Both T1 arms named the 300 K scan with its E0
offset (+2.92 eV), edge-step ratio (1.19), shorter range (10146 eV against 11362),
and different beamline and year from the citations, and both saw that the shared
reference is a copy of it. Both T3 arms chose kmax 17 from the `signal_to_noise`
table, where the fifth run's arms had copied the guide's 18. Both said the 2.27 Å peak
is not a bond length.

**The reworded T4 works.** Both arms said the cut is unnecessary because the merge
already keeps to the shared range, and that the point-count check drops the 300 K scan.
Both turned `exclude_short_data` off, merged `norm` because the edge steps differ, and
gave the end as 10134.3 eV. They differed only in scope. The CLI arm unlinked the 300 K
scan, aligned it (−2.959 eV), found its E0 again, and previewed a second time to show
the largest scatter falling from 0.20 to 0.035 of the range. The HTTP arm merged the
scans as they were, reported the 3 eV offset, and offered to align and redo the merge.

**The FEFF job paths were used.** Both HTTP arms that fitted (T3 and T5) named job
paths as `{id, feff_job, feff_path}` and never sent a file's text. Each polled the job
once under `?view=summary`. The HTTP T5 arm made 29 requests for 71 KB, where the fifth
run's made 33 for 119 KB with ten refusals. The CLI T5 arm made 65 for 172 KB, where
the fifth run's made 109 for 755 KB.

**The CLI still runs FEFF once per `fit --structure`.** The CLI T5 arm called it six
times to test kmin, kmax, R range, k weight and a held E0, and each call ran a new FEFF
job on the same structure. `--vary` exists for exactly this, but it covers one change
at a time against a shared baseline. Fixed after the run: `POST /feff/jobs` now
answers a request identical to one that completed in the last 23 hours with that job,
status 200, marked `reused`, and runs no FEFF. The comparison is the whole request,
and for an attached CIF also the file's hash. The POST takes `?view=summary`, since a
reused job arrives with its path files. `larchctl` sends it, and the browser gets a
complete job it does not need to poll.

**The CLI T5 arm fitted at k 3–12, the route's default**, because nobody had set the
group's kmax. The CLI said where the range came from, and the arm then showed that
moving kmax from 12 to 17 does not move r. Its uncertainty, ±0.01 Å, it placed in the
E0–distance correlation (0.85–0.90), like the fifth run's arms.

**One answer stated something false.** The CLI T5 arm added that the 10 K group's E0
sits "about 3 eV lower than the other foils'". Only the 300 K scan's does, and the
50 K scan's matches. The claim was an aside and does not affect the distance. The
summary and the compare table it read were both correct.

**Both T3 arms again fitted a distance they were not asked for**, 2.547–2.548 Å. The
guide's line that peaks are not bond lengths is enough to send them to Artemis. That
costs a FEFF job and about 30 KB, and is still left as is.

## Seventh run, 2026-10-01

T5 on both interfaces again, to check FEFF job reuse. The harness is the sixth run's.

| arm | task | result | requests | wire bytes | FEFF runs | tool calls | end context | wall | cost |
|---|---|---|---|---|---|---|---|---|---|
| CLI | T5 | pass, 2.547 ± 0.005 Å | 48 | 116,259 | 1 of 5 POSTs | 7 | 41,517 | 50 s | $0.38 |
| HTTP | T5 | pass, 2.549 ± 0.005 Å | 29 | 66,435 | 1 of 1 | 7 | 49,157 | 55 s | $0.46 |

**Reuse did what it was for.** The CLI arm called `fit --structure` five times and FEFF
ran once. The other four POSTs came back 200 with the finished job, and the job
directory held one calculation at the end. Against the sixth run's CLI arm, requests
fell from 65 to 48 and wire bytes from 172 KB to 116 KB, with no FEFF poll after the
first job. The HTTP arm ran FEFF once and then refitted twenty times from the job's
paths. It sent the POST with `?view=summary` as AGENTS.md now says.

**Both answers are the sixth run's, with tighter error bars.** Both arms fitted at
k 3–16, found the del_e0/del_r correlation (0.85–0.86) to be what limits the distance,
and checked the result against copper's lattice constant. Neither stated anything
false. The CLI arm chose its kmax itself, with `-t`, rather than taking the route's
k 3–12.

After this run, the fifth run's last open item was fixed. Structure search results now
carry each entry's `cell`, and `measured_at`: the temperature in K and pressure in GPa
that the entry's title states. AMCSD has no column for these, but about one title in
five gives them as "Sample: at T = 577 K" or "Note: P = 5.2 GPa". Values from sample
history, such as "synthesized at" or "after heating to", are skipped, and a title
that states two different values gives neither but keeps its words in `stated`. The
field is left out of `GET /structures/{id}`, because a project saves that reply as a
strict attachment snapshot. `larchctl structures` prints `A` and `MEASURED` columns,
so the copper series from 293 K to 1343 K no longer looks like eleven copies of one
structure.

## Eighth run, 2026-10-01

All five tasks on both interfaces, the sixth run's harness, on the code and guide after
FEFF job reuse and structure conditions. This is the baseline to compare later runs
with.

| arm | task | result | requests | wire bytes | tool calls | end context | wall | cost |
|---|---|---|---|---|---|---|---|---|
| CLI | T1 | pass | 11 | 34,400 | 4 | 37,958 | 35 s | $0.31 |
| HTTP | T1 | pass | 6 | 16,230 | 3 | 41,785 | 41 s | $0.34 |
| CLI | T2 | pass, spread 0.44 | 28 | 85,724 | 10 | 42,591 | 64 s | $0.44 |
| HTTP | T2 | pass, spread 0.44 | 15 | 48,312 | 10 | 49,583 | 84 s | $0.53 |
| CLI | T3 | pass, kmax 17 | 25 | 67,274 | 5 | 38,187 | 35 s | $0.31 |
| HTTP | T3 | pass, kmax 17 | 20 | 67,025 | 10 | 49,677 | 61 s | $0.49 |
| CLI | T4 | pass, ends 10134.3 eV | 12 | 39,599 | 7 | 39,204 | 41 s | $0.35 |
| HTTP | T4 | pass, ends 10134.32 eV | 14 | 41,742 | 7 | 49,580 | 60 s | $0.48 |
| CLI | T5 | pass, 2.549 ± 0.01 Å | 48 | 117,321 | 7 | 41,994 | 51 s | $0.38 |
| HTTP | T5 | pass, 2.549 ± 0.004 Å | 37 | 80,998 | 8 | 53,641 | 74 s | $0.54 |

Every arm passed its state assertions and its answer, no command was rejected, and no
request drew a 4xx. The ten arms cost $4.17. I found nothing false in any answer.

**The structure conditions were used.** Both T3 arms picked AMCSD 13087, the copper
entry measured at 293 K, as the bundled structure nearest 10 K; the sixth run's arms
took 11145, whose conditions are unstated. Both T5 arms fitted from 11145 and from
13087 and got the same r to 0.0004 Å, which is the evidence that `del_r` absorbs the
cell difference. That is two FEFF jobs per T5 arm, one per structure, so reuse had
nothing to save here.

**Both T4 arms aligned before merging**, where in the sixth run only the CLI arm did.
Each unlinked the 300 K scan, aligned it by −2.959 eV, found its E0 again, merged
`norm` with `exclude_short_data: false`, and gave the end as 10134.3 eV. The HTTP arm
put its choice of array in the merge's label, "merge (norm) · Cu foil 10 K + 50 K +
300 K", through the `label` option. The CLI T4 arm made 12 requests for 40 KB, against
28 for 85 KB in the sixth run.

**T1 arms now say what to do next without doing it.** Both named the 300 K scan with
its offsets and its source, saw that the shared reference is the same file, put the
falling chi(k) amplitude down to Debye–Waller damping, and listed the unlink, align and
E0 steps for the user to approve. The HTTP arm estimated the extra sigma² behind the
damping at about 0.006 Å² from the compare ratios alone.

**T2 differed only in finishing.** The HTTP arm found E0 again on both moved scans and
noticed the 300 K edge step return from 2.717 to 2.729 when it did. The CLI arm left
E0 pinned and offered to find it again. Both reported the original edge steps, read
before aligning.

Nothing in this run calls for a change. What remains is the open question of what
a T3 arm should do unasked: both still fitted a distance, and that is the user's call.
