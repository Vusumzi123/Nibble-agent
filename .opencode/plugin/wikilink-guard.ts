import type { Plugin } from "@opencode-ai/plugin"
import { homedir } from "node:os"
import { readFile, readdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { createDiagnostics } from "./lib/logging.ts"
import { readResolvedPaths } from "./lib/paths.ts"
import { createStateStore } from "./lib/state.ts"
import {
  diffBulletRewrites,
  extractWritePaths,
  normalizeFrontmatterDates,
  unescapeOutsideCode,
  vaultLabel,
} from "./lib/write-guard.ts"
import { isReadonlyVaultPath, parseReadonlyDirs, readVaultPolicy } from "./lib/vault-policy.ts"
import { recordIssue } from "./lib/verification.ts"

// Deterministic post-write guard (Plan A). Replaces the former rag-brain
// post-write re-read mandate with provable checks for the three markdown-vault
// serializer symptoms:
//   1. escaped wikilinks  (\[\[ -> [[)         — repaired
//   2. frontmatter dates   (ISO/quoted -> date) — repaired when unambiguous
//   3. bullet rewrites     (- -> *, vs. a pre-write snapshot) — repaired only
//      when a marker-only diff proves it, otherwise flagged, never guessed
//   4. tool.execute.before snapshots the pre-write bytes per callID so the
//      bullet diff has a real baseline (no false positives on intentional `*`).
//
// Escapes are also swept vault-wide on session.idle as a safety net. The guard
// records per-session receipts in lib/verification; the knowledge-hook refuses
// to delete a drained transcript while a session has unresolved (blocking)
// issues, so a guard that cannot prove a write was clean retains the raw data.

const SKIP_DIRS = new Set([".obsidian", ".trash", ".markdown_vault_mcp"])
const SNAPSHOT_TTL_MS = 5 * 60 * 1000
const MAX_SNAPSHOTS = 5000

type Snapshot = { path: string; content: string | null; at: number }

export default (async ({ directory }) => {
  const resolved = await readResolvedPaths(directory ?? process.cwd(), homedir())
  const vaultRoot = resolved.vaultDir
  const sysopDir = resolved.sysopDir
  const policy = await readVaultPolicy(directory ?? process.cwd())
  const readonlyDirs = parseReadonlyDirs(policy.readonly)
  const STATE_FILE = join(sysopDir, "wikilink-guard.json")
  const diag = createDiagnostics({ sysopDir, home: homedir(), channel: "wikilink-guard" })
  const notified = new Set<string>()

  const snapshots = new Map<string, Snapshot>()

  const inVault = (p: string): boolean => p === vaultRoot || p.startsWith(vaultRoot + "/")
  // User-write-only folders (e.g. Journal/) are never snapshotted or repaired —
  // the guard must not write a single byte there (see vault-readonly-guard.ts).
  const inReadonly = (p: string): boolean => isReadonlyVaultPath(vaultRoot, p, readonlyDirs)

  function pruneSnapshots(): void {
    if (snapshots.size <= MAX_SNAPSHOTS) return
    const cutoff = Date.now() - SNAPSHOT_TTL_MS
    for (const [id, s] of snapshots) if (s.at < cutoff) snapshots.delete(id)
    // Still over budget: drop oldest.
    if (snapshots.size > MAX_SNAPSHOTS) {
      const byAge = [...snapshots.entries()].sort((a, b) => a[1].at - b[1].at)
      for (let i = 0; i < byAge.length - MAX_SNAPSHOTS; i++) snapshots.delete(byAge[i][0])
    }
  }

  const stateStore = createStateStore<{ lastRepairAt?: string; lastRepairCount?: number }>(
    STATE_FILE,
    {},
    { onError: (err) => void diag.error("[wikilink-guard] failed to write state:", err) },
  )

  // Repair escape + dates on one file. Records nothing (used by the idle sweep).
  async function repairFile(fp: string): Promise<number> {
    try {
      const raw = await readFile(fp, "utf8")
      const { out: deEscaped, count } = unescapeOutsideCode(raw)
      const { out, fixed } = normalizeFrontmatterDates(deEscaped)
      if (count === 0 && fixed === 0) return 0
      await writeFile(fp, out, "utf8")
      void diag.error(`[wikilink-guard] repaired ${count} escape(s), ${fixed} date(s) in ${fp}`)
      return count + fixed
    } catch {
      return 0
    }
  }

  // Full deterministic verification of a single write, with session receipts.
  // `allowBulletRepair` is true only for MCP markdown-vault writes, whose
  // serializer is the known bullet-mangler; native edit/write/apply_patch are
  // byte-exact, so a marker-only change there is intentional and left alone.
  async function verifyWrite(
    sessionID: string,
    fp: string,
    before: string | null,
    allowBulletRepair: boolean,
  ): Promise<void> {
    let current: string
    try {
      current = await readFile(fp, "utf8")
    } catch {
      return
    }
    const label = vaultLabel(vaultRoot, fp)
    let working = current
    let dirty = false

    const { out: deEscaped, count: escapeCount } = unescapeOutsideCode(working)
    if (escapeCount > 0) {
      working = deEscaped
      dirty = true
      recordIssue(sessionID, {
        path: label,
        kind: "escaped-wikilink",
        detail: `${escapeCount} escaped wikilink(s)`,
        repaired: true,
      })
      void diag.error(`[wikilink-guard] repaired ${escapeCount} escaped wikilink(s) in ${fp}`)
    }

    const { out: dated, fixed, invalid } = normalizeFrontmatterDates(working)
    if (fixed > 0) {
      working = dated
      dirty = true
      recordIssue(sessionID, { path: label, kind: "date", detail: `${fixed} date(s) normalized`, repaired: true })
      void diag.error(`[wikilink-guard] normalized ${fixed} date(s) in ${fp}`)
    }
    if (invalid > 0) {
      recordIssue(sessionID, {
        path: label,
        kind: "date",
        detail: `${invalid} invalid/ambiguous date value(s) left untouched`,
        repaired: false,
      })
    }

    if (allowBulletRepair && before !== null && before !== working) {
      const diff = diffBulletRewrites(before, working)
      if (diff.kind === "safe") {
        working = diff.repaired
        dirty = true
        recordIssue(sessionID, {
          path: label,
          kind: "bullet",
          detail: `${diff.count} bullet(s) restored`,
          repaired: true,
        })
        void diag.error(`[wikilink-guard] restored ${diff.count} bullet(s) in ${fp}`)
      } else if (diff.kind === "ambiguous") {
        recordIssue(sessionID, {
          path: label,
          kind: "ambiguous",
          detail: "write changed bullet markers or content in a way the guard could not safely repair",
          repaired: false,
        })
      }
    }

    if (dirty) {
      try {
        await writeFile(fp, working, "utf8")
      } catch (err) {
        void diag.error(`[wikilink-guard] repair write failed ${fp}:`, err)
        recordIssue(sessionID, {
          path: label,
          kind: "escaped-wikilink",
          detail: "repair write failed",
          repaired: false,
        })
      }
    }
  }

  async function* walk(dir: string): AsyncGenerator<string> {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || readonlyDirs.includes(e.name)) continue
        yield* walk(full)
      } else if (e.isFile() && e.name.endsWith(".md")) {
        yield full
      }
    }
  }

  return {
    "tool.execute.before": async (input, output) => {
      for (const p of extractWritePaths(input.tool, (output as any)?.args ?? {}, vaultRoot)) {
        if (!inVault(p) || inReadonly(p)) continue
        let content: string | null = null
        try {
          content = await readFile(p, "utf8")
        } catch {
          content = null
        }
        snapshots.set(input.callID, { path: p, content, at: Date.now() })
      }
      pruneSnapshots()
    },

    "tool.execute.after": async (input) => {
      const args = (input.args ?? {}) as Record<string, unknown>
      const paths = extractWritePaths(input.tool, args, vaultRoot)
      const allowBulletRepair = input.tool.startsWith("markdown-vault")
      for (const p of paths) {
        if (!inVault(p) || inReadonly(p)) continue
        const snap = snapshots.get(input.callID)
        snapshots.delete(input.callID)
        await verifyWrite(input.sessionID, p, snap && snap.path === p ? snap.content : null, allowBulletRepair)
      }
    },

    event: async ({ event }) => {
      if (event.type !== "session.idle") return
      const sid = event.properties.sessionID
      if (!sid) return
      if (notified.has(sid)) return

      let total = 0
      for await (const fp of walk(vaultRoot)) total += await repairFile(fp)

      if (total > 0) {
        notified.add(sid)
        const line = `[wikilink-guard] repaired ${total} serializer artifact(s) this turn.`
        void diag.error(line)
        await stateStore.write({
          lastRepairAt: new Date().toISOString(),
          lastRepairCount: total,
        })
      }
    },
  }
}) satisfies Plugin
