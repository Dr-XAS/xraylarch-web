"use client"

import { createContext, useContext, useMemo, type ReactNode } from "react"
import { athenaApi, athenaTransport } from "./athena"
import { createAthenaTransport, type AthenaSession, type AthenaTransport } from "./athena-transport"

const AthenaTransportContext = createContext<AthenaTransport | null>(null)

export function AthenaProvider({ session, children, fetcher, onAuthorizationFailure }: {
  session: AthenaSession
  children: ReactNode
  fetcher?: typeof fetch
  onAuthorizationFailure?: () => void
}) {
  const transport = useMemo(() => createAthenaTransport(session, fetcher, { onAuthorizationFailure }), [session, fetcher, onAuthorizationFailure])
  return <AthenaTransportContext.Provider value={transport}>{children}</AthenaTransportContext.Provider>
}

export function useAthenaTransport() {
  return useContext(AthenaTransportContext) ?? athenaTransport()
}

export function useAthenaApi() {
  const transport = useContext(AthenaTransportContext)
  if (!transport) return athenaApi
  return <T,>(path: string, body?: unknown, method?: string, signal?: AbortSignal, headers?: Record<string, string>): Promise<T> => transport.api<T>(`/api/athena${path}`, {
    signal,
    method: method ?? (body === undefined ? "GET" : "POST"),
    ...(body instanceof FormData ? { body, headers } : body !== undefined ? {
      headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
    } : { headers }),
  })
}
