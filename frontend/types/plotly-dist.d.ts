declare module "plotly.js-dist-min" {
  const Plotly: {
    toImage(figure: { data: Array<Record<string, unknown>>; layout: Record<string, unknown> },
      options: { format: "svg"; width: number; height: number }): Promise<string>
  }
  export default Plotly
}
