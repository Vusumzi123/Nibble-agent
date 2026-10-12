// Shared, in-memory verification receipts for the deterministic write guard.
//
// The guard records every repair/flag it makes against the session that issued
// the write. The knowledge-hook consults `takeIssues(childSessionID)` after the
// drain child idles: any unresolved issue means the guard could not prove the
// writes were clean, so the raw transcript is retained rather than deleted.
// State is process-local and bounded by the number of live sessions.
export type VerificationIssue = {
  path: string
  kind: "escaped-wikilink" | "date" | "bullet" | "ambiguous"
  detail: string
  repaired: boolean
}

const issues = new Map<string, VerificationIssue[]>()

// Vault write paths recorded per session (fed by the wikilink-guard's
// tool.execute.after). The knowledge-hook consults `takeWrites(childID)` after
// a drain to enforce the changelog contract (meta/log.md must be appended
// whenever the child consolidated anything). Process-local, same lifetime as
// the issues map.
const writes = new Map<string, Set<string>>()

export function recordWrite(sessionID: string, path: string): void {
  if (!sessionID || !path) return
  const set = writes.get(sessionID) ?? new Set<string>()
  set.add(path)
  writes.set(sessionID, set)
}

export function peekWrites(sessionID: string): string[] {
  return [...(writes.get(sessionID) ?? [])]
}

export function takeWrites(sessionID: string): string[] {
  const list = peekWrites(sessionID)
  writes.delete(sessionID)
  return list
}

export function recordIssue(sessionID: string, issue: VerificationIssue): void {
  if (!sessionID) return
  const list = issues.get(sessionID) ?? []
  list.push(issue)
  issues.set(sessionID, list)
}

export function peekIssues(sessionID: string): VerificationIssue[] {
  return issues.get(sessionID) ?? []
}

export function takeIssues(sessionID: string): VerificationIssue[] {
  const list = issues.get(sessionID) ?? []
  issues.delete(sessionID)
  return list
}

export function clearSession(sessionID: string): void {
  issues.delete(sessionID)
  writes.delete(sessionID)
}

export function resetVerification(): void {
  issues.clear()
  writes.clear()
}

// An issue is "blocking" when the guard could not cleanly resolve it AND an
// unresolved state risks stale content: a date it refused to touch, or an
// escaped-wikilink whose repair write failed. An `ambiguous` bullet diff is
// deliberately NOT blocking: the child's write already landed in the vault, so
// retaining the batch would only re-run the whole drain (duplicate writes,
// re-billed context) while re-triggering the same false positive forever —
// knowledge-hook logs it and prunes anyway.
export function blockingIssues(list: VerificationIssue[]): VerificationIssue[] {
  return list.filter((i) => !i.repaired && i.kind !== "ambiguous")
}
