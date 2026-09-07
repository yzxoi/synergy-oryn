import { Config } from "../../src/config/config"
import { ConfigDomain } from "../../src/config/domain"
import { Lock } from "../../src/util/lock"
import { tmpdir as projectTmpdir } from "../fixture/fixture"

export async function globalConfig(config: Partial<Config.Info>) {
  const lock = await Lock.write("test-oryn-global-config")
  const saved: Array<{ id: ConfigDomain.Id; config: Config.Info }> = []
  const restore = async () => {
    try {
      for (const entry of saved.reverse()) await Config.domainUpdate(entry.id, entry.config, { mode: "replace-domain" })
    } finally {
      lock[Symbol.dispose]()
    }
  }
  try {
    for (const [id, fragment] of ConfigDomain.split(config)) {
      const previous = await Config.domainGet(id)
      saved.push({ id, config: previous })
      await Config.domainUpdate(id, { ...previous, ...fragment }, { mode: "replace-domain" })
    }
    return { [Symbol.asyncDispose]: restore }
  } catch (error) {
    await restore()
    throw error
  }
}

export async function tmpdir<T>(options?: Parameters<typeof projectTmpdir<T>>[0]) {
  if (!options?.config?.oryn) return projectTmpdir(options)
  const { oryn, ...projectConfig } = options.config
  const global = await globalConfig({ oryn })
  try {
    const fixture = await projectTmpdir({ ...options, config: projectConfig })
    return {
      ...fixture,
      [Symbol.asyncDispose]: async () => {
        try {
          await fixture[Symbol.asyncDispose]()
        } finally {
          await global[Symbol.asyncDispose]()
        }
      },
    }
  } catch (error) {
    await global[Symbol.asyncDispose]()
    throw error
  }
}
