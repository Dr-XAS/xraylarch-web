"use client"

import { useState, type ReactNode } from "react"
import { Download } from "lucide-react"
import { isDifferenceGroup, type AthenaGroup, type Analysis } from "@/lib/athena"
import { viewerLabels } from "@/lib/athena-viewer-order"
import { AthenaPlot, type Space } from "./athena-plot"
import { AthenaColorLegend } from "./athena-color-legend"
import { automaticPlotRange } from "./athena-plot-range"
import { ResizablePlotCard } from "./athena-plot-card"
import { ViewerPanel } from "./viewer-panel"
import { ViewerControlField, ViewerControlGroup, ViewerDisplayControls, ViewerToggle } from "./viewer-display-controls"
import type { useAthenaPlotWeight } from "./athena-plot-weight"
import type { useSpectrumViewerState } from "./athena-spectrum-viewer-state"

const energyPlotOptions = [
  { value: "mu", label: "μ(E) · raw" },
  { value: "norm", label: "μ(E) · normalized" },
  { value: "flat", label: "μ(E) · flattened" },
  { value: "dmude", label: "Derivative dμ/dE" },
  { value: "d2mude", label: "Second derivative d²μ/dE²" },
] as const
function PlotRangeInput({ label, value, automatic, disabled, onChange }: {
  label: string; value: number | null; automatic: number | null; disabled: boolean
  onChange: (value: number | null) => void
}) {
  const [emptyWhileEditing, setEmptyWhileEditing] = useState(false)
  const displayedValue = value ?? (!emptyWhileEditing ? automatic : null) ?? ""
  return <input aria-label={label} type="number" step="any" disabled={disabled} value={displayedValue} onChange={event => {
    setEmptyWhileEditing(event.target.value === "")
    onChange(event.target.value === "" ? null : Number(event.target.value))
  }} onBlur={() => setEmptyWhileEditing(false)} onKeyDown={event => {
    if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur() }
  }} />
}

function energyRangeValue(value: number | null, e0: number | null, relative: boolean, direction: 1 | -1) {
  if (value === null || e0 === null || !relative) return value
  return Number((value + direction * e0).toPrecision(12))
}

interface Props {
  viewer: "single" | "multiple"
  state: ReturnType<typeof useSpectrumViewerState>
  weightedPlot: ReturnType<typeof useAthenaPlotWeight>
  active?: AthenaGroup
  analysis: Analysis | null
  analysisVisible: boolean
  viewerKWeight: number | null
  draftE0: number | null
  pickPrompt?: ReactNode
  onChangeSpace: (space: Space) => void
  onSpecialPlot?: (space: Space) => void
  onOptionsMenuOpen: () => void
  onPickX?: (x: number, space: Space) => void
  onExport?: () => void
}

