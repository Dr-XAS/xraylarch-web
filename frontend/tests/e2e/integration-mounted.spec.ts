import { createHash, createHmac, randomBytes } from "node:crypto"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { expect, test, type APIRequestContext, type Page } from "@playwright/test"

const fixture = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../fixtures/cu_rt01.xmu")
const mount = "/advanced-xas/app"
const issuer = "playwright-drxas"
const audience = "playwright-athena"
const secret = "playwright-only-integration-secret-32-bytes"
const backendOrigin = `http://127.0.0.1:${process.env.XRAYLARCH_E2E_BACKEND_PORT ?? "18006"}`
const frontendOrigin = `http://127.0.0.1:${process.env.XRAYLARCH_E2E_FRONTEND_PORT ?? "13004"}`

type CreatedProject = { project_id: string; capability: string }

async function signedRequest(request: APIRequestContext, method: string, route: string, body: unknown, capability?: string) {
  const raw = JSON.stringify(body)
  const timestamp = String(Math.floor(Date.now() / 1000))
  const nonce = randomBytes(24).toString("hex")
  const digest = createHash("sha256").update(raw).digest("hex")
  const canonical = ["v2", method, route, issuer, audience, timestamp, nonce, digest].join("\n")
  const signature = createHmac("sha256", secret).update(canonical).digest("hex")
  return request.fetch(`${backendOrigin}${route}`, {
    method,
    data: raw,
    headers: {
      "content-type": "application/json",
      "X-DrXAS-Issuer": issuer,
      "X-DrXAS-Audience": audience,
      "X-DrXAS-Timestamp": timestamp,
      "X-DrXAS-Nonce": nonce,
      "X-DrXAS-Body-SHA256": digest,
      "X-DrXAS-Signature": signature,
      ...(capability ? { "X-XrayLarch-Project-Capability": capability } : {}),
    },
  })
}

async function createProject(request: APIRequestContext): Promise<CreatedProject> {
  const route = "/api/integration/v2/projects"
  const response = await signedRequest(request, "POST", route, {
    contract_version: 2,
    name: "Mounted persistent acceptance",
    persistent: true,
  })
  expect(response.ok()).toBeTruthy()
  return response.json()
}

async function launchProject(request: APIRequestContext, project: CreatedProject) {
  const route = `/api/integration/v2/projects/${project.project_id}/launch`
  const response = await signedRequest(request, "POST", route, { capability: project.capability }, project.capability)
  expect(response.ok()).toBeTruthy()
  return (await response.json()).handle as string
}

async function openLaunch(page: Page, handle: string) {
  await page.goto(`${mount}/integration?launch=${encodeURIComponent(handle)}&return=%2Fadvanced-xas`)
  await expect(page).toHaveURL(new RegExp(`${mount}/integration$`))
  await expect(page.getByText("Linked project", { exact: true })).toBeVisible()
  expect(await page.evaluate(() => location.search)).toBe("")
}

test("mounted persistent Athena completes its authorized lifecycle", async ({ page, request }, info) => {
  test.setTimeout(120_000)
  let project: CreatedProject | undefined
  let deleted = false
  try {
    project = await createProject(request)
    await openLaunch(page, await launchProject(request, project))
    const originalBrowserCapability = await page.evaluate(() => JSON.parse(sessionStorage.getItem("xraylarch.integration.session.v2")!).capability as string)

    await page.getByRole("button", { name: "Import data", exact: true }).click()
    await page.getByLabel("Choose data files", { exact: true }).setInputFiles(fixture)
    const importedResponse = page.waitForResponse(response => response.url().endsWith("/import"))
    await page.getByRole("button", { name: "Import spectrum", exact: true }).click()
    const imported = await (await importedResponse).json()
    expect(imported.groups).toHaveLength(1)
    const group = imported.groups[0]
    await expect(page.getByRole("heading", { name: /^Data groups 1/ })).toBeVisible()

    const processedResponse = page.waitForResponse(response => response.url().endsWith("/command") && response.request().postDataJSON().action === "parameters")
    const e0 = page.getByRole("spinbutton", { name: "E₀ eV", exact: true })
    await e0.fill("8988")
    await e0.press("Enter")
    const processed = await (await processedResponse).json()
    expect(processed.groups[0].parameters.e0).toBe(8988)

    await page.reload()
    await expect(page.getByRole("heading", { name: /^Data groups 1/ })).toBeVisible()
    await expect(page.getByRole("spinbutton", { name: "E₀ eV", exact: true })).toHaveValue("8988")

    const download = page.waitForEvent("download")
    await page.getByRole("button", { name: "CSV", exact: true }).click()
    const saved = await download
    await saved.saveAs(info.outputPath("authorized-group.csv"))
    expect(saved.suggestedFilename()).toContain(".csv")

    const markedResponse = page.waitForResponse(response => response.url().endsWith("/command") && response.request().postDataJSON().action === "metadata")
    await page.getByLabel(`Mark ${group.label}`, { exact: true }).check()
    const markedProject = await (await markedResponse).json()
    await page.route("**/advanced-xas", route => route.fulfill({ status: 200, contentType: "text/html", body: "<title>Controlled Dr.XAS return</title>" }))
    await page.getByRole("link", { name: "Import 1 selected group into Dr.XAS", exact: true }).click()
    await expect(page).toHaveURL(`${frontendOrigin}/advanced-xas`)
    const selection = JSON.parse((await page.evaluate(() => sessionStorage.getItem("xraylarch.integration.return-selection.v1")))!)
    expect(selection).toEqual({
      projectId: project.project_id,
      projectVersion: markedProject.version,
      sessionExpiresAt: expect.any(String),
      groups: [{ id: group.id, version: markedProject.version }],
    })

    const rotateRoute = `/api/integration/v2/projects/${project.project_id}/capability/rotate`
    const rotated = await signedRequest(request, "POST", rotateRoute, {}, project.capability)
    expect(rotated.ok()).toBeTruthy()
    project.capability = (await rotated.json()).capability
    const stale = await request.get(`${backendOrigin}/api/athena/projects/${project.project_id}`, {
      headers: { "X-XrayLarch-Project-Capability": originalBrowserCapability },
    })
    expect(stale.status()).toBe(404)
    await openLaunch(page, await launchProject(request, project))
    await expect(page.getByRole("heading", { name: /^Data groups 1/ })).toBeVisible()

    const unauthenticated = await request.get(`${mount}/api/backend/api/athena/projects/${project.project_id}`)
    expect(unauthenticated.status()).toBe(404)

    const deleteRoute = `/api/integration/v2/projects/${project.project_id}`
    const response = await signedRequest(request, "DELETE", deleteRoute, {}, project.capability)
    expect(response.ok()).toBeTruthy()
    expect((await response.json()).status).toBe("deleted")
    deleted = true
  } finally {
    if (project && !deleted) {
      const deleteRoute = `/api/integration/v2/projects/${project.project_id}`
      await signedRequest(request, "DELETE", deleteRoute, {}, project.capability).catch(() => undefined)
    }
  }
})
