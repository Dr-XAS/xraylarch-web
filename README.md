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

## XrayLarch Web V1

XrayLarch Web is a local browser workbench for one XAS spectrum at a time. It
keeps parsing, processing, revisions, and stored arrays in the FastAPI backend;
the frontend only sends validated choices and renders server-produced traces.

### Run locally

Create the backend environment from `backend/requirements.txt` before starting
the services. From the repository root, start the backend in one terminal:

```bash
PYTHONPATH=backend backend/.venv/bin/python -m uvicorn xraylarch_web.main:app --reload --port 8006
```

`PYTHONPATH=backend` is required for the current source-tree layout because the
web backend package lives beneath `backend/`. Start the frontend in a second
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
