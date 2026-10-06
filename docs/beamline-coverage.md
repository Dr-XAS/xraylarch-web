# Which beamlines web Larch can open

Every row below was produced by running the file through the same import path
the browser uses, with all of Demeter's file readers enabled, so a reader that
is declared but never fires does not appear here as coverage. Regenerate the
table with:

    backend/.venv/bin/python backend/scripts/beamline_coverage.py \
        --output docs/beamline-coverage.md

The "Reader" column names the registry entry that identified the file. Where a
Demeter file reader converted the file first -- which is how a beamline that
says nothing about itself in its header gets named at all -- that reader is
named too, and it has to be enabled in the import preferences for the file to
open that way.

## Real files, in this repository

8 facilities are represented by a real file that opens here: Advanced Photon Source; Canadian Light Source; ESRF; National Synchrotron Light Source; National Synchrotron Light Source II; Photon Factory, KEK; Stanford Synchrotron Radiation Lightsource; Swiss Light Source.

The Facility column below repeats whatever each file calls its own facility,
so the same place appears under more than one name ("APS" and "Advanced Photon Source", "NSLS-II" and "National Synchrotron Light Source II");
the count above treats those as one facility each.

| Facility                                   | Beamline          | Format                                    | Reader                                  | Example file                                          | Test |
| -------------------------------------------|-------------------|-------------------------------------------|-----------------------------------------|-------------------------------------------------------|----------------------------------- |
| Advanced Photon Source                     | 10-BM (MRCAT)     | MRCAT column ASCII                        | aps-mrcat                               | `examples/xafsdata/.../APS10BM_2019.dat`              | test_beamline_registry.py |
| Advanced Photon Source                     | 12-BM-B           | SPEC-style column ASCII                   | aps-12bm                                | `examples/xafsdata/.../APS12BM_2019.dat`              | test_beamline_registry.py |
| Advanced Photon Source                     | 13-BM-D (GSECARS) | Epics StepScan column ASCII               | aps-gsecars                             | `examples/xafsdata/.../APS13ID_2008.dat`              | test_beamline_registry.py |
| Advanced Photon Source                     | 13-ID-E (GSECARS) | Epics StepScan column ASCII               | aps-gsecars                             | `examples/xafsdata/.../APS13ID_2019.dat`              | test_beamline_registry.py |
| Advanced Photon Source                     | 20-BM             | LabVIEW column ASCII                      | aps-xsd-labview                         | `examples/xafsdata/.../APS20BM_2001.dat`              | test_beamline_registry.py |
| Advanced Photon Source                     | 20-ID             | LabVIEW column ASCII                      | aps-xsd-labview                         | `examples/xafsdata/.../APS20ID_2018.dat`              | test_beamline_registry.py |
| Advanced Photon Source                     | 20-ID             | LabVIEW column ASCII                      | aps-xsd-labview                         | `examples/xafsdata/.../APS20ID_2022.dat`              | test_beamline_registry.py |
| Advanced Photon Source                     | 9-BM (CMC-XOR)    | SPEC                                      | spec (converted by CMC)                 | `examples/xafsdata/.../APS9BM_2006.dat`               | test_beamline_registry.py |
| Advanced Photon Source                     | 9-BM              | LabVIEW column ASCII                      | aps-xsd-labview                         | `examples/xafsdata/.../APS9BM_2019.dat`               | test_beamline_registry.py |
| Canadian Light Source                      | HXMA (06ID-1)     | CLS column ASCII                          | cls-hxma (converted by HXMA)            | `examples/xafsdata/.../CLSHXMA.dat`                   | test_beamline_registry.py |
| ESRF                                       | BM08 (LISA)       | Column ASCII                              | esrf-lisa                               | `examples/xafsdata/.../ESRF_BM08_LISA_2021.dat`       | test_beamline_registry.py |
| ESRF                                       | —                 | SPEC (ESRF zapline)                       | esrf-zapline (converted by SPEC)        | `examples/xafsdata/.../ESRF_SNBL_2013.dat`            | test_beamline_registry.py |
| —                                          | —                 | not read (WebInputError)                  | —                                       | `examples/xafsdata/.../FDMNES_2022_Mo2C_out.dat`      | — |
| —                                          | —                 | FDMNES output                             | fdmnes                                  | `examples/xafsdata/.../FDMNES_2022_Mo2C_out_conv.dat` | test_beamline_registry.py |
| NSLS-II                                    | BMM (06BM)        | XDI 1.0                                   | xdi                                     | `examples/xafsdata/.../NSLS6BM_2019.dat`              | test_xdi_reader.py |
| NSLS-II                                    | ISS (8-ID)        | Column ASCII (Bluesky export)             | bluesky-ascii                           | `examples/xafsdata/.../NSLS8ID_2019.dat`              | test_beamline_registry.py |
| National Synchrotron Light Source          | X-23A2            | XDAC column ASCII                         | nsls-xdac (converted by X23A2MED)       | `examples/xafsdata/.../NSLS_XDAC_2011.dat`            | test_beamline_registry.py |
| Photon Factory, KEK                        | BL9A              | 9809 column ASCII (angle axis)            | kek-pf (converted by PFBL12C)           | `examples/xafsdata/.../PF9A_2022.dat`                 | test_beamline_registry.py |
| Photon Factory, KEK                        | BL12C             | 9809 column ASCII (angle axis)            | kek-pf (converted by PFBL12C)           | `examples/xafsdata/.../PFBL12C_2005.dat`              | test_beamline_registry.py |
| Swiss Light Source                         | PHOENIX (X07MB)   | Column ASCII                              | sls-phoenix                             | `examples/xafsdata/.../SLS_PHOENIX_2023.dat`          | test_beamline_registry.py |
| Stanford Synchrotron Radiation Lightsource | —                 | SSRL collector ASCII                      | ssrl-collector (converted by SSRLA)     | `examples/xafsdata/.../SSRL1_2006.dat`                | test_beamline_registry.py |
| Stanford Synchrotron Radiation Lightsource | —                 | SSRL collector ASCII                      | ssrl-collector (converted by SSRLmicro) | `examples/xafsdata/.../SSRLmicro_2008.dat`            | test_beamline_registry.py |
| —                                          | —                 | opens as plain columns, no beamline named | —                                       | `examples/xafsdata/.../generic_columns_no_header.dat` | — |
| not stated in the file                     | APS 13ID          | XDI 1.0                                   | xdi                                     | `examples/xafsdata/.../cu_metal_rt.xdi`               | test_xdi_reader.py |
| APS                                        | 13-ID-E, GSECARS  | XDI 1.0                                   | xdi                                     | `examples/xafsdata/.../cu_romanglass.xdi`             | test_xdi_reader.py |
| APS                                        | 13-BM-D           | XDI 1.0                                   | xdi                                     | `examples/xafsdata/.../fe3c_rt.xdi`                   | test_xdi_reader.py |
| Advanced Photon Source                     | 13-BM-D (GSECARS) | Epics StepScan column ASCII               | aps-gsecars                             | `examples/xafsdata/.../fe_xanes_8ch.xdi`              | test_beamline_registry.py |
| not stated in the file                     | 20BM              | XDI 1.0                                   | xdi                                     | `examples/xafsdata/.../feo_rt1.xdi`                   | test_xdi_reader.py |
| APS                                        | 13-ID-C           | XDI 1.0                                   | xdi                                     | `examples/xafsdata/.../ni_metal_rt.xdi`               | test_xdi_reader.py |
| APS                                        | 13-ID-C           | XDI 1.0                                   | xdi                                     | `examples/xafsdata/.../pt_metal_rt.xdi`               | test_xdi_reader.py |
| APS                                        | 13-BM-D           | XDI 1.0                                   | xdi                                     | `examples/xafsdata/.../se_na2so4_rt.xdi`              | test_xdi_reader.py |
| Advanced Photon Source                     | 13-BM-A (GSECARS) | Epics StepScan column ASCII               | aps-gsecars                             | `examples/xafsdata/.../v_foil.xdi`                    | test_beamline_registry.py |
| —                                          | —                 | athena-perl                               | athena-project                          | `examples/xafsdata/.../cu.prj`                        | test_project_and_plugin_readers.py |

