// Externalized `[sleepState]` directives (`quiet.prompts_file`).
//
// The JSON values are the directive text only; `buildSleepLine` prepends the
// stable `[sleepState] ` tag. A missing/unreadable/malformed file yields null
// and callers fall back to DEFAULT_SLEEP_PROMPTS.
//
// Loaded via relative import only. The plugin auto-discovery glob
// "{plugin,plugins}/*.{ts,js}" is non-recursive, so this subdirectory file is
// never loaded as a plugin itself.
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"
import { expandHome } from "./paths.ts"

export type SleepPrompts = {
  awake: string
  dreaming: string
  woken: string
  quiet_awake: string
}

export const SLEEP_PROMPT_KEYS = ["awake", "dreaming", "woken", "quiet_awake"] as const

export const DEFAULT_SLEEP_PROMPTS: SleepPrompts = {
  awake: "awake — outside the quiet window; normal daytime energy and directness.",
  dreaming: "dreaming — quiet window, no user present; low-energy, associative, inward tone.",
  woken:
    "woken — you were woken from sleep by the user and are still groggy, a little dizzy and " +
    "disoriented. Let it show briefly in your tone, then focus. The wake has already shifted " +
    "your mood (groggier, more alert). The user is present; be responsive and direct. Dreams " +
    "are paused. Do not let the grogginess impair correctness, tool use, or safety.",
  quiet_awake: "quiet window just opened, sleep state catching up; act awake for this turn.",
}

/** Strict parse: every key must be a non-empty string, unknown keys ignored. */
export function parseSleepPrompts(json: unknown): SleepPrompts | null {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null
  const root = json as Record<string, unknown>
  const out = {} as SleepPrompts
  for (const key of SLEEP_PROMPT_KEYS) {
    const value = root[key]
    if (typeof value !== "string" || !value.trim()) return null
    out[key] = value.trim()
  }
  return out
}

/** Read + parse the prompts file. Never throws: missing/malformed -> null. */
export async function readSleepPrompts(file: string): Promise<SleepPrompts | null> {
  try {
    return parseSleepPrompts(JSON.parse(await readFile(file, "utf8")))
  } catch {
    return null
  }
}

/** Absolute leaves pass through; `~` is home-expanded; else project-relative. */
export function resolveSleepPrompts(directory: string, leaf: string): string {
  const expanded = expandHome(leaf, homedir())
  return isAbsolute(expanded) ? expanded : join(directory, expanded)
}
