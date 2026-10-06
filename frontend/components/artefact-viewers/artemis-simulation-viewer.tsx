"use client"

import { SectionHelp } from "../section-help"
import { useId, useState } from "react"
import type { SimulationResult } from "@/lib/artemis-simulation"
import { simulationCsv } from "@/lib/artemis-simulation"
import { downloadArtemisText } from "@/lib/artemis-structures"
import { ThemedPlot as Plot } from "../themed-plot"
import { ViewerPanel } from "./viewer-panel"
import { ViewerDisplayControls } from "./viewer-display-controls"
import { ResizablePlotCard } from "./athena-plot-card"
import styles from "./artemis-simulation-viewer.module.css"

export function ArtemisSimulationViewer({ result }: { result: SimulationResult }) {
  const [space, setSpace] = useState<"k" | "r">("k")
  const plotId = useId()
  const weight = result.k.weight
  const stem = `${result.source.request.absorber}-${result.source.request.edge}-site-${result.source.request.site_index}-simulation`
  return <ViewerPanel title="Simulated EXAFS" help={<>FEFF paths are summed before Fourier transformation. |χ(R)| is not phase corrected; its peaks are not bond distances. Download simulation JSON retains the exact CIF, FEFF input, path files, parameters and curves.</>}>
    <ResizablePlotCard storageKey="artemis.simulation.height.v1" defaultHeight={390}
      plotSelector="[data-simulation-plot]" resizeLabel="Resize simulated EXAFS plot height" controlsId={plotId}>
    <div id={plotId} data-simulation-plot className={styles.plot} aria-label={`Simulated EXAFS ${space} plot`}>
      <Plot data={[{ type: "scatter", mode: "lines", name: "Simulation", x: space === "k" ? result.k.x : result.r.x,
        y: space === "k" ? result.k.total : result.r.total_mag, line: { color: "#3285AD", width: 2 } }]}
        layout={{ autosize: true, margin: { l: 64, r: 16, t: 18, b: 54 }, showlegend: false,
          xaxis: { title: { text: space === "k" ? "k (Å⁻¹)" : "R (Å; not phase corrected)" }, range: space === "k" ? [0, result.k.x.at(-1)!] : [0, 6] },
          yaxis: { title: { text: space === "k" ? weight ? `k<sup>${weight}</sup>χ(k) (Å<sup>−${weight}</sup>)` : "χ(k)" : `|χ(R)| (Å<sup>−${weight + 1}</sup>)` } },
          uirevision: `${result.simulation.feff_job_id}:${space}:${weight}` }}
        config={{ responsive: true, displaylogo: false, toImageButtonOptions: { filename: `${stem}-${space}`, scale: 2 } }}
        style={{ width: "100%", height: "100%" }} useResizeHandler />
    </div>
    <ViewerDisplayControls label="Simulation display and export" className={styles.controls}>
      <button type="button" aria-pressed={space === "k"} onClick={() => setSpace("k")}>χ(k)</button>
      <button type="button" aria-pressed={space === "r"} onClick={() => setSpace("r")}>|χ(R)|</button>
      <SectionHelp label="Simulation plot space">χ(k) shows the summed FEFF paths with the simulated k-weight. |χ(R)| shows the magnitude of their Fourier transform; its peaks are not phase-corrected distances.</SectionHelp>
      <button type="button" onClick={() => downloadArtemisText(`${stem}-${space}.csv`, simulationCsv(result, space), "text/csv")}>Download {space === "k" ? "χ(k)" : "χ(R)"} CSV</button>
      <button type="button" onClick={() => downloadArtemisText(`${stem}.json`, JSON.stringify(result, null, 2), "application/json")}>Download simulation JSON</button>
      <SectionHelp label="Simulation downloads">CSV exports the plotted space as numeric arrays. JSON retains the exact CIF, FEFF input, path files, simulation parameters and both spaces for reproducibility.</SectionHelp>
    </ViewerDisplayControls>
    </ResizablePlotCard>
  </ViewerPanel>
}
