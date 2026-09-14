import '@testing-library/jest-dom/vitest'
import { useLayoutEffect, type ComponentProps } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type Plot from 'react-plotly.js'
import { athenaApi, type AthenaProject } from '@/lib/athena'
import { AthenaDiagnosticPlot, type DiagnosticPlot } from './athena-diagnostic-plot'

const plot = vi.hoisted(() => vi.fn<(p: ComponentProps<typeof Plot>) => void>())
vi.mock('next/dynamic', () => ({ default: () => (props: ComponentProps<typeof Plot>) => { useLayoutEffect(() => plot(props)); return <div data-testid="diagnostic-traces" /> } }))
vi.mock('@/lib/athena', async original => ({ ...await original<typeof import('@/lib/athena')>(), athenaApi: vi.fn() }))
const api = vi.mocked(athenaApi), x = [1, 2, 3, 4]
const project = { id: 'p', version: 4, groups: ['a', 'b'].map(id => ({ id, label: id, marked: true, energy: x, mu: x, data_type: 'mu', multiplier: 1, offset: 0,
  parameters: { flatten: true, energy_shift: 0, kweight: 2 }, source: {}, result: { effective: { exafs: true } } })) } as unknown as AthenaProject
const props = () => ({ project, groupId: 'a', selectGroup: vi.fn(), close: vi.fn() })
type Options = DiagnosticPlot['options']
function response(options: Options): DiagnosticPlot {
  return { project_id: 'p', version: options.version, options, result: { group_ids: options.group_ids, kweight: options.kweight ?? 2, notes: ['Diagnostic note'],
    panels: (options.view === 'kq' ? ['kq'] : ['E', 'k', 'R', 'q']).map((id, i) => ({ id, title: id, x_label: id, y_label: 'Signal', x_range: null,
      curves: Array.from({ length: options.view === 'biquad' || options.view === 'kq' ? 2 : [4, 1, 2, 1][i] }, (_, j) => ({ group_id: options.group_ids[options.view === 'biquad' ? j : 0], name: `${id}-${j}`, x: [...x], y: x.map(v => v + j) })) })) } }
}
function serve(mutate?: (v: DiagnosticPlot) => void) { api.mockImplementation(async (_path, body) => { const v = response(body as Options); mutate?.(v); return v }) }
async function ready(panels = 4) { await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(`${panels} diagnostic panels`), { timeout: 2500 }) }
const change = (name: string, value: string) => fireEvent.change(screen.getByLabelText(name, { exact: true }), { target: { value } })
afterEach(() => { cleanup(); vi.clearAllMocks(); api.mockReset() })

it('renders every server-supplied panel, exposes fractional weights and k/q component controls without saving parameters', async () => {
  serve(); const p = props(); render(<AthenaDiagnosticPlot {...p} />); await ready()
  expect(screen.getAllByTestId('diagnostic-traces')).toHaveLength(4)
  expect(plot.mock.calls.slice(-4).map(([p]) => p.data.length)).toEqual([4, 1, 2, 1])
  change('Diagnostic k weight', '1.5'); await ready(); expect((api.mock.calls.at(-1)![1] as Options).kweight).toBe(1.5)
  change('Diagnostic plot', 'kq'); await ready(1); change('Diagnostic q component', 'im'); await ready(1)
  expect((api.mock.calls.at(-1)![1] as Options).q_component).toBe('im')
  expect(plot.mock.calls.at(-1)![0].data).toHaveLength(2)
  expect(api.mock.calls.every(([path, , method]) => path === '/projects/p/plots/special' && method === 'POST')).toBe(true)
  expect(project.groups[0].parameters.kweight).toBe(2)
  fireEvent.click(screen.getByRole('button', { name: 'Close diagnostic plots' })); expect(p.close).toHaveBeenCalledOnce()
})

it('uses exactly the marked groups in project order and explains incorrect scope', async () => {
  serve(); const p = props(), rendered = render(<AthenaDiagnosticPlot {...p} initialView="biquad" />); await ready()
  expect((api.mock.calls[0][1] as Options).group_ids).toEqual(['a', 'b'])
  rendered.rerender(<AthenaDiagnosticPlot {...p} project={{ ...project, groups: project.groups.map(g => ({ ...g, marked: g.id === 'b' })) }} />)
  expect(screen.getByRole('status')).toHaveTextContent('mark exactly two groups')
  expect(screen.queryByTestId('diagnostic-traces')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Replot diagnostics' })).toBeDisabled()
})

it.each(['project', 'version', 'groups', 'options', 'membership', 'panels', 'axis', 'signal'])('rejects an invalid %s response', async kind => {
  serve(v => {
    if (kind === 'project') v.project_id = 'elsewhere'
    if (kind === 'version') v.version--
    if (kind === 'groups') v.result.group_ids = ['b']
    if (kind === 'options') v.options = { ...v.options, kweight: 3 }
    if (kind === 'membership') v.result.panels[0].curves[0].group_id = 'b'
    if (kind === 'panels') v.result.panels.pop()
    if (kind === 'axis') v.result.panels[0].curves[0].x[0] = 5
    if (kind === 'signal') v.result.panels[0].curves[0].y[0] = NaN
  }); render(<AthenaDiagnosticPlot {...props()} />)
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('does not match'), { timeout: 2500 })
  expect(screen.queryByTestId('diagnostic-traces')).not.toBeInTheDocument()
})

it('discards obsolete group and revision responses during a request', async () => {
  serve(); const original = api.getMockImplementation()!; let resolve!: (v: DiagnosticPlot) => void, old: DiagnosticPlot | undefined
  api.mockImplementation(async (path, body, ...rest) => {
    if ((body as Options).version === 4) { old = response(body as Options); return new Promise<DiagnosticPlot>(done => { resolve = done }) }
    return original(path, body, ...rest)
  })
  const p = props(), rendered = render(<AthenaDiagnosticPlot {...p} />)
  await waitFor(() => expect(old).toBeDefined(), { timeout: 2500 })
  rendered.rerender(<AthenaDiagnosticPlot {...p} project={{ ...project, version: 5 }} groupId="b" />); await ready()
  await act(async () => resolve(old!)); expect(screen.getByRole('status')).toHaveTextContent('revision 5')
  expect(screen.getByLabelText('Diagnostic spectrum')).toHaveValue('b')
})

it('retries a failed request and makes range edits locally while rejecting invalid weights', async () => {
  serve(); api.mockRejectedValueOnce(new Error('The project changed. Reload it.'))
  render(<AthenaDiagnosticPlot {...props()} />)
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('project changed'), { timeout: 2500 })
  fireEvent.click(screen.getByRole('button', { name: 'Replot diagnostics' })); await ready()
  const count = api.mock.calls.length
  change('E plot minimum', '0'); change('E plot maximum', '3')
  expect(api).toHaveBeenCalledTimes(count)
  change('E plot minimum', '4'); expect(screen.getByRole('alert')).toHaveTextContent('From below To')
  change('Diagnostic k weight', '-1'); expect(screen.getByRole('button', { name: 'Replot diagnostics' })).toBeDisabled()
  expect(screen.queryByTestId('diagnostic-traces')).not.toBeInTheDocument()
})
