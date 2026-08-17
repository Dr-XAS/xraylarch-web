import "@testing-library/jest-dom/vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { ApiRequestError } from "@/lib/backend-client"
import { DEFAULT_RECIPE } from "@/lib/contracts"
import { ProcessingInspector } from "@/components/processing-inspector"

describe("ProcessingInspector", () => {
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
        statusText="Review controls"
        error={error}
        onChange={vi.fn()}
        onPreview={vi.fn().mockResolvedValue(undefined)}
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
})
