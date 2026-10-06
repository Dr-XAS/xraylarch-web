/** Starting values for one peak, read from the data inside the fit window.
 *
 * A fixed start (area 1, sigma 2 eV) is tens of times too large for a
 * pre-edge peak on normalized μ(E), and the fit can wander off from there. The
 * peak is taken to sit where the signal rises furthest above the straight line
 * joining the window's ends -- the part a linear background cannot explain --
 * with its height read there, its width from where that excess falls to half,
 * and its area from the Gaussian relation area = height × sigma × √(2π).
 *
 * The fit refuses a centre outside the points it fits, in every spectrum of a
 * series. ``support`` is the range measured by all the spectra to be fitted
 * (see commonSupport); the centre is kept inside it and inside this spectrum's
 * own points, and rounded towards the inside, never past the first point.
 */
export interface PeakStart { center: number; sigma: number; amplitude: number }

export function peakStart(x: readonly number[], y: readonly number[], xmin: number, xmax: number, support?: readonly [number, number]): PeakStart | null {
  const xs: number[] = [], ys: number[] = []
  x.forEach((value, i) => { if (value >= xmin && value <= xmax && Number.isFinite(y[i])) { xs.push(value); ys.push(y[i]) } })
  if (xs.length < 5) return null
  const span = xs[xs.length - 1] - xs[0]
  if (!(span > 0)) return null
  const slope = (ys[ys.length - 1] - ys[0]) / span
  const excess = ys.map((value, i) => value - (ys[0] + slope * (xs[i] - xs[0])))
  let best = 0
  excess.forEach((value, i) => { if (value > excess[best]) best = i })
  const range = Math.max(...ys) - Math.min(...ys)
  const height = excess[best] > 0 ? excess[best] : 0.1 * range
  let left = best, right = best
  while (left > 0 && excess[left] > height / 2) left -= 1
  while (right < xs.length - 1 && excess[right] > height / 2) right += 1
  const sigma = Math.min(span / 4, Math.max(span / 50, (xs[right] - xs[left]) / 2.3548))
  const amplitude = height * sigma * Math.sqrt(2 * Math.PI)
  if (!(amplitude > 0) || !Number.isFinite(amplitude)) return null
  const round = (value: number) => Number(value.toPrecision(3))
  const lo = Math.max(xs[0], support?.[0] ?? -Infinity), hi = Math.min(xs[xs.length - 1], support?.[1] ?? Infinity)
  return { center: inside(xs[best], lo, hi), sigma: round(sigma), amplitude: round(amplitude) }
}

/** ``value`` to two decimals, moved into [lo, hi] and rounded towards its inside. */
function inside(value: number, lo: number, hi: number) {
  if (!(lo <= hi)) return Number(value.toFixed(2))
  const rounded = Number(Math.min(hi, Math.max(lo, value)).toFixed(2))
  if (rounded < lo) return Math.ceil(lo * 100) / 100 <= hi ? Math.ceil(lo * 100) / 100 : lo
  if (rounded > hi) return Math.floor(hi * 100) / 100 >= lo ? Math.floor(hi * 100) / 100 : hi
  return rounded
}

/** The x range inside [xmin, xmax] that every spectrum measures: the latest first point to the earliest last point. */
export function commonSupport(spectra: readonly (readonly number[])[], xmin: number, xmax: number): [number, number] | undefined {
  let lo = -Infinity, hi = Infinity
  for (const x of spectra) {
    const inWindow = x.filter(value => value >= xmin && value <= xmax)
    if (!inWindow.length) return undefined
    lo = Math.max(lo, Math.min(...inWindow)); hi = Math.min(hi, Math.max(...inWindow))
  }
  return Number.isFinite(lo) && Number.isFinite(hi) ? [lo, hi] : undefined
}
