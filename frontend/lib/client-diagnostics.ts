/**
 * Browser-side diagnostics attached to a bug report.
 *
 * A port of Dr.XAS's client capture, minus its analytics ids (this app has no
 * PostHog) and with the build read off the server-rendered version badge
 * instead of NEXT_PUBLIC_BUILD_* variables. The schema stays version 1 so a
 * Dr.XAS reader accepts the sidecar unchanged.
 *
 * Every subsystem is captured on its own and a failure is recorded in
 * `capture_errors` rather than losing the whole capture: a locked-down browser
 * that throws on `localStorage` still reports its user agent.
 */

export const CLIENT_METADATA_SCHEMA_VERSION = 1 as const
export const MAX_CLIENT_METADATA_BYTES = 16 * 1024 * 1024

export type CaptureErrorCategory = "security_error" | "unsupported" | "capture_failed"

export type AppMetadata = {
  build_date: string | null
  build_count: string | null
  build_sha: string | null
  version: string | null
  deployment_origin: string | null
}

export type PageMetadata = {
  href: string | null
  origin: string | null
  pathname: string | null
  query: string | null
  hash: string | null
  title: string | null
  referrer: string | null
  visibility_state: string | null
  has_focus: boolean | null
}

export type ClientHintBrand = { brand: string; version: string }
export type ClientHintsMetadata = {
  brands: ClientHintBrand[] | null
  full_version_list: ClientHintBrand[] | null
  mobile: boolean | null
  platform: string | null
  platform_version: string | null
  architecture: string | null
  bitness: string | null
  model: string | null
  wow64: boolean | null
}

export type BrowserMetadata = {
  name: string | null
  version: string | null
  user_agent: string | null
  vendor: string | null
  platform: string | null
  do_not_track: string | null
  language: string | null
  languages: string[]
  cookie_enabled: boolean | null
  client_hints: ClientHintsMetadata
}

export type OsMetadata = { name: string | null; version: string | null; architecture: string | null }

export type LocaleMetadata = {
  language: string | null
  languages: string[]
  timezone: string | null
  utc_offset_minutes: number | null
}

export type DisplayMetadata = {
  width: number | null
  height: number | null
  screen_width: number | null
  screen_height: number | null
  available_width: number | null
  available_height: number | null
  color_depth: number | null
  pixel_depth: number | null
  pixel_ratio: number | null
  orientation_type: string | null
  orientation_angle: number | null
  color_scheme: string | null
  app_theme: string | null
}

export type DeviceMetadata = {
  mobile: boolean | null
  model: string | null
  touch_points: number | null
  hardware_concurrency: number | null
  device_memory: number | null
}

export type NetworkMetadata = {
  online: boolean | null
  effective_type: string | null
  downlink: number | null
  rtt: number | null
  save_data: boolean | null
  type: string | null
}

export type StorageMetadata = {
  local_storage: Record<string, string>
  session_storage: Record<string, string>
  local_storage_bytes: number
  session_storage_bytes: number
}

export type ClientMetadataV1 = {
  schema_version: 1
  captured_at: string
  app: AppMetadata
  page: PageMetadata
  browser: BrowserMetadata
  os: OsMetadata
  locale: LocaleMetadata
  display: DisplayMetadata
  device: DeviceMetadata
  network: NetworkMetadata
  storage: StorageMetadata
  capture_errors: Record<string, CaptureErrorCategory>
}

type UserAgentData = {
  brands?: ClientHintBrand[]
  mobile?: boolean
  platform?: string
  getHighEntropyValues?: (hints: string[]) => Promise<Record<string, unknown>>
}

type NetworkConnection = { effectiveType?: string; downlink?: number; rtt?: number; saveData?: boolean; type?: string }

type DiagnosticsNavigator = Navigator & {
  connection?: NetworkConnection
  deviceMemory?: number
  userAgentData?: UserAgentData
}

const encoder = new TextEncoder()

