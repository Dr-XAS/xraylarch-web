import { NextResponse } from "next/server"

const ordinaryHeaders = ["content-type", "accept", "content-length"] as const
const responseHeaders = ["content-type", "content-length", "content-disposition", "x-athena-project-version"] as const

const athenaRoutes: readonly [string, RegExp][] = [
  ["GET", /^api\/athena\/(?:edges|projects)$/], ["POST", /^api\/athena\/projects$/],
  ["GET", /^api\/athena\/preferences\/(?:rebin|smoothing|plugins|beamline|dispersive|merge)(?:\/[^/]+\/configuration|\/export|\/file)?$/],
  ["PUT", /^api\/athena\/preferences\/(?:rebin|smoothing|plugins|beamline|dispersive|merge)(?:\/[^/]+\/configuration)?$/],
  ["POST", /^api\/athena\/preferences\/(?:plugins\/import|dispersive\/import)$/],
  ["GET", /^api\/athena\/projects\/[^/]+(?:\/uploads\/[^/]+\/(?:inspection|file)|\/archives\/[^/]+\/members\/[^/]+|\/preview-project\/[^/]+\/(?:file|groups\/.+)|\/export|\/groups\/.+\/(?:source-text|xdi|export))?$/],
  ["POST", /^api\/athena\/projects\/[^/]+\/(?:inspect|import|preview-columns|command|context-report|context-plot|analyze|difference\/preview|rebin\/preview|mee\/preview|point-edit\/preview|merge\/preview|plots\/(?:special|shortcut)|alignment\/preview|calibration\/(?:preview|zero)|convolve\/preview|smooth\/preview|restore|preview-project|restore-upload|parameter-report(?:\/preview)?|export-data(?:\/preview)?|dispersive\/(?:inspect|make|[^/]+)|groups\/[^/]+\/(?:xdi\/validate|merge\/plot|wavelet|plot-transform))$/],
]

function allowedMethods(path: string[]): ReadonlySet<string> | null {
  if (path.some(segment => !segment || segment === "." || segment === "..")) return null
  const joined = path.join("/")
  if (joined === "health") return new Set(["GET"])
  if (joined === "api/integration/v2/browser/consume") return new Set(["POST"])
  const workspaceRoutes: readonly [string, RegExp][] = [
    ["GET", /^api\/workspaces$/], ["POST", /^api\/workspaces$/],
    ["GET", /^api\/workspaces\/[^/]+$/],
    ["POST", /^api\/workspaces\/[^/]+\/(?:uploads\/inspect|mapping|preview|apply|restore)$/],
    ["GET", /^api\/workspaces\/[^/]+\/revisions\/[^/]+\/(?:data\.csv|recipe\.json)$/],
  ]
  const workspaceMethods = workspaceRoutes.filter(([, pattern]) => pattern.test(joined)).map(([method]) => method)
  if (workspaceMethods.length) return new Set(workspaceMethods)
  const methods = athenaRoutes.filter(([, pattern]) => pattern.test(joined)).map(([method]) => method)
  return methods.length ? new Set(methods) : null
}

function isProjectPath(path: string[]) {
  return path[0] === "api" && path[1] === "athena" && path[2] === "projects" && path.length >= 4
}

async function proxy(request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const { path: routePath } = await params
  if (!allowedMethods(routePath)?.has(request.method)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 })
  }

  const upstreamBase = process.env.BACKEND_URL ?? "http://127.0.0.1:8006"
  const path = `/${routePath.map(encodeURIComponent).join("/")}`
  const upstream = new URL(path, upstreamBase.endsWith("/") ? upstreamBase : `${upstreamBase}/`)
  upstream.search = new URL(request.url).search
  const headers = new Headers()
  for (const header of ordinaryHeaders) {
    const value = request.headers.get(header)
    if (value) headers.set(header, value)
  }
  if (isProjectPath(routePath)) {
    const capability = request.headers.get("x-xraylarch-project-capability")
    if (capability) headers.set("x-xraylarch-project-capability", capability)
  }

  const body = request.method === "GET" || request.method === "HEAD" ? undefined : request.body
  const init: RequestInit & { duplex?: "half" } = { method: request.method, headers, body, cache: "no-store" }
  if (body) init.duplex = "half"

  const backendResponse = await fetch(upstream, init)
  if (routePath.join("/") === "health") {
    // This mount shares Dr.XAS's public origin, so this route is reachable
    // from the internet, and the backend's own health body names the deployed
    // 40-hex revision. The deploy script probes this path to prove the proxy
    // works and reads only the status code; the revision is read separately,
    // straight off the loopback backend. So answer the status and nothing else.
    return new Response(JSON.stringify({ status: backendResponse.ok ? "ok" : "error" }), {
      status: backendResponse.status,
      headers: { "content-type": "application/json" },
    })
  }
  const outputHeaders = new Headers()
  for (const header of responseHeaders) {
    const value = backendResponse.headers.get(header)
    if (value) outputHeaders.set(header, value)
  }
  return new Response(backendResponse.body, { status: backendResponse.status, headers: outputHeaders })
}

export { proxy as DELETE, proxy as GET, proxy as PATCH, proxy as POST, proxy as PUT }
