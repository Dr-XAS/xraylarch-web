import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { LcfSearchSummary, LcfSeriesSummary, LcfWeights, PeakSeriesSummary, PeakSummary, ReferenceSuggestions, plusMinus, suggestionsMatch, weightNote } from './athena-analysis-summary'

afterEach(cleanup)

it('shows a fitted value to the precision its own error resolves', () => {
  // Catches a fixed number of decimals, which either hides resolved digits or
  // invents digits the fit cannot support.
  expect(plusMinus(5468.5012, 0.0206)).toBe('5468.501 ± 0.021')
  expect(plusMinus(1.19649, 0.0327)).toBe('1.196 ± 0.033')
  expect(plusMinus(0.000123456, 1.2e-6)).toBe('0.0001235 ± 0.0000012')
})

it('says why a weight has no error instead of printing a number for it', () => {
  // Catches rendering a pinned weight as if it were a fitted parameter.
  expect(weightNote(0, null)).toBe('held at zero')
  expect(weightNote(0.42, null)).toBe('no error')
  expect(weightNote(1, 0)).toBe('fixed')
  expect(weightNote(0.859, 0.0149)).toBe('± 1.5%')
})

it('reports each standard as a percentage with its error and the fit quality', () => {
  render(<LcfWeights result={{ labels: ['Arsenopyrite', 'Kankite', 'Scorodite'],
    weights: [0.1413, 0.8587, 0], weight_stderr: [0.0149, 0.0149, null],
    rfactor: 0.0085024, reduced_chisqr: 0.0095723, degrees_of_freedom: 107 }} />)
  expect(screen.getByText('14.1%')).toBeInTheDocument()
  expect(screen.getByText('85.9%')).toBeInTheDocument()
  expect(screen.getAllByText('± 1.5%')).toHaveLength(2)
  expect(screen.getByText('held at zero')).toBeInTheDocument()
  // The statistic is RSS/dof with no noise model; calling it plain "reduced χ²" read as a calibrated test.
  expect(screen.getByText(/R-factor 0.008502 · unweighted reduced χ² 0.009572 · 107 degrees of freedom/)).toBeInTheDocument()
  expect(screen.getByText(/lower bounds/)).toBeInTheDocument()
  expect(screen.getByText(/treated as fixed rather than fitted/)).toBeInTheDocument()
})

it('shows the backend warning in place of the hint when errors are withheld', () => {
  // Catches a panel that shows "no error" on every weight with no reason given:
  // near-collinear standards are the common case, and the user has to know why.
  render(<LcfWeights result={{ labels: ['Kankite', 'Twin'], weights: [0.5, 0.5],
    weight_stderr: [null, null], weight_stderr_warning: 'The chosen standards are nearly linearly dependent.',
    rfactor: 0.0085024 }} />)
  expect(screen.getByText(/nearly linearly dependent/)).toBeInTheDocument()
  expect(screen.queryByText(/lower bounds/)).not.toBeInTheDocument()
})

const search = {
  labels: ['Elemental As', 'Arsenopyrite', 'Kankite'],
  combinations: [
    { indices: [1, 2], weights: [0.1413, 0.8587], weight_stderr: [0.0149, 0.0149], rfactor: 0.0085024, reduced_chisqr: 0.0009572 },
    { indices: [0, 2], weights: [0.09, 0.91], weight_stderr: [0.02, 0.02], rfactor: 0.0101, reduced_chisqr: 0.0011 },
    { indices: [2], weights: [1], weight_stderr: [null], rfactor: 0.031, reduced_chisqr: null },
  ],
  best: { indices: [1, 2], weights: [0.1413, 0.8587], weight_stderr: [0.0149, 0.0149],
    rfactor: 0.0085024, reduced_chisqr: 0.0009572, degrees_of_freedom: 107 },
  tried: 6, skipped: 1,
}

it('ranks the combinations and names the standards in each row', () => {
  // Catches a table that shows bare indices, which a reader cannot interpret.
  render(<LcfSearchSummary result={search} />)
  const rows = screen.getAllByRole('row').slice(1) as HTMLTableRowElement[]
  expect(within(rows[0]).getByText('Arsenopyrite 14.1% · Kankite 85.9%')).toBeInTheDocument()
  expect(within(rows[1]).getByText('Elemental As 9.0% · Kankite 91.0%')).toBeInTheDocument()
  expect(within(rows[2]).getByText('—')).toBeInTheDocument()
  expect(rows.map(row => Number(row.cells[1].textContent))).toEqual([0.008502, 0.0101, 0.031])
  expect(screen.getByText(/6 combinations fitted, 1 skipped as linearly dependent/)).toBeInTheDocument()
  // The winning fit is spelt out underneath with the standards it actually used.
  expect(screen.getByText('Arsenopyrite')).toBeInTheDocument()
  expect(screen.getByText('85.9%')).toBeInTheDocument()
})

