import "@testing-library/jest-dom/vitest"
import { useState } from "react"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, it } from "vitest"
import { defaultRebin } from "@/lib/athena-import"
import { AthenaImportRebin } from "./athena-import-rebin"

afterEach(cleanup)
function Harness({ chi = false }: { chi?: boolean }) {
  const [value, set] = useState(defaultRebin)
  return <><AthenaImportRebin value={value} chi={chi} onChange={set} /><output data-testid="state">{JSON.stringify(value)}</output></>
}
const state = () => JSON.parse(screen.getByTestId('state').textContent!)
it('defaults off with the native grid and retains choices across toggles', () => {
  render(<Harness />)
  expect(state()).toEqual(defaultRebin)
  expect(screen.getByLabelText('Perform rebinning')).not.toBeChecked()
  expect(screen.getByLabelText('Rebin XANES step · eV')).toBeDisabled()
  fireEvent.click(screen.getByLabelText('Perform rebinning'))
  fireEvent.change(screen.getByLabelText('Rebin XANES step · eV'), { target: { value: '.25' } })
  fireEvent.change(screen.getByLabelText('Rebin smoothing width · points'), { target: { value: '4' } })
  fireEvent.change(screen.getByLabelText('Rebin grid E₀ · eV'), { target: { value: '17168' } })
  expect(state()).toMatchObject({ enabled: true, xanes: .25, width: 4, e0: 17168 })
  fireEvent.click(screen.getByLabelText('Perform rebinning'))
  fireEvent.click(screen.getByLabelText('Perform rebinning'))
  expect(state()).toMatchObject({ enabled: true, xanes: .25, width: 4, e0: 17168 })
  fireEvent.change(screen.getByLabelText('Rebin grid E₀ · eV'), { target: { value: '' } })
  fireEvent.change(screen.getByLabelText('Rebin XANES step · eV'), { target: { value: '' } })
  expect(state()).toMatchObject({ e0: null, xanes: '' })
})
it('disables energy rebinning for chi data', () => {
  render(<Harness chi />)
  expect(screen.getByLabelText('Perform rebinning')).toBeDisabled()
  expect(screen.getByLabelText('Rebin smoothing width · points')).toBeDisabled()
})
