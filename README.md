## Larch:  Data Analysis Tools for X-ray Spectroscopy and More


[![A](https://github.com/xraypy/xraylarch/actions/workflows/test-ubuntu.yml/badge.svg)](https://github.com/xraypy/xraylarch/actions/workflows/test-ubuntu.yml)
[![B](https://github.com/xraypy/xraylarch/actions/workflows/test-windows.yml/badge.svg)](https://github.com/xraypy/xraylarch/actions/workflows/test-windows.yml)


Larch is an open-source library and set of applications for
visualizing, processing, and analyzing X-ray absorption and
fluorescence spectroscopy data from synchrotron beamlines.  While its
origins and emphasis are in X-ray absorption fine-structure
spectroscopy (XAS), including X-ray absorption near-edge spectroscopy
(XANES) and extended X-ray absorption fine-structure spectroscopy
(EXAFS), it also supports visualization and analysis tools for several
related X-ray measurement modes.  These include X-ray fluorescence
(XRF) spectra and XRF and X-ray diffraction (XRD) images as collected
at scanning X-ray microprobe beamlines.

Larch is written in Python, and makes heavy use of the excellent
scientific Python libraries.  It can be used as a Python library, or
through one of several Graphical User Interfaces, including Larix, and
others listed in the table below.

Larch is distributed under the MIT licence.  It has been under active
and open development for more than a decade, and is built on XAFS
analysis tools that go back to the 1990s.  Development is done
primarily at the University of Chicago, with support from the US
National Science Foundation, and the US Departmen of Energy.

The best citable reference for Larch is https://doi.org/10.1088/1742-6596/430/1/012007

## Athena Web branch

The `Athena` branch adds a browser implementation of Athena's XAS workflows.
Open [http://localhost:3004](http://localhost:3004) using the local commands
below, then import spectra or load the measured copper foil example. The
earlier single-spectrum interface is at `/classic`.

The Athena import dialog shows a live plot while selecting columns. It also
recognizes FEFF `xmu.dat` tables, selecting photon energy (`omega`) and `mu`
while preserving the supplied normalization. Detector choices and previewed
signals can be reviewed before import; successful import choices are remembered
for subsequent matching files.

Use **Group → Change data type** to correct current, marked, or all energy
groups after import. The type button next to Freeze also supports Athena's
Ctrl+Alt-click μ(E)/XANES toggle, preserving the normalized-input flag. Legacy
project records explicitly typed as detector signals display their counts
without normalization or EXAFS processing.

Athena import also recognizes native NSLS X10C, Lytle encoder, SSRL ASCII,
SSRL binary, SSRL MicroEXAFS and SPEC zapline mono files. It converts them before column selection
and offers the reader's transmission/fluorescence channel suggestions. The
live preview shows the selected signal; original and converted files can both
be downloaded. For MicroEXAFS without a transmission detector, use the
fluorescence suggestion and select additional SCA columns to sum channels.

For multi-scan SPEC files, choose the scans and preview each before reviewing
the detector columns. Selected scans import in file order and can reuse a
mapping when their columns match. Check the energy axis and signal polarity
in the preview; the official SNBL sample needs **Invert signal** with its
Ion1/Ion2 suggestion. See the [SPEC contract](docs/athena-spec-reference.md)
for the source/sample differences and tested import flow.

**SRS**, **DUBBLE** and **PFBL12C** readers handle multi-line detector records
and monochromator angle conversion. Their converted columns are available in
the same live preview. Photon Factory files distinguish requested and attained
energy; SRS files explicitly labelled ENERGY retain their supplied axis.
See the [angle-reader contract](docs/athena-angle-readers-reference.md) for
native channel defaults, geometry fallbacks and measured verification.

**CMC**, **HXMA** and **LNLS** handle dark-current correction, named CLS detector
columns and date/time-prefixed measurements. Their converted values and native
channel suggestions appear in the same live preview. For the official CMC
sample, the transmission denominator is zero: choose **Use fluorescence
columns** and **Data type → XANES · short energy range**. See the
[scalar-reader contract](docs/athena-scalar-readers-reference.md) for examples,
native numerical comparisons and retained source metadata.

**X15B** binary files and **X23A2MED** Vortex detector files have working
**Configure** forms in the plugin registry. Apply changes the current server
session; Apply and Save also persists the reader settings. After editing
source columns, deadtimes or integration time, return to import and choose
**Reinspect selected file** to update the columns and live preview. The
[configured-reader contract](docs/athena-configured-readers-reference.md)
records native defaults, official examples and numerical comparisons.

**X23A2MultiChannel** and **10BMMultiChannel** convert four simultaneous
samples into a project with independent channel previews and group selection.
10BM also supports a reference channel, names, detector columns, temperature
labels and per-channel energy shifts. Open **Configure reader** in the preview,
then **Reinspect source file** to review updated curves before importing.
See the [multichannel contract](docs/athena-multichannel-reference.md) for
measured samples, native comparisons and remaining limitations.

**B18** retains all points with Larch and suggests the 36-channel fluorescence
sum. **BM23** converts keV to eV and offers independent scan previews for
multi-scan files. Both use the live column editor; see the
[header-reader contract](docs/athena-header-readers-reference.md) for native
comparisons and the current constructed-fixture validation boundary.

Enable these readers in **File → Plugin registry…** before importing; Athena's
initial registry leaves plugins unchecked. Switches persist across sessions.
The registry provides documentation and imports/exports native
`athena.plugin_registry` settings. **File plugins…** in the import panel lets
you enable a reader and retry the selected file.

See [Athena research and tutorials](docs/athena-research.md),
[implementation and validation](docs/athena-verification.md), and the
[remaining full-parity work](docs/athena-parity.md). This branch is under active
development and does not yet implement every desktop Athena option.

## XrayLarch Web V1

XrayLarch Web is a local browser workbench for one XAS spectrum at a time. It
keeps parsing, processing, revisions, and stored arrays in the FastAPI backend;
the frontend only sends validated choices and renders server-produced traces.

### Run locally

Create the backend environment from `backend/requirements.txt` before starting
the services. From the repository root, start the backend in one terminal:

```bash
PYTHONPATH=backend backend/.venv/bin/python -m uvicorn xraylarch_web.main:app --reload --reload-dir backend/xraylarch_web --port 8006
```

`PYTHONPATH=backend` is required for the current source-tree layout because the
web backend package lives beneath `backend/`. Reload watches application code
only, so editing tests does not restart the local service. Start the frontend in a second
terminal:

```bash
cd frontend && npm run dev -- --port 3004
```

Open [http://localhost:3004](http://localhost:3004). The frontend proxies API
requests to `http://127.0.0.1:8006` unless `BACKEND_URL` supplies another local
backend address.

### Check before sharing a local build

Run these commands from the repository root. The browser test starts its own
backend on `127.0.0.1:18006`, frontend on `127.0.0.1:13004`, and a fresh
temporary `XRAYLARCH_DATA_ROOT`; it does not use the normal development data
directory.

```bash
backend/.venv/bin/python -m pytest backend/tests -q
cd frontend && npm test
cd frontend && npx tsc --noEmit
cd frontend && npm run build
cd frontend && npm run test:e2e
```

### Operating boundary and deferred work

V1 is for a trusted network and one user. It has no Dr.XAS authentication, no
user accounts, and no access to Dr.XAS shared data, databases, secrets, or
provider credentials. Do not expose it to the public internet or treat it as a
multi-user service.

XRF and XRD tools, fitting and FEFF work, multi-file alignment or batch flows,
chat, public deployment, authentication, and sharing remain outside V1. The
planned Dr.XAS address is [http://drxas.xray.aps.anl.gov:3004](http://drxas.xray.aps.anl.gov:3004);
this README does not imply that it has been deployed.

### Guarded Dr.XAS release package

The checked-in deployment contract is
[`deploy/xraylarch-web.manifest.md`](deploy/xraylarch-web.manifest.md). It
reserves an isolated `/local/apps/xraylarch-web` namespace, immutable
SHA-addressed releases, private mutable data only under
`/local/apps/xraylarch-web/data`, the namespaced frontend/backend screens, and
the planned `3004`/`8006` listeners. The host scripts are
[`scripts/deploy-xraylarch-web.sh`](scripts/deploy-xraylarch-web.sh) and
[`scripts/check-xraylarch-web.sh`](scripts/check-xraylarch-web.sh).

The scripts are a release package, not permission to write to Dr.XAS. A first
host install, any GitHub push, and every host deployment require an explicit
gate after a fresh host preflight. When that gate exists, the future operator
uses only a full SHA from `codex/xraylarch-web-v1`:

```bash
/local/apps/xraylarch-web/ops/deploy-xraylarch-web.sh deploy <full-sha>
/local/apps/xraylarch-web/ops/deploy-xraylarch-web.sh health <full-sha>
/local/apps/xraylarch-web/ops/deploy-xraylarch-web.sh rollback <full-sha>
/local/apps/xraylarch-web/ops/deploy-xraylarch-web.sh recover <full-sha>
/local/apps/xraylarch-web/ops/check-xraylarch-web.sh check <full-sha>
```

When using the prepared alternate host profile on Goldendale, prefix deploy,
health, recover, and checker commands with
`XRAYLARCH_WEB_SIBLING_PROFILE=goldendale`. This keeps XrayLarch on frontend
`3004` and backend `8006` while validating Goldendale's existing Dr.XAS dev
services on `3001` and `8001`; the default `drxas` profile remains unchanged.

`recover <full-sha>` reactivates the existing immutable release when its
processes or screens are gone, without building a release or changing the
canonical SHA. It is safe to call after a reboot; ambiguous screens, listeners,
or process records fail closed. The watcher performs this recovery automatically
after a failed health check.

The reboot/liveness helper is installed as
`/local/apps/xraylarch-web/ops/ensure-watcher.sh`. It starts exactly one
`xraylarch-web-watch` screen, never kills a colliding screen, and can be called
from Goldendale's existing persistence paths:

```cron
@reboot /usr/bin/env PATH="$HOME/miniconda3/bin:/usr/local/bin:/usr/bin:/usr/sbin:/bin:/sbin" XRAYLARCH_WEB_SIBLING_PROFILE=goldendale /local/apps/xraylarch-web/ops/ensure-watcher.sh >> /tmp/xraylarch-web-watchdog.log 2>&1
```

The existing five-minute watcher-liveness job invokes the same helper so an
unexpected watcher exit is repaired without adding a second periodic cron job.

For an installation created by the pre-record deployer, bootstrap the exact
active process records first; this is an explicit, locked, fail-closed migration
that does not stop processes or change links, state, data, or sibling services:

```bash
/local/apps/xraylarch-web/ops/deploy-xraylarch-web.sh migrate <full-sha>
```

Migration discovers and validates both final screens/listeners, writes both
private records atomically, and removes only records created by the attempt if
verification fails. Matching records make the command idempotent. Deploy and
health refuse legacy processes without records; the read-only checker never
performs migration.

The active application remains on `3004`/`8006` while a release candidate is
started in `xraylarch-web-candidate-frontend` and
`xraylarch-web-candidate-backend` on app-private loopback `13004`/`18006`.
The deployer records and validates exact screen and listener PIDs, ancestry,
the observed command line, executable, owners, release marker, working
directory, and candidate health before it begins the brief final-port handoff.
Those private launch records live under `/local/apps/xraylarch-web/state/processes`.
It then waits for the old recorded listeners to release `3004` and `8006`,
starts the target under the final screen names, revalidates its identity, and
atomically activates it. Health checks also require a regular, non-symlink
`state/last-successful` whose SHA and canonical release path match `current`.
This is not zero downtime. A failure stops only recorded target/candidate
processes and restores the prior release's symlink, state, processes, and
health.

## Larch Applications

These applications installed with Larch, in addition to a basic Python
library. Here, GUI = Graphical User Interface, CLI = Command Line
Interface, and `beta` indicates a work in progress.


| Application Name  | GUI/CLI    | Description                                            |
| ----------------- |----------- | ------------------------------------------------------ |
| larch             | CLI        | simple shell command-line interface                    |
| Larch GUI         | GUI        | enhanced command-line interface with data browser      |
| Larix             | GUI        | XAFS Processing and Analysis: XANES pre-edge peak      |
|                   |            | fitting, linear analysis, PCA/LASSO, EXAFS processing  |
|                   |            | Running Feff, fitting EXAFS data to Feff paths.        |
| GSE Map Viewer    | GUI        | XRF Map Viewer for GSECARS X-ray microprobe data.      |
| larch_xrf         | GUI        | Display and analyze XRF Spectra.                       |
| larch_xrd1d       | GUI        | Display and work with 1-D XRD patterns, integrate XRD  |
|                   |            | images, search for XRD patterns of known structures    |
| feff6l            | CLI        | Feff 6 EXAFS calculations                              |
| feff8l            | CLI        | Feff 8 EXAFS calculations (no XANES)                   |
| qtrixs            | GUI `beta` | Display RIXS planes, take profiles                     |



In addition, the applications built with it also use a built-in
Python-like macro language for interactive and batch processing.  This
embedded "miniPython" language is intended to be very easy to use for
novices while also being complete enough to automate data processing
and analysis and to encourage and facilitate a gentle transition to
transition from GUI-only analyses to scripted and programmatic
analysis of larger data sets, and allows Larch to be run as a service,
interacting with other processes or languages via XML-RPC.
