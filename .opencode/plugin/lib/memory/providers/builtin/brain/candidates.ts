// Deterministic candidate-note prefetch for the drain pipe
// (knowledge-pipeline-redesign §A.7).
//
// Ported from the retired lib/knowledge.ts. Read-only: the vault is walked,
// scored by title/tags/headings/body overlap plus a title-phrase boost, and the
// top N are rendered for the writer. No MCP, no writes, no model.
//
// Loaded via relative import only.
import { createHash } from "node:crypto"
import { readFile, readdir } from "node:fs/promises"
import { basename, join, relative } from "node:path"

export type CandidateNote = {
  path: string
  title: string
  score: number
  snippet: string
  hash: string
}

export type CandidateQuery = {
  vaultDir: string
  keywords: string[]
  /** Capitalized multi-word phrases from the batch (title-phrase boost). */
  phrases?: string[]
  limit: number
}

export type TagIndexEntry = { tag: string; count: number; notes: string[] }

const SKIP_DIRS = new Set([".obsidian", ".trash", ".markdown_vault_mcp", "Raw", "meta", "Dreams"])
const SKIP_FILES = new Set(["Kael Dreams.md"])
const MAX_SCANNED_FILES = 2000
const MAX_NOTE_BYTES = 65536
const SNIPPET_MAX = 240

/** Recursively yield markdown files, skipping generated/raw trees. */
export async function* walkMarkdown(dir: string): AsyncGenerator<string> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      yield* walkMarkdown(full)
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      if (SKIP_FILES.has(entry.name)) continue
      yield full
    }
  }
}

