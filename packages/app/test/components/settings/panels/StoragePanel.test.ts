import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { createServer as reservePort, type AddressInfo } from "node:net"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solidPlugin from "vite-plugin-solid"

let browser: Browser
let page: Page
let server: ViteDevServer
let directory: string
let url: string
const errors: string[] = []
type Fixture = {
  calls: Array<{ operation: string; apply?: boolean }>
  toasts: Array<{ type: string; title: string; description?: string }>
  changes: Array<[string, boolean]>
  fail: string
  empty: boolean
  confirm?: { title: string; onConfirm: () => Promise<void> }
}

beforeAll(async () => {
  directory = await mkdtemp(path.join(import.meta.dir, ".storage-panel-fixture-"))
  const app = path.resolve(import.meta.dir, "../../../..")
  const stubs = path.join(directory, "stubs.ts")
  await Promise.all([
    Bun.write(
      path.join(directory, "index.html"),
      '<div id="root"></div><script type="module" src="/main.tsx"></script>',
    ),
    Bun.write(
      stubs,
      `
      export const state = { calls: [], toasts: [], changes: [], fail: "", empty: false, confirm: undefined }
      export const showToast = (toast) => state.toasts.push(toast)
      export const useConfirm = () => ({ show: (options) => { state.confirm = options } })
      export const requestErrorMessage = (error) => error instanceof Error ? error.message : String(error)
      export const formatBytes = (bytes) => bytes + " B"
      const usage = {
        scopeID: "scope-fixture", owners: { shared: 2, legacy: 1, deleted: 0 },
        shared: { allocatedBytes: 100 }, legacy: { allocatedBytes: 200 }, indexes: { allocatedBytes: 50 },
        retainedLegacy: { unowned: 1, reclaimed: 0, sharedBaselines: 0, unregistered: 0 },
      }
      function request(operation, input) {
        const apply = input ? Object.values(input)[0].apply : undefined
        state.calls.push({ operation, apply })
        if (state.fail === operation) return Promise.resolve({ error: "fixture request failed" })
        if (operation === "usage") return Promise.resolve({ data: state.empty ? [] : [usage] })
        if (operation === "clean") return Promise.resolve({ data: { results: [{
          scopeID: "scope-fixture", candidates: state.empty ? [] : [{ bytes: 200 }],
          removed: apply ? 1 : 0, bytes: apply ? 200 : 0, errors: [],
        }], failures: [] } })
        if (operation === "migrate") return Promise.resolve({ data: { results: [{
          scopeID: "scope-fixture", results: state.empty ? [] : [{ status: apply ? "migrated" : "pending" }],
        }], failures: [] } })
        return Promise.resolve({ data: { results: [{ scopeID: "scope-fixture", applied: !!apply,
          before: { bytes: state.empty ? 0 : 300 }, after: { bytes: 100 },
        }], failures: [] } })
      }
      export const useGlobalSDK = () => ({ client: {
        scope: { list: async () => ({ data: [{ id: "scope-fixture", name: "Fixture project" }] }) },
        storage: { snapshot: Object.fromEntries(["usage", "clean", "migrate", "compact"].map(
          (operation) => [operation, (input) => request(operation, input)])) },
      } })
    `,
    ),
    Bun.write(
      path.join(directory, "main.tsx"),
      `
      import { setupI18n } from "@lingui/core"
      import { I18nProvider } from "@lingui/solid"
      import { createSignal } from "solid-js"
      import { render } from "solid-js/web"
      import { StoragePanel } from ${JSON.stringify(`/@fs/${app}/src/components/settings/panels/StoragePanel.tsx`)}
      import { defaultSettingsState } from ${JSON.stringify(`/@fs/${app}/src/components/settings/types.ts`)}
      import { state } from "./stubs"
      const i18n = setupI18n({ locale: "en", messages: { en: {} } })
      window.__storageFixture = state
      function Harness() {
        const [snapshot, setSnapshot] = createSignal(true)
        return <StoragePanel general={{ ...defaultSettingsState.general, get snapshot() { return snapshot() } }}
          onGeneralChange={(key, value) => { state.changes.push([key, value]); setSnapshot(value) }} />
      }
      render(() => <I18nProvider i18n={i18n}><Harness /></I18nProvider>, document.querySelector("#root"))
    `,
    ),
  ])
  const reservation = reservePort()
  await new Promise<void>((resolve, reject) => {
    reservation.once("error", reject)
    reservation.listen(0, "127.0.0.1", resolve)
  })
  const port = (reservation.address() as AddressInfo).port
  await new Promise<void>((resolve, reject) => reservation.close((error) => (error ? reject(error) : resolve())))
  server = await createServer({
    configFile: false,
    root: directory,
    cacheDir: path.join(directory, ".vite"),
    plugins: [solidPlugin()],
    optimizeDeps: { include: ["solid-js", "solid-js/web", "@lingui/core", "@lingui/solid", "zod"], noDiscovery: true },
    resolve: {
      alias: [
        { find: "@/context/global-sdk", replacement: stubs },
        { find: "@/components/dialog/confirm-dialog", replacement: stubs },
        { find: "@/components/library/shared", replacement: stubs },
        { find: "@/utils/error", replacement: stubs },
        { find: "@ericsanchezok/synergy-ui/toast", replacement: stubs },
      ],
    },
    server: { host: "127.0.0.1", port, strictPort: true, hmr: false, fs: { allow: [path.resolve(app, "../..")] } },
  })
  await server.listen()
  url = server.resolvedUrls?.local[0] ?? ""
  if (!url) throw new Error("Storage panel fixture did not bind")
  await server.warmupRequest("/main.tsx")
  browser = await chromium.launch({ headless: true })
})

