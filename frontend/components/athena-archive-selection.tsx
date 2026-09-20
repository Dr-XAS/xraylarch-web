"use client"

import { useState } from 'react'
import { AthenaDownloadButton } from './athena-download-button'
import styles from './athena-archive-selection.module.css'

export interface ArchiveInspection {
  kind: 'archive_list'; upload_id: string; display_name: string
  file_plugin: { id: 'Zip'; expanded_bytes: number; directory_count: number }
  members: { index: number; name: string; bytes: number; sha256: string }[]
}

export function AthenaArchiveSelection({ archive, projectId, busy, onContinue, onCancel }: {
  archive: ArchiveInspection; projectId: string; busy: boolean
  onContinue: (members: ArchiveInspection['members']) => void; onCancel: () => void
}) {
  const [selected, setSelected] = useState(() => archive.members.map(member => member.index))
  return <section className={styles.archive} aria-label="ZIP file selection">
    <h3>Files in {archive.display_name}</h3>
    <p>{archive.members.length} files · {archive.file_plugin.expanded_bytes.toLocaleString()} bytes expanded.
      Choose data files, then choose shared import parameters or review each file separately. Athena projects open with a group selection.</p>
    <fieldset disabled={busy}>
      <div className="ath-modal-actions">
        <button type="button" onClick={() => setSelected(archive.members.map(m => m.index))}>Select all files</button>
        <button type="button" onClick={() => setSelected([])}>Select no files</button>
        <button type="button" onClick={() => setSelected(archive.members.filter(m => !selected.includes(m.index)).map(m => m.index))}>Invert file selection</button>
      </div>
      <ul>{archive.members.map(member => <li key={member.index}>
        <label><input type="checkbox" aria-label={`Include ${member.name} · entry ${member.index + 1}`} checked={selected.includes(member.index)}
          onChange={e => setSelected(ids => e.target.checked ? [...ids, member.index] : ids.filter(id => id !== member.index))} />
          <span>{member.name}<small>Entry {member.index + 1} · {member.bytes.toLocaleString()} bytes</small></span></label>
        <AthenaDownloadButton path={`/projects/${projectId}/archives/${archive.upload_id}/members/${member.index}`}>Download {member.name}</AthenaDownloadButton>
      </li>)}</ul>
      <p>{selected.length} files selected. Files are reviewed in archive order.</p>
      <div className="ath-modal-actions">
        <button type="button" onClick={onCancel}>Choose another file</button>
        <button type="button" className="ath-primary" disabled={!selected.length} onClick={() => onContinue(archive.members.filter(m => selected.includes(m.index)))}>Review selected files</button>
      </div>
    </fieldset>
    {!!archive.file_plugin.directory_count && <p className="ath-hint">{archive.file_plugin.directory_count} directory entries omitted. All file paths are shown above.</p>}
    <AthenaDownloadButton path={`/projects/${projectId}/uploads/${archive.upload_id}/file`}>Download original ZIP</AthenaDownloadButton>
  </section>
}
