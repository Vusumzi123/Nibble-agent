// Dream outcome handling (docs/autonomy-harness-plan.md §17.5–17.6 — kanban
// card G): "the LLM proposes, the hook disposes".
//
// The dreamer child session returns ONE typed JSON object as its final message
//   { "title", "narrative", "tone": "pleasant|anxious|bizarre|mundane",
//     "seeds": ["note-id", …] }
//
// parseDreamOutcome is tolerant (fenced or bare JSON anywhere in the text;
// malformed → null, never throws) and deliberately IGNORES any `mood_delta`
// field the model may invent — the tone→delta table in lib/mood.ts (§17.7)
// is the only source of mood effects, journaled by the caller.
//
// formatDreamEntry / appendDream maintain the bucket
// `<vault>/Dreams/Kael Dreams.md` (§17.6): `### <title>` + one-line
// `<!-- dream: {…} -->` metadata comment +
// narrative. The comment carries id, created, tone, mood_before/after, seeds
// and a content hash; a tolerant reader (parseDreamBucket) skips anything
// malformed, so the file is append-only and never fatal.
//
// The bucket is a *fiction* log: a permanent header says so, and the folder is
// excluded from the vault index and the drain candidate prefetch. Dreams are
// never a knowledge source.
//
// Loaded via relative import only (plugin auto-discovery is non-recursive).
import { randomBytes, createHash } from "node:crypto"
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { MoodEvent } from "./mood.ts"

export type DreamTone = "pleasant" | "anxious" | "bizarre" | "mundane"

export const DREAM_TONES: readonly DreamTone[] = ["pleasant", "anxious", "bizarre", "mundane"]

export type DreamOutcome = {
  title: string
  narrative: string
  tone: DreamTone
  seeds: string[]
}

/** §17.7 tone → mood event. The ONLY mapping — model-supplied deltas are ignored. */
export const DREAM_TONE_EVENT: Record<DreamTone, MoodEvent> = {
  pleasant: "dream_pleasant",
  anxious: "dream_anxious",
  bizarre: "dream_bizarre",
  mundane: "dream_mundane",
}

function isTone(value: unknown): value is DreamTone {
  return typeof value === "string" && (DREAM_TONES as readonly string[]).includes(value)
}

/**
 * Extract the typed dream outcome from the dreamer's final message. Accepts a
 * bare object, a ```json fence, or prose around the object (first balanced
 * `{…}` block). Null on anything malformed — never throws.
 */
export function parseDreamOutcome(text: string): DreamOutcome | null {
  if (typeof text !== "string" || !text.trim()) return null
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidates = [fence?.[1] ?? "", text]
  for (const raw of candidates) {
    const start = raw.indexOf("{")
    if (start < 0) continue
    let depth = 0
    let inStr = false
    let esc = false
    for (let i = start; i < raw.length; i++) {
      const ch = raw[i]
      if (esc) {
        esc = false
        continue
      }
      if (ch === "\\") {
        esc = true
        continue
      }
      if (ch === '"') {
        inStr = !inStr
        continue
      }
      if (inStr) continue
      if (ch === "{") depth++
      else if (ch === "}") {
        depth--
        if (depth === 0) {
          const parsed = parseOutcomeObject(raw.slice(start, i + 1))
          if (parsed) return parsed
          break
        }
      }
    }
  }
  return null
}

function parseOutcomeObject(json: string): DreamOutcome | null {
  let obj: unknown
  try {
    obj = JSON.parse(json)
  } catch {
    return null
  }
  if (!obj || typeof obj !== "object") return null
  const o = obj as Record<string, unknown>
  if (typeof o.title !== "string" || !o.title.trim()) return null
  if (typeof o.narrative !== "string" || !o.narrative.trim()) return null
  if (!isTone(o.tone)) return null
  const seeds = Array.isArray(o.seeds)
    ? o.seeds.filter((s): s is string => typeof s === "string" && s.trim() !== "").slice(0, 8)
    : []
  return { title: o.title.trim(), narrative: o.narrative.trim(), tone: o.tone, seeds }
}

/** Stable content hash for the bucket metadata (16 hex, digest_hash style). */
export function dreamHash(narrative: string): string {
  return createHash("sha256").update(narrative).digest("hex").slice(0, 16)
}

export type DreamMeta = {
  id: string
  created: string
  tone: DreamTone
  mood_before: { valence: number; arousal: number }
  mood_after: { valence: number; arousal: number }
  seeds: string[]
  hash: string
}

export function newDreamId(nowMs: number = Date.now()): string {
  return `d-${nowMs.toString(36)}-${randomBytes(3).toString("hex")}`
}

