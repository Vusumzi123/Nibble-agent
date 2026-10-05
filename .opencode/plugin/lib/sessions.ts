// Shared session helpers: transcript text extraction, cached session metadata
// (child / parentID / agent), the bounded top-level parent walk, and
// last-assistant-text reads. Every hook uses the same filtering rule and the
// same cache so a session is queried at most once per hook lifetime.
//
// Loaded via relative import only. The plugin auto-discovery glob
// "{plugin,plugins}/*.{ts,js}" is non-recursive, so this subdirectory file is
// never loaded as a plugin itself.

export type SessionMeta = { child: boolean; parentID: string | null; agent: string | null }

// Unification rule: a text part contributes only when it is real text and is
// neither synthetic nor ignored. No producer sets the `ignored` flag today, so
// this is a no-op in practice and keeps the stricter rule.
function isTextPart(p: any): boolean {
  return p?.type === "text" && !p.synthetic && !p.ignored
}

export function textOf(parts: unknown[]): string {
  return (parts ?? [])
    .filter(isTextPart)
    .map((p: any) => p.text)
    .join("\n")
}

// Minimal structural view of the opencode client used here. Loose on purpose:
// keeps this module free of SDK imports and unit-testable with a plain mock.
export type SessionClient = {
  session: {
    get(args: any): Promise<{ data?: any }>
    messages(args: any): Promise<{ data?: any }>
  }
}

export type SessionTools = {
  meta(sid: string): Promise<SessionMeta>
  isChild(sid: string): Promise<boolean>
  topLevel(sid: string): Promise<string>
  lastAssistantText(sid: string): Promise<string>
}

export function createSessionTools(
  client: SessionClient,
  directory: string,
  opts?: { onError?: (err: unknown, context: "get" | "messages") => void },
): SessionTools {
  const cache = new Map<string, SessionMeta>()

  const meta = async (sid: string): Promise<SessionMeta> => {
    const cached = cache.get(sid)
    if (cached) return cached
    let m: SessionMeta = { child: false, parentID: null, agent: null }
    try {
      const res = await client.session.get({ path: { id: sid }, query: { directory } })
      const d = res?.data
      if (d) m = { child: !!d.parentID, parentID: d.parentID ?? null, agent: d.agent ?? null }
    } catch (err) {
      opts?.onError?.(err, "get")
    }
    cache.set(sid, m)
    return m
  }

  const isChild = async (sid: string): Promise<boolean> => (await meta(sid)).child

  // Walk a child session up to its parent-less top-level session (bounded, so a
  // malformed parent chain cannot loop forever).
  const topLevel = async (sid: string): Promise<string> => {
    let current = sid
    for (let i = 0; i < 8; i++) {
      const m = await meta(current)
      if (!m.child || !m.parentID) return current
      current = m.parentID
    }
    return current
  }

  const lastAssistantText = async (sid: string): Promise<string> => {
    try {
      const res = await client.session.messages({ path: { id: sid }, query: { directory } })
      const rows = Array.isArray(res?.data) ? res.data : []
      for (let i = rows.length - 1; i >= 0; i--) {
        const info = (rows[i] as any)?.info ?? {}
        if (info.role !== "assistant") continue
        const t = textOf((rows[i] as any)?.parts ?? []).trim()
        if (t) return t
      }
    } catch (err) {
      opts?.onError?.(err, "messages")
    }
    return ""
  }

  return { meta, isChild, topLevel, lastAssistantText }
}
