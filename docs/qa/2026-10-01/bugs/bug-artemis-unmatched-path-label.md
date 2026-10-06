# EXAFS fitting duplicates "paths" in the unmatched-path exclusion button

Severity: cosmetic. Confirmed visually on deployed revision 881d526f62d72f05f6fdaa8bfb879baee89acd55.

Status: fixed by PR #12 (`b13a8c937`), merged October 5, 2026, and live on port 3004 in release `dd47cdfd` (October 6). The button reads "Exclude unmatched paths".

1. Open a spectrum with an imported or saved FEFF path before selecting a matching CIF/site for shell assignment.
2. Select EXAFS fitting and inspect the FEFF paths section.
3. Under Unmatched paths, the button reads `Exclude unmatched paths paths`.

Expected: `Exclude unmatched paths`.

Actual: the group label already includes the noun, and the button adds it a second time. This does not prevent fitting.

Evidence: `/tmp/xas-qa-20261001/artemis/ui-artemis-loaded.png`, visually inspected at 1600 × 1100. QA project `2ft4lY2wBWhn0dhEYWCnbta2`, Cu foil 10 K.