function frontmatterTitle(content: string, fallback: string): string {
  return content.match(/^title:\s*(.+?)\s*$/m)?.[1]?.replace(/^["']|["']$/g, "") ?? fallback
}

/** Parse frontmatter `tags`: scalar, inline list, or block list. */
export function parseFrontmatterTags(content: string): string[] {
  const fm = content.match(/^---\s*\n([\s\S]*?)\n---/)?.[1]
  if (!fm) return []
  const lines = fm.split("\n")
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^tags\s*:\s*(.*)$/)
    if (!match) continue
    const inline = match[1].trim()
    if (inline) {
      const cleaned = inline.replace(/^\[|\]$/g, "")
      for (const part of cleaned.split(",")) {
        const tag = part.trim().replace(/^["']|["']$/g, "")
        if (tag) out.push(tag)
      }
    } else {
      for (let j = i + 1; j < lines.length; j++) {
        const item = lines[j].match(/^\s*-\s*(.+?)\s*$/)
        if (!item) break
        const tag = item[1].replace(/^["']|["']$/g, "").trim()
        if (tag) out.push(tag)
      }
    }
  }
  return out
}

/** Normalized title form: lowercase, alphanumerics only, single-spaced. */
export function normalizeTitle(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
}

const PHRASE_HEAD_STOP = new Set([
  "the", "this", "that", "these", "those", "when", "where", "what", "which",
  "note", "for", "and", "you", "your", "with", "from", "then", "than", "here",
  "there", "will", "would", "could", "should", "must", "please", "thanks",
  "okay", "great", "done", "yes", "no", "if", "but", "not", "can", "now",
  "user", "assistant", "consolidation", "turn", "batch",
  "see", "also", "well", "just", "maybe", "actually", "finally", "next",
  "however", "instead", "recently", "added", "updated", "created", "wrote",
  "moved", "fixed", "changed", "using", "used", "make", "made", "give",
  "gave", "take", "took", "come", "came", "went", "goes", "keep", "kept",
])

/** Extract title-like multi-word Capitalized phrases from a batch. */
export function extractTitlePhrases(text: string, limit = 12): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const re = /(?:^|[\s(“"'\[])([A-Z][\w'’-]+(?:\s+[A-Z][\w'’-]+){1,5})(?=[\s).,;:!?"'\]]|$)/g
  for (const match of text.matchAll(re)) {
    const words = normalizeTitle(match[1]).split(" ").filter(Boolean)
    while (words.length >= 2 && PHRASE_HEAD_STOP.has(words[0])) words.shift()
    if (words.length < 2) continue
    const phrase = words.join(" ")
    if (seen.has(phrase)) continue
    seen.add(phrase)
    out.push(phrase)
    if (out.length >= limit) break
  }
  return out
}

/**
 * Score vault notes against the batch keywords/phrases and return the top
 * `limit`. Deterministic: title +5 / tags +4 / headings +3 / body +1, plus a
 * +20 title-phrase boost. Never writes.
 */
export async function findCandidateNotes(query: CandidateQuery): Promise<CandidateNote[]> {
  const { vaultDir, keywords, phrases = [], limit } = query
  if (keywords.length === 0 || limit <= 0) return []

  const scored: CandidateNote[] = []
  let scanned = 0

  for await (const file of walkMarkdown(vaultDir)) {
    if (++scanned > MAX_SCANNED_FILES) break

    let content: string
    try {
      content = (await readFile(file, "utf8")).slice(0, MAX_NOTE_BYTES)
    } catch {
      continue
    }

    const rel = relative(vaultDir, file)
    const title = frontmatterTitle(content, basename(file, ".md"))
    const tags = parseFrontmatterTags(content).join(" ")
    const headings = (content.match(/^#{1,6}\s+.+$/gm) ?? []).join("\n")
    const body = content.toLowerCase()

    let score = 0
    for (const keyword of keywords) {
      if (title.toLowerCase().includes(keyword)) score += 5
      if (tags.toLowerCase().includes(keyword)) score += 4
      if (headings.toLowerCase().includes(keyword)) score += 3
      if (body.includes(keyword)) score += 1
    }

    if (phrases.length > 0) {
      const normTitle = normalizeTitle(title)
      const titleWords = normTitle.split(" ").length
      for (const phrase of phrases) {
        const phraseWords = phrase.split(" ").length
        const longEnough = Math.max(normTitle.length, phrase.length) >= 8
        const multiWord = titleWords >= 2 && phraseWords >= 2
        if (
          normTitle === phrase ||
          ((multiWord || longEnough) && (normTitle.includes(phrase) || phrase.includes(normTitle)))
        ) {
          score += 20
          break
        }
      }
    }

    if (score === 0) continue

    const snippet = content
      .replace(/^---[\s\S]*?---\s*/, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, SNIPPET_MAX)

    scored.push({
      path: rel,
      title,
      score,
      snippet,
      hash: createHash("sha1").update(snippet).digest("hex").slice(0, 12),
    })
  }

  return scored
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, limit)
}

/** Render one candidate for the consolidation prompt. */
export function formatCandidate(candidate: CandidateNote): string {
  return `- ${candidate.title} (${candidate.path}) [score ${candidate.score}, sha1:${candidate.hash}]: ${candidate.snippet}`
}

/**
 * Deterministic tag candidates from a vault tag index: rank by lexical overlap
 * with the batch keywords, preferring exact and hierarchy-segment matches.
 */
export function candidateTags(
  keywords: string[],
  index: TagIndexEntry[],
  limit: number,
): string[] {
  if (limit <= 0 || keywords.length === 0) return []
  const scored: Array<{ tag: string; score: number }> = []
  for (const entry of index) {
    const low = entry.tag.toLowerCase()
    let score = 0
    for (const keyword of keywords) {
      if (low === keyword) score += 5
      else if (low.split("/").includes(keyword)) score += 4
      else if (low.includes(keyword) || keyword.includes(low)) score += 2
    }
    if (score > 0) scored.push({ tag: entry.tag, score: score + Math.min(entry.count, 5) * 0.1 })
  }
  return scored
    .sort((a, b) => b.score - a.score || a.tag.localeCompare(b.tag))
    .slice(0, limit)
    .map((entry) => entry.tag)
}
