"use client"

import { useEffect, useId, useMemo, useRef, useState, type ReactNode, type SetStateAction, type MouseEvent, type KeyboardEvent as ReactKeyboardEvent } from "react"
import { Activity, ArrowDown, ArrowUp, BookOpen, ChevronDown, Copy, Download, ExternalLink, FileText, FolderOpen, Layers, LockKeyhole, Plus, Redo2, Search, Settings2, Trash2, Undo2, Upload, X } from "lucide-react"
import { resources, hasSavedMerge, isDifferenceGroup, dataTypeLabel, type AthenaGroup, type AthenaProject, type Parameters, type Analysis, type E0Method, type E0Options, type EdgePolicy, type EdgePair } from "@/lib/athena"
import type { AthenaSession } from "@/lib/athena-transport"
import { AthenaProvider, useAthenaApi, useAthenaTransport } from "@/lib/athena-context"
import { clearIntegrationReturnSelection, saveReturnSelection } from "@/lib/integration-session"
import type { InspectionResponse, ScanInspectionResponse } from "@/lib/contracts"
import { ATHENA_COLORMAPS, DEFAULT_COLORMAP, spectrumColor, type AthenaColormap } from "@/lib/athena-colormaps"
import { AthenaPlot, type Space } from "./athena-plot"
import { automaticPlotRange, spectrumTraceCoordinates } from "./athena-plot-range"
import { ResizableAthenaWorkspace } from "./athena-workspace"
import { ResizablePlotCard } from "./athena-plot-card"
import { AthenaWavelet } from "./athena-wavelet"
import { useAthenaPlotWeight } from "./athena-plot-weight"
import { AthenaProjectImport, type ProjectPreview } from "./athena-project-import"
import { AthenaColumnSelection } from "./athena-column-selection"
import { AthenaScanSelection } from './athena-scan-selection'
import { AthenaArchiveSelection, type ArchiveInspection } from './athena-archive-selection'
import { columnPayload, initialColumnMapping, defaultPreprocessing, defaultRebin, lastImportedSample, type ColumnMapping } from "@/lib/athena-import"
import { isAthenaProjectFile } from "@/lib/athena-file-types"
import { EdgePolicyDialog, edgePolicyDescription, useEdgePolicy } from "./athena-edge-policy"
import { EdgeIdentityDialog, edgeIdentityDescription } from "./athena-edge-identity"
import { AthenaDifferenceDialog } from "./athena-difference"
import { AthenaDatatype } from './athena-datatype'
import { AthenaPluginRegistry } from './athena-plugin-registry'
import { AthenaBeamlineMetadata, AthenaBeamlinePreferences } from './athena-beamline-metadata'
import { AthenaXDIControls } from './athena-xdi-controls'
import { AthenaDataExport } from './athena-data-export'
import { AthenaParameterReport } from './athena-parameter-report'
import { AthenaContextMenu, type ContextMenuItem } from './athena-context-menu'
import { AthenaContextReport } from './athena-context-report'
import { AthenaSpecialPlot, athenaSpecialPlotLabels, type AthenaSpecialPlotKind } from './athena-special-plot'
import { contextValues, groupImportance, groupPixelRatio, nativeRanges, type ContextTarget, type ContextReportKind, type NativeField, type NativeSection } from './athena-native-context'
import { AthenaMEE } from './athena-mee'
import { AthenaSmoothing, type SmoothingDraft } from './athena-smoothing'
import { AthenaConvolution, type ConvolutionDraft } from './athena-convolution'
import { AthenaPointEdit, type PointEditDraft } from './athena-point-edit'
import { AthenaCalibration, type CalibrationDraft } from './athena-calibration'
import { AthenaAlignment, type AlignmentDraft } from './athena-alignment'
import { AthenaMergePlot } from './athena-merge-plot'
import { AthenaDiagnosticPlot } from './athena-diagnostic-plot'
import { AthenaMerge, type MergeDraft } from './athena-merge'
import { AthenaRebin } from './athena-rebin'
import { AthenaDispersive } from './athena-dispersive'
import { RebinDefaultsControls, useRebinDefaults } from './athena-rebin-defaults'
import "@/app/athena-controls.css"
import "@/app/athena-context-controls.css"

// hbar² / (2 m_e), in eV Å²; same constant as larch.xafs.xafsutils.KTOE.
const ktoe = 3.8099821109685847
const pickFields = {
  e0: { space: "E", relative: false },
  pre1: { space: "E", relative: true }, pre2: { space: "E", relative: true },
  norm1: { space: "E", relative: true }, norm2: { space: "E", relative: true },
  bkg_kmin: { space: "k", relative: false }, bkg_kmax: { space: "k", relative: false },
  kmin: { space: "k", relative: false }, kmax: { space: "k", relative: false },
  rmin: { space: "R", relative: false }, rmax: { space: "R", relative: false },
} as const
type PickKey = keyof typeof pickFields
type PlotPick = { key: PickKey; label: string; space: Space; relative: boolean; splineEnergy: boolean; e0: number | null; context: string }

const windows = ["hanning", "kaiser", "parzen", "welch", "gaussian", "sine"]
const energyPlotOptions = [
  { value: "mu", label: "μ(E) · raw" },
  { value: "norm", label: "μ(E) · normalized" },
  { value: "flat", label: "μ(E) · flattened" },
  { value: "dmude", label: "Derivative dμ/dE" },
  { value: "d2mude", label: "Second derivative d²μ/dE²" },
] as const
const parameterSections = {
  normalization: { label: "Normalization", keys: ["e0", "step", "pre1", "pre2", "norm1", "norm2", "nnorm", "flatten"] },
  background: { label: "Background removal", keys: ["rbkg", "bkg_kmin", "bkg_kmax", "bkg_kweight", "bkg_dk", "bkg_window", "nclamp", "clamp_lo", "clamp_hi", "fnorm"] },
  forward: { label: "Forward Fourier transform", keys: ["kmin", "kmax", "kweight", "dk", "window"] },
  reverse: { label: "Backward Fourier transform", keys: ["rmin", "rmax", "dr", "rwindow"] },
  grid: { label: "Transform grid", keys: ["nfft", "kstep"] },
} as const
type ParameterSection = "all" | keyof typeof parameterSections
type ParameterSelection = { section: ParameterSection } | { parameter: keyof Parameters }
type AutoApplyPlan = { token: number; projectId: string; sourceId: string; mode: "current" | "marked"; targetIds: string[]; status: "queued" | "failed" }
type ContextEvent = MouseEvent<HTMLElement> | ReactKeyboardEvent<HTMLElement>
type ContextState = { target: ContextTarget; projectId: string; version: number; groupId: string; anchor: { x: number; y: number }; trigger: HTMLElement }
const parameterLabels: Record<keyof Parameters, string> = {
  e0: "E₀", step: "Edge step", pre1: "Pre-edge start", pre2: "Pre-edge end", norm1: "Post-edge start", norm2: "Post-edge end", nnorm: "Polynomial degree", flatten: "Flatten normalized data",
  rbkg: "Rbkg", bkg_kmin: "Spline k min", bkg_kmax: "Spline k max", bkg_kweight: "Spline k-weight", bkg_dk: "Spline dk", bkg_window: "Spline window", nclamp: "Clamp points", clamp_lo: "Low clamp", clamp_hi: "High clamp", fnorm: "Energy-dependent normalization",
  kmin: "FT k min", kmax: "FT k max", kweight: "FT k-weight", dk: "FT dk", window: "FT window", rmin: "R min", rmax: "R max", dr: "dR", rwindow: "Backward FT window", nfft: "FFT points", kstep: "k step", energy_shift: "Energy shift",
}
function sameParameterValue(left: Parameters, right: Parameters, key: keyof Parameters) {
  // Older recipes omit fnorm; its processing default is false. Keep all other
  // scalar comparisons exact, including automatic (null) versus explicit values.
  const value = (recipe: Parameters) => key === "fnorm" && recipe[key] === undefined ? false : recipe[key]
  return value(left) === value(right)
}
function sameParameters(left: Parameters, right: Parameters) {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)] as (keyof Parameters)[])
  return [...keys].every(key => sameParameterValue(left, right, key))
}
function rebaseParameterDraft(draft: Parameters, before: Parameters, saved: Parameters) {
  const rebased = { ...saved }
  const values = rebased as unknown as Record<string, unknown>
  const keys = new Set([...Object.keys(draft), ...Object.keys(before), ...Object.keys(saved)] as (keyof Parameters)[])
  for (const key of keys) {
    if (sameParameterValue(draft, before, key)) continue
    if (key in draft) values[key] = draft[key]
    else delete values[key]
  }
  return sameParameters(rebased, saved) ? null : rebased
}
const parameterAutoApplyDelay = 400
function selectedParameterKeys(selection: ParameterSelection): readonly (keyof Parameters)[] {
  if ("parameter" in selection) return [selection.parameter]
  return selection.section === "all" ? Object.values(parameterSections).flatMap(section => [...section.keys]) : parameterSections[selection.section].keys
}
function matchingColumns(left: InspectionResponse, right: InspectionResponse) {
  return left.columns.length === right.columns.length && left.columns.every((column, index) => column.name === right.columns[index].name)
}
function hasCommonChi(groups: AthenaGroup[]) {
  let minimum = -Infinity, maximum = Infinity
  for (const group of groups) {
    const { k, chi } = group.result?.arrays ?? {}
    if (group.data_type === "xanes" || group.processing_error || !k || !chi || k.length < 2 || k.length !== chi.length) return false
    minimum = Math.max(minimum, k[0]); maximum = Math.min(maximum, k[k.length - 1])
  }
  return groups.length >= 2 && Number.isFinite(minimum) && Number.isFinite(maximum) && minimum < maximum
}
type ModalName = "special_plot" | "context_report" | "rename" | "import" | "open" | "journal" | "learn" | "calibrate" | "align" | "merge" | "merge_plot" | "diagnostic_plot" | "sum" | "difference" | "smooth" | "deglitch" | "truncate" | "rebin" | "convolve" | "deconvolve" | "self_absorption" | "dispersive" | "lcf" | "pca" | "peaks" | "metadata" | "multi_electron" | "log_ratio" | "copy_series" | "parameters" | "groups" | "e0" | "edge_policy" | "edge_identity" | "datatype" | "plugins" | "beamline" | "xdi" | "data_export" | "parameter_report" | null
const toolTitles: Record<string, string> = { calibrate: "Calibrate energy", align: "Align scans", merge: "Merge marked groups", sum: "Sum marked groups", difference: "Difference spectrum", smooth: "Smooth data", deglitch: "Deglitch data", truncate: "Truncate data", rebin: "Rebin data", convolve: "Convolve data", deconvolve: "Deconvolve data", self_absorption: "Fluorescence self-absorption", dispersive: "Dispersive energy calibration", lcf: "Linear combination fitting", pca: "Principal component analysis", peaks: "XANES peak fitting", metadata: "Group information" }
Object.assign(toolTitles, { multi_electron: "Multi-electron excitation", log_ratio: "Log-ratio & phase difference", copy_series: "Copy parameter series" })
const modalOperation: Partial<Record<Exclude<ModalName, null>, string>> = {
  import: "upload", journal: "project", calibrate: "set_e0", align: "align", merge: "merge", merge_plot: "plot",
  diagnostic_plot: "plot", sum: "sum", difference: "difference", smooth: "smooth", deglitch: "deglitch", truncate: "truncate",
  rebin: "rebin", convolve: "convolve", deconvolve: "convolve", self_absorption: "parameters", dispersive: "upload",
  lcf: "analyze", pca: "analyze", peaks: "analyze", metadata: "metadata", multi_electron: "multi_electron", log_ratio: "analyze",
  copy_series: "copy_series", parameters: "copy_parameters", groups: "metadata", e0: "set_e0", edge_policy: "upload",
  edge_identity: "metadata", datatype: "change_datatype", xdi: "xdi_comments", data_export: "export", parameter_report: "report",
  context_report: "report", special_plot: "plot", rename: "metadata",
}

function Modal({ title, children, close, wide = false }: { title: string; children: ReactNode; close: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => { ref.current?.showModal(); return () => ref.current?.close() }, [])
  return <dialog className={`ath-modal${wide ? " ath-modal-wide" : ""}`} ref={ref} onCancel={event => { event.preventDefault(); close() }} aria-label={title}><header><h2>{title}</h2><button onClick={close} aria-label="Close dialog"><X size={18} /></button></header>{children}</dialog>
}

function ContextLabel({ label, children, open }: { label: string; children: ReactNode; open: (event: ContextEvent) => void }) {
  return <span className="ath-context-label" onContextMenu={open}><span>{children}</span><button type="button" className="ath-context-trigger" aria-label={`Actions for ${label}`} aria-haspopup="menu" onClick={open} onKeyDown={event => {
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) open(event)
  }}>⋯</button></span>
}

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

function NumberField({ label, value, onChange, unit, effective, optional = false, step = "any", pick, showAutomaticValue = false, contextMenu, disabled = false, onEditingChange }: {
  label: string; value: number | null; onChange: (v: number | null) => void; unit?: string
  effective?: unknown; optional?: boolean; step?: string; pick?: ReactNode; showAutomaticValue?: boolean; disabled?: boolean; contextMenu?: (event: ContextEvent) => void
  onEditingChange?: (editing: boolean) => void
}) {
  const inputId = useId()
  const [emptyWhileEditing, setEmptyWhileEditing] = useState(false)
  const automaticValue = showAutomaticValue && optional && typeof effective === "number" && Number.isFinite(effective)
    ? Number(effective.toPrecision(10)) : null
  // Display the result without turning an automatic (null) recipe into an
  // explicit override. Clearing stays blank until blur so typing still works.
  const displayedValue = value ?? (!emptyWhileEditing ? automaticValue : null) ?? ""
  const input = <label className="ath-field" htmlFor={inputId}>{contextMenu ? <ContextLabel label={label} open={contextMenu}>{label}{unit && <small>{unit}</small>}</ContextLabel> : <span>{label}{unit && <small>{unit}</small>}</span>}<input id={inputId} disabled={disabled} aria-label={`${label}${unit ? ` ${unit}` : ""}`} type="number" step={step} value={displayedValue} placeholder={optional ? "Auto" : ""} onFocus={() => onEditingChange?.(true)} onChange={e => {
    setEmptyWhileEditing(e.target.value === "")
    onChange(e.target.value === "" ? null : Number(e.target.value))
  }} onBlur={() => { setEmptyWhileEditing(false); onEditingChange?.(false) }} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur() } }} />{optional && value === null && typeof effective === "number" && <em>{automaticValue !== null ? "Automatic" : `Auto: ${effective.toFixed(3).replace(/\.?0+$/, "")}`}</em>}{optional && value !== null && typeof effective === 'number' && value !== effective && <em>Used in saved result: {Number(effective.toPrecision(10))}</em>}</label>
  return pick ? <div className="ath-pick-field">{input}{pick}</div> : input
}

