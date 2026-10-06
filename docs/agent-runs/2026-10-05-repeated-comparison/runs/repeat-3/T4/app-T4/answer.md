No—you do **not** need to cut the long scans first. I merged all three directly using the common overlap, with the 300 K scan retained (`exclude_short_data: false`).

- **Merged groups:** Cu foil · 300 K, 10 K, and 50 K
- **Array merged:** `mu`
- **Merged points:** 407
- **Merged energy range:** **8779.0 to 10139.21 eV**
- **Merged spectrum ends at:** **10139.21 eV**

The endpoint is just below the shortest scan’s raw maximum of 10145.86 eV because the merge excludes the upper grid endpoint. The two longer scans required one-point linear extrapolation onto the 300 K grid.