/** Shared panel for independent current-spectrum and marked-spectrum views. */
export function AthenaSpectrumViewer({ viewer, state, weightedPlot, active, analysis,
  analysisVisible: showingAnalysis, viewerKWeight, draftE0, pickPrompt,
  onChangeSpace, onSpecialPlot, onOptionsMenuOpen, onPickX, onExport }: Props) {
  const { space, energyMode, setEnergyMode, component, setComponent, plotScope,
    background, setBackground, preEdge, setPreEdge, postEdge, setPostEdge,
    showWindow, setShowWindow, showLegend, setShowLegend, showGrid, setShowGrid,
    showDataPoints, setShowDataPoints, plotColors, setPlotColors, offset, setOffset,
    previousStackOffset, range, setRange, rangeRelativeToE0, setRangeRelativeToE0 } = state
  const selectedGroups = weightedPlot.groups
  const detectorOnly = viewer === "single" ? active?.data_type === "detector" : selectedGroups.length > 0 && selectedGroups.every(group => group.data_type === "detector")
  const plotEnergyMode = detectorOnly ? "mu" : energyMode
  const overlayArrays = viewer === "single" && space === "E" && plotEnergyMode === "mu" && !showingAnalysis && active &&
    !["detector", "chi"].includes(active.data_type) && !isDifferenceGroup(active) ? active.result?.arrays : undefined
  const hasOverlay = (key: string) => !!overlayArrays?.energy?.length &&
    overlayArrays.mu?.length === overlayArrays.energy.length && overlayArrays[key]?.length === overlayArrays.energy.length
  const canShowPreEdge = hasOverlay("pre_edge"), canShowPostEdge = hasOverlay("post_edge"), canShowBackground = hasOverlay("bkg")
  const automaticRange = automaticPlotRange(weightedPlot.groups, space, plotEnergyMode, component, analysis, showingAnalysis, viewerKWeight)
  const relativeRange = space === "E" && !showingAnalysis && rangeRelativeToE0 && draftE0 !== null
  const displayedRange = range.map(value => energyRangeValue(value, draftE0, relativeRange, -1)) as [number | null, number | null]
  const displayedAutomaticRange = automaticRange.map(value => energyRangeValue(value, draftE0, relativeRange, -1)) as [number | null, number | null]
  const absoluteRangeValue = (value: number | null) => energyRangeValue(value, draftE0, relativeRange, 1)
  return <ViewerPanel title={viewerLabels[viewer]}><ResizablePlotCard storageKey={`athena.plot.${viewer}.height.v1`} resizeLabel={`Resize ${viewer === "single" ? "single spectrum" : "multiple spectra"} plot height`} controlsId={`athena-${viewer}-spectrum-viewer`}><div className="ath-plot-top"><div className="ath-space-tabs" role="tablist" aria-label="Plot space">{(["E", "k", "R", "q"] as Space[]).map(s => <button key={s} role="tab" aria-selected={space === s && !showingAnalysis} onContextMenu={event => { event.preventDefault(); onSpecialPlot?.(s) }} title="Right-click for Athena’s special plot" onClick={() => onChangeSpace(s)}><b>{s}</b><span>{{ E: "Energy", k: "EXAFS", R: "Fourier", q: "Back transform" }[s]}</span></button>)}</div></div>
        {plotScope === "selected" && <div className="ath-plot-scope"><span className="ath-plot-scope-note">{selectedGroups.length} checked {selectedGroups.length === 1 ? "group" : "groups"}</span></div>}
        <div className="ath-plot-controls">{space === "E" ? plotScope === "current" && <>
          <label className="ath-check" title="Show the current spectrum’s fitted background in μ(E)"><input type="checkbox" checked={background && canShowBackground} disabled={!canShowBackground} onChange={e => setBackground(e.target.checked)} />Background</label>
          <label className="ath-check" title="Show the fitted pre-edge line and its start/end points for Current spectrum in μ(E)"><input type="checkbox" checked={preEdge && canShowPreEdge} disabled={!canShowPreEdge} onChange={e => setPreEdge(e.target.checked)} />Pre-edge line</label>
          <label className="ath-check" title="Show the fitted post-edge line and its start/end points for Current spectrum in μ(E)"><input type="checkbox" checked={postEdge && canShowPostEdge} disabled={!canShowPostEdge} onChange={e => setPostEdge(e.target.checked)} />Post-edge line</label>
        </> : <>{space !== "k" && <select aria-label="Complex component" value={component} onChange={e => setComponent(e.target.value)}><option value="mag">Magnitude</option><option value="re">{space === "q" ? "Real part + χ(k)" : "Real part"}</option><option value="im">Imaginary part</option><option value="pha">Phase</option></select>}<label className="ath-check"><input type="checkbox" checked={showWindow} onChange={e => setShowWindow(e.target.checked)} />Window</label></>}<AthenaColorLegend storageKey={viewer === "single" ? "athena.plot-colors.single" : "athena.plot-colors"} value={plotColors} onChange={setPlotColors} disabled={showingAnalysis} />
        {space === "E" && plotScope === "current" && plotEnergyMode !== "mu" && <p className="ath-plot-overlay-hint">For pre-/post-edge lines, choose μ(E) · raw.</p>}
        </div>
        {pickPrompt}
        {space === "E" && <div className="ath-energy-plot-options" role="radiogroup" aria-label="Energy plot">
          {(detectorOnly ? [{ value: "mu", label: "Detector signal" }] : energyPlotOptions).map(option => <label className={`ath-energy-plot-option${plotEnergyMode === option.value ? " selected" : ""}${detectorOnly ? " disabled" : ""}`} key={option.value}><input type="radio" name={`ath-energy-plot-${viewer}`} value={option.value} checked={plotEnergyMode === option.value} disabled={detectorOnly} onChange={() => setEnergyMode(option.value)} /><span>{option.label}</span></label>)}
        </div>}
        {plotScope === "current" && <div className="ath-plot-current-spectrum"><div className="ath-plot-current-spectrum-name" title={active?.label}><span>Current spectrum</span><strong>{active?.label ?? "None selected"}</strong></div></div>}
        {weightedPlot.loading ? <div className="ath-no-plot" role="status">Updating Fourier transform…</div>
          : weightedPlot.error ? <div className="ath-no-plot" role="alert"><p>{weightedPlot.error}</p><button type="button" onClick={weightedPlot.retry}>Try again</button></div>
          : <AthenaPlot groups={weightedPlot.groups} active={active} space={space} energyMode={plotEnergyMode} component={component} plotScope={plotScope} background={background && canShowBackground} preEdge={preEdge && canShowPreEdge} postEdge={postEdge && canShowPostEdge} window={showWindow} showLegend={showLegend} showGrid={showGrid} showDataPoints={showDataPoints} onShowGridChange={setShowGrid} onShowDataPointsChange={setShowDataPoints} onOptionsMenuOpen={onOptionsMenuOpen} colorSettings={plotColors} kWeight={viewerKWeight} offset={offset} analysis={analysis} analysisVisible={showingAnalysis} range={range} picking={!!onPickX} onPickX={onPickX} />}
        <ViewerDisplayControls label="Spectrum plot display options">
          <ViewerControlGroup label="Spectrum display" className="ath-plot-display-controls">
            <ViewerToggle label="Offset plot" checked={offset !== 0} disabled={plotScope === "current"}
              title="Separate selected spectra vertically without changing their data"
              onChange={enabled => setOffset(enabled ? previousStackOffset.current : 0)} />
            <ViewerControlField label="Spacing" title="Vertical separation between selected spectra">
              <input aria-label="Stack offset" type="number" step="0.1" value={offset} disabled={plotScope === "current"} onChange={event => {
                const next = Number(event.target.value)
                if (Number.isFinite(next)) {
                  if (next !== 0) previousStackOffset.current = next
                  setOffset(next)
                }
              }} />
            </ViewerControlField>
            <ViewerToggle label="Show legend" checked={showLegend} onChange={setShowLegend} />
          </ViewerControlGroup>
          <span className="ath-plot-summary">{showingAnalysis ? "Analysis result" : `${selectedGroups.length} ${selectedGroups.length === 1 ? "spectrum" : "spectra"}`}{space === "R" && " · R is not phase corrected"}</span>
          <ViewerControlGroup label="Spectrum plot range" align="end">{space === "E" && <ViewerToggle label="Relative to E₀" title={draftE0 === null ? "E₀ is unavailable for the current spectrum" : `Use the current spectrum’s E₀ (${draftE0} eV) as zero`} checked={relativeRange} disabled={showingAnalysis || draftE0 === null} onChange={setRangeRelativeToE0} />}<ViewerControlField label="Range"><PlotRangeInput label="Plot minimum" value={showingAnalysis ? null : displayedRange[0]} automatic={displayedAutomaticRange[0]} disabled={showingAnalysis || automaticRange[0] === null} onChange={value => setRange([absoluteRangeValue(value), range[1]])} /></ViewerControlField><span>to</span><PlotRangeInput label="Plot maximum" value={showingAnalysis ? null : displayedRange[1]} automatic={displayedAutomaticRange[1]} disabled={showingAnalysis || automaticRange[1] === null} onChange={value => setRange([range[0], absoluteRangeValue(value)])} />{onExport && <button title="Export current group data" onClick={onExport}><Download size={14} />CSV</button>}</ViewerControlGroup>
        </ViewerDisplayControls>
      </ResizablePlotCard></ViewerPanel>
}
