import "@testing-library/jest-dom/vitest"
import { cleanup, render, screen } from "@testing-library/react"
import { StrictMode, useState } from "react"
import { afterEach, expect, it, vi } from "vitest"
import { AthenaProvider, useAthenaTransport } from "./athena-context"
import type { AthenaSession } from "./athena-transport"

const session = (projectId: string, capability: string): AthenaSession => ({
  mode: "integration", projectId, capability, allowedOperations: ["read_project"], expiresAt: "2099-01-01T00:00:00Z",
})

function Probe({ label }: { label: string }) {
  const transport = useAthenaTransport()
  return <button onClick={() => void transport.fetch(`/api/athena/projects/${label}`)}>{label}</button>
}

afterEach(() => cleanup())

it("keeps overlapping workbench transports bound to their own sessions", () => {
  const fetcher = vi.fn().mockResolvedValue(new Response("{}"))
  render(<>
    <AthenaProvider session={session("one", "cap-one")} fetcher={fetcher}><Probe label="one" /></AthenaProvider>
    <AthenaProvider session={session("two", "cap-two")} fetcher={fetcher}><Probe label="two" /></AthenaProvider>
  </>)
  screen.getByRole("button", { name: "one" }).click()
  screen.getByRole("button", { name: "two" }).click()
  expect((fetcher.mock.calls[0][1].headers as Headers).get("x-xraylarch-project-capability")).toBe("cap-one")
  expect((fetcher.mock.calls[1][1].headers as Headers).get("x-xraylarch-project-capability")).toBe("cap-two")
})

it("keeps its session binding through StrictMode remounts", () => {
  const fetcher = vi.fn().mockResolvedValue(new Response("{}"))
  render(<StrictMode><AthenaProvider session={session("one", "cap-one")} fetcher={fetcher}><Probe label="one" /></AthenaProvider></StrictMode>)
  screen.getByRole("button", { name: "one" }).click()
  expect((fetcher.mock.calls[0][1].headers as Headers).get("x-xraylarch-project-capability")).toBe("cap-one")
})

it("does not reset a surviving provider when another provider unmounts", () => {
  const fetcher = vi.fn().mockResolvedValue(new Response("{}"))
  function Overlap() {
    const [first, setFirst] = useState(true)
    return <>
      {first && <AthenaProvider session={session("one", "cap-one")} fetcher={fetcher}><Probe label="one" /></AthenaProvider>}
      <AthenaProvider session={session("two", "cap-two")} fetcher={fetcher}><Probe label="two" /></AthenaProvider>
      <button onClick={() => setFirst(false)}>remove one</button>
    </>
  }
  render(<Overlap />)
  screen.getByRole("button", { name: "remove one" }).click()
  screen.getByRole("button", { name: "two" }).click()
  expect((fetcher.mock.calls[0][1].headers as Headers).get("x-xraylarch-project-capability")).toBe("cap-two")
})
