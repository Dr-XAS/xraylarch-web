import styles from './athena-import-progress.module.css'

export type ImportProgress = {
  total: number
  completed: number
  filename: string
  phase: 'inspecting' | 'importing'
}

export function AthenaImportProgress({ total, completed, filename, phase }: ImportProgress) {
  return <section className={styles.progress} aria-label="Batch import">
    <div className={styles.summary} role="status">
      <strong>Importing files…</strong>
      <span>{completed} of {total} files imported</span>
    </div>
    <progress aria-label="Batch import progress" max={total} value={completed} />
    <p className={styles.file}>{phase === 'inspecting' ? 'Reading' : 'Importing'}: <strong>{filename}</strong></p>
    <p className="ath-hint">Using the same parameters for all files.</p>
  </section>
}
