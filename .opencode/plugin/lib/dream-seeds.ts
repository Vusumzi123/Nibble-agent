// §17.5 hybrid dream seeds, gathered hook-side (zero LLM): A = most recent
// un-consolidated turn (mood/recent-turn-seeded proxy), B = one random vault
// note (the associative junk-dream character). The dreamer is tool-free, so
// the fragments ride in the prompt.
//
// Loaded via relative import only. The plugin auto-discovery glob
// "{plugin,plugins}/*.{ts,js}" is non-recursive, so this subdirectory file is
// never loaded as a plugin itself.
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import type { DreamSeeds } from "./dream.ts"
import { readDrainConfig } from "./drain/config.ts"
import { readMemoryConfig } from "./memory/config.ts"
import { resolveProvider } from "./memory/registry.ts"

export async function pickDreamSeeds(opts: {
  directory: string
  stateDir: string
  vaultDir: string
  dbFile?: string
  moodLine: string
  random?: () => number
}): Promise<DreamSeeds> {
  const random = opts.random ?? Math.random
  let recent: string | null = null
  try {
    const drainCfg = await readDrainConfig(opts.directory)
    const memoryCfg = await readMemoryConfig(opts.directory)
    const provider = resolveProvider(memoryCfg.provider, {
      directory: opts.directory,
      stateDir: opts.stateDir,
      vaultDir: opts.vaultDir,
      drain: drainCfg,
      dbFile: opts.dbFile,
    })
    recent = (await provider.seed?.()) ?? null
  } catch {
    /* no turn store — seed A falls back to the mood line */
  }
  if (!recent) recent = `mood: ${opts.moodLine}`

  let randomNote: string | null = null
  try {
    const notes = (await readdir(opts.vaultDir)).filter(
      (f) => f.endsWith(".md") && f !== "Backlog.md" && f !== "Kael Dreams.md",
    )
    if (notes.length > 0) {
      const pick = notes[Math.floor(random() * notes.length)]
      const text = await readFile(join(opts.vaultDir, pick), "utf8").catch(() => "")
      const excerpt = text.replace(/---[\s\S]*?---/, "").replace(/\s+/g, " ").trim().slice(0, 300)
      randomNote = `random note "${pick}": ${excerpt}`
    }
  } catch {
    /* no vault yet — seed B omitted */
  }
  return { recent, random: randomNote }
}
