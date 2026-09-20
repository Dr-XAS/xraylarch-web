import { NextResponse, type NextRequest } from "next/server"
import { copySessionCookies, sessionRequestHeaders } from "@/lib/session-headers"

export async function proxy(request: NextRequest) {
  if (!/^(true|1|yes)$/i.test(process.env.XRAYLARCH_PUBLIC_MODE ?? "")) {
    return NextResponse.next()
  }

  // Establish the signed cookie on the document response, before React can
  // start parallel API requests. The backend also validates existing cookies.
  try {
    const upstream = await fetch(new URL("/api/session", process.env.BACKEND_URL ?? "http://127.0.0.1:8006"), {
      headers: sessionRequestHeaders(request.headers),
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    })
    if (!upstream.ok || !(await upstream.json()).isolated) throw new Error("Session unavailable")
    const response = NextResponse.next()
    response.headers.set("cache-control", "private, no-store")
    copySessionCookies(upstream.headers, response.headers)
    return response
  } catch {
    return new NextResponse("The workbench is starting. Please reload in a moment.", {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "retry-after": "10" },
    })
  }
}

export const config = { matcher: ["/", "/classic"] }
