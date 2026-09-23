import "@testing-library/jest-dom/vitest"
import { fireEvent, render, screen, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { FeffPathViewer, type FeffPathSummary } from "./feff-path-viewer"

const paths: FeffPathSummary[] = [
  { id: "cu1", filename: "feff0001.dat", label: "Cu first shell", enabled: true,
    metadata: { absorber: "Cu", edge: "K", reff: 2.56, degen: 12, nleg: 2, kmin: 0, kmax: 15,
      geometry: [{ atom: "Cu", x: 0, y: 0, z: 0, ipot: 0 }, { atom: "Cu", x: 2.56, y: 0, z: 0, ipot: 1 }] } },
  { id: "cu2", filename: "feff0002.dat", label: "Cu second shell", enabled: false,
    metadata: { absorber: "Cu", edge: "K", reff: 3.62, degen: 6, nleg: 2, kmin: 0, kmax: 15,
      geometry: [{ atom: "Cu", x: 0, y: 0, z: 0, ipot: 0 }, { atom: "Cu", x: 3.62, y: 0, z: 0, ipot: 1 }] } },
]

describe("FeffPathViewer", () => {
  it("shows the selected FEFF path metadata and geometry", () => {
    const openModel = vi.fn()
    render(<FeffPathViewer paths={paths} groupLabel="Copper foil" onOpenModel={openModel} />)
    const panel = screen.getByRole("region", { name: "FEFF path viewer" })
    expect(panel).toHaveTextContent("Copper foil")
    expect(panel).toHaveTextContent("2.56 Å")
    expect(within(panel).getByRole("table")).toHaveTextContent("2.56")
    fireEvent.change(within(panel).getByRole("combobox", { name: "Viewed FEFF path" }), { target: { value: "cu2" } })
    expect(panel).toHaveTextContent("3.62 Å")
    expect(panel).toHaveTextContent("feff0002.dat")
    fireEvent.click(within(panel).getByRole("button", { name: "Edit paths" }))
    expect(openModel).toHaveBeenCalledOnce()
  })

  it("explains how to add paths when the model is empty", () => {
    render(<FeffPathViewer paths={[]} onOpenModel={vi.fn()} />)
    expect(screen.getByRole("region", { name: "FEFF path viewer" })).toHaveTextContent("Add or generate FEFF paths")
  })
})