it('gives every series target its own row and names a target that could not be fitted', () => {
  // Catches a series table that drops the failed scan, which reads as "absent" rather than "not fitted".
  render(<LcfSeriesSummary result={{ labels: ['Cu foil', 'Cu2O'], xmin: 8960, xmax: 9060, targets: [
    { label: 'scan 3', weights: [0.8, 0.2], weight_stderr: [0.0123, 0.0123], rfactor: 1.2e-4, reduced_chisqr: 3e-6 },
    { label: 'scan 31', error: 'scan 31: The fit range must lie inside every spectrum\'s measured overlap; reduce xmin/xmax.' },
  ] }} />)
  const rows = screen.getAllByRole('row').slice(1) as HTMLTableRowElement[]
  expect(rows[0]).toHaveTextContent(/scan 3.*80\.0%.*± 1\.2%.*20\.0%/)
  expect(rows[1]).toHaveTextContent('scan 31not fitted')
  expect(screen.getByText(/1 of 2 targets fitted against the same 2 standards/)).toBeInTheDocument()
  expect(screen.getByText(/^scan 31: The fit range/)).toBeInTheDocument()
})

const peaks = {
  parameters: {
    background_slope: { value: -0.0012, stderr: 0.00004 },
    background_intercept: { value: 6.8, stderr: 0.21 },
    peak_1_amplitude: { value: 1.19649, stderr: 0.0327 },
    peak_1_center: { value: 5468.5012, stderr: 0.0206 },
    peak_1_sigma: { value: 0.766288, stderr: 0.0218 },
    peak_1_fwhm: { value: 1.80447, stderr: 0.0513 },
    peak_1_height: { value: 0.622912, stderr: 0.0147 },
  },
  redchi: 0.0012551,
  details: { peak_kinds: ['gaussian'], uncertainties_available: true },
}

it('gives peak areas and positions with errors rather than raw JSON', () => {
  render(<PeakSummary result={peaks} />)
  const row = screen.getAllByRole('row')[1] as HTMLTableRowElement
  expect(Array.from(row.cells).map(cell => cell.textContent)).toEqual(
    ['1', 'gaussian', '1.196 ± 0.033', '5468.501 ± 0.021', '1.804 ± 0.051', '0.623 ± 0.015'])
  expect(screen.getByText(/Unweighted reduced χ² 0.001255/)).toBeInTheDocument()
  expect(screen.getByText(/signal × eV/)).toBeInTheDocument()
  expect(screen.getByText(/lower bounds/)).toBeInTheDocument()
})

it('names the edge step it fitted under the peaks, and which of its settings were held', () => {
  // After the step background was added, the summary still read
  // 'background slope × x + intercept': a different model from the one fitted,
  // and the step changes pre-edge areas.
  const stepped = { ...peaks, parameters: { ...peaks.parameters,
    step_amplitude: { value: 0.42, stderr: 0.01, vary: true },
    step_center: { value: 6550.95, stderr: null, vary: false },
    step_sigma: { value: 1.5, stderr: null, vary: false } },
    details: { ...peaks.details, background: 'slope*x + intercept + erf step (amplitude, center, sigma)' } }
  render(<PeakSummary result={stepped} />)
  expect(screen.getByText(/error-function step: height 0\.420 ± 0\.010, centre 6550\.95 eV \(held\), width 1\.50 eV \(held\)/)).toBeInTheDocument()
})

const seriesSpectrum = (amplitude: number, stderr: number, redchi: number) => ({
  parameters: {
    peak_1_amplitude: { value: amplitude, stderr },
    peak_1_center: { value: 5469.0004, stderr: 0.00041 },
    peak_1_fwhm: { value: 1.8828, stderr: 0.0012 },
  },
  redchi,
})
const series = {
  labels: ['V2O5', 'VO2', 'V glass'],
  spectra: [seriesSpectrum(1.0001, 0.00124, 4.1e-6), seriesSpectrum(2.4978, 0.00141, 4.3e-6), seriesSpectrum(0.399, 0.00119, 3.9e-6)],
  redchi: 4.08e-6,
  details: { peak_kinds: ['gaussian'], shared_across_series: ['center', 'sigma'], uncertainties_available: true },
}

