# Effective smoothing preferences and retained controls

The smoothing panel now loads the server's current Savitzky–Golay preferences,
supports **Apply** and **Apply and Save**, and retains filter controls while
switching tools or data groups in the same page session. Expand **Session and
saved SG preferences** beneath the SG fields to review current, saved and
factory values. Loading errors automatically reveal this section. Ordinary
filter previews remain available alongside the controls.

## A correction established by native execution

The original [process configuration](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/configuration/process.demeter_conf)
declares SG window 31 and order 4. However, it also assigns `minint=9` to the
order. [Config.pm::default](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/Config.pm)
clamps positive-integer parameters to their bounds. Actual execution of its
unchanged parser and accessor therefore returns **window 31, order 9**.
The window has bounds 0–39: a duplicated `maxint` entry ends at 39, and an
omitted `minint` becomes zero. Order has bounds 9–39.

The prior implementation had used the literal order 4. That default is now
corrected in the panel, primitive default and project command. The earlier
36-case reference remains valid for its explicitly supplied filter settings;
its configuration bridge did not prove native preference resolution. A new
reference executes actual configuration resolution before the native Larch
template. The original oracle is retained, rather than relabelled as evidence
for a default it did not exercise.

## Session behavior and persistence

[The native preference manual](https://bruceravel.github.io/demeter/documents/Athena/other/prefs.html),
[Athena Prefs.pm](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/UI/Athena/Prefs.pm)
and [the shared preference editor](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/UI/Wx/Config.pm)
distinguish applying a setting to the current process from writing it for
future starts. SG does not have a special callback that immediately reprocesses
existing groups. Subsequent filter calculations read the current preference.

The web mirrors those semantics for the two SG values. Apply changes the
backend service session, so another browser window sees the applied values.
Apply and Save persists both currently submitted SG settings. A fresh server
process loses session-only changes and loads the saved values. Existing
spectra and project undo history are unaffected. Copying current/saved/factory
values into the controls does not apply or persist them; this permits preview
before changing preferences.

The preference API is `GET/PUT /api/athena/preferences/smoothing`. Responses
contain current, saved and effective factory values, an unsaved indicator,
a revision and a server-session ID. Writes require both window and order;
omitting one cannot reset it to a default. Invalid types and preference ranges
are rejected before mutation. Browser/server-restart conflicts and changes
from another writer require reload and review. Disk write failure leaves both
the session and the previous saved state unchanged. Explicit local session
settings remain current if another service writes the shared disk file; its
new saved values are still exposed and the stale write token is invalidated.

When an explicit-method SG project request omits a window or order, the
backend resolves the missing values from one captured session snapshot.
Preview returns both values explicitly, and the UI uses that same confirmed
revision/options when saving. A subsequent preference change cannot silently
alter an already reviewed calculation. The lower-level explicit filter API
still permits Larch polynomial orders below the native preference minimum;
the preference editor uses Athena's actual configured ranges.

The panel remembers algorithm, kernel size/repetitions, Gaussian sigma and
explicit SG drafts in the current page session. Boxcar, Gaussian and
three-point share the kernel-size/repetitions value, as the original
[Smooth.pm](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/UI/Athena/Smooth.pm)
uses one widget for all three. Gaussian sigma and SG fields are separate.
Closing, saving a derived group or changing projects does not reset those
controls. A page reload starts fresh tool controls and reloads current server
preferences. Explicit unsaved SG drafts take precedence over a late startup
load, including edits that return to their original numerical value.

Only active numerical options participate in the scientific preview identity.
A late SG preference read does not invalidate a confirmed boxcar comparison.
Responses arriving after unmount are ignored. Failed preference writes keep
the draft, release the busy state and require an explicit reload before
another preference write. Copying defaults or making one-off filter edits
does not modify server preferences.

## Executed native reference

The [replay harness](../backend/tests/reference/smoothing_preferences_native_reference.py)
uses unchanged Config parser/set/default/read/write routines, the real
`Demeter::IniReader`, `Config::INI::Writer`, `Regexp::Assemble`,
Text::Template and `UI::Wx::Config::apply`. Widget values, callbacks and
Moose mode/accessors have explicit bridges; no rewritten preference-clamping
code supplies the reference. Native `read_ini('smooth')` confines reload to
the group under test. The original Larch template then filters the measured
408-point Cu scan using the effective native values.

Thirteen observations cover factory resolution, session Apply, loss of
session-only settings at restart, saving a previously applied window along
with the order, reload of saved values, native bounds and window/order
adjustment. Twelve yield complete arrays, compared with the backend at
`atol=rtol=2e-14`. The thirteenth, window/order 39/39, triggers the native
Larch/NumPy `UFuncTypeError` when building the high-order polynomial matrix.
That failure is recorded, not omitted from the oracle. The web gives a
recoverable message requesting a lower polynomial order and never saves
invalid output. Valid preference bounds alone do not guarantee that every
filter combination is numerically usable.

```bash
PYTHONPATH=backend backend/.venv/bin/python backend/tests/reference/smoothing_preferences_native_reference.py \
  --sources /tmp/athena-smoothing-preferences-sources \
  --smoothing-sources /tmp/athena-smoothing-sources \
  --environment /tmp/athena-smoothing-preferences-runtime/environment.json \
  --perl-lib /tmp/athena-export-runtime/root/usr/share/perl5 \
  --output /tmp/athena-smoothing-preferences-replay
```

Source identities are in the [primary catalog](athena-primary-sources.json).
The [manifest](../backend/tests/fixtures/athena-smoothing-preferences-fixtures.json)
pins loaded module hashes, source files, fixture, harness, Larch math source
and temporary reference packages. The additional native packages were
verified and extracted under `/tmp`; production still uses Python/Larch.

[Backend tests](../backend/tests/test_athena_smoothing_preferences.py) cover
native observations, independent Python-process restart, persistence failure,
concurrent writers, session identity, HTTP boundaries, captured preview options
and project/undo independence. [Preference component tests](../frontend/components/athena-smoothing-defaults.test.tsx)
cover late/reverted edits, save conflicts, draft preservation, reload and
unmount. [Smoothing component tests](../frontend/components/athena-smoothing.test.tsx)
also cover shared controls and unaffected boxcar previews. Expanded
[browser flows](../frontend/tests/e2e/athena-smoothing.spec.ts) exercise actual
desktop/mobile controls, two windows, persistent save, conflicts, reopening
and preview-matched derived-group creation. Results are recorded in the
[verification log](athena-verification.md).

## Remaining scope

This implements the SG portion of Athena preferences. General preference-tree
editing, complete `demeter.ini` import/export and a global save spanning all
Athena preference groups remain open. The server stores SG values separately
from existing reader/rebin preferences. The reference executes native INI
read/write, but that is not a claim that the web UI exchanges native INI files.
The full wx application, startup lifecycle and complete native normalization,
AUTOBK and Fourier processing are not replayed here. Original requirement
statuses remain unchanged and full Athena parity is unproven. Artemis is
excluded.
