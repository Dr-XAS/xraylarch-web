"use client"

import { SectionHelp } from "../section-help"
import { useState, type ReactNode } from "react"
import { Download } from "lucide-react"
import { isDifferenceGroup, type AthenaGroup, type Analysis } from "@/lib/athena"
import { viewerLabels } from "@/lib/athena-viewer-order"
import { AthenaPlot, type Space } from "./athena-plot"
import { AthenaColorLegend } from "./athena-color-legend"
import { automaticPlotRange } from "./athena-plot-range"
import { ResizablePlotCard } from "./athena-plot-card"
import { ViewerPanel } from "./viewer-panel"
import { ViewerKWeightControl } from "./viewer-kweight-control"
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
  // The series-LCF target drawn in the fit view.
  seriesTarget?: { id: string; label: string }
  savedKWeight: number | null
  canChangeKWeight: boolean
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
  analysisVisible: showingAnalysis, seriesTarget, savedKWeight, canChangeKWeight, draftE0, pickPrompt,
  onChangeSpace, onSpecialPlot, onOptionsMenuOpen, onPickX, onExport }: Props) {
  const { space, kWeight: viewerKWeight, setKWeight, energyMode, setEnergyMode, component, setComponent, plotScope,
    background, setBackground, preEdge, setPreEdge, postEdge, setPostEdge,
    showWindow, setShowWindow, showGrid, setShowGrid,
    showDataPoints, setShowDataPoints, plotColors, setPlotColors, offset, setOffset,
    previousStackOffset, range, setRange, rangeRelativeToE0, setRangeRelativeToE0 } = state
  const selectedGroups = weightedPlot.groups
  const showLegend = showingAnalysis ? state.showAnalysisLegend : state.showLegend
  const setShowLegend = showingAnalysis ? state.setShowAnalysisLegend : state.setShowLegend
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
  return <ViewerPanel title={viewerLabels[viewer]} viewerId={viewer} help={viewer === "single" ? "Plots the highlighted group, independently of its mark. Plot display choices stay local to this viewer." : "Plots the marked groups in project order. Its display choices are independent of the single spectrum viewer."}><ResizablePlotCard storageKey={`athena.plot.${viewer}.height.v1`} resizeLabel={`Resize ${viewer === "single" ? "single spectrum" : "multiple spectra"} plot height`} controlsId={`athena-${viewer}-spectrum-viewer`}><div className="ath-plot-top"><div className="ath-space-tabs" role="tablist" aria-label="Plot space">{(["E", "k", "R", "q"] as Space[]).map(s => <button key={s} role="tab" aria-selected={space === s && !showingAnalysis} onContextMenu={event => { event.preventDefault(); onSpecialPlot?.(s) }} title="Right-click for Athena’s special plot" onClick={() => onChangeSpace(s)}><b>{s}</b><span>{{ E: "Energy", k: "EXAFS", R: "Fourier", q: "Back transform" }[s]}</span></button>)}</div><SectionHelp label="Plot space">E shows absorption versus energy; k shows EXAFS oscillations; R shows the Fourier transform; q shows the R-filtered back transform. R peaks are not phase-corrected bond lengths. Right-click a space for its Athena comparison plot.</SectionHelp></div>
        {plotScope === "selected" && <div className="ath-plot-scope"><span className="ath-plot-scope-note">{selectedGroups.length} checked {selectedGroups.length === 1 ? "group" : "groups"}</span></div>}
        <div className="ath-plot-controls">
        {space !== "E" && <ViewerKWeightControl label={`${viewer === "single" ? "Single spectrum" : "Multiple spectra"} k-weight`} value={viewerKWeight} savedWeight={savedKWeight} onChange={setKWeight} disabled={!canChangeKWeight || !selectedGroups.length || showingAnalysis} />}
        {space === "E" ? plotScope === "current" && <>
          <label className="ath-check" title="Show the current spectrum’s fitted background in μ(E)"><input type="checkbox" aria-label="Background" checked={background && canShowBackground} disabled={!canShowBackground} onChange={e => setBackground(e.target.checked)} />Background<SectionHelp label="Background">Overlay the fitted μ₀(E) background on the current raw μ(E) curve. It is available after background processing; showing it does not refit the spectrum.</SectionHelp></label>
          <label className="ath-check" title="Show the fitted pre-edge line and its start/end points for Current spectrum in μ(E)"><input type="checkbox" aria-label="Pre-edge line" checked={preEdge && canShowPreEdge} disabled={!canShowPreEdge} onChange={e => setPreEdge(e.target.checked)} />Pre-edge line<SectionHelp label="Pre-edge line">Overlay the fitted pre-edge normalization line and markers at its interval endpoints. Hover the markers for energies and offsets from E₀.</SectionHelp></label>
          <label className="ath-check" title="Show the fitted post-edge line and its start/end points for Current spectrum in μ(E)"><input type="checkbox" aria-label="Post-edge line" checked={postEdge && canShowPostEdge} disabled={!canShowPostEdge} onChange={e => setPostEdge(e.target.checked)} />Post-edge line<SectionHelp label="Post-edge line">Overlay the fitted post-edge normalization line and its interval endpoints on raw μ(E). Edit the normalization parameters to change the fit.</SectionHelp></label>
        </> : !showingAnalysis && <>{space !== "k" && <><select aria-label="Complex component" value={component} onChange={e => setComponent(e.target.value)}><option value="mag">Magnitude</option><option value="re">{space === "q" ? "Real part + χ(k)" : "Real part"}</option><option value="im">Imaginary part</option><option value="pha">Phase</option></select><SectionHelp label="Complex component">Choose magnitude, real part, imaginary part, or phase of the complex transform. In q space, Real part also overlays χ(k) for comparison with the back transform.</SectionHelp></>}<label className="ath-check"><input type="checkbox" aria-label="Window" checked={showWindow} onChange={e => setShowWindow(e.target.checked)} />Window<SectionHelp label="Window">Overlay the taper used for the transform in this space. This makes the fitted or transformed interval visible without editing its limits.</SectionHelp></label></>}
        {space === "E" && plotScope === "current" && plotEnergyMode !== "mu" && <SectionHelp label="Pre-edge and post-edge lines">For pre-/post-edge lines, choose μ(E) · raw.</SectionHelp>}
        <AthenaColorLegend storageKey={viewer === "single" ? "athena.plot-colors.single" : "athena.plot-colors"} value={plotColors} onChange={setPlotColors} disabled={showingAnalysis} />
        </div>
        {pickPrompt}
        {space === "E" && <div className="ath-energy-plot-options" role="radiogroup" aria-label="Energy plot">
          {(detectorOnly ? [{ value: "mu", label: "Detector signal" }] : energyPlotOptions).map(option => <label className={`ath-energy-plot-option${plotEnergyMode === option.value ? " selected" : ""}${detectorOnly ? " disabled" : ""}`} key={option.value}><input type="radio" name={`ath-energy-plot-${viewer}`} value={option.value} checked={plotEnergyMode === option.value} disabled={detectorOnly} onChange={() => setEnergyMode(option.value)} /><span>{option.label}</span></label>)}
          <SectionHelp label="Energy plot">Raw shows μ(E); normalized subtracts the fitted pre-edge line and divides by the edge step; flattened removes post-edge curvature. Derivatives emphasize edge features and can amplify noise. Detector groups retain their measured signal.</SectionHelp>
        </div>}
        {plotScope === "current" && <div className="ath-plot-current-spectrum"><div className="ath-plot-current-spectrum-name" title={active?.label}><span>{showingAnalysis && seriesTarget ? "Fitted target" : "Current spectrum"}</span><strong>{(showingAnalysis && seriesTarget?.label) || (active?.label ?? "None selected")}</strong></div></div>}
        {weightedPlot.loading ? <div className="ath-no-plot" role="status">Updating Fourier transform…</div>
          : weightedPlot.error ? <div className="ath-no-plot" role="alert"><p>{weightedPlot.error}</p><button type="button" onClick={weightedPlot.retry}>Try again</button></div>
          : <AthenaPlot groups={weightedPlot.groups} active={active} space={space} energyMode={plotEnergyMode} component={component} plotScope={plotScope} background={background && canShowBackground} preEdge={preEdge && canShowPreEdge} postEdge={postEdge && canShowPostEdge} window={showWindow} showLegend={showLegend} showGrid={showGrid} showDataPoints={showDataPoints} onShowGridChange={setShowGrid} onShowDataPointsChange={setShowDataPoints} onOptionsMenuOpen={onOptionsMenuOpen} colorSettings={plotColors} kWeight={viewerKWeight} offset={offset} analysis={analysis} analysisVisible={showingAnalysis} seriesTarget={seriesTarget?.id} range={range} picking={!!onPickX} onPickX={onPickX} />}
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
            <ViewerToggle label="Show legend" help="Show each curve’s name beside the plot. Click a legend entry to hide a curve temporarily; double-click to isolate it." checked={showLegend} onChange={setShowLegend} />
          </ViewerControlGroup>
          <span className="ath-plot-summary">{showingAnalysis ? "Analysis result" : `${selectedGroups.length} ${selectedGroups.length === 1 ? "spectrum" : "spectra"}`}{space === "R" && !showingAnalysis && " · R is not phase corrected"}</span>
          <ViewerControlGroup label="Spectrum plot range" align="end">{space === "E" && <ViewerToggle label="Relative to E₀" help="Enter the range limits as energy offsets from the current group’s E₀, in eV. The plotted energy axis remains absolute; this changes how the limits are entered." title={draftE0 === null ? "E₀ is unavailable for the current spectrum" : `Use the current spectrum’s E₀ (${draftE0} eV) as zero`} checked={relativeRange} disabled={showingAnalysis || draftE0 === null} onChange={setRangeRelativeToE0} />}<ViewerControlField label="Range" help={`Set the visible horizontal minimum and maximum in ${space === "E" ? "eV" : space === "R" ? "Å" : "Å⁻¹"}. ${space === "R" ? "Clear either bound to restore its default (0–6 Å)." : "Clear either bound to use the full available range."} These limits zoom the plot without trimming data or changing transform ranges.`}><PlotRangeInput label="Plot minimum" value={showingAnalysis ? null : displayedRange[0]} automatic={displayedAutomaticRange[0]} disabled={showingAnalysis || automaticRange[0] === null} onChange={value => setRange([absoluteRangeValue(value), range[1]])} /></ViewerControlField><span>to</span><PlotRangeInput label="Plot maximum" value={showingAnalysis ? null : displayedRange[1]} automatic={displayedAutomaticRange[1]} disabled={showingAnalysis || automaticRange[1] === null} onChange={value => setRange([range[0], absoluteRangeValue(value)])} />{onExport && <><button title="Export current group data" onClick={onExport}><Download size={14} />CSV</button><SectionHelp label="Spectrum CSV export">Download the current group’s arrays in the displayed E, k, R, or q space as CSV. Viewer colors, vertical offsets, and display ranges do not alter the saved arrays.</SectionHelp></>}</ViewerControlGroup>
        </ViewerDisplayControls>
      </ResizablePlotCard></ViewerPanel>
}
