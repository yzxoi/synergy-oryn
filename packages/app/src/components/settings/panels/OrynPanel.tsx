import { createResource, createSignal, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLingui } from "@lingui/solid"
import type { OrynSetupInput, OrynSetupView } from "@ericsanchezok/synergy-sdk/client"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { Switch } from "@ericsanchezok/synergy-ui/switch"
import { SettingRow } from "@ericsanchezok/synergy-ui/setting-row"
import { useGlobalSDK } from "@/context/global-sdk"
import { requestErrorMessage } from "@/utils/error"
import { SettingsPage, SettingsSection } from "../components/SettingsPrimitives"

export function OrynPanel(props: { onChannels: () => void }) {
  const { _ } = useLingui()
  const sdk = useGlobalSDK()
  const [saved, setSaved] = createSignal(false)
  const [view, { refetch }] = createResource(
    async () => (await sdk.client.oryn.setup.get({}, { throwOnError: true })).data!,
  )
  return (
    <SettingsPage
      title={_({ id: "settings.catalog.oryn.label", message: "Oryn" })}
      description={_({
        id: "settings.oryn.description",
        message:
          "Connect repository feedback, independent PR reviews and quiet human-intervention notifications. Humans merge every PR.",
      })}
    >
      <Button variant="secondary" class="self-start" onClick={props.onChannels}>
        {_({ id: "settings.oryn.connections", message: "Manage connections" })}
      </Button>
      <Show when={view.loading}>
        <p role="status">{_({ id: "settings.oryn.loading", message: "Loading connected repositories and chats…" })}</p>
      </Show>
      <Show when={view.error}>
        <p role="alert">{requestErrorMessage(view.error)}</p>
        <Button onClick={() => refetch()}>{_({ id: "settings.oryn.retry", message: "Retry" })}</Button>
      </Show>
      <Show when={!view.error && view()} keyed>
        {(value) => (
          <OrynForm
            view={value}
            onSaved={async () => {
              setSaved(true)
              await refetch()
            }}
          />
        )}
      </Show>
      <Show when={saved()}>
        <p role="status">{_({ id: "settings.oryn.saved", message: "Oryn settings saved." })}</p>
      </Show>
    </SettingsPage>
  )
}

