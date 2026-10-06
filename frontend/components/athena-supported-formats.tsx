"use client"

import { useEffect, useState } from 'react'
import { useAthenaApi } from '@/lib/athena-context'
import type { ColumnInfo, InspectionResponse } from '@/lib/contracts'

export type SupportedFormat = {
  id: string; name: string; facility: string; beamline: string; format: string; evidence: string
}

function formats(value: unknown): SupportedFormat[] {
  if (!Array.isArray(value)) throw new Error('The list of supported formats could not be read.')
  return value as SupportedFormat[]
}

/** The beamlines and file formats the readers recognize, before any upload.
 *
 * Asked by someone deciding whether to bring their data here at all, so it
 * depends on no project and no file. Beamlines reached only through a Demeter
 * file reader are in the list too, with the reader that has to be enabled.
 *
 * The catalog is fetched when the list is opened, not when the import dialog
 * is: this sits beside the file chooser, and everyone who only wants to pick
 * a file would otherwise pay for a request they never read.
 */
export function AthenaSupportedFormats() {
  const athenaApi = useAthenaApi()
  const [open, setOpen] = useState(false)
  const [catalog, setCatalog] = useState<SupportedFormat[] | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!open || catalog) return
    const abort = new AbortController()
    void (async () => {
      try {
        setCatalog(formats(await athenaApi('/formats', undefined, 'GET', abort.signal)))
      } catch (e) {
        if (!abort.signal.aborted) setError(e instanceof Error ? e.message : 'The supported formats could not be loaded.')
      }
    })()
    return () => abort.abort()
  }, [open])
  const places = new Set(catalog?.filter(item => item.facility).map(item => item.facility))
  return <details onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Which beamlines and formats open here?</summary>
    {error && <p className="ath-error" role="alert">{error}</p>}
    {open && !catalog && !error && <p role="status">Loading the list of formats…</p>}
    {catalog && <>
      <p className="ath-hint">{catalog.length} readers covering {places.size} facilities. A file is recognized from
        its own header; a format that is not listed may still open as plain columns, with the columns chosen by hand.</p>
      <table><caption>Recognized beamlines and formats</caption>
        <thead><tr><th scope="col">Facility</th><th scope="col">Beamline</th><th scope="col">Format</th></tr></thead>
        <tbody>{catalog.map(item => <tr key={item.id}>
          <td>{item.facility || '—'}</td><td>{item.beamline || '—'}</td><td>{item.format}</td>
        </tr>)}</tbody>
      </table>
    </>}
  </details>
}

const ROLE_NAMES: Record<string, string> = {
  energy: 'Energy', i0: 'I₀', i0_corrected: 'I₀ scaled for detector dead time', transmission: 'Transmission',
  fluorescence: 'Fluorescence', reference: 'Reference', mu: 'μ, already computed',
}

/** Name the beamline a file came from, and the channels read from its header.
 *
 * The column choices below this badge are the registry's, not the user's, and
 * a reader that recognized the wrong beamline puts the wrong channel in I0.
 * Saying which beamline was recognized, and on what evidence, is what makes
 * that checkable at a glance instead of by reading the numbers.
 */
export function AthenaDetectedBeamline({ reader, columns }: {
  reader: InspectionResponse['beamline_reader']; columns: ColumnInfo[]
}) {
  if (!reader) return null
  const names = new Map(columns.map(column => [column.column_id, column.name]))
  const spell = (value: string | string[]) =>
    (Array.isArray(value) ? value : [value]).map(id => names.get(id) ?? id).join(' + ')
  const roles = Object.entries(reader.roles ?? {}).filter(([role]) => role in ROLE_NAMES)
  const place = [reader.facility, reader.beamline].filter(Boolean).join(' · ')
  return <section aria-label="Recognized beamline">
    <strong>{place || reader.name}</strong>
    <span className="ath-chip">{reader.format}</span>
    {roles.length > 0 && <p>{roles.map(([role, value]) => `${ROLE_NAMES[role]}: ${spell(value)}`).join(' · ')}</p>}
    <p className="ath-hint">Recognized from {reader.evidence}. Every column choice below can still be changed.</p>
  </section>
}
