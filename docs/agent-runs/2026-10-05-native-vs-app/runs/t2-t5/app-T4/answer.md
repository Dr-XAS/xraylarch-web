No—you do **not** need to cut the long scans first. I merged all three using the common overlapping energy range; the shorter 300 K scan automatically limits the merge.

- **Inputs:** 10 K, 50 K, and 300 K
- **Method:** `demeter-larch`
- **Array:** normalized (`norm`), so differing edge steps do not dominate
- **Short-scan exclusion:** disabled; all three were included
- **Merged points:** 460
- **Merged energy range:** **8786.204 to 10134.32 eV**
- **Effective shared overlap before the final grid endpoint:** up to **10145.86 eV**

The merged spectrum ends at **10134.32 eV** because the merge uses the first scan’s grid and excludes the final grid endpoint.
