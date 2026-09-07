import { createResource, createSignal, For, Show } from "solid-js"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import { useLingui } from "@lingui/solid"
import { useGlobalSDK } from "@/context/global-sdk"
import { AppPanel } from "@/components/app-panel"
import { orynPage } from "@/locales/messages"

/**
 * Minimal redacted Case surface from the read-only /oryn routes. The server
 * projects only host-approved fields; control is the single write path and is
 * meant for the authenticated human operator looking at this workbench.
 */
type CaseListItem = {
  id: string
  revision: number
  kind: string
  summary: string
  repoAlias: string
  control: string
  activeAttemptId?: string
  issueNumber?: number
  createdAt: number
  updatedAt: number
}

type CaseDetail = CaseListItem & {
  observed?: string
  expected?: string
  acceptanceRevision: number
  epoch: number
  repairRounds: number
  noProgressRounds: number
  pullNumbers: number[]
  sourceCount: number
  humanDecisions: string[]
}

type ControlAction = "pause" | "resume" | "takeover" | "cancel"

const controlButtonClass =
  "rounded border border-border-base bg-surface-base px-2 py-1 text-12-medium text-text-strong disabled:opacity-50"

function controlBadgeClass(state: string): string {
  return state === "paused" || state === "human_owned"
    ? "bg-surface-warning-weak text-text-on-warning-base"
    : "bg-background-stronger text-text-weak"
}

export function OrynPanel() {
  const sdk = useGlobalSDK()
  const { _ } = useLingui()
  const [selectedId, setSelectedId] = createSignal<string>()
  const [busy, setBusy] = createSignal(false)

  const [cases, { refetch }] = createResource(async () => {
    const result = await sdk.client.oryn.case.list()
    return (result.data as { cases: CaseListItem[] }).cases
  })

  const [detail, { refetch: refetchDetail }] = createResource(
    () => selectedId(),
    async (id: string) => {
      const result = await sdk.client.oryn.case.get({ id })
      return result.data as CaseDetail
    },
  )

  async function refresh() {
    await refetch()
    if (selectedId()) await refetchDetail()
  }

  async function control(action: ControlAction) {
    const current = detail()
    if (!current || busy()) return
    setBusy(true)
    try {
      await sdk.client.oryn.case.control({
        id: current.id,
        orynControlInput: { expectedRevision: current.revision, action },
      })
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <AppPanel.Root class="size-full">
      <AppPanel.Content>
        <AppPanel.Header>
          <AppPanel.HeaderRow>
            <div class="flex items-center gap-2 text-14-medium text-text-strong">
              <Show
                when={!selectedId()}
                fallback={
                  <button
                    type="button"
                    class="flex items-center gap-1 text-12-medium text-text-weak"
                    onClick={() => setSelectedId(undefined)}
                  >
                    <Icon name={getSemanticIcon("navigation.back")} size="small" />
                    {_({ ...orynPage.back })}
                  </button>
                }
              >
                <Icon name={getSemanticIcon("oryn.main")} size="small" />
                {_({ id: "app.plugin.builtin.oryn", message: "Oryn" })}
              </Show>
            </div>
            <button
              type="button"
              class="flex items-center gap-1 text-12-medium text-text-weak"
              onClick={() => void refresh()}
            >
              <Icon name={getSemanticIcon("action.refresh")} size="small" />
              {_({ ...orynPage.refresh })}
            </button>
          </AppPanel.HeaderRow>
        </AppPanel.Header>
        <Show
          when={!selectedId()}
          fallback={
            <Show
              when={detail()}
              fallback={
                <div class="flex size-full items-center justify-center">
                  <Spinner />
                </div>
              }
            >
              {(current) => (
                <div class="flex flex-col gap-3 overflow-auto p-4">
                  <div class="flex items-center gap-2">
                    <span class={`rounded px-1.5 text-12-medium ${controlBadgeClass(current().control)}`}>
                      {current().control}
                    </span>
                    <span class="text-12-medium text-text-weak">
                      {current().kind} · {current().repoAlias}
                    </span>
                  </div>
                  <div class="text-14-medium text-text-strong">{current().summary}</div>
                  <Show when={current().observed}>
                    <div class="text-12-medium text-text-weak">{current().observed}</div>
                  </Show>
                  <Show when={current().expected}>
                    <div class="text-12-medium text-text-weak">{current().expected}</div>
                  </Show>
                  <div class="text-12-medium text-text-weak">
                    {_({
                      id: "app.oryn.stats",
                      message: "repair {repair} · no-progress {noProgress} · epoch {epoch}",
                      values: {
                        repair: "" + current().repairRounds,
                        noProgress: "" + current().noProgressRounds,
                        epoch: "" + current().epoch,
                      },
                    })}
                  </div>
                  <div class="text-12-medium text-text-weak">
                    {_({
                      id: "app.oryn.remote",
                      message: "issue {issue} · pr {pulls}",
                      values: {
                        issue: current().issueNumber === undefined ? "—" : "" + current().issueNumber,
                        pulls: current().pullNumbers.length > 0 ? current().pullNumbers.join(", ") : "—",
                      },
                    })}
                  </div>
                  <div class="flex flex-wrap gap-2 pt-1">
                    <button
                      type="button"
                      disabled={busy()}
                      class={controlButtonClass}
                      onClick={() => void control("pause")}
                    >
                      {_(orynPage.controlPause)}
                    </button>
                    <button
                      type="button"
                      disabled={busy()}
                      class={controlButtonClass}
                      onClick={() => void control("resume")}
                    >
                      {_(orynPage.controlResume)}
                    </button>
                    <button
                      type="button"
                      disabled={busy()}
                      class={controlButtonClass}
                      onClick={() => void control("takeover")}
                    >
                      {_(orynPage.controlTakeover)}
                    </button>
                    <button
                      type="button"
                      disabled={busy()}
                      class={controlButtonClass}
                      onClick={() => void control("cancel")}
                    >
                      {_(orynPage.controlCancel)}
                    </button>
                  </div>
                </div>
              )}
            </Show>
          }
        >
          <Show
            when={!cases.loading}
            fallback={
              <div class="flex size-full items-center justify-center">
                <Spinner />
              </div>
            }
          >
            <div class="flex flex-col gap-2 overflow-auto p-4">
              <Show
                when={(cases() ?? []).length > 0}
                fallback={<div class="text-12-medium text-text-weak">{_({ ...orynPage.empty })}</div>}
              >
                <For each={cases()}>
                  {(item) => (
                    <button
                      type="button"
                      class="flex flex-col gap-1 rounded-lg border border-border-base bg-surface-base p-3 text-left"
                      onClick={() => setSelectedId(item.id)}
                    >
                      <div class="flex items-center gap-2">
                        <span class={`rounded px-1.5 text-12-medium ${controlBadgeClass(item.control)}`}>
                          {item.control}
                        </span>
                        <span class="text-12-medium text-text-weak">
                          {item.kind} · {item.repoAlias}
                        </span>
                      </div>
                      <div class="text-14-medium text-text-strong">{item.summary}</div>
                    </button>
                  )}
                </For>
              </Show>
            </div>
          </Show>
        </Show>
      </AppPanel.Content>
    </AppPanel.Root>
  )
}
