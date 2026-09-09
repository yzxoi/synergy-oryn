import { Scope } from "../scope"
import { ScopeContext } from "../scope/context"
import { Log } from "../util/log"
import { OrynBudget } from "./budget"
import { OrynControl } from "./control"
import { OrynService } from "./service"

export namespace OrynBudgetRuntime {
  const log = Log.create({ service: "oryn.budget" })
  let stopped = true
  let timer: ReturnType<typeof setTimeout> | undefined
  let sweep: Promise<void> | undefined
  let notifications: Promise<void> | undefined
  let cleanupPending = false
  let notificationPending = true

  function tick() {
    sweep = ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        if (cleanupPending) cleanupPending = (await OrynControl.recover()).failed > 0
        await OrynBudget.checkpoint()
        const result = await OrynControl.enforceBudgets()
        cleanupPending ||= result.failed > 0
        notificationPending ||= result.expired > 0 || result.failed > 0
        if (notificationPending && !notifications) {
          notificationPending = false
          notifications = OrynService.recoverHandoffs()
            .then((result) => {
              notificationPending ||= result.failed > 0
            })
            .catch((error) => {
              notificationPending = true
              log.warn("budget handoff notification recovery failed", { error })
            })
            .finally(() => {
              notifications = undefined
            })
        }
      },
    })
      .catch((error) => log.warn("budget sweep failed", { error }))
      .finally(() => {
        sweep = undefined
        if (!stopped) {
          timer = setTimeout(tick, 1000)
          timer.unref()
        }
      })
    return sweep
  }

  export async function start() {
    if (!stopped) return sweep
    stopped = false
    notificationPending = true
    await tick()
  }

  export async function stop() {
    stopped = true
    if (timer) clearTimeout(timer)
    timer = undefined
    await sweep
    await notifications
  }
}