const EMPTY_CLIENT_HINTS: ClientHintsMetadata = {
  brands: null, full_version_list: null, mobile: null, platform: null, platform_version: null,
  architecture: null, bitness: null, model: null, wow64: null,
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

function captureErrorCategory(error: unknown): CaptureErrorCategory {
  const name = error && typeof error === "object" && "name" in error ? String((error as { name?: unknown }).name) : ""
  if (name === "SecurityError") return "security_error"
  if (name === "NotSupportedError" || name === "ReferenceError") return "unsupported"
  return "capture_failed"
}

function captureSubsystem<T>(name: string, fallback: T, errors: Record<string, CaptureErrorCategory>, capture: () => T): T {
  try {
    return capture()
  } catch (error) {
    errors[name] = captureErrorCategory(error)
    return fallback
  }
}

function readStorage(getStorage: () => Storage, name: string, errors: Record<string, CaptureErrorCategory>): Record<string, string> {
  return captureSubsystem(name, {}, errors, () => {
    const storage = getStorage()
    const entries: Array<[string, string]> = []
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index)
      if (key === null) continue
      const value = storage.getItem(key)
      if (value !== null) entries.push([key, value])
    }
    return Object.fromEntries(entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)))
  })
}

function parseBrowser(userAgent: string): Pick<BrowserMetadata, "name" | "version"> {
  const matchers: Array<[string, RegExp]> = [
    ["Edge", /Edg(?:A|iOS)?\/([\d.]+)/],
    ["Chrome", /(?:Chrome|CriOS)\/([\d.]+)/],
    ["Firefox", /(?:Firefox|FxiOS)\/([\d.]+)/],
    ["Safari", /Version\/([\d.]+).*Safari/],
  ]
  for (const [name, pattern] of matchers) {
    const match = userAgent.match(pattern)
    if (match) return { name, version: match[1] }
  }
  return { name: null, version: null }
}

function parseOs(userAgent: string, platform: string): OsMetadata {
  if (/Android/i.test(userAgent)) return { name: "Android", version: userAgent.match(/Android\s+([\d.]+)/i)?.[1] ?? null, architecture: null }
  if (/(iPhone|iPad|iPod)/i.test(userAgent)) return { name: "iOS", version: userAgent.match(/OS ([\d_]+)/)?.[1]?.replace(/_/g, ".") ?? null, architecture: null }
  if (/Windows/i.test(userAgent) || /Win/i.test(platform)) return { name: "Windows", version: userAgent.match(/Windows NT\s+([\d.]+)/i)?.[1] ?? null, architecture: null }
  if (/Macintosh|Mac OS X/i.test(userAgent) || /Mac/i.test(platform)) return { name: "macOS", version: userAgent.match(/Mac OS X\s+([\d_]+)/)?.[1]?.replace(/_/g, ".") ?? null, architecture: null }
  if (/Linux/i.test(userAgent) || /Linux/i.test(platform)) return { name: "Linux", version: null, architecture: null }
  return { name: null, version: null, architecture: null }
}

function normalizeBrands(value: unknown): ClientHintBrand[] | null {
  if (!Array.isArray(value)) return null
  const brands = value.flatMap(item => {
    if (!item || typeof item !== "object") return []
    const brand = stringOrNull((item as Record<string, unknown>).brand)
    const version = stringOrNull((item as Record<string, unknown>).version)
    return brand && version ? [{ brand, version }] : []
  })
  return brands.length > 0 ? brands : null
}

function browserFromBrands(brands: ClientHintBrand[] | null): Pick<BrowserMetadata, "name" | "version"> | null {
  if (!brands) return null
  const candidates: Array<[string, RegExp]> = [["Edge", /Microsoft Edge|Edge/i], ["Chrome", /Google Chrome|Chrome/i], ["Chrome", /Chromium/i]]
  for (const [name, pattern] of candidates) {
    const match = brands.find(({ brand }) => pattern.test(brand))
    if (match) return { name, version: match.version }
  }
  return null
}

function byteLength(values: Record<string, string>): number {
  return encoder.encode(JSON.stringify(values)).byteLength
}

/** The build the page was served from, read off the version badge the layout renders. */
export function readAppBuild(): Omit<AppMetadata, "deployment_origin"> {
  if (typeof document === "undefined") return { build_date: null, build_count: null, build_sha: null, version: null }
  const badge = document.querySelector<HTMLElement>("[data-build-sha], .portable-version-badge")
  return {
    build_date: stringOrNull(badge?.dataset.buildDate),
    build_count: stringOrNull(badge?.dataset.buildCount),
    build_sha: stringOrNull(badge?.dataset.buildSha),
    version: stringOrNull(badge?.textContent?.trim()),
  }
}