beforeEach(async () => {
  await page?.close()
  page = await browser.newPage()
  errors.length = 0
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text())
  })
  page.on("requestfailed", (request) =>
    errors.push(`${request.method()} ${request.url()} ${request.failure()?.errorText}`),
  )
  await page.goto(url)
  try {
    await page.getByRole("heading", { name: "Storage", exact: true }).waitFor()
    await page.getByText("Fixture project", { exact: true }).waitFor()
  } catch (error) {
    throw new Error(`Storage fixture failed: ${errors.join("; ")}`, { cause: error })
  }
})

afterAll(async () => {
  await page?.close()
  await browser?.close()
  const http = server?.httpServer
  if (http && "closeAllConnections" in http) http.closeAllConnections()
  await server?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
})

function state() {
  return page.evaluate(() => {
    const { calls, toasts, changes, confirm } = (window as unknown as { __storageFixture: Fixture }).__storageFixture
    return { calls, toasts, changes, confirmTitle: confirm?.title }
  })
}

async function waitForToast() {
  await page.waitForFunction(
    () => (window as unknown as { __storageFixture: Fixture }).__storageFixture.toasts.length > 0,
  )
}

test("renders project usage, refreshes it and forwards the snapshot preference", async () => {
  expect(await page.getByText("Shared repository: 100 B", { exact: false }).count()).toBe(1)
  await page.getByRole("button", { name: "Refresh", exact: true }).click()
  await page.waitForFunction(
    () =>
      (window as unknown as { __storageFixture: Fixture }).__storageFixture.calls.filter(
        (call) => call.operation === "usage",
      ).length === 2,
  )
  await page.locator('[data-slot="switch-input"]').focus()
  await page.keyboard.press("Space")
  expect((await state()).changes).toEqual([["snapshot", false]])
  expect(errors).toEqual([])
})

for (const [operation, label] of [
  ["clean", "Reclaim"],
  ["migrate", "Migrate"],
  ["compact", "Pack"],
] as const) {
  test(`${operation} previews before confirmation and refreshes after applying`, async () => {
    await page.getByRole("button", { name: label, exact: true }).click()
    await page.waitForFunction(() => !!(window as unknown as { __storageFixture: Fixture }).__storageFixture.confirm)
    expect((await state()).calls.filter((call) => call.operation === operation)).toEqual([{ operation, apply: false }])
    await page.evaluate(async () =>
      (window as unknown as { __storageFixture: Fixture }).__storageFixture.confirm!.onConfirm(),
    )
    const result = await state()
    expect(result.calls.filter((call) => call.operation === operation)).toEqual([
      { operation, apply: false },
      { operation, apply: true },
    ])
    expect(result.calls.filter((call) => call.operation === "usage")).toHaveLength(2)
    expect(result.toasts.some((toast) => toast.type === "success")).toBe(true)
  })

  test(`${operation} reports an apply failure without claiming success`, async () => {
    await page.getByRole("button", { name: label, exact: true }).click()
    await page.waitForFunction(() => !!(window as unknown as { __storageFixture: Fixture }).__storageFixture.confirm)
    await page.evaluate(async (operation) => {
      const fixture = (window as unknown as { __storageFixture: Fixture }).__storageFixture
      fixture.fail = operation
      await fixture.confirm!.onConfirm()
    }, operation)
    const result = await state()
    expect(result.calls.filter((call) => call.operation === operation)).toEqual([
      { operation, apply: false },
      { operation, apply: true },
    ])
    expect(result.toasts.map((toast) => toast.type)).toEqual(["error"])
    expect(result.calls.filter((call) => call.operation === "usage")).toHaveLength(1)
  })

  test(`${operation} does not request confirmation or apply after a failed preview`, async () => {
    await page.evaluate((operation) => {
      ;(window as unknown as { __storageFixture: Fixture }).__storageFixture.fail = operation
    }, operation)
    await page.getByRole("button", { name: label, exact: true }).click()
    await waitForToast()
    const result = await state()
    expect(result.confirmTitle).toBeUndefined()
    expect(result.calls.filter((call) => call.operation === operation)).toEqual([{ operation, apply: false }])
    expect(result.toasts.at(-1)?.type).toBe("error")
    expect(await page.getByRole("button", { name: label, exact: true }).isEnabled()).toBe(true)
  })
}

test("nothing to reclaim produces an informational result without an apply request", async () => {
  await page.evaluate(() => {
    ;(window as unknown as { __storageFixture: Fixture }).__storageFixture.empty = true
  })
  await page.getByRole("button", { name: "Reclaim", exact: true }).click()
  await waitForToast()
  expect((await state()).confirmTitle).toBeUndefined()
  expect((await state()).toasts.at(-1)?.type).toBe("info")
})

test("failed usage refresh displays an error and a later refresh recovers", async () => {
  await page.evaluate(() => {
    ;(window as unknown as { __storageFixture: Fixture }).__storageFixture.fail = "usage"
  })
  await page.getByRole("button", { name: "Refresh", exact: true }).click()
  await page.getByText("Snapshot scan failed", { exact: true }).waitFor()
  await page.evaluate(() => {
    ;(window as unknown as { __storageFixture: Fixture }).__storageFixture.fail = ""
  })
  await page.getByRole("button", { name: "Refresh", exact: true }).click()
  await page.getByText("Fixture project", { exact: true }).waitFor()
})
