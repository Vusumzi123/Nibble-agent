// JSON state-file store shared by the hooks. Reads merge persisted fields over
// the defaults (so a state file written by an older schema still loads), writes
// go through atomicWrite, and errors route to a caller-supplied handler rather
// than throwing into a hook turn.
//
// Loaded via relative import only. The plugin auto-discovery glob
// "{plugin,plugins}/*.{ts,js}" is non-recursive, so this subdirectory file is
// never loaded as a plugin itself.
import { atomicRead, atomicWrite } from "./fsx.ts"
import { errText, isEnoent } from "./util.ts"

export type StateStore<T> = {
  read(): Promise<T>
  write(state: T): Promise<void>
  update(fn: (prev: T) => T): Promise<T>
}

export function createStateStore<T extends object>(
  file: string,
  defaults: T,
  opts?: { onError?: (err: unknown) => void },
): StateStore<T> {
  const warnRead = (err: unknown): void => {
    // A missing/empty file is the normal first-run case; a parse or I/O
    // failure is silent data loss and must be surfaced (still fail-open
    // to defaults so the hook turn never breaks).
    const wrapped = new Error(`[state] failed to read ${file}, using defaults: ${errText(err)}`, {
      cause: err,
    })
    if (opts?.onError) opts.onError(wrapped)
    else console.warn(wrapped.message)
  }

  const read = async (): Promise<T> => {
    let raw: string
    try {
      raw = await atomicRead(file)
    } catch (err) {
      if (!isEnoent(err)) warnRead(err)
      return { ...defaults }
    }
    if (raw.trim() === "") return { ...defaults }
    try {
      const parsed = JSON.parse(raw)
      return { ...defaults, ...parsed }
    } catch (err) {
      warnRead(err)
      return { ...defaults }
    }
  }

  const write = async (state: T): Promise<void> => {
    try {
      await atomicWrite(file, JSON.stringify(state, null, 2))
    } catch (err) {
      opts?.onError?.(err)
    }
  }

  const update = async (fn: (prev: T) => T): Promise<T> => {
    const next = fn(await read())
    await write(next)
    return next
  }

  return { read, write, update }
}
