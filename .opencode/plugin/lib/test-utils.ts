// Shared fixtures for the hook tests.
//
// IMPORTANT: call `tempHome()` BEFORE dynamically importing a hook module. The
// hooks resolve the sysop root from HOME at plugin init, so importing this file
// statically and setting HOME first is what isolates their state files. This
// module deliberately imports no hook modules (and has no side effects beyond
// tempHome's HOME mutation), so it can never trigger plugin initialization.
//
// Loaded via relative import only. The plugin auto-discovery glob
// "{plugin,plugins}/*.{ts,js}" is non-recursive, so this subdirectory file is
// never loaded as a plugin itself.
import { mkdtempSync } from "node:fs"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Create a throwaway HOME and point the process at it. Returns the dir.
export function tempHome(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  process.env.HOME = dir
  return dir
}

// Parse an NDJSON blob into objects, skipping blank lines.
export function parseNdjson(text: string): unknown[] {
  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line))
}

// Write a one-section sysop-config.yaml under `<dir>/.opencode/` and return its
// path. `lines` are the section body; indentation is added for you.
export async function writeSection(
  dir: string,
  section: string,
  lines: string[],
): Promise<string> {
  await mkdir(join(dir, ".opencode"), { recursive: true })
  const path = join(dir, ".opencode", "sysop-config.yaml")
  const body = [section + ":", ...lines.map((line) => "  " + line), ""].join("\n")
  await writeFile(path, body, "utf8")
  return path
}

// Minimal mock of the opencode client surface most hooks touch. `create` counts
// child-session spawns (the deterministic write path must never create one);
// `prompts` captures promptAsync calls; `toasts` captures showToast calls.
export function mockClient(opts: { childParent?: Record<string, string> } = {}) {
  const calls = { create: 0, prompts: [] as any[], toasts: [] as any[] }
  return {
    calls,
    session: {
      get: async ({ path }: any) => ({
        data: opts.childParent?.[path.id] ? { parentID: opts.childParent[path.id] } : {},
      }),
      messages: async () => ({ data: [] as any[] }),
      create: async () => {
        calls.create++
        return { data: { id: "ses_child" } }
      },
      promptAsync: async (args: any) => {
        calls.prompts.push(args)
        return { response: { ok: true, status: 200 } }
      },
    },
    tui: {
      showToast: async (args: any) => {
        calls.toasts.push(args)
        return { response: { ok: true, status: 200 } }
      },
    },
  }
}

// Re-export the async temp-dir helper so tests need one import.
export async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix))
}
