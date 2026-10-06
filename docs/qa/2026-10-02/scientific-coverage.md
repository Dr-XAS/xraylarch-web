# Varied scientific QA, October 2, 2026

One new workflow defect was confirmed, XAS-QA-008. The app recommends an invalid kmax for a short processed spectrum, and its normal recommendation action fails. The report is [XAS-QA-008](bugs/short-data-kmax-suggestion.md).

The matrix recorded 98 direct HTTP requests and 38 numerical or behavioral assertions. Of 136 checks, 135 passed and one identified that defect. Additional Chromium requests reproduced the normal UI action. `coverage.json` retains the results; initial expectations corrected after valid scientific refusals are explicitly annotated.

## Deployment and isolation

Testing began on revision `881d526f62d72f05f6fdaa8bfb879baee89acd55`. The public deployment changed to `18c6a8dd03502e15c0bba88490c88f966ad70ffe` during the audit. After detecting the change, `current_release.py` reprocessed the measured and controlled spectra and repeated the principal scientific checks. It verified the same new revision before and after the rerun, at 05:30:46 and 05:30:49 UTC on October 2. The bug was also reproduced in the browser on that revision.

Only these new QA projects were changed:

| Project | ID |
|---|---|
| QA 2026-10-02 Science measured L edges and fluorescence | `g9U3XTrzmMe1ngUEq72WG4tQ` |
| QA 2026-10-02 Science controlled weak noisy short unequal cases | `i4i4j1xDXYLugONRhtuReO70` |
| QA 2026-10-02 Science unequal grids and contaminated standards | `dMZOLRlYbtnmVcnVDeOsuCXt` |

No source fixes, commits, deployment actions or shared preference writes were made. Normal imports may update remembered column mappings. The QA projects and fixtures remain available.

## Inputs and results

| Case | Input and check | Result |
|---|---|---|
| Measured Pt L3 | Repository `pt_metal_rt.xdi`, transmission from I0/itrans | Raw mu matches the logarithmic ratio; normalized and Fourier arrays are finite. The XDI Pt L3 identity survives processing. |
| Measured Sn L3 | Repository `sno2_l3.dat` | Processing succeeds. Automatic nearest-edge inference labels it In L2, explicitly marked inferred; selecting Sn L3 corrects the identity without changing numeric E0. Inference alone cannot establish the sample chemistry. |
| Measured Cu fluorescence | Repository `cu_romanglass.xdi`, deadtime-corrected fluorescence/I0 | Imported mu matches the selected detector ratio exactly. Processing and wavelet output remain finite. |
| Weak edge steps | Measured Cu 10 K mu scaled by 0.001 and 0.000001, with a constant baseline added | Edge steps scale as expected. Maximum normalized differences are 6.76e-13 and 9.58e-11. The millionfold weaker input retains the baseline fitted Cu distance, 2.5484 angstrom. |
| Low-count fluorescence | Explicitly synthetic Poisson counts derived from the measured Cu normalized curve, fixed seed 20261002 | Import preserves counts/I0 exactly, including zero counts. The digest's signal/noise ratios are 1.1 to 1.5. A Cu model fit has R-factor 0.648844 and clear poor-fit, bound and correlation concerns. |
| Short EXAFS | Measured Cu shortened to E0 + 150 eV | Available kmax is 6.25; explicit kmax=18 is correctly rejected. A model with four variables and 1.76 independent points is rejected before fitting. |
| Short XANES tails | Measured Cu shortened to E0 + 25 and +10 eV | The 25 eV tail gets a short-range warning and reduced effective kmin. The 10 eV tail retains normalization while explicitly withholding EXAFS. The recommendation action on the 25 eV case exposes XAS-QA-008. |
| Unequal grids | Two normalized standards at 0.8 and 1.1 eV steps, target at 0.55 eV; target constructed from the same linear interpolation rule | LCF recovers 0.3 and 0.7 with R-factor 3.92e-33. PCA gives one nonzero component and finite arrays. |
| Contaminated standard | The second standard contains 10% of the first; target remains the original 30/70 mixture | LCF returns the mathematically expected apparent weights 2/9 and 7/9 with almost zero residual. This is an input limitation, not a solver defect: a good residual cannot establish reference purity. |
| Missing species | The target contains a third spectral component absent from its two supplied standards | LCF exposes the residual and R-factor 0.0112835. The returned weights are not chemical truth; the test demonstrates the consequences of an incomplete reference set. |
| No edge or reversed edge | Constant signal and negated measured absorption | Imported groups retain explicit processing errors instead of presenting successful normalization. |

Measured Pt and Sn L edges were available locally; no measured Au or Pb spectrum was claimed. All count-noise, scale, range and mixture modifications are labeled synthetic or controlled derivatives, not new measurements.

## Artemis checks

A Pt L3 FEFF calculation used the bundled platinum structure AMCSD 14947, whose source states 18 C. A first-shell fit over k=3 to 14 inverse angstrom returned Pt-Pt distance 2.7656 angstrom, sigma2=0.00459036 square angstrom and R-factor 0.0024348. Repeating with kmax 8, 10, 12, 14 and 16 moved the distance from 2.7600 to 2.7656 angstrom, a spread of 0.0056. The shorter windows correctly raised amplitude/disorder and energy/distance correlation concerns. This is a consistency check, not an independent certification of structural accuracy.

The app rejected Cu K FEFF paths against the Pt L3 spectrum. Inappropriate models with the correct absorbing element were allowed to fit but reported their failures: a Cu-O path fitted to copper metal returned R-factor 0.974113 with parameters at bounds, and the Cu-Cu model fitted to Cu2O also returned concerns. The low-count fluorescence fit likewise carried strong warnings. No poor model in this matrix was accepted without either refusal or diagnostic evidence of its failure.

## Evidence and replay

`science.py` creates measured and controlled inputs. `continue.py` resumes after the correctly rejected too-large kmax request; the initial script stop is a test-driver assumption, not an app failure. `fits.py`, `followups.py`, `current_release.py` and `pt_stability.py` cover models, range guards and the current-release rerun. `reproduce-suggestion.mjs` captures the browser action and error.

Exact request/response JSON files, input fixtures, measured arrays, screenshots and compact logs are under `/tmp/xas-qa-20261002/science` and in the durable evidence archive linked from the audit report. The confirmed finding is also saved in shared project memory.