const e0Methods: Record<E0Method, { label: string; hint: string }> = {
  derivative: { label: "Derivative maximum", hint: "Locate the absorption edge from the maximum first derivative of the saved spectrum." },
  atomic: { label: "Tabulated atomic energy", hint: "Use the tabulated energy for an element and edge. Leave both fields blank to infer both separately for each group." },
  fraction: { label: "Fraction of edge step", hint: "Find the selected fraction of the normalized edge step, repeating normalization for up to 5 iterations. Use a fraction greater than 0 and at most 1 (the full edge step)." },
  zero_crossing: { label: "Second-derivative zero crossing", hint: "Find the second-derivative zero crossing nearest the initial E₀." },
  white_line: { label: "White-line peak", hint: "Refine the first peak after the initial E₀ using the locally interpolated, flattened spectrum." },
  manual: { label: "Manual energy", hint: "Set a positive E₀ in eV on the shifted energy axis. The same value is used for every selected group." },
}
function supportsE0(group: AthenaGroup) {
  return !group.frozen && group.data_type !== "chi" && !isDifferenceGroup(group)
}
function E0Dialog({ project, active, busy, error, clearError, selectGroup, close, apply }: {
  project: AthenaProject | null; active?: AthenaGroup; busy: boolean; error: string
  clearError: () => void; selectGroup: (id: string) => void; close: () => void
  apply: (ids: string[], options: E0Options) => Promise<AthenaProject | undefined>
}) {
  const [method, setMethod] = useState<E0Method>("derivative")
  const [scope, setScope] = useState<"current" | "marked" | "all">("current")
  const [fraction, setFraction] = useState("0.5")
  const [value, setValue] = useState(String(active?.parameters.e0 ?? active?.result?.effective.e0 ?? ""))
  const [element, setElement] = useState("")
  const [edge, setEdge] = useState("")
  const [validation, setValidation] = useState("")
  const [completed, setCompleted] = useState<AthenaProject | null>(null)
  const pending = useRef(false)
  const targets = scope === "all" ? project?.groups ?? [] : scope === "marked" ? project?.groups.filter(g => g.marked) ?? [] : active ? [active] : []
  const supported = targets.filter(supportsE0)
  function edit() { setValidation(""); clearError(); setCompleted(null) }
  function dismiss() { if (!busy && !pending.current) close() }
  async function submit() {
    if (busy || pending.current || !supported.length) return
    let options: E0Options
    if (method === "fraction") {
      const number = Number(fraction)
      if (!fraction.trim() || !Number.isFinite(number) || number <= 0 || number > 1) { setValidation("Enter a finite fraction greater than 0 and at most 1."); return }
      options = { method, fraction: number }
    } else if (method === "manual") {
      const number = Number(value)
      if (!value.trim() || !Number.isFinite(number) || number <= 0) { setValidation("Enter a finite, positive manual E₀ in eV."); return }
      options = { method, value: number }
    } else if (method === "atomic") {
      const absorber = element.trim(), shell = edge.trim()
      if (!!absorber !== !!shell) { setValidation("Supply both element and edge, or leave both blank to infer them per group."); return }
      options = absorber ? { method, element: absorber, edge: shell } : { method }
    } else options = { method }
    edit(); pending.current = true
    try { setCompleted(await apply(targets.map(g => g.id), options) ?? null) }
    finally { pending.current = false }
  }
  const report = completed?.last_operation
  return <Modal title="Select E₀" close={dismiss}><form className="ath-modal-body" noValidate onSubmit={event => { event.preventDefault(); void submit() }}>
    <p className="ath-hint">Uses saved spectra and processing recipes. Apply E₀ replaces E₀ for accepted groups; main-pane parameter edits process automatically. Energy shifts are preserved, including linked reference shifts.</p>
    <fieldset className="ath-e0-fields" disabled={busy}>
      <div className="ath-fields">
        <label className="ath-field"><span>E₀ targets</span><select value={scope} onChange={event => { edit(); setScope(event.target.value as typeof scope) }}><option value="current">Current group</option><option value="marked">Marked groups ({project?.groups.filter(g => g.marked).length ?? 0})</option><option value="all">All groups ({project?.groups.length ?? 0})</option></select></label>
        {scope === "current" && <label className="ath-field"><span>Current group</span><select value={active?.id ?? ""} disabled={!project?.groups.length} onChange={event => { edit(); selectGroup(event.target.value) }}>{!active && <option value="">No groups</option>}{project?.groups.map(g => <option key={g.id} value={g.id}>{g.label}</option>)}</select></label>}
        <label className="ath-field"><span>E₀ method</span><select value={method} aria-describedby="ath-e0-method-hint" onChange={event => { edit(); setMethod(event.target.value as E0Method) }}>{Object.entries(e0Methods).map(([key, item]) => <option key={key} value={key}>{item.label}</option>)}</select></label>
        {method === "fraction" && <label className="ath-field"><span>Edge-step fraction</span><input type="number" step="any" min="0" max="1" value={fraction} onChange={event => { edit(); setFraction(event.target.value) }} /></label>}
        {method === "manual" && <label className="ath-field"><span>Manual E₀ <small>eV</small></span><input type="number" step="any" min="0" value={value} onChange={event => { edit(); setValue(event.target.value) }} /></label>}
        {method === "atomic" && <><label className="ath-field"><span>Absorbing element (optional)</span><input value={element} placeholder="Infer, e.g. Cu" maxLength={32} onChange={event => { edit(); setElement(event.target.value) }} /></label><label className="ath-field"><span>Absorption edge (optional)</span><input value={edge} placeholder="Infer, e.g. K" maxLength={3} onChange={event => { edit(); setEdge(event.target.value) }} /></label></>}
      </div>
    </fieldset>
    <p id="ath-e0-method-hint" className="ath-hint">{e0Methods[method].hint}</p>
    <p className="ath-hint">Frozen groups, groups with frozen background consumers, χ(k), and signed difference spectra are skipped. All targets include groups hidden by search. Switching the current scan resets method inputs.</p>
    <p>{targets.length} target{targets.length === 1 ? "" : "s"} selected · {supported.length} supported and unfrozen before dependency checks.</p>
    {!!targets.length && <details><summary>Selected groups</summary><ul>{targets.map(g => <li key={g.id}>{g.label}{g.frozen ? " · frozen" : !supportsE0(g) ? " · unsupported spectrum" : ""}</li>)}</ul></details>}
    {!supported.length && <p className="ath-hint">No supported, unfrozen groups in this selection. Choose another scope, mark absorption spectra, or unfreeze a group.</p>}
    {(validation || error) && <div className="ath-error" role="alert">{validation || error}</div>}
    {report?.action === "set_e0" && <section className="ath-e0-report" aria-label="E₀ selection results" aria-live="polite"><h3>Accepted E₀ results</h3>
      <ul>{report.e0_results?.map(result => <li key={result.group_id}><strong>{completed?.groups.find(g => g.id === result.group_id)?.label ?? result.group_id}</strong>: <output>{result.e0.toFixed(3)} eV</output><span> · {e0Methods[result.method].label}</span>
        {result.element && result.edge && <span> · {result.element} {result.edge}{result.tabulated_e0 != null && ` (${result.tabulated_e0} eV tabulated)`}</span>}
        {result.method === "fraction" && <span> · {result.iterations} iteration{result.iterations === 1 ? "" : "s"} · {result.converged ? "converged" : "not converged"}</span>}
        {result.warnings.map((warning, index) => <p className="ath-warning" key={index}>{warning}</p>)}</li>)}</ul>
      {report.skipped_group_ids.length > 0 && <><h4>Skipped groups</h4><ul>{report.skipped_group_ids.map(id => <li key={id}><strong>{completed?.groups.find(g => g.id === id)?.label ?? id}</strong>: {report.skipped_reasons?.[id] ?? "Skipped by processing guards."}</li>)}</ul></>}
    </section>}
    <div className="ath-modal-actions"><button type="button" disabled={busy} onClick={dismiss}>{completed ? "Close" : "Cancel"}</button><button type="submit" className="ath-primary" disabled={busy || !supported.length}>{busy ? "Applying E₀…" : "Apply E₀"}</button></div>
  </form></Modal>
}

type ImportFile = File | { name: string; inspection: InspectionResponse }
function isProjectCandidate(file: ImportFile): file is File { return !('inspection' in file) && isAthenaProjectFile(file) }

export function AthenaWorkbench({ session = { mode: "legacy" }, onAuthorizationFailure }: {
  session?: AthenaSession
  onAuthorizationFailure?: () => void
}) {
  const content = <AthenaWorkbenchContent session={session} />
  return session.mode === "integration" ? <AthenaProvider session={session} onAuthorizationFailure={onAuthorizationFailure}>{content}</AthenaProvider> : content
}

