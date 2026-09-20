# Larch-Web typography

The UI uses the locally served Figtree family and one role-based type scale.
Sizes are defined in `frontend/app/globals.css` in `rem`, so they follow the
reader's default font size. Pixel equivalents below assume a 16px root.

| Token | Size | Role |
| --- | --- | --- |
| `--text-caption` | 11px | Help, units, metadata, status, count badges |
| `--text-label` | 12px | Field labels, tables, code reports |
| `--text-body` | 13px | Body text, buttons, menus, spectrum names |
| `--text-input` | 12px | Inputs, selects and textareas |
| `--text-section` | 14px | Pane, card and section headings |
| `--text-title` | 18px | App name, viewer and dialog headings |
| `--text-display` | 22px | Welcome / introduction text |

Use the role, rather than the component's location, to choose a size. Data
groups, processing, EXAFS fitting, dialogs and the classic workbench share
these values. Avoid pane-specific additions, mobile font reductions, and
new hardcoded sizes. Keep ordinary text at least 11px at the default root.
Scientific subscripts and superscripts retain their normal relative sizing;
the decorative empty-plot letter uses `--text-illustration` (64px).

Body line height is 1.5, controls 1.3, and headings 1.25. Use medium and
semibold weight to distinguish actions and headings without adding size
steps. Numeric fields and tables retain tabular figures. Let labels and menus
wrap on narrow screens, and align plot-picker buttons with their inputs.

## Scientific figures

Plotly needs concrete values for SVG and WebGL text. The shared helpers in
`frontend/lib/plot-typography.ts`, applied by `ThemedPlot`, use the same Figtree
stack with 12px ticks, legends, hover labels and annotations; 13px axis and
colorbar titles; and 14px chart titles. Special-plot SVG export uses the same
helpers. Keep presentation changes out of scientific arrays, ranges and view
revisions. Update these constants together with the UI scale when revising it.
