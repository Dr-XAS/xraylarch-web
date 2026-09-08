# Athena research notes

Research date: 2026-09-07. Shared branch: `Athena`.

The objective remains to seek XAS Athena tutorials and YouTube material and duplicate Athena into the webapp. This document supports that objective; it does not reduce it to a first release or certify implementation. The companion [full parity matrix](athena-parity.md) records requirements, unresolved coverage, and proposed evidence. Every implementation status starts **Pending**, for the parent to update from concrete implementation files and relevant passing checks.

## Evidence and reference baseline

The primary behavioral baseline is Bruce Ravel's [Athena 0.9.26 manual][index]. Its version label is the reference version, not a claim about the latest installed Demeter release. Sections were followed from the contents and read directly. The requested [LCF path][lcf] resolves successfully to section 10.1. The worked LCF example is [examples/aucl.html][examplelcf].

Text, documentation screenshots, and tutorial instructions establish expected behavior. They do not establish that a feature works in this repository. No desktop Athena session or numerical comparison was performed in this research task. Original summaries are deliberately brief; source-derived prose across these two documents is limited to 200 words per source page, with no extended quotations. Matrix acceptance checks are proposed engineering work, not reported test outcomes.

## Visual reference inspected

The populated [main-window image](https://bruceravel.github.io/demeter/documents/Athena/_images/athena_withdata.png), linked from [Introduction][intro], was opened and visually inspected in the browser. The image is 826 × 863 pixels; it shows gold-chloride groups. No screenshot asset was added to the repository.

Observed structure:

- A menu bar and project/save strip sit above a tool selector.
- The large left pane contains group identity, element/edge, shift, importance, and freeze controls.
- Normalization/background, forward FT, backward FT, and plotting parameters occupy separate stacked sections.
- The right pane contains group labels and independent checkboxes, marking controls, separate current/marked plot-button rows, k-weight selection, and plot options.
- A message area runs along the bottom.

These observations describe the documentation image, not an audit of the current webapp. Browser implementation should preserve the scientific control relationships and distinguish active selection from batch marking. Screenshot colors alone should not become the specification for state.

## Tutorials: original procedural summaries

These sequences were read from primary written tutorials. They have not been performed in the webapp or desktop Athena during this task.

### T1 — Import a spectrum

[Column selection][columns]: inspect the file preview; choose energy, numerator, denominator, and logarithm behavior; inspect the expression and plotted result; specify units and record type; then import. For multiple detector channels, decide between summing channels and retaining individual groups.

### T2 — Calibrate, align, share parameters, and merge

[Basic data processing][exampledata]:

1. Load `fe.060` from the iron-foil example as transmission data.
2. Inspect the derivative, optionally locate the second-derivative zero crossing, and calibrate the chosen edge point to 7112 eV.
3. Import `fe.061`, mark both scans, and inspect their energy plots.
4. Align the second scan to the calibrated first scan.
5. Set consistent E0 values and compare χ(k). Matching energy shifts alone does not guarantee a shared k origin.
6. Import the remaining temperature scans; align the marked set and propagate E0.
7. Alternatively, use import preprocessing against the prepared first scan for marking, alignment, and parameter transfer.
8. Mark scans from each temperature separately, merge each set, and give the resulting groups descriptive names.

The linked [author's Fe-foil directory](https://github.com/bruceravel/XAS-Education/tree/master/Examples/Fe%20foil) was inspected and lists `fe.060`, `fe.061`, `fe.062`, `fe.150`, `fe.151`, `fe.300`, and `fe.301`. These are fixture candidates; no data download or checksum capture was performed.

### T3 — Investigate background-removal sensitivity

[AUTOBK/Rbkg][rbkg]: load the foil scan, inspect its energy/background, k, and R plots, and duplicate the group. Compare Rbkg values of 1, 0.2, and 2.5. Mark the copies and overlay their results. Examine both residual low-R structure and changes to the first-shell amplitude. This is a parameter-sensitivity exercise, not a prescription for every sample.

### T4 — Fit a time series and investigate standards

[Gold-reduction worked example][examplelcf]:

1. Import the prepared gold standards/time-series project and inspect the series.
2. Select a time point and fit the gold-metal and aqueous-chloride standards.
3. Inspect residual structure, then add a sulfur-bearing candidate and refit.
4. Load the standards library into the LCF table; enlarge its capacity through preferences when needed.
5. Set a maximum combination size and require the known metal standard.
6. Run combinations, inspect ranked fits and individual components, and consider similar-quality alternatives.
7. Apply the selected model to the marked time series and export the batch report.

The example supports a sulfur-associated intermediate but does not uniquely identify one compound. Its old statement that PCA is unavailable conflicts with the dedicated PCA chapter; that discrepancy requires version-specific verification.

## Pinned background-processing source evidence

The [energy-dependent normalization guide][ednorm] describes its intended use
for low-energy fluorescence EXAFS and explains why energy plots retain the
original signal while χ/R/q use corrected processing. Its prose is not a
sufficient numerical specification. The implementation follows the explicit
[Demeter fnorm template at commit 06afc8da08a5a7d5a26ee14992170fcf5dc67406](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/templates/process/ifeffit/fnorm.tmpl):
form the post-minus-pre curve, scale the post-edge portion by its maximum,
leave earlier samples at a factor of one, divide raw μ by that factor, and
refit normalization and background removal. This is not a rescaling of an
already extracted χ array.

The [Ifeffit 1.2.11d source archive](https://deb.debian.org/debian/pool/main/i/ifeffit/ifeffit_1.2.11d.orig.tar.gz)
resolves two otherwise ambiguous expressions. `decod.f`'s `v1mth` maps
`ceil(array)` to the vector maximum; it does not round upward to an integer.
`nofx` expression dispatch uses `nofxa` in `misc_num.f`, whose strict comparison
keeps the first sample when distances tie. The science tests cover both details.
The archive's `spline.f`/`splfun.f` also show automatic standard-amplitude
adjustment. The local Larch standard uses fixed amplitude and subtracts the
standard before dividing by edge step, requiring the supplied dimensionless
χ standard to be scaled into residual μ units. Source-level agreement on the
correction sequence does not establish identical polynomial/spline numerics.

The checked-in [source manifest](athena-primary-sources.json) records exact
upstream URLs, versions, paths within their source packages, and SHA-256 hashes.
The fnorm template hash is
`146d05e061f6b6d77c0ec04b522c8c038d371b280eecede87120b4142713c1a0`;
the Ifeffit archive hash is
`76797e14a922cae4e76c92cfb6fddef545d2e3ffb6af4f53bf12ef6cf3b461a8`.
These files were fetched and inspected locally. No desktop Ifeffit execution
or exact standard-amplitude parity is claimed.

## Edge-energy methods and scientific meaning

The [E0 guide][e0] distinguishes setting an edge reference from calibrating
the energy axis. The new `set_e0` command records an explicit E0 on each
scan's shifted energy axis while retaining its energy shift. It supports
fresh derivative estimates, tabulated atomic energies, iterative edge-step
fractions, second-derivative zero crossings, white-line refinement, and
manual input. The atomic method can infer an element/edge for each scan or
use an explicit pair. Inference is an energy-table match, not a chemical
identification.

The fraction method repeats scalar normalization up to five times. Derivative
refinement must respect the source's search order on irregular grids; an
unrestricted global peak is not an equivalent substitute. White-line source
review includes `Data/Mu.pm::find_white_line` and the `find_wl` templates,
which refine a local peak using flattened data. Element/edge enforcement is
a separate operation involving import/default state; atomic E0 selection
alone does not implement enforcement. The [enforcement reference](athena-edge-enforcement-reference.md)
records the import/default-state contract. The [verification notes](athena-verification.md)
and coverage matrix retain the numerical limits and remaining work.

## YouTube discovery and verification limits

The [IXAS video index](https://xafs.xrayabsorption.org/videos.html) lists the following resources. Titles/presenter associations are verified from that index; its approximate duration/count is catalog metadata.

| Resource | Link | Verification in this task |
| --- | --- | --- |
| Bruce Ravel — EXAFS/XANES fitting with Athena | [Course playlist](https://www.youtube.com/playlist?list=PLyzX_pouV65vbohf_puwlg9fGNjJGpKpd) | IXAS describes nine roughly hour-long videos. Direct fetch returned a playlist title and generic page text only. |
| Shelly Kelly — Demeter/Athena for Fe-S, Part 1 | [YouTube video](https://www.youtube.com/watch?v=xWq-8OCxXEE) | Discovered via IXAS; direct fetch failed. |
| Shelly Kelly — Demeter/Athena for Fe-S, Part 2 | [YouTube video](https://www.youtube.com/watch?v=nBm19RncBu0) | Discovered via IXAS; direct fetch failed. |

**Playback and transcripts were not verified for these videos.** No timestamped steps, detailed lesson claims, or claims of having watched them are made. Video-specific workflow extraction remains open. T1–T4 above come from written sources and must not be represented as video summaries.

## Coverage and interpretation gaps

These findings affect the full objective and must remain visible:

- [Deconvolution][deconv] and [dispersive XAS][pixel] are upstream TODO pages. Retain both in the requested coverage; obtain a working reference or explicitly define and validate the intended additional behavior.
- [PCA][pca] documents decomposition, reconstruction, and target transformation, but labels the chapter incomplete and says cluster plotting is unimplemented. A table-of-contents entry is insufficient evidence of a working control.
- [Normalization][norm] describes its default as a three-term quadratic. Do not translate the UI's normalization-order values directly into a library polynomial degree without checking conventions.
- [Spline range][range] describes a lower default of 0.5 Å⁻¹, whereas the inspected main-window image shows 0. Defaults and screenshots can differ by dataset, preferences, and version; capture the chosen reference configuration.
- [Parameter sharing][constrain] describes applying values across groups. Treat persistent formula links as an unverified extension; sample/reference energy shifts have separately documented linkage.
- [Short-range data][short] identifies normalization limits and explicitly says MBACK is unavailable in this Athena reference. A Larch MBACK function would not by itself establish Athena parity.
- [Smoothing][smooth] and [peak fitting][peak] identify backend-dependent options. Pin whether each comparison uses IFEFFIT or Larch.
- [Project files][project] preserve analysis-tool state on full import; subset import does not restore that state. Spectrum-only round trips cannot close project parity.
- [Hephaestus][hephaestus] is a separate companion program covered by the manual. Its tools remain visible in the matrix as a companion-scope gap; this research does not silently fold all Demeter applications into Athena or silently drop the chapter.

Unverified extensions and companion scope are not grounds for reducing the requested Athena functional coverage. The parent should resolve them explicitly while implementing the documented behaviors.

## Validation work for the parent

The following is a proposed verification strategy:

1. Pin the reference Athena/Demeter version, numerical backend/version, preference file, and fixture checksums.
2. Record expected scientific arrays and operation parameters from an actual reference run. Use stated absolute/relative tolerances for each quantity; visual similarity is insufficient.
3. Replay the tutorials and the matrix's batch workflows through the browser, including mixed marked, unmarked, and frozen groups.
4. Check parameter propagation and dependency invalidation: each change must recompute only the affected scientific products while maintaining provenance.
5. Test both directions of project exchange with desktop Athena. Compare saved state as well as regenerated arrays.
6. Record mismatches by matrix ID. Partial implementations retain the missing options and limitations instead of being relabeled complete.

Likely starting points found by file inventory, **not implementation evidence**:

| Area | Existing paths to investigate |
| --- | --- |
| Web import and processing | `backend/xraylarch_web/parsing.py`, `backend/xraylarch_web/processing.py`, `backend/xraylarch_web/contracts.py` |
| Browser workflow | `frontend/components/workbench-shell.tsx`, `frontend/components/processing-inspector.tsx`, `frontend/components/upload-inspector.tsx`, `frontend/lib/workbench-state.ts` |
| Scientific routines | `larch/xafs/pre_edge.py`, `larch/xafs/autobk.py`, `larch/xafs/xafsft.py`, `larch/xafs/rebin_xafs.py`, `larch/xafs/fluo.py`, `larch/xafs/deconvolve.py` |
| Project exchange | `larch/io/athena_project.py`, `tests/test_athena_addgroup.py`, `examples/xafsdata/AthenaProjectFiles/` |
| Existing checks | `backend/tests/test_processing.py`, `backend/tests/test_parsing.py`, `backend/tests/test_api.py`, `frontend/components/workbench-shell.test.tsx`, `frontend/tests/e2e/workbench.spec.ts` |

No test results are asserted from those filenames. This documentation change does not close the webapp duplication objective.

## Primary source register

All manual links below were opened during this research. Notes identify evidence type rather than webapp implementation status. Source identifiers match the parity matrix links.

| ID | Primary source | Evidence note |
| --- | --- | --- |
| index | [Athena 0.9.26 contents](https://bruceravel.github.io/demeter/documents/Athena/index.html) | Coverage inventory |
| intro | [Introduction and first look](https://bruceravel.github.io/demeter/documents/Athena/intro.html) | Text and populated-window image inspected |
| columns | [Column selection](https://bruceravel.github.io/demeter/documents/Athena/import/columns.html) | Import controls and data types |
| projsel | [Project selection](https://bruceravel.github.io/demeter/documents/Athena/import/projsel.html) | Subset import |
| multiple | [Multiple data set import](https://bruceravel.github.io/demeter/documents/Athena/import/multiple.html) | Batch import semantics |
| ref | [Reference channel](https://bruceravel.github.io/demeter/documents/Athena/import/ref.html) | Linked energy shifts |
| preproc | [Preprocessing](https://bruceravel.github.io/demeter/documents/Athena/import/preproc.html) | Import-time operations |
| norm | [Normalization](https://bruceravel.github.io/demeter/documents/Athena/bkg/norm.html) | Pre/post-edge and flattening |
| rbkg | [AUTOBK and Rbkg](https://bruceravel.github.io/demeter/documents/Athena/bkg/rbkg.html) | Algorithm and worked comparison |
| bkgkw | [Spline clamps and background k-weight](https://bruceravel.github.io/demeter/documents/Athena/bkg/kweight.html) | Independent controls |
| range | [Spline range](https://bruceravel.github.io/demeter/documents/Athena/bkg/range.html) | Energy/k range coupling |
| ednorm | [Energy-dependent normalization](https://bruceravel.github.io/demeter/documents/Athena/bkg/ednorm.html) | Special correction and compatibility caveat |
| short | [Short energy ranges](https://bruceravel.github.io/demeter/documents/Athena/bkg/short.html) | Normalization limits; MBACK unavailable in this Athena reference |
| tabs | [Plotting space tabs](https://bruceravel.github.io/demeter/documents/Athena/plot/tabs.html) | E/k/R/q behavior |
| krange | [Spectral resolution and k-range](https://bruceravel.github.io/demeter/documents/Athena/plot/krange.html) | Transform-range comparison |
| otherplot | [Other plotting options](https://bruceravel.github.io/demeter/documents/Athena/plot/other.html) | Stacking, indicators, exports, plot targets |
| plotparams | [Group plot parameters](https://bruceravel.github.io/demeter/documents/Athena/plot/params.html) | Scale and offset |
| special | [Special plots](https://bruceravel.github.io/demeter/documents/Athena/plot/etc.html) | Diagnostic and comparative plots |
| glist | [Group list](https://bruceravel.github.io/demeter/documents/Athena/ui/glist.html) | Selection, lifecycle, ordering |
| mark | [Marking groups](https://bruceravel.github.io/demeter/documents/Athena/ui/mark.html) | Batch selection and patterns |
| pluck | [Pluck buttons](https://bruceravel.github.io/demeter/documents/Athena/ui/pluck.html) | Plot-to-field interaction |
| styles | [Plot styles](https://bruceravel.github.io/demeter/documents/Athena/ui/styles.html) | Persistent plot presets |
| plotkw | [Plot and transform k-weights](https://bruceravel.github.io/demeter/documents/Athena/ui/kweight.html) | Shared plotting/FT selector |
| frozen | [Frozen groups](https://bruceravel.github.io/demeter/documents/Athena/ui/frozen.html) | Direct and global edit protection |
| monitor | [Monitor menu](https://bruceravel.github.io/demeter/documents/Athena/ui/monitor.html) | Commands, status, diagnostics |
| constrain | [Parameter constraints](https://bruceravel.github.io/demeter/documents/Athena/params/constrain.html) | Single, section, and all-parameter propagation |
| e0 | [Setting E0](https://bruceravel.github.io/demeter/documents/Athena/params/e0.html) | Methods and element/edge enforcement |
| defaults | [Parameter defaults](https://bruceravel.github.io/demeter/documents/Athena/params/defaults.html) | Preference precedence and relative ranges |
| columnout | [Column output](https://bruceravel.github.io/demeter/documents/Athena/output/column.html) | Scientific arrays and batch export |
| project | [Project files](https://bruceravel.github.io/demeter/documents/Athena/output/project.html) | Legacy/JSON formats and analysis state |
| report | [Parameter reports](https://bruceravel.github.io/demeter/documents/Athena/output/report.html) | Tables and empirical-standard export |
| cal | [Calibration](https://bruceravel.github.io/demeter/documents/Athena/process/cal.html) | Absolute-energy assignment |
| align | [Alignment](https://bruceravel.github.io/demeter/documents/Athena/process/align.html) | Relative shifts and reference alignment |
| merge | [Merging](https://bruceravel.github.io/demeter/documents/Athena/process/merge.html) | Weights, spread, and reference merges |
| rebin | [Rebinning](https://bruceravel.github.io/demeter/documents/Athena/process/rebin.html) | Three-region grids and batch operation |
| deg | [Deglitching and truncation](https://bruceravel.github.io/demeter/documents/Athena/process/deg.html) | Point removal and bounds |
| smooth | [Smoothing](https://bruceravel.github.io/demeter/documents/Athena/process/smooth.html) | Backend-dependent filter choices |
| conv | [Convolution](https://bruceravel.github.io/demeter/documents/Athena/process/conv.html) | Broadening and noise |
| deconv | [Deconvolution](https://bruceravel.github.io/demeter/documents/Athena/process/deconv.html) | Upstream TODO in this manual |
| sa | [Self-absorption approximations](https://bruceravel.github.io/demeter/documents/Athena/process/sa.html) | Four algorithms and applicability |
| pixel | [Dispersive XAS](https://bruceravel.github.io/demeter/documents/Athena/process/pixel.html) | Upstream TODO in this manual |
| mee | [Multi-electron excitation removal](https://bruceravel.github.io/demeter/documents/Athena/process/mee.html) | Two correction models |
| series | [Copy series](https://bruceravel.github.io/demeter/documents/Athena/process/series.html) | Parameter sweeps |
| sum | [Data summation](https://bruceravel.github.io/demeter/documents/Athena/process/sum.html) | User-weighted combinations |
| lcf | [Linear combination fitting](https://bruceravel.github.io/demeter/documents/Athena/analysis/lcf.html) | Path verified; options, batch, combinatorics |
| pca | [Principal components analysis](https://bruceravel.github.io/demeter/documents/Athena/analysis/pca.html) | Incomplete chapter; cluster plot unimplemented |
| peak | [Peak fitting](https://bruceravel.github.io/demeter/documents/Athena/analysis/peak.html) | Models, results, sequences |
| lr | [Log-ratio/phase-difference](https://bruceravel.github.io/demeter/documents/Athena/analysis/lr.html) | Filtered comparison and cumulants |
| diff | [Difference spectra](https://bruceravel.github.io/demeter/documents/Athena/analysis/diff.html) | Subtraction and integrated areas |
| meta | [File metadata](https://bruceravel.github.io/demeter/documents/Athena/other/meta.html) | XDI and comments |
| journal | [Project journal](https://bruceravel.github.io/demeter/documents/Athena/other/journal.html) | Project notes |
| plugin | [File type plugins](https://bruceravel.github.io/demeter/documents/Athena/other/plugin.html) | Recognition, conversion, suggestions |
| prefs | [Preferences](https://bruceravel.github.io/demeter/documents/Athena/other/prefs.html) | Typed settings and saved defaults |
| exampledata | [Basic data processing tutorial](https://bruceravel.github.io/demeter/documents/Athena/examples/data.html) | Read; not replayed in desktop Athena |
| examplelcf | [Gold reduction LCF tutorial](https://bruceravel.github.io/demeter/documents/Athena/examples/aucl.html) | Read; not replayed in desktop Athena |
| hephaestus | [Hephaestus companion tools](https://bruceravel.github.io/demeter/documents/Athena/hephaestus.html) | Separate program included in manual |

[index]: https://bruceravel.github.io/demeter/documents/Athena/index.html
[intro]: https://bruceravel.github.io/demeter/documents/Athena/intro.html
[columns]: https://bruceravel.github.io/demeter/documents/Athena/import/columns.html
[projsel]: https://bruceravel.github.io/demeter/documents/Athena/import/projsel.html
[multiple]: https://bruceravel.github.io/demeter/documents/Athena/import/multiple.html
[ref]: https://bruceravel.github.io/demeter/documents/Athena/import/ref.html
[preproc]: https://bruceravel.github.io/demeter/documents/Athena/import/preproc.html
[norm]: https://bruceravel.github.io/demeter/documents/Athena/bkg/norm.html
[rbkg]: https://bruceravel.github.io/demeter/documents/Athena/bkg/rbkg.html
[bkgkw]: https://bruceravel.github.io/demeter/documents/Athena/bkg/kweight.html
[range]: https://bruceravel.github.io/demeter/documents/Athena/bkg/range.html
[ednorm]: https://bruceravel.github.io/demeter/documents/Athena/bkg/ednorm.html
[short]: https://bruceravel.github.io/demeter/documents/Athena/bkg/short.html
[tabs]: https://bruceravel.github.io/demeter/documents/Athena/plot/tabs.html
[krange]: https://bruceravel.github.io/demeter/documents/Athena/plot/krange.html
[otherplot]: https://bruceravel.github.io/demeter/documents/Athena/plot/other.html
[plotparams]: https://bruceravel.github.io/demeter/documents/Athena/plot/params.html
[special]: https://bruceravel.github.io/demeter/documents/Athena/plot/etc.html
[glist]: https://bruceravel.github.io/demeter/documents/Athena/ui/glist.html
[mark]: https://bruceravel.github.io/demeter/documents/Athena/ui/mark.html
[pluck]: https://bruceravel.github.io/demeter/documents/Athena/ui/pluck.html
[styles]: https://bruceravel.github.io/demeter/documents/Athena/ui/styles.html
[plotkw]: https://bruceravel.github.io/demeter/documents/Athena/ui/kweight.html
[frozen]: https://bruceravel.github.io/demeter/documents/Athena/ui/frozen.html
[monitor]: https://bruceravel.github.io/demeter/documents/Athena/ui/monitor.html
[constrain]: https://bruceravel.github.io/demeter/documents/Athena/params/constrain.html
[e0]: https://bruceravel.github.io/demeter/documents/Athena/params/e0.html
[defaults]: https://bruceravel.github.io/demeter/documents/Athena/params/defaults.html
[columnout]: https://bruceravel.github.io/demeter/documents/Athena/output/column.html
[project]: https://bruceravel.github.io/demeter/documents/Athena/output/project.html
[report]: https://bruceravel.github.io/demeter/documents/Athena/output/report.html
[cal]: https://bruceravel.github.io/demeter/documents/Athena/process/cal.html
[align]: https://bruceravel.github.io/demeter/documents/Athena/process/align.html
[merge]: https://bruceravel.github.io/demeter/documents/Athena/process/merge.html
[rebin]: https://bruceravel.github.io/demeter/documents/Athena/process/rebin.html
[deg]: https://bruceravel.github.io/demeter/documents/Athena/process/deg.html
[smooth]: https://bruceravel.github.io/demeter/documents/Athena/process/smooth.html
[conv]: https://bruceravel.github.io/demeter/documents/Athena/process/conv.html
[deconv]: https://bruceravel.github.io/demeter/documents/Athena/process/deconv.html
[sa]: https://bruceravel.github.io/demeter/documents/Athena/process/sa.html
[pixel]: https://bruceravel.github.io/demeter/documents/Athena/process/pixel.html
[mee]: https://bruceravel.github.io/demeter/documents/Athena/process/mee.html
[series]: https://bruceravel.github.io/demeter/documents/Athena/process/series.html
[sum]: https://bruceravel.github.io/demeter/documents/Athena/process/sum.html
[lcf]: https://bruceravel.github.io/demeter/documents/Athena/analysis/lcf.html
[pca]: https://bruceravel.github.io/demeter/documents/Athena/analysis/pca.html
[peak]: https://bruceravel.github.io/demeter/documents/Athena/analysis/peak.html
[lr]: https://bruceravel.github.io/demeter/documents/Athena/analysis/lr.html
[diff]: https://bruceravel.github.io/demeter/documents/Athena/analysis/diff.html
[meta]: https://bruceravel.github.io/demeter/documents/Athena/other/meta.html
[journal]: https://bruceravel.github.io/demeter/documents/Athena/other/journal.html
[plugin]: https://bruceravel.github.io/demeter/documents/Athena/other/plugin.html
[prefs]: https://bruceravel.github.io/demeter/documents/Athena/other/prefs.html
[exampledata]: https://bruceravel.github.io/demeter/documents/Athena/examples/data.html
[examplelcf]: https://bruceravel.github.io/demeter/documents/Athena/examples/aucl.html
[hephaestus]: https://bruceravel.github.io/demeter/documents/Athena/hephaestus.html