it("prints each spectrum's own step background, not only that there was one", () => {
  // The series summary said each spectrum had a step at its own E0 but printed
  // no step number; only the single-spectrum summary did.
  const stepped = (center: number, height: number) => ({ ...seriesSpectrum(1, 0.001, 4e-6), parameters: { ...seriesSpectrum(1, 0.001, 4e-6).parameters,
    step_amplitude: { value: height, stderr: 0.002, vary: true }, step_center: { value: center, stderr: null, vary: false },
    step_sigma: { value: 2, stderr: null, vary: false } } })
  render(<PeakSeriesSummary result={{ ...series, spectra: [stepped(6550.12, 0.31), stepped(6551.87, 0.29), stepped(6552.4, 0.33)],
    details: { ...series.details, background: 'slope*x + intercept + arctan step (amplitude, center, sigma)' } }} />)
  const rows = screen.getAllByRole('row').map(row => row.textContent ?? '')
  expect(rows.find(row => row.startsWith('VO2'))).toMatch(/0\.2900 ± 0\.0020.*6551\.87 \(held\).*2\.00 \(held\)/)
  expect(rows.find(row => row.startsWith('V glass'))).toContain('6552.40 (held)')
})

it('reports a shared peak once and each spectrum area on its own row', () => {
  // Catches repeating the tied centre on every row, which hides the point of
  // the series fit: one position measured on the whole series.
  render(<PeakSeriesSummary result={series} />)
  const [shared, areas] = screen.getAllByRole('table')
  expect(within(shared).getByText('5469.00040 ± 0.00041')).toBeInTheDocument()
  expect(within(shared).getByText('1.8828 ± 0.0012')).toBeInTheDocument()
  const rows = within(areas).getAllByRole('row').slice(1) as HTMLTableRowElement[]
  expect(rows.map(row => Array.from(row.cells).map(cell => cell.textContent))).toEqual([
    ['V2O5', '1.0001 ± 0.0012', '0.00000410'],
    ['VO2', '2.4978 ± 0.0014', '0.00000430'],
    ['V glass', '0.3990 ± 0.0012', '0.00000390'],
  ])
  expect(screen.getByText(/3 spectra fitted together, sharing peak positions and widths/)).toBeInTheDocument()
})

it('says when fitting one at a time contradicts the shared centre, instead of reporting success alone', () => {
  render(<PeakSeriesSummary result={{ ...series,
    consistency: [{ parameter: 'peak_1_center', fitted_alone: 3, of: 3, chi_square: 161, degrees_of_freedom: 2, probability: 1e-35, consistent: false,
      warning: "Fitted one at a time, the spectra disagree on peak 1's centre (χ² = 161 for 2 degrees of freedom, p = 1e-35); the data do not support sharing it." }],
    warnings: ["Fitted one at a time, the spectra disagree on peak 1's centre (χ² = 161 for 2 degrees of freedom, p = 1e-35); the data do not support sharing it."] }} />)
  expect(screen.getByRole('alert')).toHaveTextContent(/do not support sharing/)
  const check = screen.getByRole('table', { name: /Is sharing supported/ })
  expect(within(check).getByText('Peak 1 centre')).toBeInTheDocument()
  expect(within(check).getByText('not supported')).toBeInTheDocument()
})

it('moves a peak position into the per-spectrum table when it was not shared', () => {
  // Catches showing a free parameter as if the series constrained it.
  render(<PeakSeriesSummary result={{ ...series,
    details: { ...series.details, shared_across_series: ['sigma'] } }} />)
  const tables = screen.getAllByRole('table')
  expect(tables).toHaveLength(2)
  expect(within(tables[0]).queryByText('5469.00040 ± 0.00041')).toBeNull()
  expect(within(tables[1]).getAllByText('5469.00040 ± 0.00041')).toHaveLength(3)
})

it('warns when the peak fit converged without error estimates', () => {
  // Catches a panel that shows "(no error)" cells with no explanation, which
  // reads as a display bug rather than an unidentifiable model.
  const blind = { ...peaks, parameters: Object.fromEntries(Object.entries(peaks.parameters)
    .map(([name, p]) => [name, { ...p, stderr: null }])),
    details: { peak_kinds: ['gaussian'], uncertainties_available: false } }
  render(<PeakSummary result={blind} unit="Å⁻¹" />)
  expect(screen.getByText(/not separable with these starting values/)).toBeInTheDocument()
  expect(screen.getAllByText('1.1965 (no error)')).toHaveLength(1)
  expect(screen.getByText(/signal × Å⁻¹/)).toBeInTheDocument()
})

