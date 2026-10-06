"use client"

import { SectionHelp } from "./section-help"
import { useState, type Dispatch, type SetStateAction, type ReactNode } from "react"
import type { InspectionResponse } from "@/lib/contracts"
import { energyProcessingSettings, type AthenaGroup } from "@/lib/athena"
import { numeratorRange, denominatorColumns, columnExpression, columnProblem, changeInputType, changeImportProcessing, flipSignalColumns, initialColumnMapping, setDualMode, defaultPreprocessing, suggestedReference, batchCapacityWarning, type ColumnMapping } from "@/lib/athena-import"
import { AthenaImportPreview } from "./athena-import-preview"
import { AthenaDownloadButton } from "./athena-download-button"
import { AthenaImportPreprocessing } from "./athena-import-preprocessing"
import { AthenaImportRebin } from "./athena-import-rebin"
import { AthenaReaderPreview } from "./athena-reader-preview"
import { AthenaBeamlineMetadata } from './athena-beamline-metadata'
import { AthenaDetectedBeamline } from './athena-supported-formats'
import styles from "./athena-column-selection.module.css"

export function AthenaColumnSelection({ projectId, version, inspection, mapping, setMapping, busy, remaining, reuseMapping, groups = [],
  setReuseMapping, chooseAnother, skipFile, importCurrent, rebinDefaults, batchNotice, error, initialReaderReviewed = false, replacement = false }: {
  projectId: string; version: number; inspection: InspectionResponse; mapping: ColumnMapping
  setMapping: Dispatch<SetStateAction<ColumnMapping>>; busy: boolean; remaining: number
  groups?: AthenaGroup[]
  rebinDefaults?: ReactNode
  reuseMapping: boolean | null; setReuseMapping: (value: boolean) => void; chooseAnother: () => void; importCurrent: (readerReviewed: boolean) => void
  // Leaves this file out and moves to the next one, keeping the rest of the queue.
  skipFile?: () => void
  batchNotice?: string
  // Why the last import was refused; shown beside the Import button, which
  // stays in view while the column controls scroll.
  error?: string
  initialReaderReviewed?: boolean
  replacement?: boolean
}) {
  const [range, setRange] = useState("")
  const [rangeError, setRangeError] = useState("")
  const [reviewed, setReviewed] = useState(initialReaderReviewed)
  function selectRange() {
    try {
      const indices = numeratorRange(range, inspection.columns.length)
      setMapping(m => ({ ...m, numerator: inspection.columns.filter((c, i) => m.numerator.includes(c.column_id)
        || (indices.includes(i) && c.column_id !== m.energy_column)).map(c => c.column_id) }))
      setRangeError("")
    } catch (err) { setRangeError(err instanceof Error ? err.message : "Check the column range.") }
  }
  const denominator = denominatorColumns(mapping)
  const problem = columnProblem(mapping)
  const capacity = batchCapacityWarning(mapping, inspection, groups, remaining)
  const hasReference = !!(mapping.reference_numerator || mapping.reference_denominator)
  const dualMode = !!mapping.additional_fluorescence
  const inputFormat = mapping.data_type === 'chi' || mapping.data_type === 'xmudat' ? mapping.data_type : 'mu'
  const processing = energyProcessingSettings(mapping)
  // A Demeter plugin's suggestion wins for its formats; otherwise the beamline
  // registry's, which also says which measurement shows the edge.
  const readerSuggestions = inspection.plugin_suggestions ?? inspection.beamline_reader?.suggestions
  const measurement = inspection.plugin_suggestions ? undefined : inspection.beamline_reader?.measurement
  const beamlineReference = suggestedReference(inspection)
  const columnName = (id: string) => inspection.columns.find(c => c.column_id === id)?.name ?? "1"
  const referenceName = beamlineReference ? `${columnName(beamlineReference.reference_numerator)}/${columnName(beamlineReference.reference_denominator)}` : ''
  const contrastNote = (mode: string) => {
    // When It/Iref is offered as the spectrum, its own contrast is the one behind the offer.
    const key = mode === 'transmission' && measurement?.foil_spectrum ? 'reference' : mode
    const value = measurement?.contrast[key]
    return value === undefined ? undefined : value === null ? 'No edge window in this scan'
      : `${key === 'reference' ? `${referenceName || 'It/Iref'} edge step` : 'Edge step'} ${value.toFixed(0)} times the pre-edge noise at ${measurement!.edge_energy.toFixed(0)} eV`
  }
  // A marginal I0/It edge beside a reference edge: the data cannot say which
  // was scanned, so nothing is imported until the user says.
  const foilSuggestion = measurement?.ambiguous ? inspection.beamline_reader?.suggestions?.foil : undefined
  const [beamChoice, setBeamChoice] = useState<'sample' | 'foil' | null>(null)
  // Each choice names its own channel's contrast, not one shared tooltip.
  const edgeTimes = (key: 'transmission' | 'reference', channel: string) => {
    const value = measurement?.contrast[key]
    return typeof value === 'number' ? ` · ${channel} edge step ${value.toFixed(0)} times its noise` : ''
  }
  function chooseBeam(choice: 'sample' | 'foil') {
    const suggestion = choice === 'foil' ? foilSuggestion : readerSuggestions?.transmission
    if (!suggestion) return
    setBeamChoice(choice)
    setMapping(m => ({ ...m, energy_column: suggestion.energy_column, units: suggestion.units, numerator: suggestion.numerator,
      denominator: suggestion.denominator ?? '', mode: suggestion.mode, individual_channels: false,
      ...(choice === 'foil' ? { reference_numerator: '', reference_denominator: '' } : beamlineReference ?? {}) }))
  }
  return <>
    <div className={styles.importHeader}>
      <p className={styles.fileSummary}><strong>{inspection.display_name}</strong><span className="ath-chip">{inspection.row_count} points{remaining > 1 ? ` · ${remaining} files remaining` : ""}</span></p>
      <div className={`ath-modal-actions ${styles.importActions}`} role="group" aria-label={replacement ? "Column change actions" : "Import actions"}><button type="button" disabled={busy} onClick={chooseAnother}>{replacement ? "Cancel" : "Choose another file"}</button>{!replacement && skipFile && remaining > 1 && <button type="button" disabled={busy} onClick={skipFile}>Skip this file</button>}<button type="button" className="ath-primary" disabled={busy || !!problem || (remaining > 1 && reuseMapping === null) || (!!inspection.file_plugin?.review_required && !reviewed) || (!!foilSuggestion && !beamChoice)} onClick={() => importCurrent(reviewed)}>{replacement ? busy ? "Applying…" : "Apply column changes" : busy ? "Importing…" : remaining > 1 && reuseMapping ? `Import ${remaining} files` : dualMode ? "Import both modes" : "Import spectrum"}</button></div>
      {error && <p className={`ath-error ${styles.headerError}`} role="alert">{error}</p>}
    </div>
    {remaining > 1 && <fieldset className={styles.batchChoice} disabled={busy}>
      <legend>Use the same import parameters for all files? <SectionHelp label="Batch import parameters">Set up this file once to import the remaining files automatically using the same column positions, units, and preprocessing settings. Missing columns or required reader reviews will pause the batch.</SectionHelp></legend>
      <div className={styles.batchOptions}>
        <label className="ath-check"><input type="radio" name="batch-import-parameters" checked={reuseMapping === true} onChange={() => setReuseMapping(true)} />Yes, use the same parameters</label>
        <label className="ath-check"><input type="radio" name="batch-import-parameters" checked={reuseMapping === false} onChange={() => setReuseMapping(false)} />No, review each file</label>
      </div>
    </fieldset>}
    {batchNotice && <p className="ath-warning" role="status">{batchNotice}</p>}
    {!replacement && capacity && <p className="ath-warning" role="status">{capacity}</p>}
    <AthenaDetectedBeamline reader={inspection.beamline_reader} columns={inspection.columns} />
    {inspection.file_plugin && <section aria-label="File conversion"><strong>{inspection.file_plugin.description}</strong> <SectionHelp label="File conversion">{inspection.file_plugin.summary}</SectionHelp></section>}
    <div className={styles.layout}>
      <div className={styles.controls}>
        <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
          {!replacement && inspection.remembered_columns && <section aria-label="Remembered import choices">
            <strong>{inspection.remembered_columns.matching_columns ? 'Previous import choices' : 'Suggested columns'}</strong> <SectionHelp label="Remembered import choices">{inspection.remembered_columns.matching_columns
              ? 'Matching column labels: started with the previous successful import choices. Check the expression and preview before importing.'
              : 'Different column labels: suggested detector columns, with references and rebinning off. The previous grid and preprocessing choices are available.'}</SectionHelp>
            {inspection.remembered_columns.warnings.map(w => <p key={w} className="ath-warning">{w}</p>)}
            <button type="button" onClick={() => setMapping(m => initialColumnMapping(inspection, { ...m,
              preprocessing: { ...defaultPreprocessing }, ...(m.rebin ? { rebin: { ...m.rebin, enabled: false, e0: null } } : {}) }, false, false))}>Use suggested columns</button>
          </section>}
          <div className="ath-fields">
            <label className="ath-field"><span>Input format{mapping.data_type === "xmudat" && <SectionHelp label="FEFF xmu.dat">FEFF μ(E) is already normalized. Select photon energy (omega) and μ; the relative e and k columns have different meanings. Normalization is not refitted.</SectionHelp>}</span><select value={inputFormat} onChange={e => setMapping(m => changeInputType(m, e.target.value as ColumnMapping["data_type"]))}><option value="mu">μ(E) · absorption</option><option value="chi">χ(k) · extracted EXAFS</option><option value="xmudat">FEFF xmu.dat · normalized μ(E)</option></select></label>
            <label className="ath-field"><span>Measurement <SectionHelp label="Measurement modes">When Transmission + fluorescence is selected, import transmission and fluorescence as separate groups from each file. Energy, preprocessing, rebinning, and reference settings apply to both.</SectionHelp></span><select value={dualMode ? "both" : mapping.mode} disabled={mapping.data_type === "chi"} onChange={e => {
              const mode = e.target.value
              setMapping(m => mode === "both" ? setDualMode(m, inspection, true) : {
                ...setDualMode(m, inspection, false), ...(mode === "fluorescence" && m.additional_fluorescence ? {
                  ...m.additional_fluorescence, individual_channels: m.additional_fluorescence.individual_channels ?? false,
                  invert: m.additional_fluorescence.invert ?? false, signal_multiplier: m.additional_fluorescence.signal_multiplier ?? 1,
                } : {}),
                mode: mode as ColumnMapping["mode"], ...(mode === "mu" ? { denominator: "" } : {}),
              })
            }}><option value="mu">Direct signal</option><option value="transmission">Transmission · ln(I₀ / It)</option><option value="fluorescence">Fluorescence / yield · signal / I₀</option>{!replacement && <option value="both">Transmission + fluorescence</option>}</select></label>
            <label className="ath-field"><span>{mapping.data_type === "chi" ? "k column" : "Energy column"}</span><select value={mapping.energy_column} onChange={e => setMapping(m => ({ ...m, energy_column: e.target.value, units: m.data_type === "chi" ? "eV" : inspection.column_units?.[e.target.value] ?? m.units }))}>{inspection.columns.map(c => <option value={c.column_id} key={c.column_id}>{c.name} · column {c.index + 1}</option>)}</select></label>
            <label className="ath-field"><span>Energy units{mapping.data_type !== "chi" && inspection.column_units?.[mapping.energy_column] && <SectionHelp label="Suggested energy units">Suggested energy units: {inspection.column_units[mapping.energy_column]}. You can override this choice.</SectionHelp>}</span><select value={mapping.units} disabled={mapping.data_type === "chi"} onChange={e => setMapping(m => ({ ...m, units: e.target.value as ColumnMapping["units"] }))}><option>eV</option><option>keV</option></select></label>
          </div>
          {inputFormat === 'mu' && <div className="ath-fields" role="group" aria-label="Processing options">
            <label className="ath-check"><input type="checkbox" checked={processing.is_normalized} onChange={e => setMapping(m => changeImportProcessing(m, { is_normalized: e.target.checked }))} />Input already normalized</label>
            <label className="ath-check"><input type="checkbox" checked={processing.exafs} onChange={e => setMapping(m => changeImportProcessing(m, { exafs: e.target.checked }))} />Enable EXAFS processing</label>
          </div>}
          {!replacement && <label className="ath-check"><input type="checkbox" checked={mapping.is_reference ?? false} onChange={e => setMapping(m => ({ ...m, is_reference: e.target.checked }))} />This is reference</label>}
          {readerSuggestions && mapping.data_type !== 'chi' && <div aria-label="Reader column suggestions">
            <strong>Reader columns</strong> <SectionHelp label="Reader column suggestions">Apply this reader’s suggested detector columns, then check the preview.</SectionHelp>
            {measurement?.notes.map(note => <p key={note} className="ath-hint">{note}</p>)}
            {foilSuggestion && <fieldset className={styles.batchChoice}>
              <legend>What did this scan measure? Choose before importing.</legend>
              <div className={styles.batchOptions}>
                <label className="ath-check"><input type="radio" name="sample-or-foil" checked={beamChoice === 'sample'} onChange={() => chooseBeam('sample')} />A sample: I0/It, with {referenceName || 'It/Iref'} as its reference{edgeTimes('transmission', 'I0/It')}</label>
                <label className="ath-check"><input type="radio" name="sample-or-foil" checked={beamChoice === 'foil'} onChange={() => chooseBeam('foil')} />A foil scan: {columnName(foilSuggestion.numerator[0])}/{columnName(foilSuggestion.denominator ?? '')} as the spectrum, no reference{edgeTimes('reference', `${columnName(foilSuggestion.numerator[0])}/${columnName(foilSuggestion.denominator ?? '')}`)}</label>
              </div>
            </fieldset>}
            {(['transmission', 'fluorescence'] as const).map(mode => {
              const suggestion = readerSuggestions[mode]
              return suggestion && <button key={mode} type="button" aria-pressed={!dualMode && mapping.mode === mode && sameColumns(mapping, suggestion)}
                title={contrastNote(mode)} onClick={() => setMapping(m => ({ ...m,
                energy_column: suggestion.energy_column, units: suggestion.units,
                ...(m.additional_fluorescence && mode === 'fluorescence'
                  ? { additional_fluorescence: { ...m.additional_fluorescence, numerator: suggestion.numerator,
                    denominator: suggestion.denominator ?? '', individual_channels: false } }
                  : { numerator: suggestion.numerator, denominator: suggestion.denominator ?? '', mode: suggestion.mode,
                    individual_channels: false }),
              }))}>Use {mode} columns{measurement?.mode === mode ? ' (edge found here)' : ''}</button>
            })}
            {beamlineReference && <button type="button" aria-pressed={hasReference} onClick={() => setMapping(m => hasReference
              ? { ...m, reference_numerator: '', reference_denominator: '' } : { ...m, ...beamlineReference })}>
              {hasReference ? 'Import without the reference' : `Import the ${referenceName} reference`}</button>}
          </div>}
          {hasReference && <p className="ath-formula">Reference = {(mapping.reference_log ?? true) ? "ln(|" : ""}{columnName(mapping.reference_numerator)} / {columnName(mapping.reference_denominator)}{(mapping.reference_log ?? true) ? "|)" : ""}</p>}
          {mapping.data_type !== "chi" && inspection.column_units && !inspection.column_units[mapping.energy_column] && <p className="ath-warning">Energy units could not be inferred. Choose eV or keV and inspect the plotted range.</p>}
          {dualMode && <h3 className={styles.modeTitle}>Transmission</h3>}
          <div className={styles.range}>
            <label className="ath-field"><span>Numerator column numbers</span><input value={range} placeholder="4-8, 11" onChange={e => { setRange(e.target.value); setRangeError("") }} /></label>
            <button type="button" onClick={selectRange}>Select range</button>
            <button type="button" onClick={() => { setMapping(m => ({ ...m, numerator: [] })); setRangeError("") }}>Clear numerator</button>
            <button type="button" disabled={mapping.data_type === "chi"} onClick={() => setMapping(m => ({ ...m, denominator: "" }))}>Clear denominator</button>
          </div>
          {rangeError && <p role="alert" className="ath-error">{rangeError}</p>}
          <div className="ath-column-table"><table><thead><tr><th>Numerator <SectionHelp label="Column calculation">{mapping.data_type === 'chi' ? 'χ(k) is read directly from the numerator columns. Absorption measurement controls are inactive.'
            : `${dualMode ? 'Choose the incident intensity (I₀) as numerator and transmitted intensity (It) as denominator.' : 'Unselected numerator or denominator uses 1.'} Multiple checked columns are added together. Flip swaps all numerator and denominator selections; the constant scales the imported signal.`}</SectionHelp></th><th>Denominator</th><th>Column</th><th>First values</th></tr></thead><tbody>{inspection.columns.map(c => <tr key={c.column_id}>
            <td><input type="checkbox" aria-label={`Numerator ${c.name}`} checked={mapping.numerator.includes(c.column_id)} onChange={e => setMapping(m => ({ ...m, numerator: e.target.checked ? [...m.numerator, c.column_id] : m.numerator.filter(v => v !== c.column_id) }))} /></td>
            <td><input type="checkbox" aria-label={`Denominator ${c.name}`} disabled={mapping.data_type === "chi"} checked={mapping.mode !== "mu" && denominator.includes(c.column_id)} onChange={e => setMapping(m => ({ ...m, mode: m.mode === "mu" ? "fluorescence" : m.mode, denominator: e.target.checked ? [...(m.mode === "mu" ? [] : denominatorColumns(m)), c.column_id] : denominatorColumns(m).filter(id => id !== c.column_id) }))} /></td>
            <td>{c.index + 1}. {c.name}</td><td>{c.preview.slice(0, 3).map(v => v === null ? "NaN" : v.toPrecision(5)).join(", ")}</td>
          </tr>)}</tbody></table></div>
          <p className="ath-formula">{columnExpression(mapping, inspection.columns)}</p>
          <div className="ath-fields">
            <label className="ath-check"><input type="checkbox" checked={mapping.mode === "transmission"} disabled={mapping.data_type === "chi" || dualMode} onChange={e => setMapping(m => ({ ...m, mode: e.target.checked ? "transmission" : "fluorescence", ...(m.mode === "mu" ? { denominator: "" } : {}) }))} />Natural log</label>
            <button type="button" disabled={mapping.data_type === "chi" || mapping.mode === "mu"} onClick={() => setMapping(m => flipSignalColumns(m))}>Flip numerator and denominator</button>
            <label className="ath-field"><span>Multiplicative constant</span><input type="number" step="any" value={mapping.signal_multiplier ?? 1} disabled={mapping.data_type === "chi"} onChange={e => setMapping(m => ({ ...m, signal_multiplier: e.target.value === "" ? "" : Number(e.target.value) }))} /></label>
          </div>
          {!replacement && <label className="ath-check"><input type="checkbox" checked={mapping.individual_channels ?? false} onChange={e => setMapping(m => ({ ...m, individual_channels: e.target.checked }))} />Save each channel as its own group</label>}
          {mapping.additional_fluorescence && <FluorescenceColumns inspection={inspection} mapping={mapping} setMapping={setMapping} />}
          {problem && <p role="alert" className="ath-error">{problem}</p>}
          <AthenaImportRebin value={mapping.rebin} chi={mapping.data_type === 'chi'} onChange={rebin => setMapping(m => ({ ...m, rebin }))} />
          {rebinDefaults}
          {!replacement && <AthenaImportPreprocessing value={mapping.preprocessing} groups={groups} chi={mapping.data_type === 'chi'}
            onChange={preprocessing => setMapping(m => ({ ...m, preprocessing }))} />}
          <details><summary>{replacement ? 'Ordering' : 'Reference channel & ordering'} <SectionHelp label="Reference channel">The reference uses the same energy column and units. Its energy shift stays linked to the sample after import.</SectionHelp></summary>
            {!replacement && <>
            <div className="ath-fields">{(["reference_numerator", "reference_denominator"] as const).map(key => <label key={key} className="ath-field"><span>{key.replaceAll("_", " ")}</span><select value={mapping[key]} disabled={mapping.data_type === "chi"} onChange={e => setMapping(m => ({ ...m, [key]: e.target.value }))}><option value="">None · constant 1 when reference enabled</option><option value="1">Constant 1</option>{inspection.columns.map(c => <option value={c.column_id} key={c.column_id}>{c.name} · column {c.index + 1}</option>)}</select></label>)}</div>
            <label className="ath-check"><input type="checkbox" disabled={!hasReference} checked={mapping.reference_log ?? true} onChange={e => setMapping(m => ({ ...m, reference_log: e.target.checked }))} />Reference natural log</label>
            <label className="ath-check"><input type="checkbox" disabled={!hasReference} checked={mapping.reference_same_element ?? true} onChange={e => setMapping(m => ({ ...m, reference_same_element: e.target.checked }))} />Same element <SectionHelp label="Reference element">Use the sample’s element and edge. If the reference E₀ differs by more than 25 eV, use that element’s tabulated edge. With this option off, the reference finds its own edge independently of sample edge enforcement.</SectionHelp></label>
            {hasReference && <p className="ath-formula">Reference = {(mapping.reference_log ?? true) ? "ln(|" : ""}{inspection.columns.find(c => c.column_id === mapping.reference_numerator)?.name ?? "1"} / {inspection.columns.find(c => c.column_id === mapping.reference_denominator)?.name ?? "1"}{(mapping.reference_log ?? true) ? "|)" : ""}</p>}
            </>}
            <label className="ath-check"><input type="checkbox" checked={mapping.sort} onChange={e => setMapping(m => ({ ...m, sort: e.target.checked }))} />Sort ascending by energy (rows at a repeated energy are averaged)</label>
          </details>
        </fieldset>
        {inspection.warnings.map(w => <p className="ath-warning" key={w}>{w}</p>)}
        {inspection.file_plugin?.review_required && !reviewed && <p role="status">Review the I0 correction plot and confirm it before importing this file.</p>}
      </div>
      <div className={`${styles.preview} ${inspection.reader_preview ? styles.readerPreviews : ''}`}>
        {inspection.reader_preview && <AthenaReaderPreview value={inspection.reader_preview} required={!!inspection.file_plugin?.review_required}
          reviewed={reviewed} onReviewed={setReviewed} disabled={busy} />}
        <AthenaImportPreview projectId={projectId} version={version} uploadId={inspection.upload_id} mapping={mapping} disabled={busy} />
        <AthenaBeamlineMetadata value={inspection.beamline_metadata} />
        <AthenaBeamlineMetadata value={inspection.xdi_metadata} />
        {inspection.source_preview && <details className={styles.raw}><summary>{inspection.source_preview_format === 'hex' ? 'Binary source bytes (hex)' : 'Source file contents'}{inspection.source_preview_truncated ? " (first section)" : ""}</summary><AthenaDownloadButton path={`/projects/${projectId}/uploads/${inspection.upload_id}/file`}>Download original file</AthenaDownloadButton><pre>{inspection.source_preview.replaceAll('\0', '␀')}</pre></details>}
        {inspection.converted_preview && <details className={styles.raw}><summary>Converted columns{inspection.converted_preview_truncated ? " (first section)" : ""}</summary><AthenaDownloadButton path={`/projects/${projectId}/uploads/${inspection.upload_id}/file?variant=converted`}>Download converted file</AthenaDownloadButton><pre>{inspection.converted_preview}</pre></details>}
      </div>
    </div>
  </>
}