Two rows name no beamline, both correctly. `generic_columns_no_header.dat` has
no header at all, so there is nothing to identify and it opens as plain
columns. `FDMNES_2022_Mo2C_out.dat` is raw FDMNES output, whose multi-row
header the column parser rejects; the convolved output beside it
(`..._conv.dat`) opens normally, and that is the file an analysis would use.

## Synthetic NeXus files, one per documented layout

No public HDF5 example from these facilities could be fetched into this
environment and the repository carries none, so
`backend/scripts/write_demo_hdf5.py` writes one file per documented layout,
each with a Mn K edge of known height. They show that the reader walks the
layout and maps the channels; they are **not** evidence that it opens that
facility's real files. They add 2 further facilities: Diamond Light Source; SOLEIL.

| Facility             | Beamline | Format              | Reader       | Example file                                   | Test |
| ---------------------|----------|---------------------|--------------|------------------------------------------------|--------------------- |
| ESRF                 | BM23     | NeXus/HDF5 (BLISS)  | esrf-bliss   | synthetic, `write_demo_hdf5.py` (esrf-bliss)   | test_hdf5_readers.py |
| Diamond Light Source | B18      | NeXus/HDF5          | nxdata       | synthetic, `write_demo_hdf5.py` (nxdata)       | test_hdf5_readers.py |
| ESRF                 | BM31     | NeXus/HDF5 (NXxas)  | nxxas        | synthetic, `write_demo_hdf5.py` (nxxas)        | test_hdf5_readers.py |
| SOLEIL               | SAMBA    | NeXus/HDF5 (SOLEIL) | soleil-nexus | synthetic, `write_demo_hdf5.py` (soleil-nexus) | test_hdf5_readers.py |

