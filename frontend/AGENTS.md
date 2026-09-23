<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Shared viewer controls

Reuse existing viewer components for repeated controls rather than copying their markup or CSS. Spectrum and Wavelet color controls share `AthenaColorLegendControl` and `AthenaRampPicker`; continuous palette definitions and previews come from `lib/athena-colormaps.ts`. Keep viewer-specific labels, categorical options, state, and storage in their callers. Presentation-only changes must not trigger scientific recalculation.

Use `ViewerDisplayControls` for controls below a plot, with Offset first, its spacing beside it, then display toggles, and ranges/actions last. Use `ViewerPanel` for collapsible headings and let title/actions wrap without overlap. Reuse `athena-processing-layout.module.css` for parallel processing dialogs. Prefer 6–8 px control gaps, 12 px panel insets, and 30–32 px control heights; retain the existing readable typography. Compact by grouping related controls and removing doubled margins, while allowing narrow panels to wrap.
