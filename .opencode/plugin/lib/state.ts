// JSON state-file store shared by the hooks. Reads merge persisted fields over
// the defaults (so a state file written by an older schema still loads), writes
// go through atomicWrite, and errors route to a caller-supplied handler rather
// than throwing into a hook turn.
//
// Loaded via relative import only. The plugin auto-discovery glob
// "{plugin,plugins}/*.{ts,js}" is non-recursive, so this subdirectory file is
// never loaded as a plugin itself.
import { atomicRead, atomicWrite } from "./fsx.ts"

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
  const read = async (): Promise<T> => {
    try {
      const parsed = JSON.parse(await atomicRead(file))
      return { ...defaults, ...parsed }
    } catch {
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
