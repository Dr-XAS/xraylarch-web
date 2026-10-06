No—you do **not** need to cut the long scans first. The merge automatically uses the common energy range and does not require equal point counts.

I merged all three scans using:

- **Array:** normalized (`norm`)
- **Method:** `demeter-larch`
- **Short-scan exclusion:** disabled, so the 300 K scan was retained
- **Members:** 10 K, 50 K, and 300 K
- **Merged points:** 407

The merged spectrum spans **8779.0 to 10139.21 eV**, so it ends at approximately **10139.2 eV**. The upper endpoint is slightly below the 300 K scan’s raw maximum because the merge excludes the final grid endpoint.

All three scans were included; none were excluded.
