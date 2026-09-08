import { cmd } from "./cmd"
import { OrynDependencies } from "../../oryn/dependencies"

export const OrynCommand = cmd({
  command: "oryn",
  describe: "prepare Oryn automation resources",
  builder: (yargs) => yargs.command(OrynSealDependenciesCommand).demandCommand(),
  async handler() {},
})

export const OrynSealDependenciesCommand = cmd({
  command: "seal-dependencies <source> <output>",
  describe:
    "seal preinstalled Bun dependencies from a clean reviewed checkout; performs no installation or network access",
  builder: (yargs) =>
    yargs
      .positional("source", {
        type: "string",
        demandOption: true,
        describe: "Repository root with a tracked Bun lockfile and preinstalled node_modules",
      })
      .positional("output", {
        type: "string",
        demandOption: true,
        describe: "New snapshot directory outside the source; its parent must exist",
      })
      .option("json", {
        type: "boolean",
        default: false,
        describe: "Print the snapshot location, pinned digest and size as JSON",
      }),
  async handler(args) {
    const controller = new AbortController()
    const abort = () => controller.abort(new Error("Dependency sealing cancelled"))
    process.once("SIGINT", abort)
    process.once("SIGTERM", abort)
    try {
      const result = await OrynDependencies.seal({ source: args.source, output: args.output, abort: controller.signal })
      process.stdout.write(
        args.json
          ? `${JSON.stringify(result)}\n`
          : `Dependency snapshot: ${result.directory}\nSHA-256: ${result.digest}\nEntries: ${result.files}; bytes: ${result.bytes}\n`,
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : "Dependency sealing failed"
      process.stderr.write(args.json ? `${JSON.stringify({ error: message })}\n` : `${message}\n`)
      process.exitCode = 1
    } finally {
      process.removeListener("SIGINT", abort)
      process.removeListener("SIGTERM", abort)
    }
  },
})
