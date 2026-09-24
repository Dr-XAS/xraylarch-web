import { Activity, Layers, WavesHorizontal, createLucideIcon } from "lucide-react"
import type { ViewerId } from "@/lib/athena-viewer-order"

export const CrystalLatticeIcon = createLucideIcon("CrystalLattice", [
  ["path", { d: "M3 8h12v12H3V8Zm5-5h12v12H8V3ZM3 8l5-5m7 5 5-5m-5 17 5-5M3 20l5-5", strokeWidth: "1.4", key: "cell" }],
  ...[[3, 8], [15, 8], [15, 20], [3, 20], [8, 3], [20, 3], [20, 15], [8, 15]].map(([cx, cy], index): ["circle", Record<string, string>] => [
    "circle",
    { cx: String(cx), cy: String(cy), r: "1.35", fill: "currentColor", stroke: "none", key: `site-${index}` },
  ]),
])

export const FeffScatteringIcon = createLucideIcon("FeffScattering", [
  ["path", { d: "M9 9 5.5 6.3M14 9l3.5-3.6M15 12.4l4.1 1.9M11.6 15.1v3.9M8.6 14.1l-3.8 3.2", strokeWidth: "1.5", strokeDasharray: "1.3 1.8", key: "paths" }],
  ["circle", { cx: "4", cy: "5", r: "1.9", strokeWidth: "1.7", key: "upper-left" }],
  ["circle", { cx: "19", cy: "4", r: "1.9", strokeWidth: "1.7", key: "upper-right" }],
  ["circle", { cx: "21", cy: "15", r: "1.9", strokeWidth: "1.7", key: "right" }],
  ["circle", { cx: "11.6", cy: "21", r: "1.9", strokeWidth: "1.7", key: "bottom" }],
  ["circle", { cx: "3.5", cy: "19", r: "1.9", strokeWidth: "1.7", key: "lower-left" }],
  ["circle", { cx: "11.6", cy: "11.6", r: "3.3", fill: "currentColor", fillOpacity: "0.35", strokeWidth: "1.8", key: "absorber" }],
])

export const FitCurvesIcon = createLucideIcon("FitCurves", [
  ["path", { d: "M2 18c2.3 0 2.4-11 5.1-11s3 10 5.1 10 3.1-9 5.2-9 2.6 5 4.6 3", key: "measured" }],
  ["path", { d: "M2 20c2.3-.4 2.5-10 5.1-10s3.1 6 5.1 6 3.3-5 5.2-5 2.6 4 4.6 3", strokeWidth: "1.6", key: "fit" }],
])

export const viewerIcons = {
  single: Activity,
  multiple: Layers,
  wavelet: WavesHorizontal,
  cif: CrystalLatticeIcon,
  feff: FeffScatteringIcon,
  fit: FitCurvesIcon,
} satisfies Record<ViewerId, typeof Activity>
