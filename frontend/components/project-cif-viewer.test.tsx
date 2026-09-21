import "@testing-library/jest-dom/vitest"

import type { ReactNode } from "react"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ArtemisStructure, ArtemisStructureAttachment } from "@/lib/artemis-structures"
import { CifViewer } from "./cif-viewer"
import { ProjectCifViewer } from "./project-cif-viewer"

vi.mock("./cif-viewer", () => ({
  CifViewer: vi.fn(({ structure, structureControls }: { structure: ArtemisStructure; structureControls?: ReactNode }) => <section>
    {structureControls}
    <div role="img" aria-label={`Crystal structure of ${structure.mineral}`} data-cif={structure.cif} />
  </section>),
}))

function attachment(id: string, amcsdId: number, mineral: string): ArtemisStructureAttachment {
  return {
    id, amcsd_id: amcsdId, attached_at: "2026-09-21T00:00:00Z", sha256: `${id}-snapshot`,
    structure: {
      id: amcsdId, mineral, formula: mineral, space_group: "P 1", authors: "", year: null, journal: "", title: "",
      cif: `data_${mineral}`, elements: [], sites: [], ordered: true, supported: true, warnings: [],
      cell: { a: 5, b: 5, c: 5, alpha: 90, beta: 90, gamma: 90 },
    },
  }
}

const copper = attachment("copper-cif", 13088, "Copper")
const iron = attachment("iron-cif", 100, "Iron")

afterEach(cleanup)

describe("ProjectCifViewer", () => {
  it("shows the selected project snapshot and reports a different attachment selection", () => {
    const onSelect = vi.fn()
    const view = render(<ProjectCifViewer attachments={[copper, iron]} selectedId={iron.id} onSelect={onSelect} />)
    expect(screen.getByRole("img", { name: "Crystal structure of Iron" })).toHaveAttribute("data-cif", iron.structure.cif)
    expect(screen.getByRole("combobox", { name: "Viewed CIF structure" })).toHaveValue(iron.id)
    expect(screen.queryByRole("img", { name: "Crystal structure of Copper" })).not.toBeInTheDocument()

    fireEvent.change(screen.getByRole("combobox", { name: "Viewed CIF structure" }), { target: { value: copper.id } })
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(copper.id)
    view.rerender(<ProjectCifViewer attachments={[copper, iron]} selectedId={copper.id} onSelect={onSelect} />)
    expect(screen.getByRole("img", { name: "Crystal structure of Copper" })).toHaveAttribute("data-cif", copper.structure.cif)
    expect(screen.queryByRole("img", { name: "Crystal structure of Iron" })).not.toBeInTheDocument()
  })

  it("falls back to an attachment in the current project when the old selection is absent", () => {
    const onSelect = vi.fn()
    const view = render(<ProjectCifViewer attachments={[copper]} selectedId={copper.id} onSelect={onSelect} />)
    expect(screen.getByRole("img", { name: "Crystal structure of Copper" })).toBeVisible()

    view.rerender(<ProjectCifViewer attachments={[iron]} selectedId={copper.id} onSelect={onSelect} />)
    expect(screen.getByRole("combobox", { name: "Viewed CIF structure" })).toHaveValue(iron.id)
    expect(screen.getByRole("img", { name: "Crystal structure of Iron" })).toHaveAttribute("data-cif", iron.structure.cif)
    expect(screen.queryByRole("img", { name: "Crystal structure of Copper" })).not.toBeInTheDocument()
    expect(onSelect).not.toHaveBeenCalled()
  })

  it("removes the previous crystal when the current project has no attached CIFs", () => {
    const onSelect = vi.fn()
    const view = render(<ProjectCifViewer attachments={[copper]} selectedId={copper.id} onSelect={onSelect} />)
    view.rerender(<ProjectCifViewer attachments={[]} selectedId={copper.id} onSelect={onSelect} />)
    expect(screen.queryByRole("img")).not.toBeInTheDocument()
    expect(screen.queryByRole("combobox", { name: "Viewed CIF structure" })).not.toBeInTheDocument()
    expect(screen.getByText(/Attach a CIF in the EXAFS fitting tab/)).toBeVisible()
    expect(screen.getByRole("button", { name: "Collapse CIF structure viewer" })).toBeVisible()
  })

  it("preserves the geometry input across project refreshes and replaces it for a changed snapshot", () => {
    const onSelect = vi.fn()
    const view = render(<ProjectCifViewer attachments={[copper]} selectedId={copper.id} onSelect={onSelect} />)
    const displayedStructure = vi.mocked(CifViewer).mock.calls.at(-1)![0].structure
    const refreshed = structuredClone(copper)
    expect(refreshed.structure).not.toBe(displayedStructure)

    view.rerender(<ProjectCifViewer attachments={[refreshed]} selectedId={copper.id} onSelect={onSelect} />)
    // A new geometry input would rerun the renderer effect and reset its camera.
    expect(vi.mocked(CifViewer).mock.calls.at(-1)![0].structure).toBe(displayedStructure)

    const replacement = { ...refreshed, sha256: "updated-snapshot", structure: { ...refreshed.structure, cif: "data_updated_Copper" } }
    view.rerender(<ProjectCifViewer attachments={[replacement]} selectedId={copper.id} onSelect={onSelect} />)
    expect(vi.mocked(CifViewer).mock.calls.at(-1)![0].structure).toBe(replacement.structure)
    expect(screen.getByRole("img", { name: "Crystal structure of Copper" })).toHaveAttribute("data-cif", replacement.structure.cif)
  })
})
