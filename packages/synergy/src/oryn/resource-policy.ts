import { z } from "zod"

export const OrynProcessResources = z
  .object({
    maxSeconds: z
      .number()
      .int()
      .min(1)
      .max(86400)
      .optional()
      .describe("Systemd-managed scope lifetime in seconds, including detached descendants; default 1800"),
    memoryMiB: z
      .number()
      .int()
      .min(256)
      .max(1048576)
      .describe("Per-command cgroup memory ceiling in MiB; swap is disabled"),
    cpuQuotaPercent: z.number().int().min(1).max(12800).describe("Per-command aggregate CPU quota; 100 is one CPU"),
    maxProcesses: z
      .number()
      .int()
      .min(16)
      .max(65536)
      .describe("Per-command cgroup task limit, including threads and descendants"),
  })
  .strict()
  .meta({ ref: "OrynProcessResourcesConfig" })
export type OrynProcessResources = z.infer<typeof OrynProcessResources>

export const OrynResourcePlan = z
  .object({
    unit: z.string().regex(/^oryn-command-[a-f0-9-]{36}\.scope$/),
    limits: OrynProcessResources,
    result: z.string(),
    command: z.string(),
    args: z.array(z.string()),
    cwd: z.string(),
    environment: z.record(z.string(), z.string()),
  })
  .strict()

export const OrynResourceResult = z
  .object({
    complete: z.literal(true),
    limits: OrynProcessResources,
    exhausted: z.boolean(),
  })
  .strict()
