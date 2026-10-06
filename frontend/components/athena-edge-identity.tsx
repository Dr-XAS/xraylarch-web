import type { AthenaGroup, EdgeIdentity } from "@/lib/athena"

function readIdentity(value: unknown): EdgeIdentity | null {
  if (!value || typeof value !== "object") return null
  const { element, edge, origin } = value as Record<string, unknown>
  if (typeof element !== "string" || !/^[A-Z][a-z]?$/.test(element) || typeof edge !== "string" || !/^[A-Z][0-9]?$/.test(edge)) return null
  return { element, edge, ...(typeof origin === "string" && ["native", "inferred", "enforced", "selected"].includes(origin) ? { origin: origin as EdgeIdentity["origin"] } : {}) }
}
export function currentEdgeIdentity(group: AthenaGroup): EdgeIdentity | null {
  return readIdentity(group.source.edge_identity) ?? readIdentity(group.result?.effective)
}
export function edgeIdentityDescription(group: AthenaGroup) {
  const identity = currentEdgeIdentity(group)
  return identity ? `${identity.element} ${identity.edge}${identity.origin ? ` · ${identity.origin}` : ""}` : "Unknown"
}
