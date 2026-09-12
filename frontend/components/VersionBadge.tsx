/**
 * Server-rendered identifier for the exact frontend build.
 *
 * Git is read once when this module loads. CI-provided metadata is used when
 * the production build does not include a .git directory.
 */

import { execFileSync } from "node:child_process"

export type BuildInfo = {
  date: string
  count: string
  sha: string
  fullSha: string
  label: string
}

function git(args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
  } catch {
    return ""
  }
}

function first(...values: Array<string | undefined>): string {
  return values.find((value) => value?.trim())?.trim() ?? ""
}

export function getBuildInfo(): BuildInfo {
  const date = first(
    process.env.APP_BUILD_DATE,
    process.env.NEXT_PUBLIC_BUILD_DATE,
    git(["log", "-1", "--format=%cI"]),
    new Date().toISOString(),
  )

  const count = first(
    process.env.APP_BUILD_COUNT,
    process.env.NEXT_PUBLIC_BUILD_COUNT,
    process.env.GITHUB_RUN_NUMBER,
    git(["rev-list", "--count", "HEAD"]),
  )

  const fullSha = first(
    process.env.APP_BUILD_SHA,
    process.env.NEXT_PUBLIC_BUILD_SHA,
    process.env.RENDER_GIT_COMMIT,
    process.env.VERCEL_GIT_COMMIT_SHA,
    process.env.GITHUB_SHA,
    process.env.COMMIT_SHA,
    process.env.SOURCE_VERSION,
    git(["rev-parse", "HEAD"]),
  )

  const sha = fullSha.slice(0, 5)
  const dateShort = date.slice(0, 10).replace(/-/g, ".")
  const suffix = [dateShort, count, sha].filter(Boolean).join(".")

  return {
    date,
    count,
    sha,
    fullSha,
    label: suffix ? `v0.${suffix}` : "",
  }
}

const BUILD = getBuildInfo()

export function VersionBadge() {
  if (!BUILD.label) return null

  const tooltip = `Built ${BUILD.date}${BUILD.fullSha ? ` · ${BUILD.fullSha}` : ""}`

  return (
    <>
      <style>{`
        .portable-version-badge {
          position: fixed;
          right: 0.6rem;
          bottom: 0.4rem;
          z-index: 40;
          color: rgb(100 116 139 / 55%);
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas,
            "Liberation Mono", "Courier New", monospace;
          font-size: 10px;
          font-variant-numeric: tabular-nums;
          line-height: 1rem;
          white-space: nowrap;
          user-select: none;
          transition: color 150ms ease;
        }

        .portable-version-badge:hover {
          color: rgb(100 116 139 / 100%);
        }

        @media (min-width: 621px) {
          .ath-app .ath-status {
            padding-right: 11.5rem;
          }
        }

        @media (max-width: 620px) {
          body {
            position: relative;
            padding-bottom: 2rem;
          }

          .portable-version-badge {
            position: absolute;
            font-size: 9px;
          }
        }
      `}</style>
      <div
        className="portable-version-badge"
        title={tooltip}
        data-build-sha={BUILD.fullSha || undefined}
      >
        {BUILD.label}
      </div>
    </>
  )
}
