import { createLucideIcon } from "lucide-react"

export const NormalizationIcon = createLucideIcon("Normalization", [
  ["path", { d: "M3 19h18M3 5h18", strokeWidth: "1.3", strokeDasharray: "2 3", key: "limits" }],
  ["path", { d: "M3 18h5c2 0 2-12 4-12h9", key: "edge" }],
])

export const BackgroundRemovalIcon = createLucideIcon("BackgroundRemoval", [
  ["path", { d: "m3 20 18-6", strokeWidth: "1.3", strokeDasharray: "2 3", key: "background" }],
  ["path", { d: "M3 16c2 0 2-10 4-10s2 9 4 9 2-7 4-7 2 5 3 5 2-3 3-3", key: "signal" }],
])

export const ForwardTransformIcon = createLucideIcon("ForwardTransform", [
  ["path", { d: "M2 9c2 0 2-5 4-5s2 10 4 10 2-10 4-10 2 10 4 10 2-5 4-5", strokeWidth: "1.7", key: "wave" }],
  ["path", { d: "M3 20h18m-4-4 4 4-4 3", strokeWidth: "1.7", key: "forward" }],
])

export const BackwardTransformIcon = createLucideIcon("BackwardTransform", [
  ["path", { d: "M2 13h5c3 0 3-10 5-10s2 10 5 10h5", strokeWidth: "1.7", key: "peak" }],
  ["path", { d: "M21 20H3m4-4-4 4 4 3", strokeWidth: "1.7", key: "backward" }],
])

export const TransformGridIcon = createLucideIcon("TransformGrid", [
  ["rect", { x: "3", y: "3", width: "18", height: "18", rx: "1", strokeWidth: "1.6", key: "bounds" }],
  ["path", { d: "M9 3v18M15 3v18M3 9h18M3 15h18", strokeWidth: "1.3", key: "grid" }],
])

export const FitRangeIcon = createLucideIcon("FitRange", [
  ["path", { d: "M6 3H3v18h3M18 3h3v18h-3", strokeWidth: "1.6", key: "range" }],
  ["path", { d: "M6 14c2 0 2-7 4-7s2 10 4 10 2-7 4-7", strokeWidth: "1.8", key: "wave" }],
])