The Bluesky reader was written against one APS Bluesky export that cannot be
published; it is not in the repository and no test reads it.

## Recognized, but with no example file here

These beamlines are named when a file of theirs arrives, from the header
patterns or from one of Demeter's file readers, but nothing in the repository
exercises them.

| Facility                               | Beamline       | Format                         | Reader         | Example file            | Test |
| ---------------------------------------|----------------|--------------------------------|----------------|-------------------------|----------------------------------- |
| —                                      | —              | NeXus/HDF5 (Bluesky)           | bluesky-nexus  | none in this repository | test_hdf5_readers.py |
| Diamond Light Source                   | B18            | Diamond B18 · Core XAFS        | plugin-b18     | none in this repository | test_project_and_plugin_readers.py |
| Synchrotron Light Research Institute   | BL8            | SLRI BL8 · Ar correction in I0 | plugin-bl8ar   | none in this repository | test_project_and_plugin_readers.py |
| ESRF                                   | BM23           | ESRF BM23                      | plugin-bm23    | none in this repository | test_project_and_plugin_readers.py |
| ESRF                                   | BM26A (DUBBLE) | ESRF DUBBLE                    | plugin-dubble  | none in this repository | test_project_and_plugin_readers.py |
| Brazilian Synchrotron Light Laboratory | —              | LNLS XAS                       | plugin-lnls    | none in this repository | test_project_and_plugin_readers.py |
| Synchrotron Light Research Institute   | BL4            | Dispersive pixel/stripe data   | plugin-slribl4 | none in this repository | test_project_and_plugin_readers.py |
| Daresbury SRS                          | —              | Daresbury SRS                  | plugin-srs     | none in this repository | test_project_and_plugin_readers.py |
| National Synchrotron Light Source      | X10C           | NSLS beamline X10C             | plugin-x10c    | none in this repository | test_project_and_plugin_readers.py |
| National Synchrotron Light Source      | X15B           | NSLS beamline X15B             | plugin-x15b    | none in this repository | test_project_and_plugin_readers.py |
