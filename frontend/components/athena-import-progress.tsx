import { SectionHelp } from "./section-help"
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
      <strong>Importing files… <SectionHelp label="Batch import">Using the same parameters for all files.</SectionHelp></strong>
      <span>{completed} of {total} files imported</span>
    </div>
    <progress aria-label="Batch import progress" max={total} value={completed} />
    <p className={styles.file}>{phase === 'inspecting' ? 'Reading' : 'Importing'}: <strong>{filename}</strong></p>
  </section>
}
