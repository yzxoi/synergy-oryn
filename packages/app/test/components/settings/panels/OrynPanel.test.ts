import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { createServer as reservePort, type AddressInfo } from "node:net"
import { chromium, type Browser } from "playwright"
import { createServer, type ViteDevServer } from "vite"
import solidPlugin from "vite-plugin-solid"
import tailwindcss from "@tailwindcss/vite"

let browser: Browser
let server: ViteDevServer
let directory: string
let url: string

beforeAll(async () => {
  directory = await mkdtemp(path.join(import.meta.dir, ".oryn-panel-fixture-"))
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
      export const state = { calls: [], fail: new URLSearchParams(location.search).has("fail"), connections: 0 }
      const empty = new URLSearchParams(location.search).has("empty")
      export const view = { revision: "initial", config: { enabled: false }, repositories: empty ? [] : [{ accountId: "app", repository: "acme/widget" }], targets: empty ? [] : [{ id: "chat-choice", accountId: "feishu", chatId: "chat", label: "QA operations" }] }
      export const useGlobalSDK = () => ({ client: { oryn: { setup: {
        get: async () => { if (state.fail) throw new Error("Connection unavailable"); return { data: structuredClone(view) } },
        update: async ({ orynSetupInput }) => { if (state.fail) throw new Error("Save rejected"); state.calls.push(orynSetupInput); return { data: structuredClone(view) } },
      } } } })
      export const requestErrorMessage = (error) => error instanceof Error ? error.message : String(error)
    `,
    ),
    Bun.write(
      path.join(directory, "main.tsx"),
      `
      import { setupI18n } from "@lingui/core"
      import { I18nProvider } from "@lingui/solid"
      import { render } from "solid-js/web"
      import { MetaProvider } from "@solidjs/meta"
      import { Font } from "@ericsanchezok/synergy-ui/font"
      import { ThemeProvider } from "@ericsanchezok/synergy-ui/theme/context"
      import { OrynPanel } from ${JSON.stringify(`/@fs/${app}/src/components/settings/panels/OrynPanel.tsx`)}
      import { state } from "./stubs"
      import "@ericsanchezok/synergy-ui/styles/tailwind"
      import ${JSON.stringify(`/@fs/${app}/src/components/settings/settings-panel.css`)}
      const i18n = setupI18n({ locale: "en", messages: { en: {}, "zh-CN": { "settings.oryn.save": "保存 Oryn 设置", "settings.oryn.repository": "默认监听仓库" } } })
      window.__orynFixture = { state, chinese: () => i18n.activate("zh-CN") }
      render(() => <MetaProvider><Font /><ThemeProvider><I18nProvider i18n={i18n}><OrynPanel onChannels={() => state.connections++} /></I18nProvider></ThemeProvider></MetaProvider>, document.getElementById("root"))
    `,
    ),
  ])
  const reservation = reservePort()
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve))
  const port = (reservation.address() as AddressInfo).port
  await new Promise<void>((resolve) => reservation.close(() => resolve()))
  server = await createServer({
    configFile: false,
    root: directory,
    cacheDir: path.join(directory, ".vite"),
    plugins: [solidPlugin(), tailwindcss()],
    optimizeDeps: { include: ["solid-js", "solid-js/web", "@lingui/core", "@lingui/solid", "zod"], noDiscovery: true },
    resolve: {
      alias: [
        { find: "@/context/global-sdk", replacement: stubs },
        { find: "@/utils/error", replacement: stubs },
      ],
    },
    server: { host: "127.0.0.1", port, strictPort: true, hmr: false, fs: { allow: [path.resolve(app, "../..")] } },
  })
  await server.listen()
  url = server.resolvedUrls!.local[0]!
  await server.warmupRequest("/main.tsx")
  browser = await chromium.launch({ headless: true })
})

afterAll(async () => {
  await browser?.close()
  if (server?.httpServer && "closeAllConnections" in server.httpServer) server.httpServer.closeAllConnections()
  await server?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
})

test("Oryn setup saves selected repository and destination, translates reactively, and fits a narrow viewport", async () => {
  const page = await browser.newPage({ viewport: { width: 375, height: 900 } })
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  try {
    await page.goto(url)
    await page
      .getByLabel("Repository checkout on the server")
      .waitFor({ timeout: 15000 })
      .catch((error) => {
        throw new Error(errors.join("; "), { cause: error })
      })
    await page.getByLabel("Repository checkout on the server").fill("/srv/widget")
    await page.getByLabel("Default Feishu chat or topic").selectOption("chat-choice")
    await page.getByRole("button", { name: "Save Oryn settings", exact: true }).click()
    await page.getByText("Oryn settings saved.", { exact: true }).waitFor()
    const calls = await page.evaluate(
      () => (window as unknown as { __orynFixture: { state: { calls: unknown[] } } }).__orynFixture.state.calls,
    )
    expect(calls).toEqual([
      expect.objectContaining({
        repository: "acme/widget",
        githubAccount: "app",
        notificationTarget: "chat-choice",
        directory: "/srv/widget",
        backfill: true,
        autoReview: true,
        autoFix: false,
      }),
    ])
    await page.evaluate(() => (window as unknown as { __orynFixture: { chinese: () => void } }).__orynFixture.chinese())
    await page.getByRole("button", { name: "保存 Oryn 设置" }).waitFor()
    expect(await page.getByLabel("默认监听仓库").count()).toBe(1)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.getByLabel("默认监听仓库").focus()
    await page.keyboard.press("Tab")
    expect(
      await page
        .getByLabel("Repository checkout on the server")
        .evaluate((element) => element === document.activeElement),
    ).toBe(true)
    await page.emulateMedia({ colorScheme: "dark" })
    await page.waitForFunction(() => document.documentElement.dataset.colorScheme === "dark")
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    expect(errors).toEqual([])
    if (process.env.ORYN_UI_CAPTURE_ROOT)
      await page.screenshot({ path: path.join(process.env.ORYN_UI_CAPTURE_ROOT, "oryn-setup.png"), fullPage: true })
  } finally {
    await page.close()
  }
}, 60000)

test("load errors can retry and an empty setup points to connections", async () => {
  const page = await browser.newPage()
  try {
    await page.goto(url + "?fail")
    await page.getByRole("alert").waitFor()
    expect(await page.getByRole("alert").textContent()).toBe("Connection unavailable")
    await page.evaluate(() => {
      ;(window as unknown as { __orynFixture: { state: { fail: boolean } } }).__orynFixture.state.fail = false
    })
    await page.getByRole("button", { name: "Retry", exact: true }).click()
    await page.getByLabel("Repository checkout on the server").waitFor()
    await page.goto(url + "?empty")
    await page
      .getByText("Connect a GitHub App channel and add its repositories in Manage connections first.", { exact: true })
      .waitFor()
    expect(await page.getByRole("button", { name: "Save Oryn settings", exact: true }).isDisabled()).toBe(true)
    await page.getByRole("button", { name: "Manage connections", exact: true }).click()
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { __orynFixture: { state: { connections: number } } }).__orynFixture.state.connections,
      ),
    ).toBe(1)
  } finally {
    await page.close()
  }
}, 60000)