function AthenaWorkbenchContent({ session }: { session: AthenaSession }) {
  const athenaApi = useAthenaApi()
  const transport = useAthenaTransport()
  const integrated = session.mode === "integration"
  const can = (operation: string) => !integrated || session.allowedOperations.includes(operation)
  const canCommand = (action: string) => can(action)
  const canOpen = (name: ModalName) => name === null || !modalOperation[name] || can(modalOperation[name]!)
  const [smoothingDraft, setSmoothingDraft] = useState<SmoothingDraft>()
  const [convolutionDraft, setConvolutionDraft] = useState<ConvolutionDraft>()
  const [pointEditDraft, setPointEditDraft] = useState<PointEditDraft>()
  const [calibrationDraft, setCalibrationDraft] = useState<CalibrationDraft>()
  const [alignmentDraft, setAlignmentDraft] = useState<AlignmentDraft>()
  const [mergeDraft, setMergeDraft] = useState<MergeDraft>()
  const [mergeInitialArray, setMergeInitialArray] = useState<'mu'|'norm'|'chi'>()
  const rebinDefaults = useRebinDefaults()
  const rebinGrid = { ...defaultRebin, ...rebinDefaults.grid, enabled: true }
  const { policy: edgePolicy, update: updateEdgePolicy, storageError: edgePolicyStorageError } = useEdgePolicy()
  const [batchEdgePolicy, setBatchEdgePolicy] = useState<EdgePolicy | null>(null)
  const inspectionReuseRef = useRef<InspectionResponse | undefined>(undefined)
  const [project, setProject] = useState<AthenaProject | null>(null)
  const projectRef = useRef<AthenaProject | null>(null)
  const skippedCount = useRef(0)
  const preferenceWarnings = useRef<string[]>([])
  const init = useRef(false)
  const [activeId, setActiveId] = useState("")
  const [busy, setBusy] = useState("")
  const [error, setError] = useState("")
  const [message, setMessage] = useState("Ready to begin")
  const [modal, setModal] = useState<ModalName>(null)
  const [reportScope, setReportScope] = useState<'all' | 'marked'>('all')
  const [menu, setMenu] = useState("")
  const [specialPlot, setSpecialPlot] = useState<AthenaSpecialPlotKind>('normderiv')
  const [contextMenu, setContextMenu] = useState<ContextState | null>(null)
  const [contextReport, setContextReport] = useState<{ kind: ContextReportKind; title: string; project: AthenaProject; groups: AthenaGroup[] } | null>(null)
  const [registryPending, setRegistryPending] = useState(false)
  const registryReturn = useRef<ModalName>(null)
  const [search, setSearch] = useState("")
  const [space, setSpace] = useState<Space>("E")
  const [energyMode, setEnergyMode] = useState("norm")
  const [component, setComponent] = useState("mag")
  const [plotScope, setPlotScope] = useState<"selected" | "current">("selected")
  const [background, setBackground] = useState(false)
  const [preEdge, setPreEdge] = useState(false)
  const [postEdge, setPostEdge] = useState(false)
  const [showWindow, setShowWindow] = useState(false)
  const [showLegend, setShowLegend] = useState(true)
  const [viewerKWeight, setViewerKWeight] = useState<number | null>(null)
  const [viewerColormap, setViewerColormap] = useState<AthenaColormap>(DEFAULT_COLORMAP)
  const [offset, setOffset] = useState(0)
  const [range, setRange] = useState<[number | null, number | null]>([null, null])
  const [drafts, setDrafts] = useState<Record<string, Parameters>>({})
  const [autoApplyPlans, setAutoApplyPlans] = useState<Record<string, AutoApplyPlan>>({})
  const autoApplySerial = useRef(0)
  const autoApplyInFlight = useRef<number | null>(null)
  const [parameterFieldEditing, setParameterFieldEditing] = useState(false)
  const [analysis, setAnalysis] = useState<Analysis | null>(null)
  const [analysisVisible, setAnalysisVisible] = useState(false)
  const [inspection, setInspection] = useState<InspectionResponse | null>(null)
  const [files, setFiles] = useState<ImportFile[]>([])
  const [scanSelection, setScanSelection] = useState<ScanInspectionResponse | null>(null)
  const [archiveSelection, setArchiveSelection] = useState<ArchiveInspection | null>(null)
  const [projectFiles, setProjectFiles] = useState<File[]>([])
  const [projectPreview, setProjectPreview] = useState<ProjectPreview | null>(null)
  const [reuseMapping, setReuseMapping] = useState(true)
  const [mappingState, setMapping] = useState<ColumnMapping>({ energy_column: "", numerator: [] as string[], denominator: "", mode: "mu", units: "eV", data_type: "mu", reference_numerator: "", reference_denominator: "", sort: false })
  const mapping: ColumnMapping = { ...mappingState, rebin: { ...defaultRebin, ...mappingState.rebin, ...rebinDefaults.grid } }
  function setImportMapping(update: SetStateAction<ColumnMapping>) {
    const next = typeof update === 'function' ? update(mapping) : update
    setMapping(next)
    if (next.rebin) rebinDefaults.edit(next.rebin)
  }
  const [recent, setRecent] = useState<{ id: string; name: string; updated: string; count: number }[]>([])
  const [options, setOptions] = useState<Record<string, string | number | boolean>>({})
  const [journal, setJournal] = useState("")
  const [projectName, setProjectName] = useState("")
  const [applyMarked, setApplyMarked] = useState(false)
  const [parameterScope, setParameterScope] = useState<ParameterSection | "single">("all")
  const [parameterKey, setParameterKey] = useState<keyof Parameters>("rbkg")
  const [parameterTarget, setParameterTarget] = useState<"current" | "marked" | "all">("marked")
  const [fitSelection, setFitSelection] = useState<string[]>([])
  const [peaks, setPeaks] = useState<{center: number; sigma: number; amplitude: number; kind: string}[]>([])
  const [combineWeights, setCombineWeights] = useState<Record<string, number | null>>({})
  const [combineArray, setCombineArray] = useState<"" | "mu" | "norm" | "chi">("")
  const [pick, setPick] = useState<PlotPick | null>(null)
  const pickRef = useRef<PlotPick | null>(null)
  const [groupPattern, setGroupPattern] = useState("")
  const [ignoreCase, setIgnoreCase] = useState(false)
  const [freezeTarget, setFreezeTarget] = useState<"current" | "marked" | "all" | "matching">("marked")
  const [standardDrafts, setStandardDrafts] = useState<Record<string, string>>({})
  const active = project?.groups.find(g => g.id === activeId) ?? project?.groups[0]
  const marked = project?.groups.filter(g => g.marked) ?? []
  const plotEnergyMode = active?.data_type === "detector" ? "mu" : energyMode
  const parameters = active && (drafts[active.id] ?? active.parameters)
  const dirty = active && parameters && !sameParameters(parameters, active.parameters)
  const activeAutoApplyPlan = active ? autoApplyPlans[active.id] : undefined
  const parameterUpdatePending = Object.keys(autoApplyPlans).length > 0
  const parameterUpdateRunning = Object.values(autoApplyPlans).some(plan => plan.status === "queued")
  const selectedGroups = plotScope === "selected" ? marked : active ? [active] : []
  const weightedPlot = useAthenaPlotWeight({ projectId: project?.id, version: project?.version, groups: selectedGroups,
    kWeight: viewerKWeight, space: analysisVisible ? "E" : space, pending: parameterUpdatePending || !!dirty })
  const displayedSpectrumGroups = weightedPlot.loading || weightedPlot.error || (analysis && analysisVisible) ? []
    : weightedPlot.groups.filter(group => spectrumTraceCoordinates(group, space, plotEnergyMode, component, viewerKWeight))
  const spectrumColors = new Map(displayedSpectrumGroups.map((group, index) =>
    [group.id, spectrumColor(viewerColormap, index, displayedSpectrumGroups.length)]))
  const savedPlotWeight = (group: AthenaGroup) => {
    const effective = group.result?.effective.kweight
    return typeof effective === "number" && Number.isFinite(effective) ? effective : group.parameters.kweight
  }
  const automaticWeights = [...new Set(selectedGroups.map(savedPlotWeight))]
  const automaticWeightLabel = automaticWeights.length > 1 ? "per spectrum" : automaticWeights[0] ?? (active ? savedPlotWeight(active) : 2)
  const overlayArrays = space === "E" && plotEnergyMode === "mu" && !analysisVisible && active &&
    !["detector", "chi"].includes(active.data_type) && !isDifferenceGroup(active) &&
    selectedGroups.some(group => group.id === active.id) ? active.result?.arrays : undefined
  const hasOverlay = (key: string) => !!overlayArrays?.energy?.length &&
    overlayArrays.mu?.length === overlayArrays.energy.length && overlayArrays[key]?.length === overlayArrays.energy.length
  const canShowPreEdge = plotScope === "current" && hasOverlay("pre_edge")
  const canShowPostEdge = plotScope === "current" && hasOverlay("post_edge")
  const canShowBackground = hasOverlay("bkg")
  const automaticRange = automaticPlotRange(weightedPlot.groups, space, plotEnergyMode, component, analysis, analysisVisible, viewerKWeight)
  const parameterTargets = parameterTarget === "all" ? project?.groups ?? [] : parameterTarget === "marked" ? marked : active ? [active] : []
  const backgroundStandard = active ? standardDrafts[active.id] ?? active.background_standard_id ?? "" : ""
  const backgroundStandards = project?.groups.filter(g => g.id !== active?.id && !!g.result?.arrays.chi?.length) ?? []
  const combining = modal === "sum"
  const canCombineMu = marked.length >= 2 && marked.every(g => !["chi", "detector"].includes(g.data_type))
  const canCombineNorm = canCombineMu && marked.every(g => !g.processing_error && !!g.result?.arrays.norm?.length)
  const canCombineChi = hasCommonChi(marked)
  const combinationReady = marked.length >= 2 && (combineArray === "chi" ? canCombineChi : combineArray === "norm" ? canCombineNorm : combineArray === "mu" ? canCombineMu : true)
  const referenceE0 = parameters?.e0 ?? active?.result?.effective.e0
  const draftE0 = typeof referenceE0 === "number" && Number.isFinite(referenceE0) ? referenceE0 : null
  function pickContext(plotSpace = space, showAnalysis = analysisVisible) {
    return JSON.stringify([project?.id, project?.version, active?.id, active?.frozen, plotSpace, showAnalysis, energyMode, component, plotScope, viewerKWeight, selectedGroups.map(g => g.id), modal, busy, parameters])
  }
  const context = pickContext()
  const contextRef = useRef(context)
  contextRef.current = context
  useEffect(() => {
    const mergeShortcut = (event:KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || !event.shiftKey || event.altKey || modal || busy || !project || !canOpen("merge")) return
      if ((event.target as HTMLElement)?.closest('input,textarea,select,[contenteditable="true"]')) return
      const array = ({m:'mu',n:'norm',c:'chi'} as const)[event.key.toLowerCase() as 'm'|'n'|'c']
      if (!array) return
      event.preventDefault();cancelPick();setMenu('');setError('');setMergeInitialArray(array);setModal('merge')
    }
    document.addEventListener('keydown',mergeShortcut)
    return () => document.removeEventListener('keydown',mergeShortcut)
  },[modal,busy,project]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    // A newer click can arm a pick before this render's passive effect runs.
    // Invalidate only the pick captured with this context, never that newer arm.
    if (pick && pickRef.current === pick && pick.context !== context) cancelPick()
  }, [context, pick])
  useEffect(() => {
    if (!pick) return
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") cancelPick() }
    document.addEventListener("keydown", escape)
    return () => document.removeEventListener("keydown", escape)
  }, [pick])

  let patternError = ""
  let matchingGroups: AthenaGroup[] = []
  if (groupPattern) {
    try {
      const regex = new RegExp(groupPattern, ignoreCase ? "i" : "")
      matchingGroups = project?.groups.filter(g => regex.test(g.label)) ?? []
    } catch { patternError = "Invalid JavaScript regular expression. Correct the pattern to continue." }
  }
  const freezeTargets = freezeTarget === "all" ? project?.groups ?? [] : freezeTarget === "marked" ? marked : freezeTarget === "matching" ? matchingGroups : active ? [active] : []

  function cancelPick() { pickRef.current = null; setPick(null) }
  function parameterActionBlocked() {
    if (!parameterUpdatePending) return false
    const failed = Object.values(autoApplyPlans).some(plan => plan.status === "failed")
    setMessage(failed ? "Retry or discard the failed parameter changes before continuing" : "Waiting for automatic parameter processing")
    return true
  }
  function openEdgeIdentity() {
    if (!canOpen("edge_identity") || !active || active.frozen || busy || parameterActionBlocked()) return
    cancelPick(); setMenu(""); setError(""); setModal("edge_identity")
  }
  function stopEdgePolicy() { updateEdgePolicy(null); setMenu(""); setMessage("Element and edge enforcement stopped · future batches") }
  function armPick(key: PickKey, label: string, splineEnergy = false) {
    if (!active || active.frozen || busy) return
    if (pick?.key === key && pick.splineEnergy === splineEnergy) { cancelPick(); return }
    const { space: nativeSpace, relative: nativeRelative } = pickFields[key]
    const pickSpace = splineEnergy ? "E" : nativeSpace
    const relative = splineEnergy || nativeRelative
    if (relative && draftE0 === null) { setError("Set E₀ or reprocess the spectrum before picking a relative energy."); return }
    const next: PlotPick = { key, label, space: pickSpace, relative, splineEnergy, e0: draftE0, context: pickContext(pickSpace, false) }
    setError(""); setSpace(pickSpace); setAnalysisVisible(false); setRange([null, null])
    pickRef.current = next; setPick(next)
  }
  function pluck(x: number, plotSpace: Space, armed: PlotPick | null) {
    // Ignore queued Plotly clicks after cancellation, a new arm, or a context change.
    if (!armed || pickRef.current !== armed || contextRef.current !== armed.context || plotSpace !== armed.space || !Number.isFinite(x)) return
    const value = armed.relative ? x - armed.e0! : x
    if ((armed.splineEnergy || armed.space !== "E") && value < 0) {
      setError(armed.splineEnergy ? "The spline energy must be at or above E₀. Pick again or type a nonnegative relative energy." : "Pick a nonnegative transform limit, or type the value.")
      return
    }
    cancelPick(); setError("")
    changeParameter(armed.key, armed.splineEnergy ? Math.sqrt(value / ktoe) : value)
    setMessage(`${armed.label} updated · processing automatically`)
  }
  function pickButton(key: PickKey, label: string, splineEnergy = false) {
    const requiredSpace = splineEnergy ? "E" : pickFields[key].space
    return <button type="button" className="ath-pick-button" aria-label={`Pick ${label} from plot`} aria-pressed={pick?.key === key && pick.splineEnergy === splineEnergy} title={`Pick x from the ${requiredSpace} plot, or type the value`} disabled={active?.frozen || (requiredSpace === "E" && active?.data_type === "chi")} onClick={() => armPick(key, label, splineEnergy)}>⌖</button>
  }
  function setGroupFlags(field: "marked" | "frozen", value: boolean, targets: AthenaGroup[]) {
    if (busy || !targets.length) return
    act("metadata", targets.map(g => g.id), { [field]: value })
  }
  function invertMarks() {
    if (busy || !project?.groups.length) return
    act("selection", project.groups.map(g => g.id), { field: "marked", mode: "invert" })
  }

  function showContext(event: ContextEvent, target: ContextTarget) {
    event.preventDefault(); event.stopPropagation()
    if (!can("metadata") || !project || !active || busy || registryPending || parameterActionBlocked()) return
    const focusedButton = event.target instanceof HTMLElement ? event.target.closest('button') : null
    const trigger = focusedButton && event.currentTarget.contains(focusedButton) ? focusedButton : event.currentTarget.matches('button') ? event.currentTarget : event.currentTarget.querySelector<HTMLElement>('button') ?? event.currentTarget
    const bounds = trigger.getBoundingClientRect()
    const pointer = event.type === 'contextmenu' && 'clientX' in event && (event.clientX || event.clientY)
    cancelPick(); setMenu('')
    setContextMenu({ target, projectId: project.id, version: project.version, groupId: active.id, trigger,
      anchor: pointer ? { x: event.clientX, y: event.clientY } : { x: bounds.left, y: bounds.bottom } })
  }
  useEffect(() => {
    if (contextMenu && (busy || menu || (modal && modal !== 'metadata' && modal !== 'peaks') || contextMenu.projectId !== project?.id || contextMenu.version !== project?.version || contextMenu.groupId !== active?.id)) setContextMenu(null)
  }, [busy, menu, modal, project?.id, project?.version, active?.id, contextMenu])
  function report(kind: ContextReportKind, title: string, groups = active ? [active] : []) {
    if (!can("report") || !project || parameterActionBlocked()) return
    cancelPick(); setMenu(''); setError(''); setContextReport({ kind, title, project, groups }); setModal('context_report')
  }
  function contextKeys(section: NativeSection): (keyof Parameters)[] {
    const backgroundKeys: (keyof Parameters)[] = ['e0', 'rbkg', 'flatten', 'bkg_kweight', 'step', 'nnorm', 'pre1', 'pre2', 'norm1', 'norm2', 'bkg_kmin', 'bkg_kmax', 'clamp_lo', 'clamp_hi']
    if (section === 'background') return backgroundKeys
    if (section === 'forward') return [...parameterSections.forward.keys]
    if (section === 'reverse') return [...parameterSections.reverse.keys]
    return section === 'all' ? [...backgroundKeys, ...parameterSections.forward.keys, ...parameterSections.reverse.keys] : []
  }
  async function contextParameterAction(mode: 'copy' | 'reset', targets: AthenaGroup[], choice: { section: NativeSection } | { field: NativeField }) {
    if (!project || !active || !parameters || busy || parameterActionBlocked()) return
    const sourceId = active.id
    const destinations = mode === 'copy' ? targets.filter(g => g.id !== sourceId) : targets
    if (!destinations.some(g => !g.frozen)) return
    const field = 'field' in choice ? choice.field : null
    const metadataFields = ['element', 'edge', 'importance', 'multiplier', 'offset', 'fix_step']
    const nativeSection = 'section' in choice
    const useNative = nativeSection || (field !== null && metadataFields.includes(field))
    const keys = nativeSection ? contextKeys(choice.section) : field === 'background_standard_id' ? [] : field && !metadataFields.includes(field) ? nativeRanges[field] ?? [field as keyof Parameters] : []
    await task(mode === 'copy' ? 'Copying current values' : 'Restoring defaults', async () => {
      const before = projectRef.current!
      const next = await command(useNative ? 'context_parameters' : mode === 'copy' ? 'copy_parameters' : 'reset_parameters', destinations.map(g => g.id), useNative ? {
        mode, ...choice, ...(mode === "copy" ? { source_id: sourceId, values: parameters, ...(modal === "metadata" ? { metadata: { importance: options.importance, multiplier: options.multiplier, offset: options.offset } } : {}) } : {}),
      } : {
        parameters: field === 'background_standard_id' ? ['background_standard_id'] : keys,
        ...(mode === 'copy' ? { source_id: sourceId, values: { ...contextValues(active, parameters), background_standard_id: backgroundStandard || null } } : {}),
      })
      const skipped = new Set(next.last_operation?.skipped_group_ids ?? [])
      setDrafts(d => {
        const updated = { ...d }
        for (const g of destinations) {
          if (skipped.has(g.id) || !updated[g.id]) continue
          const saved = next.groups.find(item => item.id === g.id)?.parameters
          if (!saved) continue
          const appliedKeys = field === 'fix_step' ? ['step'] as const : keys
          updated[g.id] = { ...updated[g.id], ...Object.fromEntries(appliedKeys.map(key => [key, saved[key]])) }
          if (sameParameters(updated[g.id], saved)) delete updated[g.id]
        }
        return updated
      })
      if (field === 'background_standard_id' || (nativeSection && ['background', 'all'].includes(choice.section))) {
        setStandardDrafts(d => Object.fromEntries(Object.entries(d).filter(([id]) => !destinations.some(g => g.id === id && !skipped.has(id)))))
      }
      if (modal === 'metadata' && destinations.some(g => g.id === sourceId) && !skipped.has(sourceId)) {
        const fields = nativeSection ? choice.section === 'plot' ? ['multiplier', 'offset'] : choice.section === 'group' ? ['importance'] : choice.section === 'all' ? ['importance', 'multiplier', 'offset'] : [] : field ? [field] : []
        refreshContextMetadata(next, fields)
      }
      if (next.version === before.version) throw new Error('The parameter update could not be confirmed. Reload the workspace.')
    })
  }
  const sectionNames: Record<NativeSection, string> = { all: 'all parameters', group: 'group parameters', background: 'normalization and background parameters', forward: 'forward transform parameters', reverse: 'backward transform parameters', plot: 'plot parameters' }
  function fieldName(field: NativeField): string {
    return ({ spline_energy: 'Spline energy range', background_standard_id: 'Background removal standard', element: 'Element', edge: 'Edge', importance: 'Importance', multiplier: 'Plot multiplier', offset: 'Vertical offset', fix_step: 'Fix edge step' } as Record<string, string>)[field] ?? parameterLabels[field as keyof Parameters]
  }
  function contextItems(target: ContextTarget): ContextMenuItem[] {
    if (!project || !active || !parameters) return []
    const current = active, all = project.groups
    const item = (id: string, label: string, onSelect: () => void, extra: Partial<ContextMenuItem> = {}): ContextMenuItem => ({ id, label, onSelect, ...extra })
    if (target.kind === 'peak') return ['gaussian', 'lorentzian', 'voigt'].filter(kind => kind !== peaks[target.index]?.kind).map(kind => item(kind, kind[0].toUpperCase() + kind.slice(1), () => setPeaks(current => current.map((peak, index) => index === target.index ? { ...peak, kind } : peak))))
    const copy = (targets: AthenaGroup[], choice: { section: NativeSection } | { field: NativeField }) => { void contextParameterAction('copy', targets, choice) }
    if (target.kind === 'group') return [
      item('target', `Current group: ${current.label}`, () => {}, { disabled: true }),
      item('rename', 'Rename current group…', () => openTool('rename')),
      item('duplicate', 'Copy current group', () => act('duplicate', [current.id])),
      item('datatype', 'Change data type…', () => openTool('datatype')),
      item('copy-all', "Set all groups’ values to the current", () => copy(all, { section: 'all' }), { separatorBefore: true, disabled: !all.some(g => g.id !== current.id && !g.frozen) }),
      item('copy-marked', "Set marked groups’ values to the current", () => copy(marked, { section: 'all' }), { disabled: !marked.some(g => g.id !== current.id && !g.frozen) }),
      item('about', 'About current group', () => report('about', 'About current group'), { separatorBefore: true }),
      item('yaml', 'Show YAML for current group', () => report('yaml', 'Group parameters and arrays')),
      item('source', 'Show the text of the current group’s data file', () => report('source', 'Original data file'), { disabled: !((current.source.mapping as { upload_id?: string } | undefined)?.upload_id) }),
      ...([['all', all], ['marked', marked], ['this', [current]]] as const).map(([scope, groups]) => item(`noise-${scope}`, `Show measurement uncertainties · ${scope === 'this' ? 'this group' : `${scope} groups`}`, () => report('measurement_uncertainty', 'Measurement uncertainties', [...groups]), { separatorBefore: scope === 'all', disabled: !groups.length })),
      item('remove', 'Remove current group', () => act('delete', [current.id]), { separatorBefore: true, danger: true }),
      item('remove-marked', 'Remove marked groups', () => act('delete', marked.map(g => g.id)), { disabled: !marked.length, danger: true }),
      ...(!integrated ? [item('close-project', 'Close project', () => { void task('Closing project', async () => { accept(await athenaApi<AthenaProject>('/projects', {})); setDrafts({}); setContextReport(null) }) }, { disabled: !!busy || parameterUpdatePending })] : []),
    ]
    const choice = target.kind === 'section' ? { section: target.section } : { field: target.field }
    const label = target.kind === 'section' ? sectionNames[target.section] : fieldName(target.field)
    const field = target.kind === 'field' ? target.field : null
    const output: ContextMenuItem[] = [
      item('target', `${current.label} · ${label}`, () => {}, { disabled: true }),
      item('copy-all', `Set all groups to current ${label}`, () => copy(all, choice), { disabled: !all.some(g => g.id !== current.id && !g.frozen) }),
      item('copy-marked', `Set marked groups to current ${label}`, () => copy(marked, choice), { disabled: !marked.some(g => g.id !== current.id && !g.frozen) }),
    ]
    if (!field || !['step', 'flatten', 'fnorm', 'fix_step'].includes(field)) output.push(item('default', `Restore default ${label}`, () => { void contextParameterAction('reset', [current], choice) }, { separatorBefore: true, disabled: current.frozen }))
    if (field === 'e0') output.push(...([['derivative', 'Larch’s default'], ['atomic', 'the tabulated value'], ['fraction', 'a fraction of the edge step'], ['zero_crossing', 'the second-derivative zero crossing'], ['white_line', 'the white-line peak']] as const).map(([method, text], i) => item(`e0-${method}`, `Set E₀ to ${text}`, () => { void applySelectedE0([current.id], { method } as E0Options) }, { separatorBefore: i === 0, disabled: !supportsE0(current) || current.data_type === 'detector' })))
    if (field === 'kmin' || field === 'kmax') output.push(item('recommended-kmax', 'Set kmax to Larch’s suggestion', () => { void recommendedKmax(current) }, { separatorBefore: true, disabled: current.frozen || ['detector', 'xanes'].includes(current.data_type) }))
    if (field === 'energy_shift') output.push(
      item('reference', 'Identify this group’s reference', () => { const reference = all.find(g => g.id === current.reference_id), sample = all.find(g => g.reference_id === current.id); setMessage(reference ? `${reference.label} is the reference for ${current.label}` : sample ? `${current.label} is the reference for ${sample.label}` : `${current.label} has no linked reference`) }, { separatorBefore: true }),
      item('untie', 'Untie this group from its reference', () => act('untie_reference', [current.id])),
      item('explain-shift', 'Explain energy shift', () => setMessage('Energy shift is added to measured energy: positive values move the spectrum to higher energy. Linked sample/reference groups shift together. A shift-only edit also moves an explicit E₀ by the same amount.')),
      ...([['this', [current]], ['all', all], ['marked', marked]] as const).map(([scope, groups]) => item(`shifts-${scope}`, `Show energy shifts · ${scope === 'this' ? 'this group' : `${scope} groups`}`, () => report('shifts', 'Energy shifts', [...groups]), { separatorBefore: scope === 'this', disabled: !groups.length })),
    )
    if (field === 'step') output.push(item('steps-all', 'Show edge steps of all groups', () => report('steps', 'Edge steps', all), { separatorBefore: true }), item('steps-marked', 'Show edge steps of marked groups', () => report('steps', 'Edge steps', marked), { disabled: !marked.length }), item('step-error', 'Approximate uncertainty in edge step', () => report('edge_step_uncertainty', 'Edge-step uncertainty'), { separatorBefore: true, disabled: ['chi', 'detector'].includes(current.data_type) || isDifferenceGroup(current) }))
    if (field === 'importance') output.push(...([['all', all], ['marked', marked]] as const).map(([scope, groups]) => item(`importance-one-${scope}`, `Set Importance to 1 for ${scope} groups`, () => { void contextMetadataAction('metadata', [...groups].filter(g => !g.frozen), { importance: 1 }, ['importance']) }, { separatorBefore: scope === 'all', disabled: !groups.some(g => !g.frozen) })))
    if (field === 'importance' || field === 'multiplier') output.push(item('pixel-ratio', `Set ${field === 'importance' ? 'Importance' : 'Plot multiplier'} for marked data to BLA pixel ratio`, () => { void contextMetadataAction('context_parameters', marked, { mode: 'pixel_ratio', field }, [field]) }, { separatorBefore: true, disabled: groupPixelRatio(current) === null || !marked.some(g => !g.frozen && groupPixelRatio(g) !== null) }))
    return output
  }
  function refreshContextMetadata(next: AthenaProject, fields: string[]) {
    if (modal !== 'metadata' || !active || next.last_operation?.skipped_group_ids.includes(active.id)) return
    const saved = next.groups.find(g => g.id === active.id)
    if (!saved) return
    setOptions(o => ({ ...o, ...Object.fromEntries(fields.filter(key => ['importance', 'multiplier', 'offset'].includes(key)).map(key => [key, key === 'importance' ? groupImportance(saved) : saved[key as 'multiplier' | 'offset']])) }))
  }
  async function contextMetadataAction(action: string, targets: AthenaGroup[], values: Record<string, unknown>, fields: string[]) {
    if (busy || !targets.length) return
    await task('Updating group values', async () => {
      const next = await command(action, targets.map(g => g.id), values)
      if (targets.some(g => g.id === active?.id)) refreshContextMetadata(next, fields)
    })
  }
  async function recommendedKmax(current: AthenaGroup) {
    if (!project || busy || current.frozen) return
    await task('Selecting recommended kmax', async () => {
      const result = await athenaApi<{ version: number; results: { group_id: string; recommended_kmax?: number }[]; skipped: { reason: string }[] }>(`/projects/${project.id}/context-report`, { version: project.version, group_ids: [current.id], kind: 'measurement_uncertainty' })
      const suggestion = result.results.find(row => row.group_id === current.id)?.recommended_kmax
      if (result.version !== project.version || typeof suggestion !== 'number' || !Number.isFinite(suggestion)) throw new Error(result.skipped?.[0]?.reason ?? 'Larch could not recommend a kmax for this spectrum.')
      await command('parameters', [current.id], { kmax: suggestion })
      setDrafts(d => { const next = { ...d }; if (next[current.id]) next[current.id] = { ...next[current.id], kmax: suggestion }; return next })
    })
  }

  function accept(p: AthenaProject) {
    if (p.import_preferences_warning && !preferenceWarnings.current.includes(p.import_preferences_warning)) preferenceWarnings.current.push(p.import_preferences_warning)
    const previous = projectRef.current
    if (previous?.id !== p.id) {
      setStandardDrafts({}); setDrafts({}); setAutoApplyPlans({})
    } else {
      setDrafts(current => {
        const updated: Record<string, Parameters> = {}
        for (const [id, draft] of Object.entries(current)) {
          const before = previous.groups.find(group => group.id === id)?.parameters
          const saved = p.groups.find(group => group.id === id)?.parameters
          if (!before || !saved) continue
          const rebased = rebaseParameterDraft(draft, before, saved)
          if (rebased) updated[id] = rebased
        }
        return updated
      })
    }
    projectRef.current = p; setProject(p)
    setAnalysis(p.analyses?.at(-1) ?? null)
    if (!integrated) localStorage.setItem("athena.project", p.id)
    setActiveId(id => p.groups.some(g => g.id === id) ? id : p.groups[0]?.id ?? "")
  }
  async function task(label: string, work: () => Promise<void>) {
    cancelPick()
    setBusy(label); setError(""); skippedCount.current = 0; preferenceWarnings.current = []
    try {
      await work()
      setMessage(label + " · complete" + (skippedCount.current ? ` · ${skippedCount.current} group${skippedCount.current === 1 ? "" : "s"} skipped` : "") + (preferenceWarnings.current.length ? ' · ' + preferenceWarnings.current.join(' ') : ''))
      return true
    } catch (e) {
      setError(e instanceof Error ? e.message : "The operation failed."); setMessage("Action needs attention")
      return false
    } finally { setBusy("") }
  }
  useEffect(() => {
    if (init.current) return
    init.current = true
    void task("Opening project", async () => {
      if (session.mode === "integration") {
        accept(await athenaApi<AthenaProject>(`/projects/${session.projectId}`))
        return
      }
      const saved = localStorage.getItem("athena.project")
      if (saved) accept(await athenaApi<AthenaProject>(`/projects/${saved}`))
      else accept(await athenaApi<AthenaProject>("/projects", {}))
    })
  }, [])
  async function command(action: string, group_ids: string[] = [], commandOptions: Record<string, unknown> = {}) {
    const p = projectRef.current
    if (!p) throw new Error("Open a project first.")
    if (!canCommand(action)) throw new Error("This operation is unavailable in this integration session.")
    const next = await athenaApi<AthenaProject>(`/projects/${p.id}/command`, { version: p.version, action, group_ids, options: commandOptions })
    if (projectRef.current?.id !== p.id || projectRef.current.version !== p.version) throw new Error("The active project changed while this operation was running. Its response was not loaded.")
    skippedCount.current = next.last_operation?.action === action ? next.last_operation.skipped_group_ids.length : 0
    if (next.last_operation?.action === action && next.last_operation.warnings) preferenceWarnings.current.push(...next.last_operation.warnings)
    accept(next)
    return next
  }
  function act(action: string, ids = active ? [active.id] : [], opts: Record<string, unknown> = {}) {
    if (parameterActionBlocked()) return
    void task(action.replaceAll("_", " "), async () => { await command(action, ids, opts) })
    setMenu("")
  }
  function openPluginRegistry() {
    cancelPick(); registryReturn.current = modal === "import" ? "import" : null
    setRegistryPending(true); setMenu(""); setModal("plugins")
  }
  function closePluginRegistry() {
    if (!registryPending) { setError(""); setModal(registryReturn.current) }
  }
  function openTool(name: ModalName) {
    if (!canOpen(name) || (name !== "learn" && parameterActionBlocked())) return
    cancelPick()
    if (name === "merge") setMergeInitialArray(undefined)
    setMenu(""); setError(""); setModal(name)
    const e0 = Number(active?.result?.effective.e0 ?? 0)
    setOptions({ reference_id: project?.groups.find(g => g.id !== active?.id)?.id ?? "", target: Math.round(e0), observed: e0 - (active?.parameters.energy_shift ?? 0),
      xmin: e0 ? e0 - 20 : 0, xmax: e0 ? e0 + 80 : 100, window: 7, order: 2, width: 1,
      kind: "gaussian", formula: "Fe2O3", element: "Fe", edge: "K", angle_in: 45, angle_out: 45,
      e0, pre_step: 5, xanes_step: .5, exafs_step: .05, xanes_start: -30, xanes_end: 30,
      offset: 0, linear: 1, quadratic: 0, array: "norm", sum_to_one: true, nonnegative: true,
      center: e0, sigma: 2, amplitude: .05, use_reference: false, shift: 100,
      edge_step: Number(active?.result?.effective.edge_step ?? 1), method: "arctangent",
      kmin: 3, kmax: Math.min(12, Number(active?.result?.effective.kmax ?? 12)), phase_offset: 0,
      fit_cumulants: true, max_cumulant: 4, parameter: "rbkg", start: .8, stop: 1.2, count: 3 })
    setPeaks([{center: e0 + 5, sigma: 2, amplitude: 1, kind: "gaussian"}])
    setFitSelection([...(active ? [active.id] : []), ...marked.filter(g => g.id !== active?.id).map(g => g.id)])
    if (name === "merge" || name === "sum") {
      setCombineWeights(Object.fromEntries(marked.map(g => [g.id, 1])))
      setCombineArray("")
    }
    if (name === "journal") { setJournal(project?.journal ?? ""); setProjectName(project?.name ?? "") }
    if (name === "open") setProjectFiles([])
    if (name === "open") void task("Loading recent projects", async () => { setRecent(await athenaApi("/projects")) })
    if (name === "rename") setOptions({ label: active?.label ?? "" })
    if (name === "metadata") setOptions({ importance: active ? groupImportance(active) : 1, label: active?.label ?? "", notes: active?.notes ?? "", multiplier: active?.multiplier ?? 1, offset: active?.offset ?? 0, reference_id: active?.reference_id ?? "" })
  }
  function changeParameter(key: keyof Parameters, value: number | string | boolean | null) {
    if (!active || !parameters) return
    cancelPick()
    if ((key === "bkg_kmin" || key === "bkg_kmax") && typeof value === "number" && (!Number.isFinite(value) || value < 0)) {
      setError("Spline limits must be nonnegative. Correct the value to continue."); return
    }
    const source = active
    const next = { ...parameters, [key]: value }
    const changed = !sameParameters(next, source.parameters)
    const token = changed ? ++autoApplySerial.current : 0
    setDrafts(current => {
      const updated = { ...current }
      if (changed) updated[source.id] = next
      else delete updated[source.id]
      return updated
    })
    setAutoApplyPlans(current => {
      const updated = { ...current }
      if (changed) updated[source.id] = {
        token,
        projectId: projectRef.current?.id ?? project?.id ?? "",
        sourceId: source.id,
        mode: applyMarked ? "marked" : "current",
        targetIds: applyMarked ? marked.map(group => group.id) : [source.id],
        status: "queued",
      }
      else delete updated[source.id]
      return updated
    })
    setError("")
    setMessage(changed ? `Parameter changes queued for automatic processing${applyMarked ? " · marked groups" : ""}` : "Parameter changes reverted · up to date")
  }
  async function updateSharedParameters(action: "copy_parameters" | "reset_parameters", targets: AthenaGroup[], selection: ParameterSelection, closeDialog = false) {
    if (!active || !parameters || busy || parameterActionBlocked()) return
    const writableIds = targets.filter(g => !g.frozen).map(g => g.id)
    if (!writableIds.length) return
    await task("Processing spectra", async () => {
      const next = await command(action, targets.map(g => g.id), {
        ...selection, ...(action === "copy_parameters" ? { source_id: active.id, values: parameters } : {}),
      })
      const keys = selectedParameterKeys(selection)
      const skipped = next.last_operation?.action === action ? next.last_operation.skipped_group_ids : []
      // Clear only applied fields. Keep unrelated drafts and every skipped group's draft.
      setDrafts(d => {
        const updated = { ...d }
        for (const id of writableIds) {
          const saved = next.groups.find(g => g.id === id)?.parameters
          if (!saved || !updated[id] || skipped.includes(id)) continue
          updated[id] = { ...updated[id], ...Object.fromEntries(keys.filter(key => key in saved).map(key => [key, saved[key]])) }
          if (sameParameters(updated[id], saved)) delete updated[id]
        }
        return updated
      })
      if (closeDialog) setModal(null)
    })
  }
  function finishAutoApply(plan: AutoApplyPlan) {
    setAutoApplyPlans(current => {
      if (current[plan.sourceId]?.token !== plan.token) return current
      const updated = { ...current }; delete updated[plan.sourceId]; return updated
    })
  }
  function failAutoApply(plan: AutoApplyPlan) {
    setAutoApplyPlans(current => current[plan.sourceId]?.token === plan.token
      ? { ...current, [plan.sourceId]: { ...plan, status: "failed" } }
      : current)
  }
  function retryParameterChanges(plan: AutoApplyPlan) {
    const token = ++autoApplySerial.current
    setAutoApplyPlans(current => ({ ...current, [plan.sourceId]: { ...plan, token, status: "queued" } }))
    setError(""); setMessage("Parameter changes queued for automatic processing")
  }
  function changeApplyMarked(checked: boolean) {
    setApplyMarked(checked)
    if (!active || !drafts[active.id] || sameParameters(drafts[active.id], active.parameters)) return
    const token = ++autoApplySerial.current
    setAutoApplyPlans(current => ({ ...current, [active.id]: {
      token,
      projectId: projectRef.current?.id ?? project?.id ?? "",
      sourceId: active.id,
      mode: checked ? "marked" : "current",
      targetIds: checked ? marked.map(group => group.id) : [active.id],
      status: "queued",
    } }))
    setError(""); setMessage(`Parameter changes queued for automatic processing${checked ? " · marked groups" : ""}`)
  }
  function reconcileSubmittedDraft(sourceId: string, submitted: Parameters, saved: Parameters) {
    setDrafts(current => {
      const latest = current[sourceId]
      if (!latest) return current
      const updated = { ...current }
      if (sameParameters(latest, submitted)) {
        delete updated[sourceId]
        return updated
      }
      const reconciled = { ...latest }
      const values = reconciled as unknown as Record<string, unknown>
      const keys = new Set([...Object.keys(latest), ...Object.keys(submitted), ...Object.keys(saved)] as (keyof Parameters)[])
      for (const key of keys) {
        if (!sameParameterValue(latest, submitted, key)) continue
        if (key in saved) values[key] = saved[key]
        else delete values[key]
      }
      if (sameParameters(reconciled, saved)) delete updated[sourceId]
      else updated[sourceId] = reconciled
      return updated
    })
  }
  async function autoApplyParameters(plan: AutoApplyPlan, submitted: Parameters) {
    const current = projectRef.current
    const source = current?.groups.find(group => group.id === plan.sourceId)
    if (!current || current.id !== plan.projectId || !source) {
      finishAutoApply(plan)
      return
    }
    if (plan.mode === "marked") {
      const targetIds = plan.targetIds.filter(id => current.groups.some(group => group.id === id))
      if (!targetIds.some(id => !current.groups.find(group => group.id === id)?.frozen)) {
        setError("Mark at least one unfrozen group before applying parameter changes to marked groups.")
        setMessage("Action needs attention")
        failAutoApply(plan)
        return
      }
      const succeeded = await task("Processing spectra", async () => {
        await command("copy_parameters", targetIds, { source_id: source.id, section: "all", values: submitted })
      })
      if (succeeded) finishAutoApply(plan)
      else failAutoApply(plan)
      return
    }
    const changes = Object.fromEntries(Object.entries(submitted).filter(([key]) => !sameParameterValue(submitted, source.parameters, key as keyof Parameters)))
    if (!Object.keys(changes).length) {
      reconcileSubmittedDraft(source.id, submitted, source.parameters)
      finishAutoApply(plan)
      return
    }
    let saved: Parameters | null = null
    const succeeded = await task("Processing spectra", async () => {
      const next = await command("parameters", [source.id], changes)
      saved = next.groups.find(group => group.id === source.id)?.parameters ?? null
    })
    if (succeeded && saved) reconcileSubmittedDraft(source.id, submitted, saved)
    if (succeeded) finishAutoApply(plan)
    else failAutoApply(plan)
  }
  useEffect(() => {
    if (busy || parameterFieldEditing || autoApplyInFlight.current !== null) return
    const plan = Object.values(autoApplyPlans).filter(candidate => candidate.status === "queued").sort((left, right) => left.token - right.token)[0]
    if (!plan) return
    const source = project?.groups.find(group => group.id === plan.sourceId)
    const draft = drafts[plan.sourceId]
    if (!source || plan.projectId !== project?.id || !draft || sameParameters(draft, source.parameters)) {
      finishAutoApply(plan)
      return
    }
    const timer = window.setTimeout(() => {
      if (autoApplyInFlight.current !== null) return
      autoApplyInFlight.current = plan.token
      void autoApplyParameters(plan, { ...draft }).finally(() => {
        if (autoApplyInFlight.current === plan.token) autoApplyInFlight.current = null
      })
    }, parameterAutoApplyDelay)
    return () => window.clearTimeout(timer)
  }, [autoApplyPlans, busy, drafts, parameterFieldEditing, project]) // eslint-disable-line react-hooks/exhaustive-deps
  function discardParameterChanges(id: string) {
    setDrafts(current => { const updated = { ...current }; delete updated[id]; return updated })
    setAutoApplyPlans(current => { const updated = { ...current }; delete updated[id]; return updated })
    setError(""); setMessage("Parameter changes discarded")
  }
  async function reprocessActive() {
    if (!active || active.frozen || busy) return
    const source = active
    const submitted = drafts[source.id] ?? source.parameters
    const changes = Object.fromEntries(Object.entries(submitted).filter(([key]) => !sameParameterValue(submitted, source.parameters, key as keyof Parameters)))
    setAutoApplyPlans(current => { const updated = { ...current }; delete updated[source.id]; return updated })
    let saved: Parameters | null = null
    await task("Reprocessing spectrum", async () => {
      const next = await command("parameters", [source.id], changes)
      saved = next.groups.find(group => group.id === source.id)?.parameters ?? null
    })
    if (saved) reconcileSubmittedDraft(source.id, submitted, saved)
  }
  async function applyBackgroundStandard() {
    if (!active || active.frozen || busy || parameterActionBlocked()) return
    const id = active.id
    await task("Applying background standard", async () => {
      const next = await command("background_standard", [id], { standard_id: backgroundStandard || null })
      if (!next.last_operation?.skipped_group_ids.includes(id)) setStandardDrafts(d => Object.fromEntries(Object.entries(d).filter(([key]) => key !== id)))
    })
  }
  async function saveEdgeIdentity(id: string, identity: EdgePair) {
    if (busy || active?.id !== id || active.frozen || parameterActionBlocked()) return false
    let saved = false
    await task("Saving absorber and edge", async () => {
      await command("edge_identity", [id], identity)
      saved = true
    })
    return saved
  }
  async function applySelectedE0(ids: string[], options: E0Options) {
    if (busy || !ids.length || parameterActionBlocked()) return
    let completed: AthenaProject | undefined
    await task("Selecting E₀", async () => {
      const next = await command("set_e0", ids, options)
      const accepted = new Set(next.last_operation?.e0_results?.map(result => result.group_id))
      setDrafts(current => {
        const updated = { ...current }
        for (const group of next.groups) {
          if (!accepted.has(group.id) || !updated[group.id]) continue
          const draft = { ...updated[group.id], e0: group.parameters.e0 }
          if (sameParameters(draft, group.parameters)) delete updated[group.id]
          else updated[group.id] = draft
        }
        return updated
      })
      completed = next
    })
    return completed
  }
  function openParameterControls() {
    if (!canOpen("parameters") || parameterActionBlocked()) return
    setParameterScope("all"); setParameterKey("rbkg"); setParameterTarget("marked")
    setError(""); setModal("parameters")
  }
  function field(key: keyof Parameters, label: string, unit?: string, optional = false) {
    if (!parameters || !active) return null
    return <NumberField key={`${active.id}:${key}`} label={label} disabled={active.frozen} contextMenu={event => showContext(event, { kind: "field", field: key })} value={parameters[key] as number | null} unit={unit} optional={optional} showAutomaticValue={parameterSections.normalization.keys.some(normalizationKey => normalizationKey === key)} effective={active.result?.effective[key === "step" ? "edge_step" : key]} onEditingChange={setParameterFieldEditing} onChange={v => changeParameter(key, v)} pick={key in pickFields ? pickButton(key as PickKey, label) : undefined} />
  }
  function splineEnergyField(key: "bkg_kmin" | "bkg_kmax", label: string) {
    const k = parameters?.[key]
    const effective = active?.result?.effective[key]
    return <NumberField label={label} disabled={active?.frozen} contextMenu={event => showContext(event, { kind: "field", field: "spline_energy" })} unit="E − E₀ (eV)" value={typeof k === "number" ? k * k * ktoe : null} optional={key === "bkg_kmax"} effective={typeof effective === "number" ? effective * effective * ktoe : undefined} pick={pickButton(key, label, true)} onEditingChange={setParameterFieldEditing} onChange={value => {
      if (value !== null && (!Number.isFinite(value) || value < 0)) { cancelPick(); setError("Spline energy relative to E₀ must be nonnegative. Correct the value to continue."); return }
      setError(""); changeParameter(key, value === null ? key === "bkg_kmin" ? 0 : null : Math.sqrt(value / ktoe))
    }} />
  }
  function optionNumber(key: string, label: string, unit?: string) {
    return <NumberField key={key} label={label} disabled={modal === "metadata" && key === "importance" && active?.frozen} contextMenu={modal === "metadata" && ["multiplier", "offset", "importance"].includes(key) ? event => showContext(event, { kind: "field", field: key as NativeField }) : undefined} unit={unit} value={typeof options[key] === "number" ? options[key] as number : null} onChange={v => setOptions(o => ({ ...o, [key]: v ?? "" }))} />
  }
  function optionText(key: string, label: string) { return <label className="ath-field"><span>{label}</span><input value={String(options[key] ?? "")} onChange={e => setOptions(o => ({ ...o, [key]: e.target.value }))} /></label> }
  function selectParameter(key: "window" | "rwindow" | "bkg_window", label: string) { return <label className="ath-field" htmlFor={`ath-select-${key}`}><ContextLabel label={label} open={event => showContext(event, { kind: "field", field: key })}>{label}</ContextLabel><select id={`ath-select-${key}`} disabled={active?.frozen} aria-label={label} value={parameters?.[key]} onChange={e => changeParameter(key, e.target.value)}>{windows.map(w => <option key={w}>{w}</option>)}</select></label> }
  async function inspectFile(file: ImportFile, reuseFrom?: InspectionResponse, pending = files) {
    const p = projectRef.current
    if (!p) return
    // A failed inspection must not leave an already accepted upload available to import again.
    setInspection(null)
    setScanSelection(null)
    setArchiveSelection(null)
    inspectionReuseRef.current = reuseFrom
    let inspect: InspectionResponse | ScanInspectionResponse | ArchiveInspection | { kind: 'project'; preview: ProjectPreview }
    if ('inspection' in file) {
      inspect = await athenaApi<InspectionResponse>(`/projects/${p.id}/uploads/${file.inspection.upload_id}/inspection`)
    } else {
      const form = new FormData(); form.append("file", file)
      inspect = await athenaApi<InspectionResponse | ScanInspectionResponse | ArchiveInspection | { kind: 'project'; preview: ProjectPreview }>(`/projects/${p.id}/inspect`, form)
    }
    if ('kind' in inspect && inspect.kind === 'archive_list') {
      setArchiveSelection(inspect)
      return
    }
    if ('kind' in inspect && inspect.kind === 'project') {
      setProjectPreview(inspect.preview); setProjectFiles(pending as File[]); setFiles([]); setModal('open')
      return
    }
    if ('kind' in inspect && inspect.kind === 'scan_list') {
      setScanSelection(inspect)
      return
    }
    // Only collection responses carry kind; the remaining response is a
    // staged column table and follows the existing batch mapping rules.
    inspect = inspect as InspectionResponse
    setInspection(inspect)
    if (!reuseMapping || !reuseFrom || !matchingColumns(reuseFrom, inspect)) {
      setMapping(m => initialColumnMapping(inspect, m))
      // Last accepted column choices precede personal grid defaults in Athena.
      // Adopting even an equal grid prevents a late defaults response replacing it.
      if (inspect.remembered_columns?.mapping.rebin) rebinDefaults.adopt(inspect.remembered_columns.mapping.rebin)
    }
    return inspect
  }
  async function queueFiles(incoming: ImportFile[]) {
    if (!canOpen("import") || !incoming.length || parameterActionBlocked()) return
    setProjectPreview(null)
    setScanSelection(null)
    setArchiveSelection(null)
    if (isProjectCandidate(incoming[0])) {
      // Unopened tail entries are original Files. Scan entries are expanded
      // only at the head of the queue, before any later project handoff.
      setInspection(null); setFiles([]); setProjectFiles(incoming as File[])
      setError(""); setMenu(""); setModal("open")
      return
    }
    setProjectFiles([])
    // A new file choice is a new batch intent. Keep this immutable snapshot for
    // every request and retry, even if enforcement is stopped while it runs.
    setBatchEdgePolicy(edgePolicy ? Object.freeze({ ...edgePolicy }) : null)
    setMapping(m => ({ ...m, preprocessing: { ...(m.preprocessing ?? defaultPreprocessing), mark: false },
      ...(m.rebin ? { rebin: { ...m.rebin, enabled: false } } : {}) }))
    setModal("import"); setFiles(incoming)
    await task("Inspecting " + incoming[0].name, async () => { await inspectFile(incoming[0], undefined, incoming) })
  }
  async function importCurrent(readerReviewed = false) {
    if (!inspection || !projectRef.current) return
    const edge_policy = batchEdgePolicy
    let remainingProjects: File[] | null = null
    await task("Importing spectrum", async () => {
      const p = projectRef.current!
      const next = await athenaApi<AthenaProject>(`/projects/${p.id}/import`, { ...columnPayload(mapping), edge_policy, version: p.version, upload_id: inspection.upload_id, ...(readerReviewed ? { reader_reviewed: true } : {}) })
      accept(next); setActiveId(lastImportedSample(next.groups.slice(p.groups.length))!.id)
      let remaining = files.slice(1); setFiles(remaining)
      while (remaining.length) {
        if (isProjectCandidate(remaining[0])) {
          setInspection(null); setFiles([]); remainingProjects = remaining as File[]
          return
        }
        const inspected = await inspectFile(remaining[0], inspection, remaining)
        if (!inspected || !reuseMapping || !matchingColumns(inspection, inspected) || inspected.file_plugin?.review_required) return
        const current = projectRef.current!
        const result = await athenaApi<AthenaProject>(`/projects/${current.id}/import`, { ...columnPayload(mapping), edge_policy, version: current.version, upload_id: inspected.upload_id })
        accept(result); setActiveId(lastImportedSample(result.groups.slice(current.groups.length))!.id)
        remaining = remaining.slice(1); setFiles(remaining)
      }
      setInspection(null); setModal(null)
    })
    // Start the other panel after releasing this task's busy state.
    if (remainingProjects) await queueFiles(remainingProjects)
  }
  async function reviewScans(selected: InspectionResponse[]) {
    if (!selected.length || !scanSelection) return
    const expanded = selected.map(inspection => ({ name: inspection.display_name, inspection }))
    setFiles([...expanded, ...files.slice(1)])
    setScanSelection(null)
    await task('Reading selected scan columns', async () => { await inspectFile(expanded[0], inspectionReuseRef.current) })
  }
  async function reviewArchive(selected: ArchiveInspection['members']) {
    if (!selected.length || !archiveSelection || !projectRef.current) return
    let projectTail: ImportFile[] | null = null
    await task('Reading selected ZIP files', async () => {
      const expanded: ImportFile[] = []
      for (const member of selected) {
        const response = await transport.fetch(`/api/athena/projects/${projectRef.current!.id}/archives/${archiveSelection.upload_id}/members/${member.index}`)
        if (!response.ok) throw new Error(`Could not read ${member.name}. Select the original ZIP again or retry.`)
        expanded.push(new File([await response.blob()], member.name))
      }
      expanded.push(...files.slice(1))
      setFiles(expanded); setArchiveSelection(null)
      if (isProjectCandidate(expanded[0])) projectTail = expanded
      else await inspectFile(expanded[0], inspectionReuseRef.current, expanded)
    })
    if (projectTail) await queueFiles(projectTail)
  }
  async function skipImportFile() {
    const pending = files.slice(1)
    setFiles(pending); setInspection(null)
    if (!pending.length) { setError(''); return }
    if (isProjectCandidate(pending[0])) await queueFiles(pending)
    else await task('Inspecting ' + pending[0].name, async () => { await inspectFile(pending[0], inspectionReuseRef.current, pending) })
  }
  function importPolicyNotice() {
    return <section className="ath-import-policy" aria-label="Import batch edge policy">
      <p>Next batch: <strong>{edgePolicyDescription(edgePolicy)}</strong>. {edgePolicy && <button onClick={stopEdgePolicy}>Stop enforcing element and edge</button>}</p>
      {!!files.length && <p>This batch: <strong>{edgePolicyDescription(batchEdgePolicy)}</strong>. This snapshot covers every sample, including retries. Reference identity follows the Same element option; its E₀ is found independently.</p>}
      <p className="ath-hint">Only subsequent raw-file imports use enforcement; χ(k) ignores it and project restores are unchanged. Choosing new files starts a new batch with the current policy.</p>
      {!inspection && !scanSelection && !archiveSelection && !!files.length && <div className="ath-modal-actions"><button disabled={!!busy} onClick={() => { void task("Inspecting " + files[0].name, async () => { await inspectFile(files[0], inspectionReuseRef.current) }) }}>Retry file inspection</button><button disabled={!!busy} onClick={() => { void skipImportFile() }}>Skip this file</button></div>}
    </section>
  }
  async function runTool() {
    if (!modal || !active || parameterActionBlocked()) return
    await task(toolTitles[modal] ?? modal, async () => {
      if (["lcf", "pca", "peaks", "log_ratio"].includes(modal)) {
        const p = projectRef.current!
        const opts: Record<string, unknown> = { array: options.array, xmin: options.xmin, xmax: options.xmax }
        if (modal === "lcf") Object.assign(opts, { sum_to_one: options.sum_to_one, nonnegative: options.nonnegative })
        if (modal === "peaks") opts.peaks = peaks
        if (modal === "log_ratio") Object.assign(opts, { kmin: options.kmin, kmax: options.kmax, phase_offset: options.phase_offset, fit_cumulants: true, max_cumulant: options.max_cumulant })
        const result = await athenaApi<Analysis>(`/projects/${p.id}/analyze`, { version: p.version, action: modal, group_ids: modal === "peaks" ? [active.id] : modal === "log_ratio" ? [active.id, options.reference_id] : fitSelection, options: opts })
        setAnalysis(result); setAnalysisVisible(true)
        const updated = { ...p, analyses: [...(p.analyses ?? []), result].slice(-50) }
        projectRef.current = updated; setProject(updated)
      } else {
        const ids = ["merge", "sum"].includes(modal) || (modal === "align" && applyMarked) ? marked.map(g => g.id) : [active.id]
        let opts: Record<string, unknown> = { ...options }
        if (modal === "convolve" || modal === "deconvolve") opts.form = options.kind
        if (modal === "metadata") {
          opts = { label: options.label, notes: options.notes, multiplier: options.multiplier, offset: options.offset, reference_id: options.reference_id || null }
          if (options.importance !== groupImportance(active)) {
            if (typeof options.importance !== 'number' || !Number.isFinite(options.importance) || options.importance < 0) throw new Error('Enter a finite, nonnegative Importance.')
            opts.importance = options.importance
          }
        }
        const keys: Record<string, string[]> = { calibrate: ["target", "observed"], align: ["reference_id", "xmin", "xmax", "use_reference"],
          merge: [], sum: [], smooth: ["window", "order"], deglitch: ["xmin", "xmax"], truncate: ["xmin", "xmax"],
          convolve: ["form", "width"], deconvolve: ["form", "width", "xmin", "xmax"], self_absorption: ["formula", "element", "edge", "angle_in", "angle_out"], dispersive: ["offset", "linear", "quadratic"],
          multi_electron: ["method", "e0", "shift", "amplitude", "width", "edge_step"], copy_series: ["parameter", "start", "stop", "count"] }
        if (keys[modal]) opts = Object.fromEntries(keys[modal].map(key => [key, opts[key]]))
        if (modal === "merge" || modal === "sum") {
          const weights = marked.map(g => {
            const value = combineWeights[g.id]
            if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Enter a finite ${modal === "merge" ? "weight" : "coefficient"} for ${g.label}.`)
            return value
          })
          opts = { weights, ...(combineArray ? { array: combineArray } : {}) }
        }
        const next = await command(modal, ids, opts)
        if (["merge", "sum", "difference", "smooth", "deglitch", "truncate", "rebin", "convolve", "deconvolve", "self_absorption", "dispersive", "multi_electron", "copy_series"].includes(modal)) setActiveId(next.groups.at(-1)!.id)
      }
      setModal(null)
    })
  }
  function changeSpace(value: Space) { cancelPick(); setSpace(value); setRange([null, null]); setAnalysisVisible(false) }
  function specialPlotShortcut(value: Space) {
    if (!active || busy) return
    const kind: AthenaSpecialPlotKind | null = plotScope === "selected"
      ? value === 'E' ? 'i0' : value === 'q' ? 'biquad' : null
      : value === 'E' ? 'i0sig' : value === 'k' ? 'k123' : value === 'R' ? 'r123' : null
    if (kind) { cancelPick(); setSpecialPlot(kind); setModal('special_plot') }
    else changeSpace(value)
  }
  function moveGroup(delta: number) {
    if (!project || !active) return
    const ids = project.groups.map(g => g.id), index = ids.indexOf(active.id)
    if (index + delta < 0 || index + delta >= ids.length) return
    ;[ids[index], ids[index + delta]] = [ids[index + delta], ids[index]]
    act("reorder", [], { ids })
  }
  const toolsMenu = ["calibrate", "align", "merge", "difference", "sum", "rebin", "deglitch", "truncate", "smooth", "convolve", "deconvolve", "self_absorption", "dispersive", "multi_electron", "copy_series"] as ModalName[]
  const analysisMenu = ["lcf", "pca", "peaks", "log_ratio"] as ModalName[]
  const canOpenTool = (tool: ModalName) => {
    if (integrated && (tool === "merge" || tool === "dispersive")) return false
    return canOpen(tool)
  }
  const download = (path: string, filename: string) => transport.download(path, filename).catch(error => setError(error instanceof Error ? error.message : "The download failed."))
  const fileInput = useRef<HTMLInputElement>(null)

  return <main className="ath-app" onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); if (canOpen("import") && !busy && !registryPending && project) void queueFiles(Array.from(e.dataTransfer.files)) }}>
    <header className="ath-header"><div className="ath-brand"><span className="ath-logo"><Activity size={25} /></span><div><h1>ATHENA <span>WEB</span></h1><p>X-ray absorption spectroscopy</p></div></div>
      <nav aria-label="Main menu">{["File", "Edit", "Group", "Energy", "Plot", "Process", "Analysis"].map(label => <div className="ath-menu-wrap" key={label}><button aria-expanded={menu === label} onClick={() => setMenu(menu === label ? "" : label)}>{label}<ChevronDown size={12} /></button>{menu === label && <div className="ath-menu" onKeyDown={e => { if (e.key === "Escape") setMenu("") }}>
        {label === "Edit" && <>{(['all', 'marked'] as const).map(scope => <button key={scope} disabled={!project?.groups.length || !!busy || !canOpen("parameter_report")} onClick={() => { setReportScope(scope); openTool('parameter_report') }}><Download size={15} />Excel report on {scope} groups…</button>)}</>}
        {label === "Plot" && <><button disabled={!active||!!busy||parameterUpdatePending||!canOpen("diagnostic_plot")} onClick={()=>openTool('diagnostic_plot')}>Diagnostic plots…</button><button disabled={!active||!hasSavedMerge(active)||!!busy||!canOpen("merge_plot")} onClick={()=>openTool('merge_plot')}>Saved merge spread…</button></>}
        {label === "Energy" && <><button disabled={!project || !!busy || !canOpen("e0")} onClick={() => { if (canOpen("e0")) { cancelPick(); setMenu(""); setError(""); setModal("e0") } }}>Select E₀…</button><button disabled={!!busy || !canOpen("edge_policy")} onClick={() => { if (canOpen("edge_policy")) { cancelPick(); setMenu(""); setModal("edge_policy") } }}>Enforce element and edge…</button><button disabled={!edgePolicy || !canOpen("edge_policy")} onClick={stopEdgePolicy}>Stop enforcing element and edge</button></>}
        {label === "Group" && <button disabled={!project?.groups.length || !!busy || !canOpen("groups")} onClick={() => openTool("groups")}>Mark / freeze groups…</button>}
        {label === "Group" && <button disabled={!project?.groups.length || !!busy || !canOpen("datatype")} onClick={() => openTool("datatype")}>Change data type…</button>}
        {label === "Group" && <button disabled={!active || active.frozen || !!busy || !canOpen("edge_identity")} onClick={openEdgeIdentity}>Edit absorber and edge…</button>}
        {label === "Group" && <button disabled={!active || !!busy || !canOpen("xdi")} onClick={() => openTool('xdi')}>File metadata…</button>}
        {label === "File" && <button disabled={!project || !active || !!busy || !canOpen("data_export")} onClick={() => openTool("data_export")}><Download size={15} />Export column data…</button>}
        {label === "File" && project && can("export") && (marked.length ? <button onClick={() => { if (!parameterActionBlocked()) void download(`/api/athena/projects/${project.id}/export?format=prj&marked_only=true`, `${project.name}-marked.prj`) }}><Download size={15} />Save marked project (.prj)</button> : <button disabled>Save marked project (.prj)</button>)}
        {label === "File" && <>{!integrated && <><button disabled={!!busy || parameterUpdatePending} onClick={() => { setMenu(""); void task("Creating project", async () => { accept(await athenaApi("/projects", {})); setDrafts({}) }) }}><Plus size={15} />New project</button><button disabled={!!busy || parameterUpdatePending} onClick={() => openTool("open")}><FolderOpen size={15} />Open project…</button></>}{can("upload") && <button disabled={!project || !!busy || parameterUpdatePending} onClick={() => { setMenu(""); setModal("import") }}><Upload size={15} />Import data…</button>}<hr />{project && can("export") && <><button onClick={() => void download(`/api/athena/projects/${project.id}/export?format=prj`, `${project.name}.prj`)}><Download size={15} />Save Athena project (.prj)</button><button onClick={() => void download(`/api/athena/projects/${project.id}/export?format=json`, `${project.name}.json`)}><Download size={15} />Save complete web project</button></>}<button onClick={() => openTool("journal")} disabled={!project || parameterUpdatePending || !can("project")}><FileText size={15} />Project journal</button>{!integrated && <><hr /><button disabled={!!busy || parameterUpdatePending} onClick={openPluginRegistry}>Plugin registry…</button><button disabled={!!busy || parameterUpdatePending} onClick={() => { setMenu(""); setModal("beamline") }}>Beamline identification…</button></>}</>}
        {label === "Group" && <><button disabled={!active || !!busy || !can("metadata")} onClick={() => openTool("metadata")}>Group information…</button><button disabled={!active || !!busy || !can("duplicate")} onClick={() => act("duplicate")}><Copy size={15} />Duplicate current group</button><button disabled={!active || !!busy || !can("metadata")} onClick={() => act("metadata", [active!.id], { frozen: !active?.frozen })}><LockKeyhole size={15} />{active?.frozen ? "Unfreeze" : "Freeze"} group</button><button disabled={!active || !!busy || !can("delete")} onClick={() => act("delete")}><Trash2 size={15} />Remove current group</button><hr /><button disabled={!!busy || marked.length !== 2 || !can("tie_reference")} onClick={() => act("tie_reference", marked.map(g => g.id))}>Tie marked sample and reference</button><button disabled={!active || !!busy || !can("untie_reference")} onClick={() => act("untie_reference")}>Untie current reference</button><p className="ath-hint">Mark exactly two groups: the first in list order is the sample, the second its reference. Tying adopts the sample’s energy shift and keeps both shifts linked when either is edited.</p>{marked.length === 2 && <p className="ath-hint">Sample: {marked[0].label}<br />Reference: {marked[1].label}</p>}</>}
        {(label === "Process" ? toolsMenu : label === "Analysis" ? analysisMenu : []).map(tool => <button disabled={(tool === "dispersive" ? !project : !active) || !!busy || !canOpenTool(tool)} key={tool} onClick={() => openTool(tool)}>{toolTitles[tool!]}</button>)}
      </div>}</div>)}</nav><button className="ath-learn" onClick={() => openTool("learn")}><BookOpen size={16} />Learn Athena</button><span className="ath-local"><i /> Local workspace</span></header>
    <section className="ath-project-bar"><div><FolderOpen size={17} /><button className="ath-project-name" onClick={() => openTool("journal")} disabled={!project || parameterUpdatePending || !canCommand("project")}>{project?.name ?? "Opening workspace…"}<ChevronDown size={12} /></button><span className="ath-autosaved">{busy ? "Working…" : parameterUpdatePending ? "Parameter changes pending" : project ? integrated ? "Linked project" : "Saved locally" : "Connecting"}</span></div><div><button title="Undo last project change" aria-label="Undo" disabled={!project?.undo.length || !!busy || parameterUpdatePending || !canCommand("undo")} onClick={() => act("undo", [])}><Undo2 size={16} /></button><button title="Redo project change" aria-label="Redo" disabled={!project?.redo.length || !!busy || parameterUpdatePending || !canCommand("redo")} onClick={() => act("redo", [])}><Redo2 size={16} /></button><span className="ath-divider" />{can("upload") && <button disabled={!project || !!busy || parameterUpdatePending} onClick={() => { setInspection(null); setModal("import") }}><Upload size={15} />Import data</button>}{project && can("export") && <button className="ath-button ath-primary" onClick={() => { if (!parameterActionBlocked()) void download(`/api/athena/projects/${project.id}/export?format=prj`, `${project.name}.prj`) }}><Download size={15} />Save project</button>}{integrated && session.returnTo && <><a className="ath-button" href={session.returnTo} onClick={clearIntegrationReturnSelection}>Return to Dr.XAS</a><a className="ath-button ath-primary" href={session.returnTo} aria-label={`Import ${marked.length} selected ${marked.length === 1 ? "group" : "groups"} into Dr.XAS`} aria-disabled={!marked.length || !can("export")} onClick={event => { if (!marked.length || !can("export") || !project) { event.preventDefault(); return } saveReturnSelection(session, project.version, marked.map(group => ({ id: group.id, version: project.version }))) }}>Import into Dr.XAS</a></>}</div></section>
    <section className="ath-edge-policy-bar" aria-label="Import edge policy"><span>Import edge enforcement: <strong>{edgePolicyDescription(edgePolicy)}</strong>. Applies to new raw-file samples. References use their own E₀ and can share the sample’s element.</span>{edgePolicy && <button onClick={stopEdgePolicy}>Stop enforcing element and edge</button>}</section>
    {edgePolicyStorageError && <p className="ath-warning" role="alert">{edgePolicyStorageError}</p>}
    {error && !modal && <div className="ath-error" role="alert">{error}<button onClick={() => { void task("Reloading project", async () => { const id = projectRef.current?.id ?? (integrated ? session.projectId : localStorage.getItem("athena.project")); if (id) accept(await athenaApi(`/projects/${id}`)); else accept(await athenaApi("/projects", {})) }) }}>Reload workspace</button><button onClick={() => setError("")} aria-label="Dismiss error"><X size={15} /></button></div>}
    <ResizableAthenaWorkspace
      groups={<aside id="athena-data-groups" className="ath-groups"><div className="ath-panel-heading"><h2><ContextLabel label="current group" open={event => showContext(event, { kind: "group" })}>Data groups <span>{project?.groups.length ?? 0}</span></ContextLabel></h2>{can("upload") && <button aria-label="Import spectra" disabled={!project || !!busy} onClick={() => setModal("import")}><Plus size={17} /></button>}</div>
        <div className="ath-sidebar-actions" role="group" aria-label="Project actions">{!integrated && <button type="button" disabled={!!busy || parameterUpdatePending} onClick={() => openTool("open")}><FolderOpen size={15} />Open project</button>}<button type="button" onClick={() => openTool("journal")} disabled={!project || !!busy || parameterUpdatePending || !canCommand("project")} aria-label="Project journal"><FileText size={15} /></button></div>
        <label className="ath-search"><Search size={14} /><input aria-label="Search groups" placeholder="Find a spectrum…" value={search} onChange={e => setSearch(e.target.value)} /></label>
        <div className="ath-mark-toolbar"><label><input type="checkbox" aria-label="Mark all groups" disabled={!project?.groups.length || !!busy || !canCommand("metadata")} checked={!!project?.groups.length && marked.length === project.groups.length} onChange={e => act("metadata", project!.groups.map(g => g.id), { marked: e.target.checked })} />{marked.length} marked</label><div><button onClick={() => moveGroup(-1)} disabled={!active || !!busy || !canCommand("reorder")} aria-label="Move group up"><ArrowUp size={13} /></button><button onClick={() => moveGroup(1)} disabled={!active || !!busy || !canCommand("reorder")} aria-label="Move group down"><ArrowDown size={13} /></button></div></div>
        <div className="ath-group-list" onContextMenu={event => showContext(event, { kind: "group" })} onKeyDown={event => { if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) showContext(event, { kind: "group" }) }}>{project?.groups.filter(g => g.label.toLowerCase().includes(search.toLowerCase())).map(g => <div key={g.id} className={`ath-group ${active?.id === g.id ? "selected" : ""}`}><input aria-label={`Mark ${g.label}`} type="checkbox" checked={g.marked} disabled={!!busy || parameterUpdatePending || !canCommand("metadata")} onChange={e => act("metadata", [g.id], { marked: e.target.checked })} /><button className="ath-group-select" disabled={!!busy} onClick={() => { setActiveId(g.id); setAnalysisVisible(false) }}><span className="ath-swatch" style={{ background: spectrumColors.get(g.id) ?? "var(--ath-line)" }} /><span><strong>{g.label}</strong><small>{isDifferenceGroup(g) ? (g.data_type === "chi" ? "Δχ(k)" : "Difference (E)") : dataTypeLabel(g)} · {g.energy.length.toLocaleString()} points{g.processing_error ? " · needs processing" : ""}</small></span>{g.frozen && <LockKeyhole size={12} />}{drafts[g.id] && !sameParameters(drafts[g.id], g.parameters) && <i title={autoApplyPlans[g.id]?.status === "failed" ? "Automatic processing failed" : autoApplyPlans[g.id] ? "Pending automatic processing" : "Draft parameter values"} className="ath-dirty-dot" />}</button></div>)}</div>
        {!project?.groups.length && <div className="ath-empty-groups"><Layers size={30} strokeWidth={1} /><p>A place for every scan.</p><span>Import files together to compare, align, and merge your spectra.</span></div>}
        {!integrated && <div className="ath-sidebar-bottom"><button disabled={!!busy || !project} onClick={() => { void task("Loading copper example", async () => { const next = await command("example"); setActiveId(next.groups.at(-3)!.id) }) }}><Activity size={16} />Load copper foil example</button><small>Real spectra · 10 K, 50 K & 300 K</small></div>}
      </aside>}
      spectrum={<section id="athena-spectrum-viewer" className="ath-center">
        <div className="ath-center-heading">
          <div><p className="ath-eyebrow">SPECTRUM WORKSPACE</p><h2>{plotScope === "current" && active ? active.label : "Explore your XAS data"}</h2></div>
          <div className="ath-viewer-tools">
            <label className="ath-colormap-control" title="Shared colormap for spectrum lines and the 2D/3D wavelet viewer.">Colormap
              <select aria-label="Viewer colormap" value={viewerColormap} onChange={event => setViewerColormap(event.target.value as AthenaColormap)}>
                {ATHENA_COLORMAPS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
            <label className="ath-kweight-control" title="Shared k-weight for k, R, back-transform, and wavelet views. Auto uses each spectrum’s saved weight.">k-weight
              <select aria-label="Viewer k-weight" value={viewerKWeight ?? ""} disabled={!active} onChange={event => setViewerKWeight(event.target.value === "" ? null : Number(event.target.value))}>
                <option value="">Auto ({automaticWeightLabel})</option>
                {[0, 1, 2, 3, 4].map(weight => <option key={weight} value={weight}>{weight}</option>)}
              </select>
            </label>
            {active && <button className="ath-subtle" disabled={!canOpen("metadata")} onClick={() => openTool("metadata")} aria-label="Edit group information"><Settings2 size={16} /></button>}
          </div>
        </div>
        {active && <section className="ath-group-identity" aria-label="Current absorber and edge"><span onContextMenu={event => showContext(event, { kind: "section", section: "group" })}>Absorber / edge: <strong>{edgeIdentityDescription(active)}</strong></span><button disabled={active.frozen || !!busy || !canOpen("edge_identity")} onClick={openEdgeIdentity}>Edit absorber and edge…</button></section>}
        <ResizablePlotCard><div className="ath-plot-top"><div className="ath-space-tabs" role="tablist" aria-label="Plot space">{(["E", "k", "R", "q"] as Space[]).map(s => <button key={s} role="tab" aria-selected={space === s && !analysisVisible} onContextMenu={event => { event.preventDefault(); if (canOpen("special_plot")) specialPlotShortcut(s) }} title="Right-click for Athena’s special plot" onClick={() => changeSpace(s)}><b>{s}</b><span>{{ E: "Energy", k: "EXAFS", R: "Fourier", q: "Back transform" }[s]}</span></button>)}</div><button type="button" disabled={!active || !!busy || !canOpen("special_plot")} onClick={() => openTool("special_plot")}>Plot shortcuts…</button><label className="ath-check"><input type="checkbox" checked={showLegend} onChange={e => setShowLegend(e.target.checked)} />Show legend</label></div>
          <div className="ath-plot-scope" role="radiogroup" aria-label="Plot spectra">
            <span className="ath-plot-scope-label">Plot</span>
            {([{ value: "selected", label: "All selected", hint: "Plot the checked data groups" }, { value: "current", label: "Current spectrum", hint: "Plot only the highlighted data group" }] as const).map(option =>
              <label key={option.value} className={`ath-plot-scope-option${plotScope === option.value ? " selected" : ""}`} title={option.hint}>
                <input type="radio" name="ath-plot-scope" value={option.value} checked={plotScope === option.value} onChange={() => { setPlotScope(option.value); setAnalysisVisible(false) }} />
                <span>{option.label}</span>
              </label>)}
            <span className="ath-plot-scope-note">{plotScope === "selected" ? `${marked.length} checked ${marked.length === 1 ? "group" : "groups"}` : "Highlighted group"}</span>
          </div>
          <div className="ath-plot-controls">{space === "E" ? <>
            <label className="ath-check" title="Show the current spectrum’s fitted background in μ(E)"><input type="checkbox" checked={background && canShowBackground} disabled={!canShowBackground} onChange={e => setBackground(e.target.checked)} />Background</label>
            <label className="ath-check" title="Show the fitted pre-edge line and its start/end points for Current spectrum in μ(E)"><input type="checkbox" checked={preEdge && canShowPreEdge} disabled={!canShowPreEdge} onChange={e => setPreEdge(e.target.checked)} />Pre-edge line</label>
            <label className="ath-check" title="Show the fitted post-edge line and its start/end points for Current spectrum in μ(E)"><input type="checkbox" checked={postEdge && canShowPostEdge} disabled={!canShowPostEdge} onChange={e => setPostEdge(e.target.checked)} />Post-edge line</label>
          </> : <>{space !== "k" && <select aria-label="Complex component" value={component} onChange={e => setComponent(e.target.value)}><option value="mag">Magnitude</option><option value="re">Real part</option><option value="im">Imaginary part</option><option value="pha">Phase</option></select>}<label className="ath-check"><input type="checkbox" checked={showWindow} onChange={e => setShowWindow(e.target.checked)} />Window</label></>}<label className="ath-inline-input">Stack offset <input aria-label="Stack offset" type="number" step="0.1" value={offset} disabled={plotScope === "current"} onChange={e => setOffset(Number(e.target.value))} /></label></div>
          {space === "E" && (plotScope !== "current" || plotEnergyMode !== "mu") && <p className="ath-plot-overlay-hint">For pre-/post-edge lines, choose Current spectrum and μ(E).</p>}
          {pick && <div className="ath-pick-prompt" aria-live="polite"><span>Picking <strong>{pick.label}</strong> for {active?.label}. Click a spectrum in the {pick.space} plot{pick.relative && `; E − E₀ uses ${pick.e0} eV`}. You can also type the field value. Changes process automatically.</span><button onClick={cancelPick}>Cancel pick <kbd>Esc</kbd></button></div>}
          {weightedPlot.loading ? <div className="ath-no-plot" role="status">Updating Fourier transform…</div>
            : weightedPlot.error ? <div className="ath-no-plot" role="alert"><p>{weightedPlot.error}</p><button type="button" onClick={weightedPlot.retry}>Try again</button></div>
            : <AthenaPlot groups={weightedPlot.groups} active={active} space={space} energyMode={plotEnergyMode} component={component} plotScope={plotScope} background={background && canShowBackground} preEdge={preEdge && canShowPreEdge} postEdge={postEdge && canShowPostEdge} window={showWindow} showLegend={showLegend} colormap={viewerColormap} kWeight={viewerKWeight} offset={offset} analysis={analysis} analysisVisible={analysisVisible} range={range} picking={!!pick} onPickX={(x, pickedSpace) => pluck(x, pickedSpace, pick)} />}
          {space === "E" && <div className="ath-energy-plot-options" role="radiogroup" aria-label="Energy plot">
            {(active?.data_type === "detector" ? [{ value: "mu", label: "Detector signal" }] : energyPlotOptions).map(option => <label className={`ath-energy-plot-option${plotEnergyMode === option.value ? " selected" : ""}${active?.data_type === "detector" ? " disabled" : ""}`} key={option.value}><input type="radio" name="ath-energy-plot" value={option.value} checked={plotEnergyMode === option.value} disabled={active?.data_type === "detector"} onChange={() => setEnergyMode(option.value)} /><span>{option.label}</span></label>)}
          </div>}
          <div className="ath-plot-bottom"><span>{analysisVisible ? "Analysis result" : `${selectedGroups.length} ${selectedGroups.length === 1 ? "spectrum" : "spectra"}`}{space === "R" && " · R is not phase corrected"}</span><div><label>Range <PlotRangeInput label="Plot minimum" value={analysisVisible ? null : range[0]} automatic={automaticRange[0]} disabled={analysisVisible || automaticRange[0] === null} onChange={value => setRange([value, range[1]])} /></label><span>to</span><PlotRangeInput label="Plot maximum" value={analysisVisible ? null : range[1]} automatic={automaticRange[1]} disabled={analysisVisible || automaticRange[1] === null} onChange={value => setRange([range[0], value])} />{active && project && can("export") && <button title="Export current group data" onClick={() => { if (!parameterActionBlocked()) void download(`/api/athena/projects/${project.id}/groups/${active.id}/export?space=${space}`, `${active.label}.csv`) }}><Download size={14} />CSV</button>}</div></div>
        </ResizablePlotCard>
        {active?.processing_error && <div className="ath-error" role="alert">{active.processing_error}</div>}{active?.result?.warnings.map(w => <p className="ath-warning" key={w}>{w}</p>)}
        <AthenaWavelet colormap={viewerColormap} projectId={project?.id} version={project?.version} group={active} kWeight={viewerKWeight} pending={!!dirty || !!activeAutoApplyPlan} />
        {analysis && <section className="ath-analysis-result"><header><h3>{toolTitles[analysis.kind]}</h3>{(project?.analyses?.length ?? 0) > 1 && <select aria-label="Saved analysis" value={analysis.id ?? ""} onChange={e => { const result = project?.analyses?.find(r => r.id === e.target.value); if (result) { setAnalysis(result); setAnalysisVisible(true) } }}>{project?.analyses?.map((r,i) => <option key={r.id ?? i} value={r.id}>{toolTitles[r.kind]} · {i+1}</option>)}</select>}<button onClick={() => setAnalysisVisible(!analysisVisible)}>{analysisVisible ? "Show spectra" : "Show fit plot"}</button><button onClick={() => { const a = document.createElement("a"); const url = URL.createObjectURL(new Blob([JSON.stringify(analysis, null, 2)], { type: "application/json" })); a.href = url; a.download = `athena-${analysis.kind}.json`; a.click(); URL.revokeObjectURL(url) }}><Download size={14} />Report</button></header>{analysis.project_version !== project?.version && <p className="ath-warning">The project changed after this analysis. Run the fit again to use the current data.</p>}{analysis.kind === "lcf" && <div className="ath-weights">{(analysis.result.weights as number[] ?? []).map((weight, i) => <div key={i}><span>{(analysis.result.labels as string[])[i]}</span><strong>{(weight * 100).toFixed(2)}%</strong></div>)}<p>R-factor: {Number(analysis.result.rfactor).toPrecision(5)}</p></div>}{analysis.kind === "pca" && <p>Explained variance: {(analysis.result.explained_variance_ratio as number[] ?? []).map(v => `${(v * 100).toFixed(2)}%`).join(" · ")}</p>}{analysis.kind === "peaks" && <pre>{JSON.stringify(analysis.result.parameters, null, 2)}</pre>}{analysis.kind === "log_ratio" && <><p className="ath-hint">Effective cumulant differences (target minus reference). These require the same isolated shell and scatterers; they are not absolute structural parameters.</p><pre>{JSON.stringify((analysis.result.cumulant_fit as {parameters: unknown})?.parameters, null, 2)}</pre></>}</section>}
        <div className="ath-center-note"><BookOpen size={15} /><span>Familiar Athena workflows. Scientific calculations by Larch.</span><button onClick={() => openTool("learn")}>Tutorials & reference <ExternalLink size={12} /></button></div>
      </section>}
      processing={<aside id="athena-processing-parameters" className="ath-parameters"><div className="ath-panel-heading"><h2>Processing parameters</h2><Settings2 size={16} /></div>{!active ? <div className="ath-param-empty"><Settings2 size={30} strokeWidth={1} /><p>Parameters follow the selected group.</p><small>Import a spectrum to begin normalization and background removal.</small></div> : <><div className="ath-param-current"><span className="ath-green-dot" /><strong><ContextLabel label="Group parameters" open={event => showContext(event, { kind: "section", section: "group" })}>{active.label}</ContextLabel></strong><button aria-label={`Data type: ${dataTypeLabel(active)}`} title="Change data type; Ctrl+Alt+click toggles μ(E) / XANES while preserving normalization" disabled={!!busy} onClick={event => {
          if (event.ctrlKey && event.altKey && ['mu', 'xanes', 'norm'].includes(active.data_type)) {
            void task('Changing data type', async () => { await command('change_datatype', [active.id], { toggle: true }); setSpace('E'); setAnalysisVisible(false) })
          } else openTool('datatype')
        }}>{dataTypeLabel(active)}</button><button aria-label={active.frozen ? "Unfreeze group" : "Freeze group"} disabled={!!busy || !can("metadata")} onClick={() => act("metadata", [active.id], { frozen: !active.frozen })}><LockKeyhole size={14} />{active.frozen ? "Frozen" : "Freeze"}</button></div><fieldset disabled={!!busy || !can("parameters")} className="ath-param-fields">
        <details open><summary><ContextLabel label="Normalization" open={event => showContext(event, { kind: "section", section: "background" })}>Normalization <small>μ(E)</small></ContextLabel></summary><fieldset className="ath-e0-fields" disabled={active.data_type === "chi" || active.data_type === "detector"}><div className="ath-fields">{field("e0", "E₀", "eV", true)}{field("step", "Edge step", undefined, true)}{field("pre1", "Pre-edge start", "eV relative", true)}{field("pre2", "Pre-edge end", "eV relative", true)}{field("norm1", "Post-edge start", "eV relative", true)}{field("norm2", "Post-edge end", "eV relative", true)}<label className="ath-field" htmlFor="ath-polynomial-degree"><ContextLabel label="Polynomial degree" open={event => showContext(event, { kind: "field", field: "nnorm" })}>Polynomial degree</ContextLabel><select id="ath-polynomial-degree" disabled={active.frozen} aria-label="Polynomial degree" value={parameters?.nnorm ?? ""} onChange={e => changeParameter("nnorm", e.target.value === "" ? null : Number(e.target.value))}><option value="">{typeof active.result?.effective.nnorm === "number" && [0, 1, 2, 3].includes(active.result.effective.nnorm) ? `${active.result.effective.nnorm} (Auto)` : "Auto"}</option>{[0, 1, 2, 3].map(n => <option key={n} value={n}>{n}</option>)}</select></label>{active.data_type !== "detector" && field("energy_shift", "Energy shift", "eV")}</div><label className="ath-check"><input type="checkbox" disabled={active.frozen} aria-label="Flatten normalized data" checked={parameters?.flatten} onChange={e => changeParameter("flatten", e.target.checked)} /><ContextLabel label="Flatten normalized data" open={event => showContext(event, { kind: "field", field: "flatten" })}>Flatten normalized data</ContextLabel></label><label className="ath-check"><input type="checkbox" aria-label="Fix edge step" disabled={active.frozen || typeof (parameters?.step ?? active.result?.effective.edge_step) !== "number"} checked={parameters?.step !== null} onChange={event => changeParameter("step", event.target.checked ? Number(active.result?.effective.edge_step) : null)} /><ContextLabel label="Fix edge step" open={event => showContext(event, { kind: "field", field: "fix_step" })}>Fix edge step</ContextLabel></label><p className="ath-hint">Values marked Automatic are calculated from this spectrum. Edit a value to override it; clear it to return to automatic.</p></fieldset>{active.data_type === "detector" && <div className="ath-fields">{field("energy_shift", "Energy shift", "eV")}</div>}</details>
        <fieldset className="ath-e0-fields" disabled={active.data_type === "xanes" || active.data_type === "chi" || active.data_type === "detector"}><details open><summary><ContextLabel label="Background removal" open={event => showContext(event, { kind: "section", section: "background" })}>Background removal <small>AUTOBK</small></ContextLabel></summary><div className="ath-fields">{field("rbkg", "Rbkg", "Å")}{field("bkg_kweight", "Spline k-weight")}{field("bkg_kmin", "Spline k min", "Å⁻¹")}{field("bkg_kmax", "Spline k max", "Å⁻¹", true)}{splineEnergyField("bkg_kmin", "Spline energy min")}{splineEnergyField("bkg_kmax", "Spline energy max")}{field("clamp_lo", "Low clamp")}{field("clamp_hi", "High clamp")}{field("bkg_dk", "Spline dk", "Å⁻¹")}{field("nclamp", "Clamp points")}{selectParameter("bkg_window", "Spline window")}</div><p className="ath-hint">Spline energy is relative to E₀; energy and k limits update each other. Use ⌖ to pick a plotted x value or type either limit. Changes process automatically.</p>
          <label className="ath-check"><input type="checkbox" aria-label="Energy-dependent normalization" checked={parameters?.fnorm ?? false} disabled={active.frozen || active.data_type !== "mu"} onChange={e => changeParameter("fnorm", e.target.checked)} /><ContextLabel label="Energy-dependent normalization" open={event => showContext(event, { kind: "field", field: "fnorm" })}>Energy-dependent normalization</ContextLabel></label><p className="ath-hint">For low-energy fluorescence EXAFS in raw μ(E) groups, with well-chosen pre/post-edge fits. Affects χ(k), not the energy plot. Changes process automatically.</p>
          <label className="ath-field" htmlFor="ath-background-standard"><ContextLabel label="Background removal standard" open={event => showContext(event, { kind: "field", field: "background_standard_id" })}>Background removal standard</ContextLabel><select id="ath-background-standard" disabled={active.frozen} aria-label="Background removal standard" value={backgroundStandard} onChange={e => { cancelPick(); setStandardDrafts(d => ({ ...d, [active.id]: e.target.value })) }}><option value="">None</option>{backgroundStandard && !backgroundStandards.some(g => g.id === backgroundStandard) && <option disabled value={backgroundStandard}>Unavailable standard</option>}{backgroundStandards.map(g => <option key={g.id} value={g.id}>{g.label}</option>)}</select></label><button disabled={active.frozen || backgroundStandard === (active.background_standard_id ?? "")} onClick={() => { void applyBackgroundStandard() }}>Apply standard</button><p className="ath-hint">Uses the standard’s live processed χ(k). Apply standard saves this choice and processes the current group with saved parameters. Parameter copy uses the saved standard, so apply a new choice first. Other parameter edits process automatically. Frozen groups are skipped.</p>
        </details></fieldset>
        <fieldset className="ath-e0-fields" disabled={active.data_type === "xanes" || active.data_type === "detector"}><details open><summary><ContextLabel label="Forward Fourier transform" open={event => showContext(event, { kind: "section", section: "forward" })}>Forward Fourier transform <small>k → R</small></ContextLabel></summary><div className="ath-fields">{field("kmin", "FT k min", "Å⁻¹")}{field("kmax", "FT k max", "Å⁻¹", true)}{field("dk", "dk", "Å⁻¹")}{field("kweight", "FT k-weight")}{selectParameter("window", "Window")}</div></details>
        <details><summary><ContextLabel label="Backward Fourier transform" open={event => showContext(event, { kind: "section", section: "reverse" })}>Backward Fourier transform <small>R → q</small></ContextLabel></summary><div className="ath-fields">{field("rmin", "R min", "Å")}{field("rmax", "R max", "Å")}{field("dr", "dR", "Å")}{selectParameter("rwindow", "Window")}</div></details>
        <details><summary>Transform grid</summary><div className="ath-fields">{field("nfft", "FFT points")}{field("kstep", "k step", "Å⁻¹")}</div></details></fieldset>
      </fieldset><div className="ath-apply"><label className="ath-check"><input type="checkbox" aria-describedby="ath-auto-apply-hint" checked={applyMarked} disabled={!!busy || parameterUpdateRunning || !can("parameters")} onChange={e => changeApplyMarked(e.target.checked)} />Apply to marked groups ({marked.length})</label><p className="ath-hint" id="ath-auto-apply-hint">{applyMarked ? "Changes automatically copy to the marked groups when you finish editing; the current group changes only if it is marked. Frozen groups are skipped and energy shifts are preserved." : "Changes apply automatically to the current group when you finish editing."}</p>{dirty && activeAutoApplyPlan?.status === "failed" && <button className="ath-primary" disabled={!!busy || active.frozen} onClick={() => retryParameterChanges(activeAutoApplyPlan)}>Retry processing</button>}{active.processing_error && <button className="ath-primary" disabled={!!busy || active.frozen || !!activeAutoApplyPlan} onClick={() => { void reprocessActive() }}>{busy === "Reprocessing spectrum" ? "Reprocessing…" : "Reprocess spectrum"}</button>}{active.processing_error && active.frozen && <p className="ath-hint">Unfreeze this group to reprocess it.</p>}<button disabled={!!busy || parameterUpdatePending} className="ath-reset" onClick={openParameterControls}>Copy / reset parameters…</button>{dirty && <button disabled={!!busy} className="ath-reset" onClick={() => discardParameterChanges(active.id)}>Discard parameter changes</button>}</div></>}</aside>}
    />
    <footer className="ath-status" role="status"><span><i className={error ? "error" : ""} />{busy || message}</span><span>{project ? `${project.groups.length} groups · revision ${project.version}` : ""}<b>Athena Web</b>Powered by Larch</span></footer>

    {modal === 'datatype' && project && <Modal title="Change data type" close={() => { if (!busy) setModal(null) }}><AthenaDatatype project={project} activeId={active?.id ?? ''} selectGroup={setActiveId} busy={!!busy} error={error} clearError={() => setError('')} close={() => setModal(null)} apply={async (ids, type) => {
      let saved: AthenaProject | null = null
      await task('Changing data type', async () => { saved = await command('change_datatype', ids, { data_type: type }); setSpace('E'); setAnalysisVisible(false) })
      return saved
    }} /></Modal>}
    {modal === "edge_policy" && <EdgePolicyDialog policy={edgePolicy} apply={policy => { updateEdgePolicy(policy); setMessage(`Import edge enforcement · ${edgePolicyDescription(policy)}`) }} close={() => setModal(null)} />}
    {modal === "edge_identity" && active && <EdgeIdentityDialog key={`${project?.id}:${active.id}`} group={active} busy={!!busy} error={error} clearError={() => setError("")} save={saveEdgeIdentity} close={() => setModal(null)} />}
    {modal === 'rebin' && project && <Modal title="Rebin data" wide close={() => { if (!busy) setModal(null) }}>
      <AthenaRebin key={project.id} project={project} activeId={activeId} selectGroup={setActiveId}
        grid={rebinGrid} setGrid={rebinDefaults.edit} setBusy={setBusy}
        defaultsControls={<RebinDefaultsControls state={rebinDefaults} disabled={!!busy} />}
        saved={next => { accept(next); setMessage('Rebinned groups saved') }} />
    </Modal>}
    {modal === 'multi_electron' && project && <Modal title="Multi-electron excitation" wide close={() => { if (!busy) setModal(null) }}>
      <AthenaMEE key={project.id} project={project} activeId={activeId} selectGroup={setActiveId} setBusy={setBusy} disabled={!!busy}
        close={() => setModal(null)} saved={next => { const added = next.groups.find(g => !project.groups.some(old => old.id === g.id)); accept(next); if (added) setActiveId(added.id); setMessage('MEE-corrected group saved') }} />
    </Modal>}
    {(modal === 'deglitch' || modal === 'truncate') && project && <Modal title="Deglitch and truncate" wide close={() => { if (!busy) setModal(null) }}>
      <AthenaPointEdit key={project.id} project={project} activeId={activeId} selectGroup={setActiveId} initialMode={modal === 'truncate' ? 'truncate' : 'point'} initialDraft={pointEditDraft} rememberDraft={setPointEditDraft} setBusy={setBusy} disabled={!!busy} close={() => setModal(null)} saved={next => { accept(next); setMessage('Point edit applied') }} />
    </Modal>}
    {modal === 'calibrate' && project && <Modal title="Calibrate energy" wide close={() => { if (!busy) setModal(null) }}>
      <AthenaCalibration key={project.id} project={project} activeId={activeId} selectGroup={setActiveId} initialDraft={calibrationDraft} rememberDraft={setCalibrationDraft} setBusy={setBusy} disabled={!!busy} close={() => setModal(null)} saved={next => { accept(next); setMessage('Energy calibrated') }} />
    </Modal>}
    {modal === 'convolve' && project && <Modal title="Convolve data" wide close={() => { if (!busy) setModal(null) }}>
      <AthenaConvolution key={project.id} project={project} activeId={activeId} selectGroup={setActiveId} setBusy={setBusy} disabled={!!busy} initialDraft={convolutionDraft} rememberDraft={setConvolutionDraft}
        close={() => setModal(null)} saved={next => { const added = next.groups.find(g => !project.groups.some(old => old.id === g.id)); accept(next); if (added) setActiveId(added.id); setMessage('Convolved/noisy group saved') }} />
    </Modal>}
    {modal === 'smooth' && project && <Modal title="Smooth data" wide close={() => { if (!busy) setModal(null) }}>
      <AthenaSmoothing key={project.id} project={project} activeId={activeId} selectGroup={setActiveId} setBusy={setBusy} disabled={!!busy} initialDraft={smoothingDraft} rememberDraft={setSmoothingDraft}
        close={() => setModal(null)} saved={next => { const added = next.groups.find(g => !project.groups.some(old => old.id === g.id)); accept(next); if (added) setActiveId(added.id); setMessage('Smoothed group saved') }} />
    </Modal>}
    {modal === "difference" && project && <AthenaDifferenceDialog key={project.id} project={project} activeId={activeId} getProject={() => projectRef.current} selectData={id => { setActiveId(id); setAnalysisVisible(false) }} onSaved={next => {
      accept(next)
      const added = next.last_operation?.difference_results
      setActiveId(added?.at(-1)?.group_id ?? next.groups.at(-1)?.id ?? activeId)
      setMessage(`Difference groups saved · ${added?.length ?? next.groups.length - project.groups.length} created`)
    }} onBusyChange={setBusy} close={() => setModal(null)} disabled={!!busy} />}
    {modal === 'merge_plot' && project && active && <Modal title="Saved merge spread" wide close={()=>setModal(null)}><AthenaMergePlot key={project.id} project={project} groupId={active.id} selectGroup={setActiveId} close={()=>setModal(null)}/></Modal>}
    {modal === 'diagnostic_plot' && project && active && <Modal title="Diagnostic plots" wide close={()=>setModal(null)}><AthenaDiagnosticPlot key={project.id} project={project} groupId={active.id} selectGroup={setActiveId} close={()=>setModal(null)}/></Modal>}
    {modal === "merge" && project && <Modal title="Merge marked groups" wide close={() => { if (!busy) setModal(null) }}><AthenaMerge key={project.id} project={project} initialDraft={mergeDraft} initialArray={mergeInitialArray} rememberDraft={setMergeDraft} disabled={!!busy} setBusy={setBusy} saved={(next,id) => { accept(next); setActiveId(id); setMessage('Merged spectra saved') }} close={() => setModal(null)} /></Modal>}
    {modal === "align" && project && <Modal title="Align scans" wide close={() => { if (!busy) setModal(null) }}><AthenaAlignment key={`${project.id}:${activeId}`} project={project} activeId={activeId} selectGroup={setActiveId} initialDraft={alignmentDraft} rememberDraft={setAlignmentDraft} disabled={!!busy} setBusy={setBusy} saved={next => { accept(next); setMessage('Energy alignment saved') }} close={() => setModal(null)} /></Modal>}
    {modal === "dispersive" && project && <Modal title="Dispersive energy calibration" wide close={() => { if (!busy) setModal(null) }}><AthenaDispersive project={project} activeId={activeId} setBusy={setBusy} onSaved={next => { const added=next.groups.find(g=>!project.groups.some(old=>old.id===g.id)); accept(next); if(added)setActiveId(added.id) }} /></Modal>}
    {modal === "beamline" && <Modal title="Beamline identification" close={() => setModal(null)}><div className="ath-modal-body"><AthenaBeamlinePreferences close={() => setModal(null)} /></div></Modal>}
    {modal === 'parameter_report' && project && <Modal title="Excel parameter report" wide close={() => { if (!busy) setModal(null) }}>
      <div className="ath-modal-body"><AthenaParameterReport key={`${project.id}:${reportScope}`} project={project} initialScope={reportScope}
        close={() => { if (!busy) setModal(null) }} onBusyChange={pending => setBusy(pending ? 'Preparing parameter report' : '')} /></div>
    </Modal>}
    {modal === "data_export" && project && active && <Modal title="Export column data" close={() => { if (!busy) setModal(null) }}>
      <div className="ath-modal-body"><AthenaDataExport key={`${project.id}:${active.id}`} project={project} groupId={active.id}
        close={() => { if (!busy) setModal(null) }} onBusyChange={pending => setBusy(pending ? 'Preparing export' : '')} /></div>
    </Modal>}
    {modal === 'xdi' && active && project && <Modal title="File metadata" close={() => { if (!busy) setModal(null) }}>
      <div className="ath-modal-body"><AthenaXDIControls key={`${project.id}:${active.id}`} projectId={project.id} groupId={active.id}
        onSaved={accept} onBusyChange={pending => setBusy(pending ? 'File metadata' : '')} close={() => setModal(null)} /></div>
    </Modal>}
    {modal === "plugins" && <Modal title="Plugin registry" close={closePluginRegistry}><div className="ath-modal-body"><AthenaPluginRegistry onPendingChange={setRegistryPending} /><div className="ath-modal-actions"><button disabled={registryPending} onClick={closePluginRegistry}>{registryReturn.current === "import" ? "Return to import" : "Close registry"}</button></div></div></Modal>}
    {modal === "context_report" && contextReport && <Modal title={contextReport.title} wide close={() => setModal(null)}><div className="ath-modal-body"><AthenaContextReport key={`${contextReport.project.id}:${contextReport.project.version}:${contextReport.kind}:${contextReport.groups.map(g => g.id).join()}`} {...contextReport} /><div className="ath-modal-actions"><button onClick={() => setModal(null)}>Close report</button></div></div></Modal>}
    {modal === "rename" && active && <Modal title="Rename current group" close={() => { if (!busy) setModal(null) }}><form className="ath-modal-body" onSubmit={event => { event.preventDefault(); void task('Renaming group', async () => { await command('metadata', [active.id], { label: String(options.label).trim() }); setModal(null) }) }}><p>{active.label}</p>{optionText('label', 'New group label')}{error && <p role="alert" className="ath-error">{error}</p>}<div className="ath-modal-actions"><button type="button" disabled={!!busy} onClick={() => setModal(null)}>Cancel</button><button className="ath-primary" disabled={!!busy || !String(options.label ?? '').trim()}>Rename group</button></div></form></Modal>}
    {modal === "special_plot" && project && active && <Modal title="Athena plot shortcuts" wide close={() => setModal(null)}><div className="ath-modal-body"><label className="ath-field"><span>Plot shortcut</span><select aria-label="Plot shortcut" value={specialPlot} onChange={event => setSpecialPlot(event.target.value as AthenaSpecialPlotKind)}>{Object.entries(athenaSpecialPlotLabels).map(([kind, label]) => <option value={kind} key={kind}>{label}</option>)}</select></label><AthenaSpecialPlot kind={specialPlot} groups={project.groups} active={active} projectId={project.id} version={project.version} energyMode={energyMode} component={component} offset={offset} selectGroup={setActiveId} /><div className="ath-modal-actions"><button onClick={() => setModal(null)}>Close plot shortcuts</button></div></div></Modal>}
    {contextMenu && <AthenaContextMenu key={`${contextMenu.groupId}:${JSON.stringify(contextMenu.target)}:${contextMenu.anchor.x}:${contextMenu.anchor.y}`} label={`Actions for ${active?.label}`} items={contextItems(contextMenu.target)} anchor={contextMenu.anchor} returnFocus={contextMenu.trigger} onClose={() => setContextMenu(null)} />}
    {modal === "e0" && <E0Dialog key={`${project?.id}:${active?.id}`} project={project} active={active} busy={!!busy} error={error} clearError={() => setError("")} selectGroup={id => { setActiveId(id); setAnalysisVisible(false) }} close={() => setModal(null)} apply={applySelectedE0} />}
    {modal === "groups" && <Modal title="Mark / freeze groups" close={() => { if (!busy) setModal(null) }}><div className="ath-modal-body ath-group-controls">
      <p className="ath-hint">Actions use the full group list, including groups hidden by search, and keep the current group selected. Frozen groups can still be marked or unfrozen.</p>
      <fieldset disabled={!!busy}><legend>Mark groups</legend><div className="ath-bulk-actions">
        <button disabled={!project?.groups.length} onClick={() => setGroupFlags("marked", true, project?.groups ?? [])}>Mark all</button>
        <button disabled={!project?.groups.length} onClick={() => setGroupFlags("marked", false, project?.groups ?? [])}>Mark none</button>
        <button disabled={!project?.groups.length} onClick={invertMarks}>Invert marks</button>
      </div></fieldset>
      <label className="ath-field"><span>JavaScript regular expression</span><input value={groupPattern} aria-describedby="ath-regex-hint" onChange={e => { setGroupPattern(e.target.value); setError("") }} placeholder="e.g. ^Foil|standard$" /></label>
      <p id="ath-regex-hint" className="ath-hint">Match group labels using JavaScript syntax, without / delimiters. Perl-specific regex features are unavailable. A blank pattern selects no groups.</p>
      <label className="ath-check"><input type="checkbox" checked={ignoreCase} onChange={e => { setIgnoreCase(e.target.checked); setError("") }} />Ignore case</label>
      <p aria-live="polite">{matchingGroups.length} matching groups</p>
      <div className="ath-bulk-actions"><button disabled={!!busy || !!patternError || !matchingGroups.length} onClick={() => setGroupFlags("marked", true, matchingGroups)}>Mark matching</button><button disabled={!!busy || !!patternError || !matchingGroups.length} onClick={() => setGroupFlags("marked", false, matchingGroups)}>Unmark matching</button></div>
      <fieldset disabled={!!busy}><legend>Freeze groups</legend><label className="ath-field"><span>Freeze targets</span><select value={freezeTarget} onChange={e => setFreezeTarget(e.target.value as typeof freezeTarget)}><option value="current">Current group</option><option value="marked">Marked groups</option><option value="all">All groups</option><option value="matching">Matching labels</option></select></label><p className="ath-hint">{freezeTargets.length} targets. Freezing protects processing parameters; marking remains available.</p><div className="ath-bulk-actions">
        <button disabled={!freezeTargets.length || (freezeTarget === "matching" && !!patternError)} onClick={() => setGroupFlags("frozen", true, freezeTargets)}>Freeze targets</button>
        <button disabled={!freezeTargets.length || (freezeTarget === "matching" && !!patternError)} onClick={() => setGroupFlags("frozen", false, freezeTargets)}>Unfreeze targets</button>
      </div></fieldset>
      {(patternError || error) && <div className="ath-error" role="alert">{patternError || error}</div>}
      <div className="ath-modal-actions"><button disabled={!!busy} onClick={() => setModal(null)}>Close</button></div>
    </div></Modal>}
    {modal === "parameters" && <Modal title="Copy / reset parameters" close={() => { if (!busy) setModal(null) }}><div className="ath-modal-body">
      <p>Copy from <strong>{active?.label}</strong>, including any parameter edits still waiting to process, or restore processing defaults for the destination groups.</p>
      <div className="ath-fields">
        <label className="ath-field"><span>Parameters to change</span><select disabled={!!busy} value={parameterScope} onChange={e => setParameterScope(e.target.value as ParameterSection | "single")}><option value="all">All processing parameters</option>{Object.entries(parameterSections).map(([key, section]) => <option key={key} value={key}>{section.label}</option>)}<option value="single">Single parameter</option></select></label>
        <label className="ath-field"><span>Destination groups</span><select disabled={!!busy} value={parameterTarget} onChange={e => setParameterTarget(e.target.value as typeof parameterTarget)}><option value="marked">Marked groups ({marked.length})</option><option value="all">All groups ({project?.groups.length ?? 0})</option><option value="current">Current group</option></select></label>
        {parameterScope === "single" && <label className="ath-field"><span>Parameter</span><select disabled={!!busy} value={parameterKey} onChange={e => setParameterKey(e.target.value as keyof Parameters)}>{Object.entries(parameterSections).map(([key, section]) => <optgroup key={key} label={section.label}>{section.keys.map(key => <option key={key} value={key}>{parameterLabels[key]}</option>)}</optgroup>)}<option value="energy_shift">Energy shift</option></select></label>}
      </div>
      <p className="ath-hint">Frozen groups and groups with frozen tied references are skipped. {parameterScope === "single" && parameterKey === "energy_shift" ? "Energy shift is explicitly selected and will change." : "Energy shifts are preserved."}</p>
      <p>{parameterTargets.length} destination group{parameterTargets.length === 1 ? "" : "s"} selected.</p>
      {error && <div className="ath-error" role="alert">{error}</div>}
      <div className="ath-modal-actions"><button disabled={!!busy} onClick={() => setModal(null)}>Cancel</button>{(["reset_parameters", "copy_parameters"] as const).map(action => <button key={action} className={action === "copy_parameters" ? "ath-primary" : undefined} disabled={!!busy || !parameterTargets.some(g => !g.frozen)} onClick={() => { void updateSharedParameters(action, parameterTargets, parameterScope === "single" ? { parameter: parameterKey } : { section: parameterScope }, true) }}>{action === "copy_parameters" ? "Copy parameters" : "Reset to defaults"}</button>)}</div>
    </div></Modal>}

    {modal === "learn" && <Modal title="Learn Athena" close={() => setModal(null)}><div className="ath-modal-body"><p className="ath-intro">From your first spectrum to EXAFS analysis.</p><p className="ath-hint">Tutorials and demonstrations from Athena’s author and the XAS community. This web implementation is under development; the desktop manual describes additional capabilities.</p><div className="ath-resource-grid">{resources.map(r => <a key={r.url} href={r.url} target="_blank" rel="noreferrer"><span>{r.kind}<ExternalLink size={13} /></span><h3>{r.title}</h3><small>{r.author}</small><p>{r.description}</p></a>)}</div><p className="ath-hint">Video references were identified through the <a href="https://xafs.xrayabsorption.org/videos.html" target="_blank" rel="noreferrer">IXAS video index</a>. Athena / Demeter is by Bruce Ravel; this is an independent web implementation using XrayLarch.</p></div></Modal>}
    {modal === "import" && <Modal title="Import spectra" wide close={() => { if (!busy) setModal(null) }}><div className="ath-modal-body">{importPolicyNotice()}<div className="ath-modal-actions"><button type="button" disabled={!!busy} onClick={openPluginRegistry}>File plugins…</button>{inspection && files[0] && !('inspection' in files[0]) && <button type="button" disabled={!!busy} onClick={() => { void task('Reinspecting ' + files[0].name, async () => { await inspectFile(files[0]) }) }}>Reinspect selected file</button>}</div>{inspection?.file_plugin && <p className="ath-hint">This preview uses the reader settings from the last inspection. After changing file plugins, reinspect the selected file to update its columns and preview.</p>}{archiveSelection ? <AthenaArchiveSelection key={archiveSelection.upload_id} archive={archiveSelection} projectId={project!.id} busy={!!busy} onContinue={selected => { void reviewArchive(selected) }} onCancel={() => { setArchiveSelection(null); setInspection(null); setFiles([]) }} /> : scanSelection ? <AthenaScanSelection key={scanSelection.scans[0]?.upload_id} collection={scanSelection} projectId={project!.id} version={project!.version} busy={!!busy} onContinue={selected => { void reviewScans(selected) }} onCancel={() => { setScanSelection(null); setInspection(null); setFiles([]) }} /> : !inspection ? <><label className="ath-upload-zone"><Upload size={30} /><strong>Choose data files</strong><span>ASCII, CSV, XDI, XMU, SPEC scans, Athena .prj, ZIP · multiple files supported</span><input ref={fileInput} type="file" multiple aria-label="Choose data files" disabled={!!busy || !project} onChange={e => { void queueFiles(Array.from(e.target.files ?? [])) }} /></label><p className="ath-hint">Athena projects open with a group preview and selection. You can also drop data files or projects onto the workbench.</p></> : <AthenaColumnSelection key={inspection.upload_id} groups={project!.groups} projectId={project!.id} version={project!.version} inspection={inspection} mapping={mapping} setMapping={setImportMapping} rebinDefaults={<RebinDefaultsControls state={rebinDefaults} disabled={!!busy} />} busy={!!busy} remaining={files.length} reuseMapping={reuseMapping} setReuseMapping={setReuseMapping} chooseAnother={() => { setInspection(null); setFiles([]) }} importCurrent={reviewed => { void importCurrent(reviewed) }} />}{error && <div className="ath-error" role="alert">{error}</div>}</div></Modal>}
    {modal === "open" && <Modal title="Open a project" close={() => { if (!busy) setModal(null) }}><div className="ath-modal-body"><AthenaProjectImport initialFiles={projectFiles} initialPreview={projectPreview} onRemainingFiles={incoming => { void queueFiles(incoming) }} getProject={() => projectRef.current} onImported={p => { accept(p); setActiveId(p.groups.at(-1)?.id ?? "") }} onComplete={() => { setProjectFiles([]); setProjectPreview(null); setModal(null); setMessage("Project import · complete") }} onBusyChange={setBusy} disabled={!!busy || !project} /><h3>Recent local projects</h3><div className="ath-recent">{recent.map(p => <button key={p.id} disabled={!!busy} onClick={() => { void task("Opening project", async () => { accept(await athenaApi(`/projects/${p.id}`)); setDrafts({}); setModal(null) }) }}><FolderOpen size={18} /><span><strong>{p.name}</strong><small>{p.count} groups · {new Date(p.updated).toLocaleString()}</small></span></button>)}</div>{error && <div className="ath-error" role="alert">{error}</div>}</div></Modal>}
    {modal === "journal" && <Modal title="Project journal" close={() => setModal(null)}><div className="ath-modal-body"><label className="ath-field"><span>Project name</span><input value={projectName} onChange={e => setProjectName(e.target.value)} /></label><label className="ath-field"><span>Notes, observations, and analysis decisions</span><textarea rows={8} value={journal} onChange={e => setJournal(e.target.value)} placeholder="Record sample details, beamline conditions, and processing choices…" /></label><h3>Processing history</h3><div className="ath-history">{project?.history.slice().reverse().map((h, i) => <div key={i}><small>{new Date(h.time).toLocaleTimeString()}</small><span>{h.message}</span></div>)}</div>{error && <div className="ath-error" role="alert">{error}</div>}<div className="ath-modal-actions"><button className="ath-primary" disabled={!!busy} onClick={() => { void task("Saving journal", async () => { await command("project", [], { name: projectName, journal }); setModal(null) }) }}>Save journal</button></div></div></Modal>}
    {modal && modal !== "difference" && modal !== "rebin" && modal !== "dispersive" && modal !== 'multi_electron' && modal !== 'smooth' && modal !== 'convolve' && modal !== 'deglitch' && modal !== 'truncate' && modal !== 'calibrate' && modal !== 'align' && modal !== 'merge' && toolTitles[modal] && <Modal title={toolTitles[modal]} close={() => { if (!busy) setModal(null) }}><div className="ath-modal-body"><p className="ath-tool-target">Current group <strong>{active?.label}</strong></p>
      {modal === "metadata" ? <>{optionText("label", "Group label")}<label className="ath-field"><span>Notes</span><textarea rows={4} value={String(options.notes ?? "")} onChange={e => setOptions(o => ({ ...o, notes: e.target.value }))} /></label><h3><ContextLabel label="Plot parameters" open={event => showContext(event, { kind: "section", section: "plot" })}>Plot parameters</ContextLabel></h3><div className="ath-fields">{optionNumber("multiplier", "Plot multiplier")}{optionNumber("offset", "Plot offset")}{optionNumber("importance", "Importance")}</div><div className="ath-fields"><ContextLabel label="Element" open={event => showContext(event, { kind: "field", field: "element" })}>Element: {String(active?.result?.effective.element ?? "Unknown")}</ContextLabel><ContextLabel label="Edge" open={event => showContext(event, { kind: "field", field: "edge" })}>Edge: {String(active?.result?.effective.edge ?? "Unknown")}</ContextLabel></div><label className="ath-field"><span>Reference group</span><select value={String(options.reference_id)} onChange={e => setOptions(o => ({ ...o, reference_id: e.target.value }))}><option value="">None</option>{project?.groups.filter(g => g.id !== active?.id).map(g => <option value={g.id} key={g.id}>{g.label}</option>)}</select></label><AthenaBeamlineMetadata value={active?.source?.beamline_metadata} /><AthenaBeamlineMetadata value={active?.source?.xdi_metadata} /><details><summary>Source metadata</summary><pre>{JSON.stringify(active?.source, null, 2)}</pre></details></> : <>
      {combining && <><p>{"Add marked spectra over their common range. Signed coefficients are used unchanged, so negative values subtract a spectrum."}</p><label className="ath-field"><span>Signal to combine</span><select disabled={!!busy} value={combineArray} onChange={e => setCombineArray(e.target.value as typeof combineArray)}><option value="">Original data (same type)</option><option value="mu" disabled={!canCombineMu}>μ(E)</option><option value="norm" disabled={!canCombineNorm}>Normalized μ(E)</option><option value="chi" disabled={!canCombineChi}>χ(k)</option></select></label><p className="ath-hint">Original data keeps the existing signal and requires matching data types. Choose a common signal to combine different types. χ(k) requires processed EXAFS for every marked group and overlapping k ranges.</p><div className="ath-fields">{marked.map(g => <label className="ath-field" key={g.id}><span>{"Coefficient"}: {g.label}</span><input type="number" step="any"  disabled={!!busy} value={combineWeights[g.id] ?? ""} onChange={e => setCombineWeights(weights => ({ ...weights, [g.id]: e.target.value === "" ? null : Number(e.target.value) }))} /></label>)}</div>{marked.length < 2 && <p className="ath-hint">Mark at least two groups to combine.</p>}<p className="ath-hint">A new group is created. Undo is available from the project toolbar.</p></>}
      {["lcf", "pca", "peaks", "deconvolve"].includes(modal) && <div className="ath-fields">{optionNumber("xmin", "Range minimum", "eV")}{optionNumber("xmax", "Range maximum", "eV")}</div>}
      {modal === "deconvolve" && <><p>{"Remove instrumental broadening over the selected energy interval using Larch’s deconvolution. The input is normalized first. This can amplify noise; inspect the derived spectrum."}</p><div className="ath-fields">{optionNumber("width", options.kind === "gaussian" ? "Gaussian sigma" : "Lorentzian HWHM", "eV")}<label className="ath-field"><span>Line shape</span><select value={String(options.kind)} onChange={e => setOptions(o => ({ ...o, kind: e.target.value }))}><option value="gaussian">Gaussian</option><option value="lorentzian">Lorentzian</option></select></label></div></>}
      {modal === "self_absorption" && <><p>Larch’s thick, homogeneous sample approximation for fluorescence self-absorption. Provide composition and geometry appropriate to your measurement. The derived group contains the corrected normalized signal.</p><div className="ath-fields">{optionText("formula", "Sample formula")}{optionText("element", "Absorbing element")}{optionText("edge", "Absorption edge")}{optionNumber("angle_in", "Incident angle", "degrees")}{optionNumber("angle_out", "Exit angle", "degrees")}</div></>}
      {modal === "copy_series" && <><p>Make a series of independent copies to explore how one parameter affects the result.</p><label className="ath-field"><span>Parameter</span><select value={String(options.parameter)} onChange={e => setOptions(o => ({...o, parameter:e.target.value}))}>{["rbkg", "e0", "kmin", "kmax", "dk", "rmin", "rmax", "energy_shift"].map(key => <option key={key}>{key}</option>)}</select></label><div className="ath-fields">{optionNumber("start", "Start value")}{optionNumber("stop", "End value")}{optionNumber("count", "Number of copies")}</div></>}
      {modal === "log_ratio" && <><p>Compare amplitudes and phases of a common isolated shell. Set identical E₀, k windows, R windows, and k-weights on both groups before running this analysis.</p><label className="ath-field"><span>Reference spectrum</span><select value={String(options.reference_id)} onChange={e => setOptions(o => ({...o, reference_id:e.target.value}))}>{project?.groups.filter(g => g.id !== active?.id).map(g => <option value={g.id} key={g.id}>{g.label}</option>)}</select></label><div className="ath-fields">{optionNumber("kmin", "Reliable k minimum", "Å⁻¹")}{optionNumber("kmax", "Reliable k maximum", "Å⁻¹")}{optionNumber("phase_offset", "Phase branch", "multiples of 2π")}<label className="ath-field"><span>Maximum cumulant</span><select value={Number(options.max_cumulant)} onChange={e => setOptions(o => ({...o, max_cumulant:Number(e.target.value)}))}>{[2,3,4].map(n => <option value={n} key={n}>{n}</option>)}</select></label></div><p className="ath-hint">Fits report effective target-minus-reference cumulants. Different scattering species, inconsistent calibration, or overlapping shells invalidate this interpretation.</p></>}
      {["lcf", "pca", "peaks"].includes(modal) && <><label className="ath-field"><span>Fit signal</span><select value={String(options.array)} onChange={e => setOptions(o => ({ ...o, array: e.target.value }))}><option value="norm">Normalized μ(E)</option><option value="flat">Flattened μ(E)</option><option value="dmude">Derivative dμ/dE</option><option value="chi">χ(k) — range in Å⁻¹</option></select></label>{modal !== "peaks" && <><p className="ath-hint">{modal === "lcf" ? "The current group is the target. Choose at least two standards below." : "Choose the spectra for a common-grid principal component analysis."}</p><div className="ath-fit-groups">{project?.groups.filter(g => modal !== "lcf" || g.id !== active?.id).map(g => <label className="ath-check" key={g.id}><input type="checkbox" checked={fitSelection.includes(g.id)} onChange={e => setFitSelection(s => e.target.checked ? [...s, g.id] : s.filter(id => id !== g.id))} />{g.label}</label>)}</div></>}{modal === "lcf" && <div className="ath-fields">{["sum_to_one", "nonnegative"].map(key => <label className="ath-check" key={key}><input type="checkbox" checked={Boolean(options[key])} onChange={e => setOptions(o => ({ ...o, [key]: e.target.checked }))} />{key === "sum_to_one" ? "Weights sum to 1" : "Non-negative weights"}</label>)}</div>}{modal === "peaks" && <><p className="ath-hint">Fit one or more positive peaks with a linear background. Amplitude is integrated area; sigma is the line-shape width.</p>{peaks.map((peak, index) => <div className="ath-peak-editor" key={index}><header><h3>Peak {index + 1}</h3><button aria-label={`Remove peak ${index + 1}`} disabled={peaks.length === 1} onClick={() => setPeaks(p => p.filter((_, i) => i !== index))}><X size={14} /></button></header><div className="ath-fields">{(["center", "sigma", "amplitude"] as const).map(key => <NumberField key={key} label={`Peak ${index + 1} ${key}`} value={peak[key]} onChange={v => setPeaks(p => p.map((item, i) => i === index ? {...item, [key]: v ?? 0} : item))} />)}<label className="ath-field" htmlFor={`ath-peak-shape-${index}`}><ContextLabel label={`Peak ${index + 1} shape`} open={event => showContext(event, { kind: "peak", index })}>Peak {index + 1} shape</ContextLabel><select id={`ath-peak-shape-${index}`} aria-label={`Peak ${index + 1} shape`} value={peak.kind} onChange={e => setPeaks(p => p.map((item, i) => i === index ? {...item, kind:e.target.value} : item))}><option value="gaussian">Gaussian</option><option value="lorentzian">Lorentzian</option><option value="voigt">Voigt</option></select></label></div></div>)}<button disabled={peaks.length >= 8} onClick={() => setPeaks(p => [...p, {center: Number(options.xmin) + (Number(options.xmax) - Number(options.xmin)) * .5, sigma: 2, amplitude: 1, kind:"gaussian"}])}><Plus size={14} />Add peak</button></>}</>}
      </>}{error && <div className="ath-error" role="alert">{error}</div>}<div className="ath-modal-actions"><button disabled={!!busy} onClick={() => setModal(null)}>Cancel</button><button className="ath-primary" disabled={!!busy || !active || (combining && !combinationReady)} onClick={() => { void runTool() }}>{busy ? "Working…" : modal === "metadata" ? "Save group" : ["lcf", "pca", "peaks", "log_ratio"].includes(modal) ? "Run analysis" : "Apply"}</button></div></div></Modal>}
  </main>
}
