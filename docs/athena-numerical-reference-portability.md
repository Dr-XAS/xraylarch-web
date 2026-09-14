# Native numerical reference portability

Athena Web must reproduce the recorded Demeter/Larch operations without treating
one machine's floating-point roundoff as a scientific requirement. The native
commands, measured inputs, source hashes, and archived output arrays remain in
`backend/tests/fixtures`; none of those reference files were regenerated for this
repair.

The September 2026 clean Linux check found 35 failures confined to native
Savitzky–Golay smoothing and calculations that use it. Larch constructs an
unscaled integer Vandermonde matrix and calculates its pseudoinverse with
`numpy.linalg.pinv`. At window 31 and order 9, the matrix condition number is
about 2.86e10. The pinned Linux NumPy/OpenBLAS environment produced coefficient
asymmetry of 5.33e-9 and a maximum difference of 3.14e-8 from the archived
smoothed spectrum. Comparing those results at 2e-14 required reproducing the
recording environment's SVD roundoff, even when both implementations executed
the same native operation.

The affected tests now execute the immutable recorded native commands through
an independent Larch interpreter in the test environment. They compare the web
result with that execution at the original tolerances. The replay helper imports
Larch, not the web processing functions, and follows the original reference
recorders' group setup and fit capture. For the six previously failing alignment
cases, web-versus-native residual differences were at most 3.61e-13 in the
reproducing Linux environment.

Only the floating-point outputs of native SG calculations use replay. Fixed
source and input hashes, native preferences, unsmoothed and Fortran/PDL results,
committed shifts and uncertainties, and archived fitted shift/scale comparisons
retain their existing checks. SG-dependent fit covariance and residuals use the
same native replay as the smoothing outputs. Separate replay tests use exact rational polynomial-fit coefficients and
intentional wrong-order, boundary, and alignment inputs to check that replay
still rejects meaningful numerical mistakes. The production smoothing algorithm is unchanged. Smoothing outputs, residuals,
fitted shifts, scales, and fit statistics retain their original tolerances.

There is one narrow precision correction for derived alignment uncertainty.
The native command recomputes the standard smoothing inside each residual call;
the web caches that standard. In a noisy Cu alignment, residuals differ by at
most 3.62e-13, while MINPACK's finite-difference covariance produces standard
errors of 4.6255146392226165e-5 and 4.6255168802803546e-5 eV. The relative
difference is 4.85e-7. An independently differentiated piecewise-linear
interpolation Jacobian gives 4.625515530105946e-5 eV, between the two estimates;
their relative errors are +2.92e-7 and -1.93e-7. Smoothed-fit standard errors
therefore have a one-ppm
relative comparison budget, retaining the original 2e-11 eV absolute floor.
The native committed uncertainty, rounded to 0.001 eV, still matches exactly;
unsmoothed uncertainty comparisons remain unchanged.

The missing MEE fixture was a packaging omission. The bytes in
`examples/xafsdata/AthenaProjectFiles/LaCoO3.prj` match the existing fixture
manifest's SHA256:
`9b5e126dad2514252beff52630a8a961b239aa47739b3eecdbe2c42260a8d0a2`.
They are now tracked at `backend/tests/fixtures/demeter-mee-LaCoO3.prj`, with a
specific exception to the repository's general project-file ignore rule.

CI runs the full backend suite after the shared clean-install and runtime gate.
The production deployer retains its bounded runtime gate before publishing a
candidate; test data stays separate from live workspaces.
