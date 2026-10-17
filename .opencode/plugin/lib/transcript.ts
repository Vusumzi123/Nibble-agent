// Generic, deterministic conversation-transcript helpers.
//
// These were previously homed in the knowledge pipeline's lib/knowledge.ts.
// They are pure (no LLM, no network, no filesystem) and are shared by the JEV
// decision provider (classifyTranscript as the deterministic RulesProvider
// fallback), the profile/soul idle gates (classifyTranscript), idea generation
// (extractKeywords), and the mission accounting ledgers (sessionAccounting).
//
// Loaded via relative import only. The plugin auto-discovery glob
// "{plugin,plugins}/*.{ts,js}" is non-recursive, so this subdirectory file is
// never loaded as a plugin itself.

// ---------------------------------------------------------------------------
// Transcript classification (deterministic, no LLM)

export type TurnVerdict = { skip: boolean; reason: string }

// Backwards-compatible alias (decisions.ts / RulesProvider speak of the
// transcript triage verdict).
export type TriageVerdict = TurnVerdict

// Signals that a turn is *likely* to hold durable knowledge. Presence of any
// one of these forces ingestion (never an auto-drop).
export const SIGNAL_PATTERNS: RegExp[] = [
  /```|~~~/,
  /\b(?:sudo|systemctl|pacman|yay|paru|apt|dnf|docker|podman|git|npm|pnpm|bun|python3?|pip|node|make|cmake|nix|flatpak|snap)\b/i,
  /(?:^|\s)(?:\.\/|~\/|\/etc\/|\/usr\/|\/home\/|\/var\/|\/opt\/|\/boot\/|[A-Za-z]:\\)/,
  /\bhttps?:\/\//i,
  /\b[A-Z][A-Z0-9_]{2,}=\S/,
  /\b[\w.-]+\.(?:md|ts|tsx|js|jsx|json|yaml|yml|toml|conf|service|sh|py|rs|go|cpp|h)\b/,
  /--[a-z][\w-]{1,}/i,
  /\b(?:btrfs|systemd|kernel|grub|fstab|wayland|x11|nvidia|pipewire|wireplumber|firewall|nftables|iptables|ssh|gpg|zfs|luks|opencode|mcp)\b/i,
]

// Decision / preference / durability language.
export const DURABLE_SIGNAL_PATTERNS: RegExp[] = [
  /\b(?:remember|decided|decision|convention|policy|prefer|preference|always|never|instead|gotcha|root cause|workaround|important|note to self|do not|don't|should)\b/i,
]

// Whole-message filler. Only used when BOTH sides of the turn are filler.
export const TRIVIAL_PATTERNS: RegExp[] = [
  /^(?:thanks|thank you|ty|ok|okay|k|got it|sure|yep|yes|no|nope|done|great|cool|nice|hi|hello|hey|cheers|perfect|awesome|sounds good|understood|welcome|you're welcome|no problem|anytime|glad to help|let me know|👍|👋)[.!]?$/i,
]

const INTERROGATIVE_RE = /\b(?:how|what|why|where|when|which|who|can|could|should|does|do|is|are|will|would)\b/i

// Default byte ceiling for the transcript classifier (mirrors the former
// knowledge.skip_triage_max_bytes; the profile section still honors its own
// copy for the idle update gate).
export const DEFAULT_SKIP_TRIAGE_MAX_BYTES = 800

export function hasDurableSignal(content: string): boolean {
  return (
    SIGNAL_PATTERNS.some((re) => re.test(content)) ||
    DURABLE_SIGNAL_PATTERNS.some((re) => re.test(content))
  )
}

// Split a transcript into its per-turn {user, assistant} text. Tolerant of
// missing sections (returns "" for the absent side).
export function splitTranscriptTurns(content: string): Array<{ user: string; assistant: string }> {
  const turns: Array<{ user: string; assistant: string }> = []
  for (const chunk of content.split(/<!--\s*turn:\s*\d+\s*-->/)) {
    if (!chunk.trim()) continue
    const user = chunk.match(/##\s*User\s*\n([\s\S]*?)(?=\n##\s*Assistant|$)/)?.[1] ?? ""
    const assistant = chunk.match(/##\s*Assistant\s*\n([\s\S]*)$/)?.[1] ?? ""
    turns.push({ user: user.trim(), assistant: assistant.trim() })
  }
  return turns
}

// Conservative transcript classifier: skip ONLY when the transcript is small,
// carries no durable signal, is not a question, and every turn is whole-message
// filler. Everything else is worth a closer look. Used as the deterministic
// RulesProvider fallback for the JEV gates.
export function classifyTranscript(
  content: string,
  maxBytes: number = DEFAULT_SKIP_TRIAGE_MAX_BYTES,
): TurnVerdict {
  if (Buffer.byteLength(content, "utf8") > maxBytes) return { skip: false, reason: "over-size" }
  if (hasDurableSignal(content)) return { skip: false, reason: "durable-signal" }

  const turns = splitTranscriptTurns(content)
  if (turns.length === 0) return { skip: false, reason: "unparseable" }

  for (const t of turns) {
    if (/[?？]/.test(t.user) || INTERROGATIVE_RE.test(t.user)) return { skip: false, reason: "question" }
  }
  for (const t of turns) {
    const userFiller = t.user === "" || TRIVIAL_PATTERNS.some((re) => re.test(t.user))
    const assistantFiller = t.assistant === "" || TRIVIAL_PATTERNS.some((re) => re.test(t.assistant))
    if (!userFiller || !assistantFiller) return { skip: false, reason: "non-trivial-turn" }
  }
  return { skip: true, reason: "trivial-chatter" }
}

// ---------------------------------------------------------------------------
// Keyword extraction (deterministic dedupe proxy)

const STOPWORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all", "can", "her", "was", "one", "our",
  "out", "day", "get", "has", "him", "his", "how", "its", "new", "now", "old", "see", "two",
  "who", "boy", "did", "use", "with", "that", "this", "have", "from", "they", "will", "would",
  "there", "their", "what", "about", "which", "when", "make", "like", "time", "just", "know",
  "take", "into", "your", "some", "them", "then", "than", "been", "were", "also", "does",
  "here", "more", "only", "over", "such", "very", "well", "should", "could", "after", "before",
  "being", "because", "between", "through", "where", "while", "please", "need",
])

export function extractKeywords(content: string, limit = 24): string[] {
  const freq = new Map<string, number>()
  for (const raw of content.toLowerCase().match(/[a-z0-9][a-z0-9._/-]{2,}/g) ?? []) {
    const token = raw.replace(/[.\-/]+$/, "")
    if (token.length < 4 || STOPWORDS.has(token) || /^\d+$/.test(token)) continue
    freq.set(token, (freq.get(token) ?? 0) + 1)
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, limit)
    .map(([token]) => token)
}

// ---------------------------------------------------------------------------
// Session accounting (deterministic usage ledger for a child session)

export type DrainAccounting = {
  assistantSteps: number
  toolCalls: number
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  cost: number
  usageKnown: boolean
}

// Fold a child session's message rows into a usage summary. Deduped by
// assistant-message id; only rows carrying `tokens` contribute token counts.
export function sessionAccounting(messages: unknown[]): DrainAccounting {
  const seen = new Set<string>()
  const acc: DrainAccounting = {
    assistantSteps: 0,
    toolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: 0,
    usageKnown: false,
  }

  for (const row of messages ?? []) {
    const info = (row as any)?.info ?? {}
    if (info.role !== "assistant") continue
    const id = String(info.id ?? "")
    if (id && seen.has(id)) continue
    if (id) seen.add(id)
    acc.assistantSteps++

    const parts = Array.isArray((row as any)?.parts) ? (row as any).parts : []
    for (const p of parts) {
      if (p?.type === "tool" || p?.type === "tool-invocation" || p?.type === "tool_call") acc.toolCalls++
    }

    const t = info.tokens
    if (t && typeof t.input === "number") {
      acc.usageKnown = true
      acc.inputTokens += t.input ?? 0
      acc.outputTokens += t.output ?? 0
      acc.reasoningTokens += t.reasoning ?? 0
      acc.cacheReadTokens += t.cache?.read ?? 0
      acc.cacheWriteTokens += t.cache?.write ?? 0
      if (typeof info.cost === "number") acc.cost += info.cost
    }
  }
  return acc
}
