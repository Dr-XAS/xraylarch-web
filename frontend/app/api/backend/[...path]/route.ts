import { NextResponse } from "next/server"

const allowedHeaders = ["content-type", "accept", "content-length"] as const
const responseHeaders = ["content-type", "content-length", "content-disposition"] as const

function isAllowedPath(path: string[]): boolean {
  if (path.some((segment) => !segment || segment === "." || segment === "..")) {
    return false
  }
  return (path.length === 1 && path[0] === "health") ||
    (path[0] === "api" && (path[1] === "workspaces" || path[1] === "athena"))
}

async function proxy(request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const { path: routePath } = await params
  if (!isAllowedPath(routePath)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 })
  }

  const upstreamBase = process.env.BACKEND_URL ?? "http://127.0.0.1:8006"
  const path = `/${routePath.map(encodeURIComponent).join("/")}`
  const upstream = new URL(path, upstreamBase.endsWith("/") ? upstreamBase : `${upstreamBase}/`)
  upstream.search = new URL(request.url).search
  const headers = new Headers()
  for (const header of allowedHeaders) {
    const value = request.headers.get(header)
    if (value) headers.set(header, value)
  }

  const body = request.method === "GET" || request.method === "HEAD" ? undefined : request.body
  const init: RequestInit & { duplex?: "half" } = {
    method: request.method,
    headers,
    body,
    cache: "no-store",
  }
  if (body) init.duplex = "half"

  const backendResponse = await fetch(upstream, init)
  const outputHeaders = new Headers()
  for (const header of responseHeaders) {
    const value = backendResponse.headers.get(header)
    if (value) outputHeaders.set(header, value)
  }
  return new Response(backendResponse.body, {
    status: backendResponse.status,
    headers: outputHeaders,
  })
}

export { proxy as DELETE, proxy as GET, proxy as PATCH, proxy as POST, proxy as PUT }
