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
}

export function resetVerification(): void {
  issues.clear()
}

// An issue is "blocking" when the guard could not cleanly resolve it (an
// ambiguous bullet diff, or a date it refused to touch). Repaired issues are
// informational only.
export function blockingIssues(list: VerificationIssue[]): VerificationIssue[] {
  return list.filter((i) => !i.repaired)
}
