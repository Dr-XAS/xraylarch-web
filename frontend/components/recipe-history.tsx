import type { BackendClient } from "@/lib/backend-client"
import type { RevisionSummary } from "@/lib/contracts"

interface RecipeHistoryProps {
  workspaceId: string | null
  revisions: RevisionSummary[]
  activeRevisionId: number | null
  client: BackendClient
  onRestore: (revisionId: number) => Promise<void>
}

export function RecipeHistory({ workspaceId, revisions, activeRevisionId, client, onRestore }: RecipeHistoryProps) {
  const applied = revisions.filter((revision) => revision.kind === "applied").slice().reverse()
  return (
    <section className="history-card" data-testid="recipe-history" aria-labelledby="history-heading">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Provenance</p>
          <h2 id="history-heading">Recipe history</h2>
        </div>
      </div>
      {applied.length === 0 ? <p className="muted">Applied revisions will be retained here.</p> : (
        <ol className="revision-list">
          {applied.map((revision) => {
            const active = revision.revision_id === activeRevisionId
            const effective = revision.effective
            const parent = revisions.find((candidate) => candidate.revision_id === revision.parent_revision_id)
            const changed = revision.recipe && parent?.recipe
              ? (Object.keys(revision.recipe) as Array<keyof typeof revision.recipe>)
                  .filter((key) => revision.recipe?.[key] !== parent.recipe?.[key])
                  .map((key) => key.replaceAll("_", " "))
              : []
            return <li key={revision.revision_id} className={active ? "active-revision" : undefined}>
              <div>
                <strong>Revision {revision.revision_id}{active ? " · active" : ""}</strong>
                <p>Parent {revision.parent_revision_id ?? "source"}{revision.restored_from_revision_id ? ` · restored from ${revision.restored_from_revision_id}` : ""}</p>
                {effective && <p>E0 {effective.e0.toFixed(2)} eV · rbkg {effective.rbkg} Å · k {effective.kmin}–{effective.kmax} Å⁻¹</p>}
                {changed.length > 0 && <p>Changes: {changed.join(", ")}</p>}
              </div>
              <div className="revision-actions">
                <button type="button" disabled={!workspaceId || active} onClick={() => void onRestore(revision.revision_id)}>Restore as new</button>
                {workspaceId && <a href={client.dataDownloadUrl(workspaceId, revision.revision_id)}>CSV</a>}
                {workspaceId && <a href={client.recipeDownloadUrl(workspaceId, revision.revision_id)}>Recipe JSON</a>}
              </div>
            </li>
          })}
        </ol>
      )}
    </section>
  )
}
