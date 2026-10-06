import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { AthenaDetectedBeamline, AthenaSupportedFormats } from './athena-supported-formats'
import { athenaApi } from '@/lib/athena'

vi.mock('@/lib/athena', () => ({ athenaApi: vi.fn() }))
const api = vi.mocked(athenaApi)
afterEach(() => { cleanup(); api.mockReset() })

const CATALOG = [
  { id: 'aps-mrcat', name: 'MRCAT', facility: 'Advanced Photon Source', beamline: '10-BM (MRCAT)',
    format: 'MRCAT column ASCII', evidence: 'the MRCAT header' },
  { id: 'plugin-b18', name: 'Diamond B18', facility: 'Diamond Light Source', beamline: 'B18',
    format: 'Diamond B18 · Core XAFS', evidence: 'the B18 file reader, which must be enabled first' },
  { id: 'athena-project', name: 'Athena project', facility: '', beamline: '',
    format: 'Athena project', evidence: 'the header line' },
]

function expand() {
  fireEvent.click(screen.getByText('Which beamlines and formats open here?'))
}

it('counts only the facilities, so a format that belongs to none is not one', async () => {
  api.mockResolvedValueOnce(CATALOG)
  render(<AthenaSupportedFormats />)
  expand()
  expect(await screen.findByText(/3 readers covering 2 facilities/)).toBeInTheDocument()
  expect(api).toHaveBeenCalledWith('/formats', undefined, 'GET', expect.anything())
  expect(screen.getByRole('cell', { name: 'Diamond B18 · Core XAFS' })).toBeInTheDocument()
})

it('asks the backend for nothing until the list is opened', () => {
  // This sits inside the import dialog, whose own tests answer the requests
  // they expect in order. A catalog fetched on mount would be served one of
  // their answers and shift every later one onto the wrong request.
  render(<AthenaSupportedFormats />)
  expect(api).not.toHaveBeenCalled()
})

it('says the list could not be loaded rather than showing an empty one', async () => {
  api.mockRejectedValueOnce(new Error('The backend is not reachable.'))
  render(<AthenaSupportedFormats />)
  expand()
  expect(await screen.findByRole('alert', { hidden: true })).toHaveTextContent('not reachable')
  expect(screen.queryByRole('table')).toBeNull()
})

it('spells the recognized channels with the column names the user sees', () => {
  render(<AthenaDetectedBeamline
    reader={{ id: 'bluesky-nexus', name: 'Bluesky', facility: 'Advanced Photon Source', beamline: '25-ID-C',
      format: 'NeXus/HDF5 (Bluesky)', evidence: 'the Bluesky entry metadata', confidence: 'beamline',
      roles: { energy: 'column_0001', i0: 'column_0002', fluorescence: ['column_0003', 'column_0004'] } }}
    columns={[
      { column_id: 'column_0001', name: 'energy', index: 0, numeric: true, unit: 'eV', role_hint: null, preview: [] },
      { column_id: 'column_0002', name: 'IpreKB', index: 1, numeric: true, unit: null, role_hint: null, preview: [] },
      { column_id: 'column_0003', name: 'mca1', index: 2, numeric: true, unit: null, role_hint: null, preview: [] },
      { column_id: 'column_0004', name: 'mca2', index: 3, numeric: true, unit: null, role_hint: null, preview: [] },
    ]} />)
  expect(screen.getByText('Advanced Photon Source · 25-ID-C')).toBeVisible()
  expect(screen.getByText(/I₀: IpreKB/)).toHaveTextContent('Fluorescence: mca1 + mca2')
  expect(screen.getByText(/Recognized from the Bluesky entry metadata/)).toBeVisible()
})

it('shows nothing at all when no reader claimed the file', () => {
  render(<AthenaDetectedBeamline reader={undefined} columns={[]} />)
  expect(screen.queryByRole('region')).toBeNull()
})
