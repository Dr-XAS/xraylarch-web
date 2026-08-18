import type { Metadata } from "next"

import "./globals.css"

export const metadata: Metadata = {
  title: "XrayLarch Web",
  description: "Browser workbench for server-authoritative XAS processing.",
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>
}