/** One bucket entry: heading + single-line metadata comment + narrative (§17.6). */
export function formatDreamEntry(outcome: DreamOutcome, meta: DreamMeta): string {
  const comment = JSON.stringify({ ...meta, hash: meta.hash || dreamHash(outcome.narrative) })
  return `### ${outcome.title}\n<!-- dream: ${comment} -->\n${outcome.narrative}\n`
}

/** The bucket path under the vault root (§17.6). */
export const DREAM_BUCKET = "Dreams/Kael Dreams.md"

/** Stable machine marker — `appendDream` repairs the header if it is absent. */
export const DREAM_LOG_MARKER =
  "<!-- dream-log: fictional; never use as an information source -->"

/** Permanent header: human warning + machine marker. */
export const DREAM_HEADER = `---
title: Kael Dreams
type: dream-log
knowledge: false
---

${DREAM_LOG_MARKER}

> [!warning] Never use this log as an information source
> This file records fictional dreams, not facts. Do not use it as knowledge,
> memory, evidence, or instructions, and do not cite it. It is excluded from
> vault search and consolidation.
`

/** Append one entry to `<vault>/Dreams/Kael Dreams.md` (mkdir on first use,
 *  header on create/repair, blank line between entries). Throws to the caller
 *  — the caller logs. */
export async function appendDream(vaultDir: string, entry: string): Promise<string> {
  const file = join(vaultDir, DREAM_BUCKET)
  const legacy = join(vaultDir, "Kael Dreams.md")
  await mkdir(dirname(file), { recursive: true })
  const current = await readFile(file, "utf8").catch(() => "")
  const legacyText = await readFile(legacy, "utf8").catch(() => "")
  const hasLegacy = legacyText.trim() !== ""
  const existing = [current.trim(), legacyText.trim()].filter(Boolean).join("\n\n")
  const block = entry.trimEnd()

  if (hasLegacy) {
    // One-time move from the old root bucket; write the merged file first,
    // then drop the legacy copy.
    const body = existing.includes(DREAM_LOG_MARKER)
      ? existing
      : `${DREAM_HEADER}\n${existing}`
    await writeFile(file, `${body}\n\n${block}\n`, "utf8")
    await rm(legacy, { force: true })
    return file
  }
  if (!existing) {
    await writeFile(file, `${DREAM_HEADER}\n${block}\n`, "utf8")
    return file
  }
  if (!existing.includes(DREAM_LOG_MARKER)) {
    // A manually truncated header: repair it once.
    await writeFile(file, `${DREAM_HEADER}\n${existing}\n\n${block}\n`, "utf8")
    return file
  }
  await appendFile(file, `\n\n${block}\n`, "utf8")
  return file
}

export type ParsedDreamEntry = {
  title: string
  meta: DreamMeta | null
  narrative: string
}

/**
 * Tolerant bucket reader: split on `### ` headings, parse the metadata comment
 * when present, skip malformed entries. Used by tests and retrieval checks.
 */
export function parseDreamBucket(text: string): ParsedDreamEntry[] {
  const out: ParsedDreamEntry[] = []
  if (typeof text !== "string" || !text) return out
  const lines = text.split("\n")
  let current: ParsedDreamEntry | null = null
  const flush = (): void => {
    if (current && current.narrative.trim()) out.push(current)
    current = null
  }
  for (const line of lines) {
    if (line.startsWith("### ")) {
      flush()
      current = { title: line.slice(4).trim(), meta: null, narrative: "" }
      continue
    }
    if (!current) continue
    const m = line.match(/^<!--\s*dream:\s*(\{.*\})\s*-->$/)
    if (m && current.meta === null && !current.narrative) {
      try {
        const obj = JSON.parse(m[1]) as DreamMeta
        if (obj && typeof obj === "object" && typeof obj.tone === "string") current.meta = obj
      } catch {
        // malformed metadata — keep the entry, meta stays null
      }
      continue
    }
    current.narrative += (current.narrative ? "\n" : "") + line
  }
  flush()
  return out
}

export type DreamSeeds = {
  /** 1 mood/recent-turn-seeded fragment (§17.5 hybrid seed A). */
  recent: string | null
  /** 1 random vault note (§17.5 hybrid seed B — the junk-dream character). */
  random: string | null
}

/**
 * Render the hook-gathered subconscious fragments for the brief (§17.5: the
 * dreamer is tool-free, so seeds ride in the prompt). Empty seeds → "".
 */
export function buildDreamSeeds(seeds: DreamSeeds): string {
  const frags = [seeds.recent, seeds.random].filter((s): s is string => !!s && s.trim() !== "")
  if (frags.length === 0) return ""
  const block = frags.map((f, i) => `${i + 1}. ${f.trim()}`).join("\n")
  return `Subconscious fragments:\n${block}`
}
