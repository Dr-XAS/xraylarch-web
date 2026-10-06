import "@testing-library/jest-dom/vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, it } from "vitest"
import { ParameterHelp } from "./parameter-help"
import { InstructionVisibility } from "./section-help"

afterEach(cleanup)

it("keeps input values and descriptions when help is toggled and opens only from the icon", () => {
  const content = <ParameterHelp label="Rbkg" help="Low-R cutoff for AUTOBK, in Å.">
    {(descriptionId, helpIcon) => <label><span>Rbkg{helpIcon}</span><input type="number" defaultValue="1" aria-describedby={descriptionId} /></label>}
  </ParameterHelp>
  const { rerender } = render(<InstructionVisibility value={false}>{content}</InstructionVisibility>)
  const input = screen.getByRole("spinbutton", { name: "Rbkg" })
  expect(input).toHaveAccessibleDescription("Low-R cutoff for AUTOBK, in Å.")
  act(() => input.focus())
  fireEvent.mouseEnter(input)
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument()
  expect(screen.queryByRole("button", { name: "About Rbkg" })).not.toBeInTheDocument()
  fireEvent.change(input, { target: { value: "1.2" } })

  rerender(<InstructionVisibility value={true}>{content}</InstructionVisibility>)
  expect(input).toHaveValue(1.2)
  expect(input).toHaveAccessibleName("Rbkg")
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument()
  act(() => screen.getByRole("button", { name: "About Rbkg" }).focus())
  expect(screen.getByRole("tooltip")).toHaveTextContent("Low-R cutoff for AUTOBK, in Å.")
  rerender(<InstructionVisibility value={false}>{content}</InstructionVisibility>)
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument()
  expect(input).toHaveValue(1.2)
  expect(input).toHaveAccessibleDescription("Low-R cutoff for AUTOBK, in Å.")
})
