"use client"

import type { ProcessingResult, PlotId } from "@/lib/contracts"
import type { SelectedView } from "@/lib/workbench-state"

import { PlotlyViewer } from "@/components/plotly-viewer"

const views: Array<{ id: SelectedView; label: string }> = [
  { id: "raw_mu", label: "Raw μ(E)" },
  { id: "norm_mu", label: "Normalized μ(E)" },
  { id: "chi_k", label: "χ(k)" },
  { id: "chi_r", label: "χ(R)" },
]

interface PlotCanvasProps {
  result: ProcessingResult | null
  selectedView: SelectedView
  onSelectView: (view: SelectedView) => void
}

function selectedTrace(result: ProcessingResult | null, view: PlotId) {
  return result?.plots.filter((trace) => trace.id === view) ?? []
}

export function PlotCanvas({ result, selectedView, onSelectView }: PlotCanvasProps) {
  const trace = selectedTrace(result, selectedView)
  const reference = trace[0]
  return (
    <section className="plot-canvas" data-testid="plot-canvas" aria-labelledby="plot-heading">
      <div className="section-heading plot-heading">
        <div>
          <p className="eyebrow">Scientific views</p>
          <h2 id="plot-heading">Processed spectrum</h2>
        </div>
        <div className="plot-tabs" role="tablist" aria-label="Spectrum views">
          {views.map((view) => (
            <button
              key={view.id}
              type="button"
              role="tab"
              aria-selected={selectedView === view.id}
              className={selectedView === view.id ? "active" : undefined}
              onClick={() => onSelectView(view.id)}
            >{view.label}</button>
          ))}
        </div>
      </div>
      {reference ? (
        <PlotlyViewer
          trace={trace}
          title={reference.label}
          xLabel={`${reference.x_label}${reference.x_unit ? ` (${reference.x_unit})` : ""}`}
          yLabel={`${reference.y_label}${reference.y_unit ? ` (${reference.y_unit})` : ""}`}
          testId={`plot-${selectedView}`}
        />
      ) : <div className="plot-empty">Processed server traces will appear here after a successful preview or apply.</div>}
    </section>
  )
}
