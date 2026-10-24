#!/usr/bin/env node
// Runtime networking helpers for the launcher (scripts/run.sh) and its tests.
//
// Ports are ephemeral by default: `free-port 0` asks the kernel for one. A
// pinned port from config/CLI is honoured when free; when it is busy we fall
// back to a kernel-assigned port, report `fallback=1`, and the caller logs it.
// No config is ever rewritten.
//
// CLI:
//   node scripts/lib/net.mjs free-port [preferred]   -> "<port> <0|1>"
//   node scripts/lib/net.mjs can-bind <port>         -> exit 0 when bindable
//   node scripts/lib/net.mjs config <dir> <block> <key>
//                                                    -> value (may be empty)
//   node scripts/lib/net.mjs manifest <file> <json>  -> atomic write
//
// Imported by tests as an ESM module (no side effects on import).
import { createServer } from "node:net"
import { readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

/** Bind a loopback port and close it again; `0` = kernel-assigned. */
export function bindPort(port = 0, host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.once("error", reject)
    server.listen(port, host, () => {
      const address = server.address()
      const actual = typeof address === "object" && address !== null ? address.port : port
      server.close(() => resolve(actual))
    })
  })
}

/** True when the loopback port can be bound right now. */
export async function canBind(port, host = "127.0.0.1") {
  try {
    await bindPort(port, host)
    return true
  } catch {
    return false
  }
}

/**
 * Resolve a listen port. A preferred port > 0 is used when free; otherwise the
 * kernel assigns one. `fallback` is true only when a preferred port was busy.
 */
export async function resolvePort(preferred = 0, host = "127.0.0.1") {
  if (!Number.isInteger(preferred) || preferred <= 0) {
    return { port: await bindPort(0, host), fallback: false }
  }
  if (await canBind(preferred, host)) return { port: preferred, fallback: false }
  return { port: await bindPort(0, host), fallback: true }
}

// --- block-scoped YAML scalar reader ---------------------------------------
// The sysop config is line-oriented YAML with two-space nesting; this reads a
// single scalar without a YAML dependency.
export async function configScalar(directory, block, key, text) {
  const raw =
    text ??
    (await readFile(join(directory, ".opencode", "sysop-config.yaml"), "utf8").catch(() => ""))
  let inSection = false
  for (const line of String(raw).split("\n")) {
    if (new RegExp(`^${block}:`).test(line)) {
      inSection = true
      continue
    }
    if (inSection && /^[^\s]/.test(line)) break
    if (!inSection) continue
    const match = line.match(new RegExp(`^  ${key}: *(.*)$`))
    if (!match) continue
    return match[1]
      .replace(/\s+#.*$/, "")
      .trim()
      .replace(/^"(.*)"$/, "$1")
      .replace(/^'(.*)'$/, "$1")
  }
  return ""
}

export async function writeAtomic(file, content) {
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`
  await writeFile(tmp, content, "utf8")
  await rename(tmp, file)
}

// --- CLI --------------------------------------------------------------------
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  const [cmd, ...args] = process.argv.slice(2)
  try {
    switch (cmd) {
      case "free-port": {
        const preferred = Number(args[0] ?? 0)
        const result = await resolvePort(Number.isFinite(preferred) ? preferred : 0)
        process.stdout.write(`${result.port} ${result.fallback ? 1 : 0}\n`)
        break
      }
      case "can-bind": {
        const port = Number(args[0])
        if (!Number.isInteger(port) || port < 1 || port > 65535) process.exit(2)
        process.exit((await canBind(port)) ? 0 : 1)
      }
      case "config": {
        const [directory, block, key] = args
        if (!directory || !block || !key) process.exit(2)
        process.stdout.write((await configScalar(directory, block, key)).trim())
        break
      }
      case "manifest": {
        const [file, payload] = args
        if (!file || payload === undefined) process.exit(2)
        await writeAtomic(file, `${payload.replace(/\n+$/, "")}\n`)
        break
      }
      default:
        process.stderr.write("usage: net.mjs free-port|can-bind|config|manifest ...\n")
        process.exit(2)
    }
  } catch (err) {
    process.stderr.write(`net.mjs: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  }
}
