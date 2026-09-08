import { z } from "zod"
import { MessageContext } from "../../../src/channel/types"
import { ActionReceipt, Assignment, Case } from "../../../src/oryn/schema"

export const RuntimeMessage = MessageContext.omit({ channelType: true, accountId: true })

export const RuntimeCommand = z.discriminatedUnion("operation", [
  z.object({ id: z.string(), operation: z.literal("receive"), message: RuntimeMessage }),
  z.object({ id: z.string(), operation: z.literal("snapshot") }),
  z.object({ id: z.string(), operation: z.literal("stop") }),
])
export const RuntimeSnapshot = z.object({
  pid: z.number(),
  cases: Case.array(),
  assignments: Assignment.array(),
  actions: ActionReceipt.array(),
  sessions: z.array(
    z.object({
      id: z.string(),
      exists: z.boolean(),
      roots: z.string().array(),
      running: z.boolean(),
      workspace: z.string().optional(),
    }),
  ),
  reactions: z.number(),
  streaming: z.number(),
  agents: z.object({ workers: z.number(), active: z.number() }),
})
