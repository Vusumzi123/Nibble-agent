// Credential-file reading shared by the hooks. Keeps secrets out of the repo
// config: callers store only a path and read the chmod-600 file at use time.
// Missing/unreadable files yield "" (never throw into a hook turn).
//
// Loaded via relative import only. The plugin auto-discovery glob
// "{plugin,plugins}/*.{ts,js}" is non-recursive, so this subdirectory file is
// never loaded as a plugin itself.
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { expandHome } from "./paths.ts"

// Expand a leading `~` against `home` (defaults to the current user's home).
export function expandHomePath(file: string, home: string = homedir()): string {
  return expandHome(file, home)
}

// Read a credential file, trimming the trailing newline that editors/echo add.
export async function readCredential(file: string, home: string = homedir()): Promise<string> {
  try {
    return (await readFile(expandHomePath(file, home), "utf8")).trim()
  } catch {
    return ""
  }
}
