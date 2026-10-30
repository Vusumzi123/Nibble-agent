// Plugin files whose edit must disable the heartbeat scheduler until opencode
// restarts (stale-code guard). Every file that can change dispatch or result
// behaviour belongs here; missing files are ignored by the guard.
//
// Loaded via relative import only.

export const HEARTBEAT_CODE_FILES = [
  ".opencode/plugin/heartbeat-hook.ts",
  ".opencode/plugin/lib/heartbeat.ts",
  ".opencode/plugin/lib/code-files.ts",
  ".opencode/plugin/lib/missions.ts",
  ".opencode/plugin/lib/mission-result.ts",
  ".opencode/plugin/lib/vault-stale.ts",
  ".opencode/plugin/lib/work-queue.ts",
  ".opencode/plugin/lib/work-producers.ts",
  ".opencode/plugin/lib/step-registry.ts",
  ".opencode/plugin/lib/work-kinds/types.ts",
  ".opencode/plugin/lib/work-kinds/shared.ts",
  ".opencode/plugin/lib/work-kinds/registry.ts",
  ".opencode/plugin/lib/work-kinds/mission.ts",
  ".opencode/plugin/lib/work-kinds/staleness.ts",
  ".opencode/plugin/lib/work-kinds/drain.ts",
  ".opencode/plugin/lib/work-kinds/steps.ts",
  ".opencode/plugin/lib/drain/status.ts",
  ".opencode/plugin/lib/drain/step.ts",
  ".opencode/plugin/lib/drain/pipe.ts",
]
