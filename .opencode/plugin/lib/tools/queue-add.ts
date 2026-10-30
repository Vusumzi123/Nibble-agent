// `queue_add` tool: write one pending user-task file (user-task queue plan,
// Phase 1).
//
// The tool NEVER touches `work-queue.json`. The `user-task` producer ingests
// the new file on the next heartbeat tick (≤ one tick of latency) in exchange
// for having a single queue writer and no lock.
//
// Loaded via relative import only.
import { tool } from "@opencode-ai/plugin"
import {
  TASK_PRIORITY_DEFAULT,
  TASK_PRIORITY_MAX,
  TASK_PRIORITY_MIN,
  createTask,
} from "../user-tasks.ts"

export const QUEUE_ADD_TOOL = "queue_add"

export function createQueueAddTool(opts: { stateDir: string }) {
  const schema = tool.schema
  return tool({
    description:
      "Queue a task for the heartbeat to execute later. Writes one task file; the " +
      "heartbeat picks it up on the next tick (≤60 s). Use for work the user wants " +
      "done but not now. Include the full instructions in `prompt` and only the " +
      "evidence the task needs in `context`. Never put credentials in either field.",
    args: {
      title: schema.string().describe("Short imperative title (≤160 characters)."),
      prompt: schema
        .string()
        .describe(
          "Complete instructions for the executing agent: objective, stopping " +
            "condition, and what to do with each tool result. Max 16 KB.",
        ),
      context: schema
        .string()
        .optional()
        .describe("Optional evidence: paths, values, decisions already made. Max 16 KB."),
      priority: schema
        .number()
        .min(TASK_PRIORITY_MIN)
        .max(TASK_PRIORITY_MAX)
        .optional()
        .describe(
          `Within-kind priority ${TASK_PRIORITY_MIN}–${TASK_PRIORITY_MAX}, higher runs ` +
            `first (default ${TASK_PRIORITY_DEFAULT}). Does not preempt a mission.`,
        ),
      dedupe_key: schema
        .string()
        .optional()
        .describe("Reuse an existing pending task with the same key instead of creating a second."),
      expires_in_hours: schema
        .number()
        .optional()
        .describe("Optional TTL in hours; the task drops (and is skipped) after it."),
    },
    async execute(args: any) {
      const result = await createTask(opts.stateDir, {
        title: String(args.title ?? ""),
        prompt: String(args.prompt ?? ""),
        context: args.context === undefined ? undefined : String(args.context),
        ...(args.priority === undefined ? {} : { priority: Number(args.priority) }),
        ...(args.dedupe_key === undefined ? {} : { dedupe_key: String(args.dedupe_key) }),
        ...(args.expires_in_hours === undefined
          ? {}
          : { expires_in_hours: Number(args.expires_in_hours) }),
      })
      return JSON.stringify(result)
    },
  })
}
