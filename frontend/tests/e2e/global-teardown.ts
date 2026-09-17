import { rm } from "node:fs/promises"

export default async function globalTeardown() {
  const dataRoot = process.env.XRAYLARCH_E2E_DATA_ROOT_INTERNAL
  if (!dataRoot || process.env.XRAYLARCH_E2E_PRESERVE_DATA === "1") return
  await rm(dataRoot, { recursive: true, force: true })
}
