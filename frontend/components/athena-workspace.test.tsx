import "@testing-library/jest-dom/vitest"

import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { ResizableAthenaWorkspace, athenaWorkspaceSizesKey } from "./athena-workspace"

function box(left: number, width: number) {
  return {
    x: left, y: 0, left, top: 0, width, height: 700,
    right: left + width, bottom: 700, toJSON: () => ({}),
  } as DOMRect
}

function pointer(type: string, clientX: number, pointerId = 7, isPrimary = true) {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperties(event, {
    button: { value: 0 },
    clientX: { value: clientX },
    isPrimary: { value: isPrimary },
    pointerId: { value: pointerId },
  })
  return event
}

function showWorkspace() {
  let workspaceWidth = 1440
  const rendered = render(<ResizableAthenaWorkspace
    groups={<aside id="athena-data-groups" className="ath-groups">Groups</aside>}
    processing={<aside id="athena-processing-parameters" className="ath-parameters">Processing</aside>}
    spectrum={<section id="athena-spectrum-viewer" className="ath-center">Spectrum</section>}
  />)
  const workspace = screen.getByTestId("athena-workspace")
  const groups = document.getElementById("athena-data-groups")!
  const processing = document.getElementById("athena-processing-parameters")!
  const spectrum = document.getElementById("athena-spectrum-viewer")!
  const paneWidth = (name: "--ath-groups-width" | "--ath-processing-width", fallback: number) => Number.parseFloat(workspace.style.getPropertyValue(name)) || fallback
  Object.defineProperty(workspace, "getBoundingClientRect", { configurable: true, value: () => box(0, workspaceWidth) })
  Object.defineProperty(groups, "getBoundingClientRect", { configurable: true, value: () => box(0, paneWidth("--ath-groups-width", 237)) })
  Object.defineProperty(processing, "getBoundingClientRect", { configurable: true, value: () => {
    const groupsWidth = paneWidth("--ath-groups-width", 237)
    return box(groupsWidth + 9, paneWidth("--ath-processing-width", 307))
  } })
  Object.defineProperty(spectrum, "getBoundingClientRect", { configurable: true, value: () => {
    const groupsWidth = paneWidth("--ath-groups-width", 237)
    const processingWidth = paneWidth("--ath-processing-width", 307)
    return box(groupsWidth + processingWidth + 18, workspaceWidth - groupsWidth - processingWidth - 18)
  } })
  fireEvent(window, new Event("resize"))
  return { ...rendered, workspace, setWorkspaceWidth: (width: number) => { workspaceWidth = width; fireEvent(window, new Event("resize")) } }
}

beforeEach(() => localStorage.clear())
afterEach(() => {
  cleanup()
  localStorage.clear()
})

