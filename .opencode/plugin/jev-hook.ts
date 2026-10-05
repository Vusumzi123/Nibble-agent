import type { Plugin } from "@opencode-ai/plugin"

// RETIRED (docs/temporal-memory-plan.md). The legacy jev-hook observed the
// per-session `Brain/Raw/` staging files and recorded shadow noul decisions to
// `decisions.log`. That staging pipeline is gone: capture now writes one JSON
// record per turn to `.opencode/state/memory.json`, and the per-turn ingest gate
// (including shadow-mode journaling) lives in knowledge-hook.ts, which is now
// the sole writer of decisions.log.
//
// Kept as an explicit no-op so the plugin auto-discovery glob still resolves a
// module and the retirement is documented in-place. Delete this file together
// with the last reference to `Brain/Raw/`.

export default (async () => {
  return {}
}) satisfies Plugin