function sameColumns(mapping: ColumnMapping, suggestion: { numerator: string[]; denominator: string | null }) {
  return mapping.numerator.join() === suggestion.numerator.join() && denominatorColumns(mapping).join() === (suggestion.denominator ?? '')
}

function FluorescenceColumns({ inspection, mapping, setMapping }: {
  inspection: InspectionResponse; mapping: ColumnMapping; setMapping: Dispatch<SetStateAction<ColumnMapping>>
}) {
  const fluorescence = mapping.additional_fluorescence!
  const signalMapping: ColumnMapping = { ...mapping, ...fluorescence, mode: 'fluorescence', additional_fluorescence: null,
    individual_channels: fluorescence.individual_channels ?? false, invert: fluorescence.invert ?? false,
    signal_multiplier: fluorescence.signal_multiplier ?? 1 }
  const denominator = denominatorColumns(signalMapping)
  function update(value: Partial<NonNullable<ColumnMapping['additional_fluorescence']>>) {
    setMapping(m => m.additional_fluorescence ? { ...m, additional_fluorescence: { ...m.additional_fluorescence, ...value } } : m)
  }
  function flip() {
    setMapping(m => m.additional_fluorescence ? { ...m,
      additional_fluorescence: flipSignalColumns(m.additional_fluorescence) } : m)
  }
  return <fieldset className={styles.fluorescence} aria-label="Fluorescence columns">
    <legend>Fluorescence <SectionHelp label="Fluorescence columns">Choose the fluorescence detector signal and incident intensity (I₀). Multiple selected columns are summed.</SectionHelp></legend>
    <div className={styles.range}>
      <button type="button" onClick={() => update({ numerator: [] })}>Clear fluorescence numerator</button>
      <button type="button" onClick={() => update({ denominator: '' })}>Clear fluorescence denominator</button>
    </div>
    <div className="ath-column-table"><table><thead><tr><th>Numerator</th><th>Denominator · I₀</th><th>Column</th></tr></thead><tbody>{inspection.columns.map(c => <tr key={c.column_id}>
      <td><input type="checkbox" aria-label={`Fluorescence numerator ${c.name}`} checked={fluorescence.numerator.includes(c.column_id)}
        onChange={e => update({ numerator: e.target.checked ? [...fluorescence.numerator, c.column_id] : fluorescence.numerator.filter(id => id !== c.column_id) })} /></td>
      <td><input type="checkbox" aria-label={`Fluorescence denominator ${c.name}`} checked={denominator.includes(c.column_id)}
        onChange={e => update({ denominator: e.target.checked ? [...denominator, c.column_id] : denominator.filter(id => id !== c.column_id) })} /></td>
      <td>{c.index + 1}. {c.name}</td>
    </tr>)}</tbody></table></div>
    <p className="ath-formula">{columnExpression(signalMapping, inspection.columns)}</p>
    <div className={`ath-fields ${styles.fluorescenceFields}`}>
      <button type="button" onClick={flip}>Flip fluorescence numerator and denominator</button>
      <label className="ath-field"><span>Fluorescence multiplicative constant</span><input type="number" step="any" value={fluorescence.signal_multiplier ?? 1}
        onChange={e => update({ signal_multiplier: e.target.value === '' ? '' : Number(e.target.value) })} /></label>
    </div>
    <label className="ath-check"><input type="checkbox" checked={fluorescence.individual_channels ?? false}
      onChange={e => update({ individual_channels: e.target.checked })} />Save each fluorescence channel as its own group</label>
  </fieldset>
}
