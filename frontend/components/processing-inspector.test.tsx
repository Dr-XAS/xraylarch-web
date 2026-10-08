import "@testing-library/jest-dom/vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { ApiRequestError } from "@/lib/backend-client"
import { DEFAULT_RECIPE } from "@/lib/contracts"
import { ProcessingInspector } from "@/components/processing-inspector"

describe("ProcessingInspector", () => {
  it.each([
    ["kweight", 9], ["kweight", 1.5], ["nnorm", 4], ["rbkg", -1], ["ft_dk", 0],
    ["nfft", 129], ["kstep", 0.0001], ["rmax_out", 32], ["pre1", 100], ["norm2", -100],
  ])("blocks preview and apply for invalid %s=%s", (field, value) => {
    const onPreview = vi.fn(), onApply = vi.fn()
    render(<ProcessingInspector recipe={{ ...DEFAULT_RECIPE, [field]: value }} canPreview canApply isPreviewing={false}
      statusText="Review controls" error={null} onChange={vi.fn()} onPreview={onPreview} onCancelPreview={vi.fn()} onApply={onApply} />)
    expect(screen.getByTestId("preview-button")).toBeDisabled()
    expect(screen.getByTestId("apply-button")).toBeDisabled()
    fireEvent.click(screen.getByTestId("preview-button"))
    fireEvent.click(screen.getByTestId("apply-button"))
    expect(onPreview).not.toHaveBeenCalled()
    expect(onApply).not.toHaveBeenCalled()
  })
  it("binds advanced backend validation recovery to every affected control", () => {
    const error = new ApiRequestError({
      code: "invalid_recipe",
      message: "Advanced EXAFS values are invalid.",
      fields: ["autobk_dk", "autobk_window", "ft_dk", "ft_dk2", "ft_window", "nfft", "kstep", "rmax_out"],
      recovery: "Use a permitted advanced value and preview again.",
    }, 422)
    render(
      <ProcessingInspector
        recipe={DEFAULT_RECIPE}
        canPreview
        canApply={false}
        isPreviewing={false}
        statusText="Review controls"
        error={error}
        onChange={vi.fn()}
        onPreview={vi.fn().mockResolvedValue(undefined)}
        onCancelPreview={vi.fn()}
        onApply={vi.fn().mockResolvedValue(undefined)}
      />,
    )

    expect(screen.getByText(/advanced larch controls/i).closest("details")).toHaveAttribute("open")

    for (const label of [/^Autobk taper/, /^Autobk window/, /^Fourier taper(?! 2)/, /^Fourier taper 2/, /^Fourier window/, /^FFT points/, /^k step/i, /^Output range/]) {
      const control = screen.getByLabelText(label)
      expect(control).toHaveAttribute("aria-invalid", "true")
      expect(control).toHaveAccessibleDescription(/use a permitted advanced value and preview again/i)
    }
  })

  it("offers a visible cancel action while preview is in flight", () => {
    const onCancelPreview = vi.fn()
    render(
      <ProcessingInspector
        recipe={DEFAULT_RECIPE}
        canPreview={false}
        canApply={false}
        isPreviewing
        statusText="Previewing"
        error={null}
        onChange={vi.fn()}
        onPreview={vi.fn().mockResolvedValue(undefined)}
        onCancelPreview={onCancelPreview}
        onApply={vi.fn().mockResolvedValue(undefined)}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: /cancel preview/i }))

    expect(onCancelPreview).toHaveBeenCalledOnce()
  })
})
