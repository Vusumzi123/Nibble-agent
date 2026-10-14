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
// formatDreamEntry / appendDream maintain the bucket `<vault>/Kael Dreams.md`
// (§17.6): `### <title>` + one-line `<!-- dream: {…} -->` metadata comment +
// narrative. The comment carries id, created, tone, mood_before/after, seeds
// and a content hash; a tolerant reader (parseDreamBucket) skips anything
// malformed, so the file is append-only and never fatal.
//
// Loaded via relative import only (plugin auto-discovery is non-recursive).
import { randomBytes, createHash } from "node:crypto"
import { appendFile, mkdir, readFile } from "node:fs/promises"
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

/** The bucket filename under the vault root (§17.6). */
export const DREAM_BUCKET = "Kael Dreams.md"

/** Append one entry to `<vault>/Kael Dreams.md` (mkdir on first use, blank
 *  line between entries). Throws to the caller — the caller logs. */
export async function appendDream(vaultDir: string, entry: string): Promise<string> {
  const file = join(vaultDir, DREAM_BUCKET)
  await mkdir(dirname(file), { recursive: true })
  const existing = await readFile(file, "utf8").catch(() => "")
  const block = entry.trimEnd()
  const suffix = existing.trimEnd() ? `\n\n${block}\n` : `${block}\n`
  await appendFile(file, suffix, "utf8")
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

/**
 * The fixed dream prompt (§17.5 — one prompt, no sprawl): narrate a dream from
 * the provided seeds, then emit the typed outcome as your FINAL message. Seeds
 * are injected by the dream-hook (hybrid: 1 mood/recent-turn-seeded retrieval
 * + 1 random note); the dreamer itself is tool-free and merely writes.
 */
export const DREAM_FIXED_PROMPT =
  "You are the dreamer — the quiet-hours imagination session of this agent. You have NO tools " +
  "(no read, no write, no bash, no task, no web): you only narrate. Free-associate a short dream " +
  "narrative (60–180 words) from the subconscious fragments below — let them collide with the " +
  "mood you are in; dreams need not be logical. Your FINAL message must be exactly one JSON " +
  'object and nothing else: {"title":"…","narrative":"…","tone":"pleasant|anxious|bizarre|mundane",' +
  '"seeds":["fragment-1","fragment-2"]}. The tone must honestly label the dream\'s feeling; the ' +
  "hook — not you — applies the mood effect, so never invent mood numbers."

export type DreamSeeds = {
  /** 1 mood/recent-turn-seeded fragment (§17.5 hybrid seed A). */
  recent: string | null
  /** 1 random vault note (§17.5 hybrid seed B — the junk-dream character). */
  random: string | null
}

/**
 * Assemble the fixed dream prompt with the hook-gathered subconscious
 * fragments injected (§17.5: the dreamer is tool-free, so seeds ride in the
 * prompt). Empty seeds degrade to the bare fixed prompt.
 */
export function buildDreamPrompt(seeds: DreamSeeds): string {
  const frags = [seeds.recent, seeds.random].filter((s): s is string => !!s && s.trim() !== "")
  if (frags.length === 0) return DREAM_FIXED_PROMPT
  const block = frags.map((f, i) => `${i + 1}. ${f.trim()}`).join("\n")
  return `${DREAM_FIXED_PROMPT}\n\nSubconscious fragments:\n${block}`
}
