No cutting is needed: the merge automatically uses the scans’ shared energy range. Truncating first would not solve the separate short-scan exclusion rule.

I merged all three scans (10 K, 50 K and 300 K) with equal weights in **μ**, using `demeter-larch` and `exclude_short_data=false`. The saved merge confirms all three parents, no exclusions, and no processing errors or warnings. The original scans remain unchanged.

**The merged spectrum ends at 10,134.32 eV**, with 460 points spanning 8,786.204–10,134.32 eV. The common overlap extends to 10,145.86 eV, but the merge uses the 10 K grid and excludes the upper endpoint, so its final stored point is lower.
