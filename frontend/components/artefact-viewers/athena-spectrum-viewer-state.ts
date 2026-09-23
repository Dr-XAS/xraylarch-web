"use client"

import { useRef, useState } from "react"
import { defaultPlotColors, type PlotColorSettings } from "@/lib/athena-plot-colors"
import type { Space } from "./athena-plot"

export function useSpectrumViewerState(scope: "current" | "selected") {
  const current = scope === "current"
  const [space, setSpace] = useState<Space>("E")
  const [energyMode, setEnergyMode] = useState(current ? "mu" : "norm")
  const [rComponent, setRComponent] = useState("mag")
  const [qComponent, setQComponent] = useState("re")
  const component = space === "q" ? qComponent : rComponent
  const setComponent = space === "q" ? setQComponent : setRComponent
  const [background, setBackground] = useState(current)
  const [preEdge, setPreEdge] = useState(current)
  const [postEdge, setPostEdge] = useState(current)
  const [showWindow, setShowWindow] = useState(false)
  const [showLegend, setShowLegend] = useState(!current)
  const [showGrid, setShowGrid] = useState(true)
  const [showDataPoints, setShowDataPoints] = useState(false)
  const [plotColors, setPlotColors] = useState<PlotColorSettings>(defaultPlotColors)
  const [offset, setOffset] = useState(0)
  const previousStackOffset = useRef(0.1)
  const [range, setRange] = useState<[number | null, number | null]>([null, null])
  const [rangeRelativeToE0, setRangeRelativeToE0] = useState(true)

  return {
    space, setSpace,
    energyMode, setEnergyMode,
    rComponent, setRComponent,
    qComponent, setQComponent,
    component, setComponent,
    background, setBackground,
    preEdge, setPreEdge,
    postEdge, setPostEdge,
    showWindow, setShowWindow,
    showLegend, setShowLegend,
    showGrid, setShowGrid,
    showDataPoints, setShowDataPoints,
    plotColors, setPlotColors,
    offset, setOffset, previousStackOffset,
    range, setRange,
    rangeRelativeToE0, setRangeRelativeToE0,
    plotScope: scope,
  }
}
