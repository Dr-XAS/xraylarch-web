"use client"

import { useState, type ButtonHTMLAttributes, type ReactNode } from "react"
import { athenaDownload } from "@/lib/athena"

export function AthenaDownloadButton({ path, filename, children, ...button }: {
  path: string
  filename?: string
  children: ReactNode
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  const [error, setError] = useState("")
  const [downloading, setDownloading] = useState(false)
  return <>
    <button {...button} type="button" disabled={button.disabled || downloading} onClick={() => {
      setError("")
      setDownloading(true)
      void athenaDownload(path, filename).catch(reason => {
        setError(reason instanceof Error ? reason.message : "The download failed.")
      }).finally(() => setDownloading(false))
    }}>{children}</button>
    {error && <span role="alert" className="ath-error">{error}</span>}
  </>
}
