import "@testing-library/jest-dom/vitest"
import { useState } from "react"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, it } from "vitest"
import { AthenaParameterTabs, type ParameterTab } from "./athena-parameter-tabs"

afterEach(cleanup)

it("switches workflows with the keyboard and preserves the fitting draft", () => {
  function Host() {
    const [tab, select] = useState<ParameterTab>("processing")
    return <AthenaParameterTabs tab={tab} select={select}
      processing={<input aria-label="Processing draft" defaultValue="1" />}
      fitting={<input aria-label="Fitting draft" defaultValue="amp" />} />
  }
  render(<Host />)
  const processing = screen.getByRole("tab", { name: "Processing" })
  const fitting = screen.getByRole("tab", { name: "EXAFS fitting" })
  expect(screen.getByRole("tabpanel", { name: "Processing" })).toBeVisible()
  expect(screen.queryByRole("textbox", { name: "Fitting draft" })).toBeNull()
  fireEvent.keyDown(processing, { key: "ArrowRight" })
  expect(fitting).toHaveFocus()
  expect(fitting).toHaveAttribute("aria-selected", "true")
  fireEvent.change(screen.getByRole("textbox", { name: "Fitting draft" }), { target: { value: "amp * fraction" } })
  fireEvent.keyDown(fitting, { key: "Home" })
  expect(processing).toHaveFocus()
  fireEvent.keyDown(processing, { key: "End" })
  expect(screen.getByRole("textbox", { name: "Fitting draft" })).toHaveValue("amp * fraction")
})