export function serializeClientMetadataWithinLimit(metadata: ClientMetadataV1): string | null {
  const serialized = JSON.stringify(metadata)
  return encoder.encode(serialized).byteLength <= MAX_CLIENT_METADATA_BYTES ? serialized : null
}

function emptyMetadata(capturedAt: string, errors: Record<string, CaptureErrorCategory>): ClientMetadataV1 {
  return {
    schema_version: CLIENT_METADATA_SCHEMA_VERSION,
    captured_at: capturedAt,
    app: { ...readAppBuild(), deployment_origin: null },
    page: { href: null, origin: null, pathname: null, query: null, hash: null, title: null, referrer: null, visibility_state: null, has_focus: null },
    browser: { name: null, version: null, user_agent: null, vendor: null, platform: null, do_not_track: null, language: null, languages: [], cookie_enabled: null, client_hints: { ...EMPTY_CLIENT_HINTS } },
    os: { name: null, version: null, architecture: null },
    locale: { language: null, languages: [], timezone: null, utc_offset_minutes: null },
    display: { width: null, height: null, screen_width: null, screen_height: null, available_width: null, available_height: null, color_depth: null, pixel_depth: null, pixel_ratio: null, orientation_type: null, orientation_angle: null, color_scheme: null, app_theme: null },
    device: { mobile: null, model: null, touch_points: null, hardware_concurrency: null, device_memory: null },
    network: { online: null, effective_type: null, downlink: null, rtt: null, save_data: null, type: null },
    storage: { local_storage: {}, session_storage: {}, local_storage_bytes: 0, session_storage_bytes: 0 },
    capture_errors: errors,
  }
}