describe("ResizableAthenaWorkspace", () => {
  it("renders the panes in visual reading order with two named vertical separators", () => {
    const { workspace } = showWorkspace()
    expect(Array.from(workspace.children).map(child => child.id || child.getAttribute("aria-label"))).toEqual([
      "athena-data-groups",
      "Resize data groups and processing parameters",
      "athena-processing-parameters",
      "Resize processing parameters and spectrum viewer",
      "athena-spectrum-viewer",
    ])
    const separators = screen.getAllByRole("separator")
    expect(separators).toHaveLength(2)
    expect(separators[0]).toHaveAttribute("aria-orientation", "vertical")
    expect(separators[0]).toHaveAttribute("aria-controls", "athena-data-groups athena-processing-parameters")
    expect(separators[0]).toHaveAttribute("aria-valuenow", "237")
    expect(separators[1]).toHaveAttribute("aria-controls", "athena-processing-parameters athena-spectrum-viewer")
    expect(separators[1]).toHaveAttribute("aria-valuenow", "307")
  })

  it("resizes adjacent panes from the keyboard and keeps minimum widths", () => {
    const { workspace } = showWorkspace()
    const [first, second] = screen.getAllByRole("separator")
    fireEvent.keyDown(first, { key: "ArrowRight" })
    expect(workspace.style.getPropertyValue("--ath-groups-width")).toBe("253px")
    expect(workspace.style.getPropertyValue("--ath-processing-width")).toBe("291px")

    fireEvent.keyDown(second, { key: "Home" })
    expect(workspace.style.getPropertyValue("--ath-groups-width")).toBe("253px")
    expect(workspace.style.getPropertyValue("--ath-processing-width")).toBe("260px")

    fireEvent.keyDown(second, { key: "Enter" })
    expect(workspace.style.getPropertyValue("--ath-groups-width")).toBe("")
    expect(localStorage.getItem(athenaWorkspaceSizesKey)).toBeNull()
  })

  it("drags a divider, persists the result, and lets Escape restore the starting widths", () => {
    const { workspace } = showWorkspace()
    const second = screen.getByRole("separator", { name: "Resize processing parameters and spectrum viewer" })
    fireEvent(second, pointer("pointerdown", 553))
    expect(workspace).toHaveAttribute("data-resizing", "processing-spectrum")
    fireEvent(window, pointer("pointermove", 601))
    expect(workspace.style.getPropertyValue("--ath-processing-width")).toBe("355px")
    expect(localStorage.getItem(athenaWorkspaceSizesKey)).toBeNull()
    fireEvent(window, pointer("pointerup", 601))
    expect(JSON.parse(localStorage.getItem(athenaWorkspaceSizesKey)!)).toEqual({ groups: 237, processing: 355 })

    fireEvent(second, pointer("pointerdown", 601))
    fireEvent(window, pointer("pointermove", 633))
    expect(workspace.style.getPropertyValue("--ath-processing-width")).toBe("387px")
    fireEvent.keyDown(window, { key: "Escape" })
    expect(workspace).not.toHaveAttribute("data-resizing")
    expect(workspace.style.getPropertyValue("--ath-groups-width")).toBe("237px")
    expect(workspace.style.getPropertyValue("--ath-processing-width")).toBe("355px")
    expect(JSON.parse(localStorage.getItem(athenaWorkspaceSizesKey)!)).toEqual({ groups: 237, processing: 355 })
  })

  it("keeps preferred widths when a temporary narrow viewport clamps the rendered panes", () => {
    localStorage.setItem(athenaWorkspaceSizesKey, JSON.stringify({ groups: 300, processing: 360 }))
    const { workspace, setWorkspaceWidth } = showWorkspace()
    expect(workspace.style.getPropertyValue("--ath-groups-width")).toBe("300px")
    expect(workspace.style.getPropertyValue("--ath-processing-width")).toBe("360px")

    setWorkspaceWidth(960)
    expect(workspace.style.getPropertyValue("--ath-groups-width")).toBe("300px")
    expect(workspace.style.getPropertyValue("--ath-processing-width")).toBe("262px")
    expect(JSON.parse(localStorage.getItem(athenaWorkspaceSizesKey)!)).toEqual({ groups: 300, processing: 360 })

    setWorkspaceWidth(1440)
    expect(workspace.style.getPropertyValue("--ath-groups-width")).toBe("300px")
    expect(workspace.style.getPropertyValue("--ath-processing-width")).toBe("360px")
  })

  it("ignores non-primary and mismatched pointers and cancels the active pointer safely", () => {
    const { workspace } = showWorkspace()
    const first = screen.getByRole("separator", { name: "Resize data groups and processing parameters" })
    fireEvent(first, pointer("pointerdown", 237, 8, false))
    expect(workspace).not.toHaveAttribute("data-resizing")

    fireEvent(first, pointer("pointerdown", 237, 7))
    fireEvent(window, pointer("pointermove", 285, 8))
    expect(workspace.style.getPropertyValue("--ath-groups-width")).toBe("")
    fireEvent(window, pointer("pointercancel", 285, 8))
    expect(workspace).toHaveAttribute("data-resizing", "groups-processing")

    fireEvent(window, pointer("pointercancel", 285, 7))
    expect(workspace).not.toHaveAttribute("data-resizing")
    expect(workspace.style.getPropertyValue("--ath-groups-width")).toBe("")
    expect(localStorage.getItem(athenaWorkspaceSizesKey)).toBeNull()
  })
})
