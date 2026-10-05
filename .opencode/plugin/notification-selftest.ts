import type { Plugin } from "@opencode-ai/plugin"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

// TEMPORARY live smoke test for TUI notifications.
//
// Arm it by creating the marker, then send a message in opencode: the first
// message of each session raises one success toast. Remove the marker to disarm
// (no restart needed once loaded), or delete this file entirely.
//
//   touch ~/.opencode-sysop/notification-selftest
//
// Inert when the marker is absent; it writes nothing else.
const MARKER = join(homedir(), ".opencode-sysop", "notification-selftest")

export default (async ({ client, directory }) => {
  const fired = new Set<string>()
  return {
    "chat.message": async (input) => {
      const sid = input.sessionID
      if (!sid || fired.has(sid) || !existsSync(MARKER)) return
      fired.add(sid)
      try {
        await client.tui.showToast({
          body: {
            title: "notification-selftest",
            message: "If you can read this, TUI notifications work.",
            variant: "success",
            duration: 10000,
          },
          query: { directory },
        })
      } catch {}
    },
  }
}) satisfies Plugin
