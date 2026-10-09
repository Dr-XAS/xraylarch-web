# Spline ranges and endpoint clamps

The background panel follows Athena's Rbkg, k-weight, **Spline range in k**,
**Spline range in E**, **Spline clamps**, **Standard**, and
**Energy-dependent normalization** controls. Rbkg defaults to 1 Å and spline
k-weight to 2; energy-dependent normalization starts off. The ranges stay
linked, with energy measured relative to E₀. Range maxima depend on the
spectrum and the selected parameters, not on the values in a reference screenshot.
**Advanced spline settings** contains spline dk, window, and clamp points.

**Spline energy max** is the end of the AUTOBK background-extraction range,
measured above E₀. It is the same setting as **Spline k max**, using
`E − E₀ = 3.8099821109685847 k²`. A maximum of 100 eV therefore permits
extracted χ(k) only through about 5.12 Å⁻¹. Choose a background range covering
the useful EXAFS to be fitted; a stronger clamp cannot extend that range.
The Fourier-transform range is a separate setting within that support.

The μ(E) viewer displays the background only within the effective spline
energy interval, including when the limits were entered in k. It uses the
processed E₀ on the shifted energy axis. This is a display restriction:
calculated arrays, exports, and EXAFS fitting retain their existing behavior.

Larch initializes its full-length background array with the measured μ(E),
then replaces the fitted portion from E₀ through the spline maximum (including
one bracketing energy sample). Values outside that portion are placeholders.
Drawing them made the background appear to follow the measured spectrum beyond
the selected maximum. The viewer now hides those values and the portion below
the selected spline minimum. It does not extrapolate the fitted background.

## What clamp values mean

AUTOBK adjusts a smooth spline to minimize low-R Fourier components of the
background-subtracted signal. Clamps add penalties for its endpoint residuals.
They are numerical weights, not energies, percentages, distances, or fitted
physical properties.

In this checkout's `larch/xafs/autobk.py`, let `d(k)` be the interpolated
`μ − μ₀` signal before edge-step normalization, with the supplied standard
subtracted when present, and let `r` be its low-R Fourier residual vector.
The least-squares residual appends:

```text
scale = 0.1 + 10 * mean(r²)
low endpoint residuals  = abs(clamp_lo) * scale * d[:nclamp]
high endpoint residuals = abs(clamp_hi) * scale * d[-nclamp:]
```

Increasing the high clamp thus penalizes a nonzero endpoint residual more
strongly. Without a standard, this pulls μ₀ toward μ near the chosen spline
maximum. At fixed residuals, changing the weight from 1 to 10 multiplies the
squared endpoint contribution by 100. The optimizer changes the residuals
and scale, so the resulting background displacement is not proportional to
the number entered. Strong clamps can suppress genuine endpoint EXAFS.

Clamps act on the first/last `nclamp` samples of the uniform k grid. The grid
starts at k = 0 even when **Spline k min** is positive, so the low clamp is
not a restraint exactly at the selected spline minimum.

## Practical settings

The low and high dropdowns use the native Athena preset names and weights:

| Preset | AUTOBK weight |
| --- | ---: |
| None | 0 |
| Slight | 3 |
| Weak | 6 |
| Medium | 12 |
| Strong | 24 |
| Rigid | 96 |

These are the [Athena clamp presets](https://bruceravel.github.io/demeter/documents/Athena/bkg/kweight.html).
The pinned [Demeter Larch template](https://github.com/bruceravel/demeter/blob/06afc8da08a5a7d5a26ee14992170fcf5dc67406/lib/Demeter/templates/process/larch/autobk.tmpl)
passes these weights directly as `clamp_lo` and `clamp_hi`, with `nclamp=5`.

| Control | Starting value | How to adjust |
| --- | --- | --- |
| low | None | Leave disabled unless the low-k endpoint needs restraint. |
| high | Strong | Compare weaker presets if the endpoint EXAFS is suppressed; use the smallest restraint that controls an unphysical endpoint excursion. |
| Clamp points | 5 | Start within 1–5 uniform k-grid samples. Zero disables both clamps. |

These presets are not physical bounds or a guarantee of a good background.
Inspect χ(k), low-R leakage, and
the stability of fitted results as well as μ(E). In particular, placing the
cutoff at only +100 eV can restrain a genuine oscillation near that cutoff.

The web API accepts finite clamp weights from 0 through 1000. A saved value
outside the native preset table appears as **Custom (value)** and remains
unchanged until a preset is selected. In particular, existing web projects
with the earlier high weight of 1 retain it; opening the panel does not
reprocess them. Older web files missing clamp parameters recover the saved
effective values when available, otherwise the historical defaults 0/1.
New spectra and an explicit reset use the native defaults None/Strong.

The
[Larch guide](https://xraypy.github.io/xraylarch/xafs_autobk.html#end-point-clamps-for-the-spline)
describes values around 1 as ordinary and 10–20 as very strong, but its examples
also use 50 and 200. Current native Larix offers values including 0, 1, 2, 5,
10, 20, 50, 100, 200, 500, and 1000 (`larch/wxxas/exafs_panel.py`). These are tuning choices,
not calibrated physical categories. The local algorithm also depends on the
absolute scale of μ through `scale`, so the same number need not have the same
effect for differently scaled inputs.

The web defaults above come from `AthenaParameters`; the lower-level `autobk()`
function retains its own defaults (high weight 1 and 3 clamp points).
The controls match Athena's Larch adapter. This does not establish identical
numerical results between the Larch and Ifeffit background algorithms.