function OrynForm(props: { view: OrynSetupView; onSaved: () => Promise<unknown> }) {
  const { _ } = useLingui()
  const sdk = useGlobalSDK()
  const first = props.view.repositories[0]
  const alias =
    props.view.config?.defaultRepoAlias ??
    Object.keys(props.view.config?.repositories ?? {})[0] ??
    first?.repository ??
    ""
  const repository = props.view.config?.repositories?.[alias]
  const target = props.view.config?.notifications?.target
  const [draft, setDraft] = createStore<OrynSetupInput>({
    revision: props.view.revision,
    enabled: props.view.config?.enabled ?? false,
    repoAlias: alias,
    githubAccount: repository?.githubAccount ?? first?.accountId ?? "",
    repository: repository ? `${repository.owner}/${repository.repo}` : (first?.repository ?? ""),
    directory: repository?.directory ?? "",
    baseBranch: repository?.baseBranch ?? "dev",
    backfill: repository?.github?.backfill ?? true,
    autoReview: repository?.github?.autoReview ?? true,
    autoFix: repository?.github?.autoFix ?? false,
    notificationTarget: props.view.targets.find(
      (item) =>
        item.accountId === target?.accountId && item.chatId === target?.chatId && item.threadId === target?.threadId,
    )?.id,
  })
  const [saving, setSaving] = createSignal(false)
  const [error, setError] = createSignal("")
  const [saved, setSaved] = createSignal(false)
  const save = async () => {
    setSaving(true)
    setError("")
    setSaved(false)
    try {
      await sdk.client.oryn.setup.update({ orynSetupInput: { ...draft } }, { throwOnError: true })
      setSaved(true)
      await props.onSaved()
    } catch (error) {
      setError(requestErrorMessage(error))
    } finally {
      setSaving(false)
    }
  }
  const selectRepository = (value: string) => {
    const selected = props.view.repositories[Number(value)]
    if (!selected) return
    const existing = Object.entries(props.view.config?.repositories ?? {}).find(
      ([, repo]) => `${repo.owner}/${repo.repo}` === selected.repository && repo.githubAccount === selected.accountId,
    )
    setDraft({
      githubAccount: selected.accountId,
      repository: selected.repository,
      repoAlias: existing?.[0] ?? selected.repository,
      directory: existing?.[1].directory ?? "",
      baseBranch: existing?.[1].baseBranch ?? "dev",
      backfill: existing?.[1].github?.backfill ?? true,
      autoReview: existing?.[1].github?.autoReview ?? true,
      autoFix: existing?.[1].github?.autoFix ?? false,
    })
  }
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        void save()
      }}
      class="flex flex-col gap-4"
    >
      <SettingsSection>
        <SettingRow
          title={_({ id: "settings.oryn.enabled", message: "Enable Oryn" })}
          description=""
          trailing={
            <Switch
              checked={draft.enabled}
              disabled={saving()}
              onChange={(value) => setDraft("enabled", value)}
              aria-label={_({ id: "settings.oryn.enabled", message: "Enable Oryn" })}
            />
          }
        />
        <label class="flex flex-col gap-2">
          {_({ id: "settings.oryn.repository", message: "Default monitored repository" })}
          <select
            class="w-full rounded-md border border-border-base bg-background-base text-text-base px-3 py-2"
            disabled={saving() || !props.view.repositories.length}
            value={String(
              props.view.repositories.findIndex(
                (item) => item.repository === draft.repository && item.accountId === draft.githubAccount,
              ),
            )}
            onChange={(event) => selectRepository(event.currentTarget.value)}
          >
            <For each={props.view.repositories}>
              {(item, index) => (
                <option value={String(index())}>
                  {item.repository} · {item.accountId}
                </option>
              )}
            </For>
          </select>
        </label>
        <Show when={!props.view.repositories.length}>
          <p>
            {_({
              id: "settings.oryn.noRepositories",
              message: "Connect a GitHub App channel and add its repositories in Manage connections first.",
            })}
          </p>
        </Show>
        <TextField
          label={_({ id: "settings.oryn.directory", message: "Repository checkout on the server" })}
          value={draft.directory}
          onChange={(value) => setDraft("directory", value)}
          disabled={saving()}
        />
        <TextField
          label={_({ id: "settings.oryn.baseBranch", message: "Target branch" })}
          value={draft.baseBranch}
          onChange={(value) => setDraft("baseBranch", value)}
          disabled={saving()}
        />
      </SettingsSection>
      <SettingsSection
        title={_({ id: "settings.oryn.notifications", message: "Human intervention" })}
        description={_({
          id: "settings.oryn.notificationsDescription",
          message:
            "GitHub tasks send only decisions and ready results here. Feishu feedback keeps replies in its original conversation.",
        })}
      >
        <label class="flex flex-col gap-2">
          {_({ id: "settings.oryn.destination", message: "Default Feishu chat or topic" })}
          <select
            class="w-full rounded-md border border-border-base bg-background-base text-text-base px-3 py-2"
            value={draft.notificationTarget ?? ""}
            disabled={saving()}
            onChange={(event) => setDraft("notificationTarget", event.currentTarget.value || undefined)}
          >
            <option value="">{_({ id: "settings.oryn.noDestination", message: "No default destination" })}</option>
            <For each={props.view.targets}>
              {(item) => (
                <option value={item.id}>
                  {item.label} · {item.accountId}
                </option>
              )}
            </For>
          </select>
        </label>
        <Show when={!props.view.targets.length}>
          <p>
            {_({
              id: "settings.oryn.noChats",
              message:
                "Connect Feishu, add the bot to a chat, then refresh projects in Channels. Topics appear after a conversation with Oryn.",
            })}
          </p>
        </Show>
      </SettingsSection>
      <SettingsSection title={_({ id: "settings.oryn.automation", message: "Automation" })}>
        <SettingRow
          title={_({ id: "settings.oryn.backfill", message: "Include existing open issues and PRs" })}
          description=""
          trailing={
            <Switch
              checked={draft.backfill}
              onChange={(value) => setDraft("backfill", value)}
              disabled={saving()}
              aria-label={_({ id: "settings.oryn.backfill", message: "Include existing open issues and PRs" })}
            />
          }
        />
        <SettingRow
          title={_({ id: "settings.oryn.review", message: "Automatically review PRs" })}
          description=""
          trailing={
            <Switch
              checked={draft.autoReview}
              onChange={(value) => setDraft("autoReview", value)}
              disabled={saving()}
              aria-label={_({ id: "settings.oryn.review", message: "Automatically review PRs" })}
            />
          }
        />
        <SettingRow
          title={_({ id: "settings.oryn.fix", message: "Automatically fix reproduced bugs" })}
          description={_({
            id: "settings.oryn.fixDescription",
            message:
              "Requires configured verification environments. Unreproducible bugs go to a human; contributor branches are never overwritten.",
          })}
          trailing={
            <Switch
              checked={draft.autoFix}
              onChange={(value) => setDraft("autoFix", value)}
              disabled={saving()}
              aria-label={_({ id: "settings.oryn.fix", message: "Automatically fix reproduced bugs" })}
            />
          }
        />
      </SettingsSection>
      <Show when={error()}>
        <p role="alert" class="break-words">
          {error()}
        </p>
      </Show>
      <Show when={saved()}>
        <p role="status">{_({ id: "settings.oryn.saved", message: "Oryn settings saved." })}</p>
      </Show>
      <Button type="submit" disabled={saving() || !draft.repository || !draft.directory || !draft.baseBranch}>
        {saving()
          ? _({ id: "settings.oryn.saving", message: "Saving…" })
          : _({ id: "settings.oryn.save", message: "Save Oryn settings" })}
      </Button>
    </form>
  )
}
