import { describe, expect, it } from 'vitest'
import type { ArtemisFitArchive, ArtemisPath, ArtemisTransform } from './artemis'
import { buildHistoryComparison, historyComparisonFilename, type HistoryComparisonContext } from './artemis-history-comparison'

const input = 'a'.repeat(64)
const context: HistoryComparisonContext = {
  projectId: 'project', projectName: 'Synthetic comparison', version: 17,
  groupId: 'group', groupLabel: 'Synthetic Cu', currentInputSha256: input,
}

function archive(id: string): ArtemisFitArchive {
  const path: ArtemisPath = {
    id: 'cu-first-shell', label: 'Cu–Cu', filename: 'feff0001.dat', content: 'synthetic FEFF file\nnot executed', enabled: true,
    s02: 'amp', e0: 'de0', deltar: 'dr', sigma2: 'sig2',
    metadata: {
      reff: 2.5, degen: 12, nleg: 2, absorber: 'Cu', edge: 'K', kmin: 0, kmax: 20,
      geometry: [{ atom: 'Cu', x: 0, y: 0, z: 0, ipot: 0 }, { atom: 'Cu', x: 2.5, y: 0, z: 0, ipot: 1 }],
    },
  }
  const parameter = { name: 'dr', kind: 'guess' as const, value: .02, initial: 0, expression: '', min: -.1, max: .1, stderr: .002 }
  const transform: ArtemisTransform = { fitspace: 'r', kmin: 3, kmax: 12, kweight: [2, 1], dk: 2, window: 'hanning', rmin: 1, rmax: 3, dr: 0 }
  return {
    id, created: '2026-10-10T16:00:00Z', input_sha256: input, imported: false,
    origin: { project_id: 'source-project', group_id: 'source-group', project_version: 4, larch_version: '0.9.synthetic' },
    model: {
      parameters: [{ ...parameter, id: 'parameter1', value: '0', min: '-.1', max: '.1' }], paths: [path], revision: 3,
      transform: { ...transform, kmin: '3', kmax: '12', dk: '2', rmin: '1', rmax: '3', dr: '0' },
    },
    result: {
      project_id: 'source-project', group_id: 'source-group', group_label: 'original Cu', version: 4,
      success: true, message: 'Converged', report: 'full report omitted from comparison', warnings: [],
      statistics: { n_varys: 1, n_independent: 13.4, n_data: 75, nfev: 9, chi_square: 10, reduced_chi_square: .8, r_factor: .003, aic: -12, bic: -11, errorbars: true, epsilon_k: .00003 },
      parameters: [parameter], correlations: [], transform, metadata: { engine: 'larch', seconds: { solve: 42 } },
      paths: [{ id: path.id, label: path.label, filename: path.filename, metadata: structuredClone(path.metadata),
        values: { s02: .9, e0: 1, deltar: .02, sigma2: .003 }, sigma2_expression: 'sig2', k: { chi: [99] } }],
      k: { x: [0, 1], data: [0, 1], model: [0, 1], residual: [0, 0], weight: 2 },
      r: { x: [0, 1], data_mag: [0, 1], model_mag: [0, 1], residual_mag: [0, 0],
        data_re: [0, 1], model_re: [0, 1], residual_re: [0, 0], data_im: [0, 1], model_im: [0, 1], residual_im: [0, 0] },
    },
  }
}

function compare(a = archive('first'), b = archive('second'), state = context) {
  return buildHistoryComparison(state, a, b)
}

function deepFreeze(value: unknown): void {
  if (!value || typeof value !== 'object') return
  Object.freeze(value)
  for (const item of Object.values(value)) deepFreeze(item)
}

