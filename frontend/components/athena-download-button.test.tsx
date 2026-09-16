import "@testing-library/jest-dom/vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { athenaDownload } from "@/lib/athena"
import { AthenaDownloadButton } from "./athena-download-button"

vi.mock("@/lib/athena", () => ({ athenaDownload: vi.fn() }))

afterEach(() => { cleanup(); vi.mocked(athenaDownload).mockReset() })

it("reports a failed bound download without an unhandled rejection", async () => {
  vi.mocked(athenaDownload).mockRejectedValue(new Error("Download authorization expired."))
  render(<AthenaDownloadButton path="/projects/p1/export">Download project</AthenaDownloadButton>)

  fireEvent.click(screen.getByRole("button", { name: "Download project" }))

  expect(await screen.findByRole("alert")).toHaveTextContent("Download authorization expired.")
  await waitFor(() => expect(screen.getByRole("button", { name: "Download project" })).toBeEnabled())
})
