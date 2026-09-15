"use client"

import { useEffect, useRef, useState } from 'react'
import { loadRebinDefaults, saveRebinDefaults } from '@/lib/athena-preferences'
import { defaultRebin, rebinProblem, type ImportRebinOptions } from '@/lib/athena-import'

const fields = ['emin', 'emax', 'pre', 'xanes', 'exafs', 'width'] as const
export type RebinGrid = Pick<ImportRebinOptions, typeof fields[number]>
type SavedGrid = { version: number; grid: RebinGrid }
export function gridValues(value: ImportRebinOptions | RebinGrid): RebinGrid {
  return Object.fromEntries(fields.map(key => [key, value[key]])) as RebinGrid
}
function checked(value: unknown): SavedGrid {
  const v = value as SavedGrid | null
  if (!v || !Number.isInteger(v.version) || v.version < 0 || !v.grid
    || fields.some(key => typeof v.grid[key] !== 'number')
    || rebinProblem({ ...v.grid, enabled: true, e0: null })) throw new Error('Could not read saved rebin defaults. Retry loading them.')
  return { version: v.version, grid: gridValues(v.grid) }
}

export function useRebinDefaults() {
  const [grid, setGrid] = useState<RebinGrid>(() => gridValues(defaultRebin))
  const current = useRef(grid), edits = useRef(0), generation = useRef(0)
  const accepted = useRef<SavedGrid | null>(null), running = useRef(false)
  const [pending, setPending] = useState(true)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState(''), [notice, setNotice] = useState('')
  function edit(value: RebinGrid) {
    const next = gridValues(value)
    if (JSON.stringify(next) !== JSON.stringify(current.current)) {
      edits.current++; current.current = next; setGrid(next); setNotice('')
    }
  }
  async function load(signal?: AbortSignal) {
    const token = ++generation.current, before = edits.current
    running.current = true; setPending(true); setError(''); setNotice('')
    try {
      const next = checked(await loadRebinDefaults(signal))
      if (token !== generation.current || signal?.aborted) return
      accepted.current = next; setReady(true)
      if (before === edits.current) { current.current = next.grid; setGrid(next.grid); setNotice('Saved grid defaults loaded.') }
      else setNotice('Saved defaults loaded; your newer grid edits are kept.')
    } catch (e) {
      if (token === generation.current && !signal?.aborted) setError(e instanceof Error ? e.message : 'Could not load rebin defaults.')
    } finally {
      if (token === generation.current) { running.current = false; setPending(false) }
    }
  }
  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => { generation.current++; controller.abort() }
    // Initial loading must not overwrite edits made while it is in flight.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const problem = rebinProblem({ ...grid, enabled: true, e0: null })
  async function save() {
    if (running.current || !accepted.current || problem) return
    const request = { version: accepted.current.version, grid: gridValues(current.current) }
    const token = ++generation.current
    running.current = true; setPending(true); setError(''); setNotice('')
    try {
      const next = checked(await saveRebinDefaults(request))
      if (token !== generation.current) return
      if (next.version !== request.version + 1 || JSON.stringify(next.grid) !== JSON.stringify(request.grid)) {
        throw new Error('The saved defaults could not be confirmed. Load saved defaults before trying again.')
      }
      accepted.current = next
      setNotice('Grid defaults saved for future sessions.')
    } catch (e) {
      if (token === generation.current) setError(e instanceof Error ? e.message : 'Could not save rebin defaults.')
    } finally {
      if (token === generation.current) { running.current = false; setPending(false) }
    }
  }
  return { grid, edit, pending, ready, error, notice, problem, save,
    adopt: (value: RebinGrid) => { edits.current++; current.current = gridValues(value); setGrid(current.current); setNotice('') },
    load: () => { if (!running.current) void load() },
    reset: () => edit(gridValues(defaultRebin)) }
}

export function RebinDefaultsControls({ state, disabled = false }: {
  state: ReturnType<typeof useRebinDefaults>; disabled?: boolean
}) {
  return <section aria-label="Rebin grid defaults">
    <p className="ath-hint">Import and processing share this grid. Save defaults to keep it for future sessions on this local server. Grid E₀ and the import checkbox are separate.</p>
    <div className="ath-modal-actions">
      <button type="button" disabled={disabled || state.pending || !state.ready || !!state.problem} onClick={() => { void state.save() }}>Save grid as defaults</button>
      <button type="button" disabled={disabled || state.pending} onClick={state.load}>Load saved grid</button>
      <button type="button" disabled={disabled || state.pending} onClick={state.reset}>Use Athena default grid</button>
    </div>
    {state.pending && <p role="status">Loading or saving grid defaults…</p>}
    {state.error && <p role="alert" className="ath-error">{state.error}</p>}
    {state.notice && <p role="status">{state.notice}</p>}
  </section>
}
