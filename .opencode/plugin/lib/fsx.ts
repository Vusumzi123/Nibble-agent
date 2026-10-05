// Atomic file IO shared across the hooks. Writes go to a unique temp file in
// the same directory and are renamed over the target (same-directory rename is
// atomic on POSIX); the temp file is cleaned up on failure. Reads and updates
// treat a missing file as "".
//
// Loaded via relative import only. The plugin auto-discovery glob
// "{plugin,plugins}/*.{ts,js}" is non-recursive, so this subdirectory file is
// never loaded as a plugin itself.
import { randomBytes } from "node:crypto"
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

// Unique same-directory temp path: pid + time + random so concurrent writers
// cannot collide, and same-dir so the final rename stays atomic.
function tmpPath(file: string): string {
  const rand = randomBytes(4).toString("hex")
  return `${file}.${process.pid}.${Date.now().toString(36)}.${rand}.tmp`
}

export async function atomicWrite(file: string, content: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const tmp = tmpPath(file)
  try {
    await writeFile(tmp, content, "utf8")
    await rename(tmp, file)
  } catch (err) {
    await unlink(tmp).catch(() => {})
    throw err
  }
}

export async function atomicRead(file: string): Promise<string> {
  try {
    return await readFile(file, "utf8")
  } catch {
    return ""
  }
}

// Per-file in-process queue so concurrent read-modify-writes to the same file
// cannot lose an update (cross-process safety still relies on rename atomicity).
const updateLocks = new Map<string, Promise<unknown>>()

export function atomicUpdate(
  file: string,
  update: (current: string) => string,
): Promise<string> {
  const prev = updateLocks.get(file) ?? Promise.resolve()
  const run = prev.catch(() => {}).then(async () => {
    const current = await atomicRead(file)
    const next = update(current)
    await atomicWrite(file, next)
    return next
  })
  const guarded = run.catch(() => {})
  updateLocks.set(file, guarded)
  void guarded.finally(() => {
    if (updateLocks.get(file) === guarded) updateLocks.delete(file)
  })
  return run
}