export async function collectClientMetadata(): Promise<ClientMetadataV1> {
  const capturedAt = new Date().toISOString()
  const errors: Record<string, CaptureErrorCategory> = {}
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    errors.browser = "unsupported"
    return emptyMetadata(capturedAt, errors)
  }
  const empty = emptyMetadata(capturedAt, errors)
  const diagnosticsNavigator = navigator as DiagnosticsNavigator
  const localStorage = readStorage(() => window.localStorage, "local_storage", errors)
  const sessionStorage = readStorage(() => window.sessionStorage, "session_storage", errors)

  const page = captureSubsystem<PageMetadata>("page", empty.page, errors, () => ({
    href: stringOrNull(window.location?.href),
    origin: stringOrNull(window.location?.origin),
    pathname: stringOrNull(window.location?.pathname),
    query: stringOrNull(window.location?.search),
    hash: stringOrNull(window.location?.hash),
    title: stringOrNull(document.title),
    referrer: stringOrNull(document.referrer),
    visibility_state: stringOrNull(document.visibilityState),
    has_focus: typeof document.hasFocus === "function" ? document.hasFocus() : null,
  }))

  const browserCore = captureSubsystem("browser", {
    userAgent: "", vendor: null as string | null, platform: "", doNotTrack: null as string | null,
    language: null as string | null, languages: [] as string[], cookieEnabled: null as boolean | null,
  }, errors, () => ({
    userAgent: diagnosticsNavigator.userAgent || "",
    vendor: stringOrNull(diagnosticsNavigator.vendor),
    platform: diagnosticsNavigator.platform || "",
    doNotTrack: stringOrNull(diagnosticsNavigator.doNotTrack),
    language: stringOrNull(diagnosticsNavigator.language),
    languages: stringList(diagnosticsNavigator.languages),
    cookieEnabled: booleanOrNull(diagnosticsNavigator.cookieEnabled),
  }))

  const userAgentData = captureSubsystem<UserAgentData | null>("client_hints", null, errors, () => diagnosticsNavigator.userAgentData ?? null)
  let highEntropy: Record<string, unknown> = {}
  if (userAgentData?.getHighEntropyValues) {
    try {
      highEntropy = await userAgentData.getHighEntropyValues(["architecture", "bitness", "fullVersionList", "model", "platformVersion", "wow64"])
    } catch (error) {
      errors.client_hints = captureErrorCategory(error)
    }
  }
  const clientHints: ClientHintsMetadata = {
    brands: normalizeBrands(userAgentData?.brands),
    full_version_list: normalizeBrands(highEntropy.fullVersionList),
    mobile: booleanOrNull(userAgentData?.mobile),
    platform: stringOrNull(userAgentData?.platform),
    platform_version: stringOrNull(highEntropy.platformVersion),
    architecture: stringOrNull(highEntropy.architecture),
    bitness: stringOrNull(highEntropy.bitness),
    model: stringOrNull(highEntropy.model),
    wow64: booleanOrNull(highEntropy.wow64),
  }
  const parsedBrowser = parseBrowser(browserCore.userAgent)
  const hintedBrowser = browserFromBrands(clientHints.full_version_list ?? clientHints.brands)
  const parsedOs = parseOs(browserCore.userAgent, browserCore.platform)

  const locale = captureSubsystem<LocaleMetadata>("locale", empty.locale, errors, () => ({
    language: stringOrNull(diagnosticsNavigator.language),
    languages: stringList(diagnosticsNavigator.languages),
    timezone: stringOrNull(Intl.DateTimeFormat().resolvedOptions().timeZone),
    utc_offset_minutes: numberOrNull(new Date(capturedAt).getTimezoneOffset()),
  }))

  const display = captureSubsystem<DisplayMetadata>("display", empty.display, errors, () => ({
    width: numberOrNull(window.innerWidth),
    height: numberOrNull(window.innerHeight),
    screen_width: numberOrNull(window.screen?.width),
    screen_height: numberOrNull(window.screen?.height),
    available_width: numberOrNull(window.screen?.availWidth),
    available_height: numberOrNull(window.screen?.availHeight),
    color_depth: numberOrNull(window.screen?.colorDepth),
    pixel_depth: numberOrNull(window.screen?.pixelDepth),
    pixel_ratio: numberOrNull(window.devicePixelRatio),
    orientation_type: stringOrNull(window.screen?.orientation?.type),
    orientation_angle: numberOrNull(window.screen?.orientation?.angle),
    color_scheme: typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
    app_theme: stringOrNull(document.documentElement.dataset.theme),
  }))

  const device = captureSubsystem<DeviceMetadata>("device", empty.device, errors, () => ({
    mobile: clientHints.mobile ?? /Mobile|Android|iPhone|iPad/i.test(browserCore.userAgent),
    model: clientHints.model,
    touch_points: numberOrNull(diagnosticsNavigator.maxTouchPoints),
    hardware_concurrency: numberOrNull(diagnosticsNavigator.hardwareConcurrency),
    device_memory: numberOrNull(diagnosticsNavigator.deviceMemory),
  }))

  const network = captureSubsystem<NetworkMetadata>("network", empty.network, errors, () => {
    const connection = diagnosticsNavigator.connection
    return {
      online: booleanOrNull(diagnosticsNavigator.onLine),
      effective_type: stringOrNull(connection?.effectiveType),
      downlink: numberOrNull(connection?.downlink),
      rtt: numberOrNull(connection?.rtt),
      save_data: booleanOrNull(connection?.saveData),
      type: stringOrNull(connection?.type),
    }
  })

  return {
    schema_version: CLIENT_METADATA_SCHEMA_VERSION,
    captured_at: capturedAt,
    app: { ...readAppBuild(), deployment_origin: page.origin },
    page,
    browser: {
      name: hintedBrowser?.name ?? parsedBrowser.name,
      version: hintedBrowser?.version ?? parsedBrowser.version,
      user_agent: stringOrNull(browserCore.userAgent),
      vendor: browserCore.vendor,
      platform: stringOrNull(browserCore.platform),
      do_not_track: browserCore.doNotTrack,
      language: browserCore.language,
      languages: browserCore.languages,
      cookie_enabled: browserCore.cookieEnabled,
      client_hints: clientHints,
    },
    os: {
      name: clientHints.platform ?? parsedOs.name,
      version: clientHints.platform_version ?? parsedOs.version,
      architecture: clientHints.architecture ?? parsedOs.architecture,
    },
    locale,
    display,
    device,
    network,
    storage: {
      local_storage: localStorage,
      session_storage: sessionStorage,
      local_storage_bytes: byteLength(localStorage),
      session_storage_bytes: byteLength(sessionStorage),
    },
    capture_errors: errors,
  }
}