describe('saved fit comparison snapshots', () => {
  it('reports forward and reverse differences by identity, including legitimate zero values', () => {
    const a = archive('first'), b = archive('second')
    b.result.parameters[0].value = 0
    b.result.paths[0].values!.deltar = 0
    b.result.paths[0].values!.sigma2 = 0
    const forward = compare(a, b), reverse = compare(b, a)
    expect(forward).toMatchObject({ schema_version: 1, project_id: 'project', version: 17, group_id: 'group', baseline_fit_id: 'first', comparison_fit_id: 'second', same_input: true })
    expect(forward.parameter_changes[0]).toMatchObject({ name: 'dr', baseline: { initial: 0, value: .02 }, comparison: { value: 0 }, delta: -.02 })
    expect(forward.path_changes[0]).toMatchObject({ match: 'same_feff', comparison: { r: 2.5, sigma2: 0, distance_kind: 'single_scattering' }, delta_sigma2: -.003 })
    expect(forward.path_changes[0].delta_r).toBeCloseTo(-.02)
    expect(reverse.parameter_changes[0].delta).toBe(-forward.parameter_changes[0].delta!)
    expect(reverse.path_changes[0].delta_r).toBe(-forward.path_changes[0].delta_r!)
    expect(reverse.path_changes[0].delta_sigma2).toBe(-forward.path_changes[0].delta_sigma2!)
  })

  it('uses saved fitted transforms, preserves kweight order, and reports each statistic without ranking', () => {
    const a = archive('first'), b = archive('second')
    a.model.transform.kmax = '19'
    b.model.transform.kmax = '17'
    b.result.transform.kmax = 10
    b.result.transform.kweight = [1, 2]
    b.result.statistics.epsilon_k = .00005
    b.result.statistics.chi_square = 30
    const report = compare(a, b)
    expect(report.transform_changes).toEqual([
      { field: 'kmax', label: 'k maximum', unit: 'Å⁻¹', baseline: 12, comparison: 10 },
      { field: 'kweight', label: 'k weights', unit: '', baseline: [2, 1], comparison: [1, 2] },
    ])
    expect(report.baseline.statistics).toMatchObject({ chi_square: 10, epsilon_k: .00003, aic: -12 })
    expect(report.comparison.statistics).toMatchObject({ chi_square: 30, epsilon_k: .00005 })
    expect(report).not.toHaveProperty('statistic_changes')
    expect(report.notes.join(' ')).toContain('not ranked')
    expect(report.notes.join(' ')).toContain('first plotted k weight')
    expect(report.notes.join(' ')).toContain('Standard errors are not combined')
  })

  it('preserves imported origins and separates shared saved input from current input', () => {
    const a = archive('first'), b = archive('second')
    b.imported = true
    b.origin.project_id = 'import-origin'
    b.origin.larch_version = 'older-version'
    b.result.metadata!.engine = 'fast'
    const report = compare(a, b, { ...context, currentInputSha256: 'b'.repeat(64) })
    expect(report.same_input).toBe(true)
    expect(report.baseline.input_current).toBe(false)
    expect(report.comparison).toMatchObject({ imported: true, input_current: false, origin: { project_id: 'import-origin', larch_version: 'older-version' }, engine: 'fast' })
    expect(report.notes.join(' ')).toContain('imported archive')
    expect(report.notes.join(' ')).toContain('engine or Larch version differs')
    b.input_sha256 = 'b'.repeat(64)
    expect(compare(a, b).same_input).toBe(false)
  })

  it.each([null, '', 'not-a-fingerprint'])('does not label unavailable current input %s as a mismatch', currentInputSha256 => {
    const report = compare(undefined, undefined, { ...context, currentInputSha256 })
    expect(report.baseline.input_current).toBeNull()
    expect(report.comparison.input_current).toBeNull()
    expect(report.same_input).toBe(true)
    expect(report.notes.join(' ')).toContain('current processed input is unknown')
    expect(report.notes.join(' ')).not.toContain('differs from the current')
  })

  it('does not equate two missing saved fingerprints', () => {
    const a = archive('first'), b = archive('second')
    a.input_sha256 = b.input_sha256 = ''
    expect(compare(a, b)).toMatchObject({ same_input: null, baseline: { input_current: null, input_sha256: null } })
  })

  it('marks different bounds and starting values while keeping compatible final-value differences', () => {
    const a = archive('first'), b = archive('second')
    b.result.parameters[0].min = -.05
    b.result.parameters[0].initial = .01
    b.result.parameters[0].value = .03
    const row = compare(a, b).parameter_changes[0]
    expect(row).toMatchObject({ bounds_changed: true, initial_changed: true, comparison: { initial: .01, min: -.05 } })
    expect(row.delta).toBeCloseTo(.01)
    expect(row.notes.join(' ')).toContain('different constraints')
    expect(row.notes.join(' ')).toContain('initial value changed')
  })

  it('requires exact unique names and compatible kinds and expressions, independent of row order', () => {
    const a = archive('first'), b = archive('second')
    a.result.parameters.push({ ...a.result.parameters[0], name: 'amp', value: .9 })
    b.result.parameters.unshift({ ...b.result.parameters[0], name: 'amp', value: 1 })
    let report = compare(a, b)
    expect(report.parameter_changes.map(row => row.name)).toEqual(['dr', 'amp'])
    expect(report.parameter_changes[1].delta).toBeCloseTo(.1)
    b.result.parameters[1].kind = 'set'
    expect(compare(a, b).parameter_changes[0].delta).toBeNull()
    b.result.parameters[1].kind = 'guess'
    b.result.parameters[1].expression = 'different_definition'
    expect(compare(a, b).parameter_changes[0].delta).toBeNull()
    b.result.parameters.push({ ...b.result.parameters[0] })
    report = compare(a, b)
    expect(report.parameter_changes[1]).toMatchObject({ comparison: null, delta: null })
    expect(report.parameter_changes[1].notes.join(' ')).toContain('ambiguous')
  })

  it('shows unmatched parameter names without trying aliases or inferring units', () => {
    const a = archive('first'), b = archive('second')
    b.result.parameters[0].name = 'delta_r'
    const report = compare(a, b)
    expect(report.parameter_changes.map(row => [row.name, row.delta])).toEqual([['dr', null], ['delta_r', null]])
    expect(report.notes.join(' ')).toContain('not inferred from names')
  })

  it('withholds unreported and fixed-parameter standard errors without hiding saved final values', () => {
    const a = archive('first'), b = archive('second')
    a.result.statistics.errorbars = false
    b.result.parameters[0].kind = 'set'
    const report = compare(a, b)
    expect(report.parameter_changes[0].baseline).toMatchObject({ value: .02, stderr: null })
    expect(report.parameter_changes[0].comparison).toMatchObject({ value: .02, stderr: null })
    expect(report.notes.join(' ')).toContain('did not report available error bars')
  })

  it('refuses to match changed FEFF contents even with the same ID, label and filename', () => {
    const a = archive('first'), b = archive('second')
    b.model.paths[0].content += '\nchanged'
    expect(compare(a, b).path_changes[0]).toMatchObject({ match: 'changed_feff', delta_r: null, delta_sigma2: null })
  })

  it('does not match identical FEFF files under different saved path IDs', () => {
    const a = archive('first'), b = archive('second')
    b.model.paths[0].id = b.result.paths[0].id = 'renamed-id'
    const report = compare(a, b)
    expect(report.path_changes.map(row => [row.id, row.match, row.delta_r])).toEqual([
      ['cu-first-shell', 'baseline_only', null], ['renamed-id', 'comparison_only', null],
    ])
  })

  it.each(['filename', 'disabled', 'missing-model', 'duplicate-model', 'duplicate-result', 'metadata', 'expression', 'empty-content'] as const)(
    'requires consistent saved path identity: %s', fault => {
      const a = archive('first'), b = archive('second')
      if (fault === 'filename') b.result.paths[0].filename = 'feff0002.dat'
      if (fault === 'disabled') b.model.paths[0].enabled = false
      if (fault === 'missing-model') b.model.paths = []
      if (fault === 'duplicate-model') b.model.paths.push(structuredClone(b.model.paths[0]))
      if (fault === 'duplicate-result') b.result.paths.push(structuredClone(b.result.paths[0]))
      if (fault === 'metadata') b.result.paths[0].metadata.reff = 2.6
      if (fault === 'expression') b.result.paths[0].sigma2_expression = 'different_sig2'
      if (fault === 'empty-content') b.model.paths[0].content = ''
      expect(compare(a, b).path_changes[0]).toMatchObject({ match: 'unavailable', delta_r: null, delta_sigma2: null })
    },
  )

  it('ignores display metadata and object property order while retaining exact physical geometry checks', () => {
    const a = archive('first'), b = archive('second')
    b.model.paths[0].metadata.sourceCif = { sha256: 'b'.repeat(64), label: 'relabelled display source', siteIndex: 1 }
    const metadata = b.result.paths[0].metadata
    b.result.paths[0].metadata = { ...metadata, geometry: metadata.geometry.map(atom => ({ ipot: atom.ipot, z: atom.z, y: atom.y, x: atom.x, atom: atom.atom })) }
    b.result.paths[0].metadata.viewerCluster = { source: 'feff.inp', atoms: metadata.geometry }
    expect(compare(a, b).path_changes[0].match).toBe('same_feff')
    b.result.paths[0].metadata.geometry[1].x = b.model.paths[0].metadata.geometry[1].x = 2.6
    expect(compare(a, b).path_changes[0].match).toBe('unavailable')
  })

  it('distinguishes single scattering distance from multiple scattering half path length', () => {
    const a = archive('first'), b = archive('second')
    for (const fit of [a, b]) fit.model.paths[0].metadata.nleg = fit.result.paths[0].metadata.nleg = 3
    const report = compare(a, b)
    expect(report.path_changes[0]).toMatchObject({ match: 'same_feff', baseline: { r: 2.52, distance_kind: 'half_path_length', degen: 12 } })
    expect(report.notes.join(' ')).toContain('FEFF degeneracy is not a fitted coordination number')
  })

  it('preserves finite nonphysical fitted outcomes and flags them instead of hiding them', () => {
    const a = archive('first'), b = archive('second')
    b.result.paths[0].values = { s02: -.2, e0: -3, deltar: -3, sigma2: -.001 }
    const row = compare(a, b).path_changes[0]
    expect(row).toMatchObject({ match: 'same_feff', comparison: { r: -.5, sigma2: -.001, s02: -.2, e0: -3 }, delta_sigma2: -.004 })
    expect(row.notes.join(' ')).toContain('value is preserved')
  })

  it('handles missing legacy fields and malformed inert metadata without reconstructing scientific values', () => {
    const a = archive('first'), b = archive('second')
    delete a.result.statistics.epsilon_k
    delete a.result.paths[0].values
    delete a.result.paths[0].sigma2_expression
    a.result.metadata = ['inert', 'metadata'] as unknown as NonNullable<ArtemisFitArchive['result']['metadata']>
    a.result.parameters[0].expression = undefined as unknown as string
    a.result.parameters[0].initial = undefined as unknown as number
    a.result.transform.kmax = Infinity
    a.result.success = false
    const report = compare(a, b)
    expect(report.baseline).toMatchObject({ engine: null, transform: { kmax: null }, statistics: { epsilon_k: null }, success: false })
    expect(report.parameter_changes[0]).toMatchObject({ baseline: { initial: null, expression: null }, delta: null })
    expect(report.path_changes[0]).toMatchObject({ baseline: { r: null, sigma2: null }, delta_r: null, delta_sigma2: null })
    expect(report.notes.join(' ')).toContain('not reconstructed')
    expect(report.notes.join(' ')).toContain('did not report successful convergence')
  })

  it('normalizes nonfinite values and malformed identities without throwing or exporting false numeric certainty', () => {
    const a = archive('first'), b = archive('second')
    a.result.parameters[0].value = NaN
    a.result.parameters[0].stderr = Infinity
    a.result.parameters.push({ ...a.result.parameters[0], name: '' })
    a.result.paths.push(null as unknown as ArtemisFitArchive['result']['paths'][number])
    a.result.statistics.chi_square = Infinity
    a.result.transform.kweight = [2, 2]
    a.result.paths[0].values!.deltar = Infinity
    const report = compare(a, b)
    expect(report.parameter_changes).toHaveLength(1)
    expect(report.parameter_changes[0]).toMatchObject({ baseline: { value: null, stderr: null }, delta: null })
    expect(report.path_changes).toHaveLength(1)
    expect(report.path_changes[0].delta_r).toBeNull()
    expect(report.baseline).toMatchObject({ statistics: { chi_square: null }, transform: { kweight: null } })
    expect(report.notes.join(' ')).toContain('identities are missing')
    expect(JSON.parse(JSON.stringify(report))).toEqual(report)
  })

  it('makes a detached scalar snapshot, neither mutating frozen archives nor exporting curves, FEFF text or arbitrary metadata', () => {
    const a = archive('first'), b = archive('second')
    a.result.metadata!.secret_extra = { text: 'metadata-must-not-leak' }
    a.model.paths[0].content = b.model.paths[0].content = 'globalThis.unexpectedComparisonExecution = true'
    const before = structuredClone([a, b])
    deepFreeze(a)
    deepFreeze(b)
    const report = compare(a, b)
    expect([a, b]).toEqual(before)
    expect((globalThis as Record<string, unknown>).unexpectedComparisonExecution).toBeUndefined()
    const output = JSON.stringify(report)
    for (const excluded of ['unexpectedComparisonExecution', 'metadata-must-not-leak', 'full report omitted', 'data_mag', 'residual', 'content']) expect(output).not.toContain(excluded)
    expect(report.baseline.transform.kweight).not.toBe(a.result.transform.kweight)
    expect(report.baseline.warnings).not.toBe(a.result.warnings)
    const mutable = archive('mutable'), detached = compare(mutable, archive('other'))
    mutable.result.transform.kweight.push(3)
    mutable.result.parameters[0].value = 99
    mutable.result.paths[0].values!.deltar = 99
    expect(detached.baseline.transform.kweight).toEqual([2, 1])
    expect(detached.parameter_changes[0].baseline!.value).toBe(.02)
    expect(detached.path_changes[0].baseline!.r).toBe(2.52)
  })

  it('requires two distinct saved archives and makes safe download names', () => {
    expect(() => compare(archive('same'), archive('same'))).toThrow('Choose two different saved fits')
    expect(() => compare(archive(''), archive('second'))).toThrow('Choose two different saved fits')
    const report = compare(archive('../first'), archive('second/fit'), { ...context, groupId: '../Cu: foil' })
    expect(historyComparisonFilename(report)).toBe('craft-fit-comparison-___Cu__foil-v17-___first-second_fit.json')
    const longReport = compare(archive('a'.repeat(128)), archive('b'.repeat(128)), { ...context, groupId: 'Cu → foil/\\'.repeat(30), version: Number.MAX_SAFE_INTEGER })
    expect(historyComparisonFilename(longReport).length).toBeLessThanOrEqual(200)
    expect(historyComparisonFilename(longReport)).toMatch(/^[a-zA-Z0-9_.-]+\.json$/)
  })
})
