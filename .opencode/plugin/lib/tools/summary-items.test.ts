import { test } from "node:test"
import assert from "node:assert/strict"
import {
  SUMMARY_ITEMS_TOOL,
  parseSummaryItems,
  validateSummaryItems,
} from "../drain/summarize.ts"
import { createSummaryItemsTool } from "./summary-items.ts"

const ITEM = {
  title: "Wireguard Restart",
  tags: ["linux/network"],
  summary: "Restart wg0 after changing the config.",
  atoms: ["sudo systemctl restart wg0"],
}

test("an empty item array is the clean no-items outcome", () => {
  const result = validateSummaryItems({ items: [] })
  assert.deepEqual(result, { ok: true, items: [] })
})

test("items are trimmed and normalized", () => {
  const result = validateSummaryItems({
    items: [{ title: "  Title  ", tags: [" tag "], summary: " text ", atoms: [" atom "] }],
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.items[0], {
    title: "Title",
    tags: ["tag"],
    summary: "text",
    atoms: ["atom"],
  })
})

test("an empty title is rejected with a structured error", () => {
  const result = validateSummaryItems({ items: [{ title: "  ", tags: [], summary: "", atoms: [] }] })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.match(result.error, /title/i)
})

test("tags and atoms must be string arrays when present", () => {
  const badTags = validateSummaryItems({ items: [{ title: "T", tags: "linux", atoms: [] }] })
  assert.equal(badTags.ok, false)
  const badAtoms = validateSummaryItems({ items: [{ title: "T", tags: [], atoms: [1] }] })
  assert.equal(badAtoms.ok, false)
})

test("parseSummaryItems reads the last tool call and rejects an invalid one", () => {
  const rows = [
    {
      info: { role: "assistant" },
      parts: [{ type: "tool", tool: SUMMARY_ITEMS_TOOL, state: { input: { items: [ITEM] } } }],
    },
    {
      info: { role: "assistant" },
      parts: [{ type: "tool", tool: SUMMARY_ITEMS_TOOL, state: { input: { items: [] } } }],
    },
  ]
  assert.deepEqual(parseSummaryItems(rows), [])

  const invalid = [
    {
      info: { role: "assistant" },
      parts: [
        {
          type: "tool",
          tool: SUMMARY_ITEMS_TOOL,
          state: { input: { items: [{ title: "", tags: [], summary: "", atoms: [] }] } },
        },
      ],
    },
  ]
  assert.equal(parseSummaryItems(invalid), null)
  assert.equal(parseSummaryItems([]), null)
})

test("the tool reports the count and rejects an empty title", async () => {
  const tool = createSummaryItemsTool()
  assert.deepEqual(
    JSON.parse(await (tool as any).execute({ items: [ITEM] })),
    { ok: true, count: 1 },
  )
  const failed = JSON.parse(
    await (tool as any).execute({ items: [{ title: "", tags: [], summary: "", atoms: [] }] }),
  )
  assert.equal(failed.ok, false)
  assert.match(failed.error, /title/i)
})