const suggestions = {
  element: 'As', edge: 'K', xmin: 11851.5, xmax: 11951.5, considered: 3,
  citation: 'Standards distributed as example data with xraylarch.',
  suggestions: [
    { id: 'as-k-kankite', name: 'Kankite', formula: 'FeAsO4·3.5H2O', oxidation_state: 'As(V)', technique: 'XAS', rfactor: 0.010413, scale: 0.9512, points: 125 },
    { id: 'as-k-elemental', name: 'Elemental arsenic', formula: 'As', oxidation_state: 'As(0)', technique: 'XAS', rfactor: 0.19629, scale: 0.927, points: 125 },
    { id: 'cu-k-herfd-foil', name: 'Copper foil', formula: 'Cu', oxidation_state: 'Cu(0)', technique: 'HERFD', rfactor: 0.31, scale: 1.02, points: 125 },
  ],
  skipped: [{ id: 'as-k-arsenopyrite', name: 'Arsenopyrite', reason: 'the fit window lies outside the measured overlap' }],
  unusable: [],
}

it('ranks suggested standards and says the R-factors are not combination R-factors', () => {
  // Catches presenting single-standard scores next to a combination search as if
  // they were on the same scale, which would make every suggestion look worse
  // than any combination and invite the wrong standard set.
  render(<ReferenceSuggestions result={suggestions} picked={[]} onPick={() => {}} />)
  const rows = screen.getAllByRole('row').slice(1)
  expect(rows.map(row => within(row).getAllByRole('cell')[1].textContent))
    .toEqual(['Kankite (FeAsO4·3.5H2O)', 'Elemental arsenic (As)', 'Copper foil (Cu) · HERFD'])
  expect(within(rows[0]).getByText('0.0104')).toBeInTheDocument()
  expect(within(rows[0]).getByText('0.95')).toBeInTheDocument()
  expect(screen.getByText(/not comparable with a combination fit/)).toBeInTheDocument()
  expect(screen.getByText(/3 bundled As K-edge standards fitted one at a time over 11851.5–11951.5 eV/)).toBeInTheDocument()
})

it('withdraws a ranking made over another window, so it cannot choose standards for a different fit', () => {
  // The suggestion used to rank over e0-20..e0+80 whatever range the dialog set.
  const ranked = { ...suggestions, array: 'norm' }
  expect(suggestionsMatch(ranked, { array: 'norm', xmin: 11851.5, xmax: 11951.5 })).toBe(true)
  expect(suggestionsMatch(ranked, { array: 'norm', xmin: 11851.5, xmax: 12000 })).toBe(false)
  expect(suggestionsMatch(ranked, { array: 'flat', xmin: 11851.5, xmax: 11951.5 })).toBe(false)
  render(<ReferenceSuggestions result={ranked} picked={[]} onPick={() => {}} stale />)
  expect(screen.queryByRole('checkbox')).toBeNull()
  expect(screen.getByRole('status')).toHaveTextContent(/Suggest again/)
})

it('names a standard that could not be fitted instead of dropping it silently', () => {
  // Catches a ranking that looks complete while a standard has vanished, which
  // reads as "that reference does not match" rather than "it was not tried".
  render(<ReferenceSuggestions result={suggestions} picked={[]} onPick={() => {}} />)
  expect(screen.getByText(/Arsenopyrite could not be used: the fit window lies outside/)).toBeInTheDocument()
})

it('ticks and unticks a standard without disturbing the others', () => {
  // Catches a checkbox wired to replace the selection rather than extend it.
  const picks: string[][] = []
  const { rerender } = render(<ReferenceSuggestions result={suggestions} picked={['as-k-kankite']}
    onPick={next => picks.push(next)} />)
  expect(screen.getByLabelText('Use Kankite')).toBeChecked()
  expect(screen.getByLabelText('Use Elemental arsenic')).not.toBeChecked()
  fireEvent.click(screen.getByLabelText('Use Elemental arsenic'))
  expect(picks.at(-1)).toEqual(['as-k-kankite', 'as-k-elemental'])
  rerender(<ReferenceSuggestions result={suggestions} picked={['as-k-kankite', 'as-k-elemental']}
    onPick={next => picks.push(next)} />)
  fireEvent.click(screen.getByLabelText('Use Kankite'))
  expect(picks.at(-1)).toEqual(['as-k-elemental'])
})
