import type { Metadata } from "next"

import { VersionBadge } from "@/components/VersionBadge"
import { ThemeProvider } from "@/components/theme-provider"
import { themeInitScript } from "@/lib/theme"

import "./globals.css"
import "./athena.css"

export const metadata: Metadata = {
  title: "Athena Web · XAS workbench",
  description: "Athena workflows for X-ray absorption spectroscopy, powered by Larch.",
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" data-theme="light" suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: themeInitScript }} /></head>
      <body>
        <ThemeProvider>{children}</ThemeProvider>
        <VersionBadge />
      </body>
    </html>
  )
}
