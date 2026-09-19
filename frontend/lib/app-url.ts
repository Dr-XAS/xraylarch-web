const configured = process.env.NEXT_PUBLIC_APP_BASE_PATH ?? ""

function normalizeBasePath(value: string): string {
  if (value === "") return ""
  if (!value.startsWith("/") || value.endsWith("/") || value.includes("..") || /[\\\\?#]|\/\//.test(value)) {
    throw new Error("NEXT_PUBLIC_APP_BASE_PATH must be an absolute normalized path")
  }
  return value
}

export const appBasePath = normalizeBasePath(configured)

export function appUrl(path: string): string {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("..") || /^https?:/i.test(path)) {
    throw new Error("internal path must be root-relative")
  }
  return `${appBasePath}${path}`
}

export function backendUrl(path: string): string {
  return appUrl(`/api/backend${path.startsWith("/") ? path : `/${path}`}`)
}
