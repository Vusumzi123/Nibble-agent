import assert from "node:assert/strict"
import { test } from "node:test"

// DST cases are only meaningful in a zone with transitions; pin one so the
// assertions do not depend on the machine's local time.
process.env.TZ = "Europe/Berlin"

const { occurrence, nextDue, parseSchedule } = await import("./schedule.ts")

function ok(raw: string) {
  const parsed = parseSchedule(raw)
  assert.equal(parsed.ok, true, `expected ${raw} to parse`)
  if (!parsed.ok) throw new Error("unreachable")
  return parsed.schedule
}

function ms(iso: string): number {
  return Date.parse(iso)
}

test("parses interval shorthand with and without every", () => {
  assert.deepEqual(ok("30m"), { kind: "interval", interval_ms: 1_800_000, source: "30m" })
  assert.deepEqual(ok("every 1h"), { kind: "interval", interval_ms: 3_600_000, source: "every 1h" })
  assert.deepEqual(ok("12h"), { kind: "interval", interval_ms: 43_200_000, source: "12h" })
  assert.deepEqual(ok("every 50m"), { kind: "interval", interval_ms: 3_000_000, source: "every 50m" })
})

test("parses cron, aliases, daily and weekly forms", () => {
  assert.deepEqual(ok("0 9 * * *"), { kind: "cron", pattern: "0 9 * * *", source: "0 9 * * *" })
  assert.deepEqual(ok("@daily"), { kind: "cron", pattern: "@daily", source: "@daily" })
  assert.deepEqual(ok("daily 09:00"), { kind: "cron", pattern: "0 9 * * *", source: "daily 09:00" })
  assert.deepEqual(ok("weekly mon 09:30"), {
    kind: "cron",
    pattern: "30 9 * * mon",
    source: "weekly mon 09:30",
  })
  assert.deepEqual(ok("manual"), { kind: "manual", source: "manual" })
})

test("parses one-shot at schedules", () => {
  assert.deepEqual(ok("at 2026-11-02T09:00:00Z"), {
    kind: "once",
    at_ms: ms("2026-11-02T09:00:00Z"),
    source: "at 2026-11-02T09:00:00Z",
  })
})

test("invalid schedules fail closed without throwing", () => {
  for (const raw of ["", "nonsense", "0 9 * *", "every 0m", "daily 25:00", "weekly funday 09:00", "at not-a-date"]) {
    const parsed = parseSchedule(raw)
    assert.equal(parsed.ok, false, `expected ${raw} to be invalid`)
  }
})

test("interval fire uses the first missed boundary and marks lateness", () => {
  const spec = ok("30m")
  const t0 = ms("2026-11-01T09:00:00Z")
  assert.deepEqual(occurrence(spec, t0 + 29 * 60_000, t0), { due: false })
  assert.deepEqual(occurrence(spec, t0 + 30 * 60_000, t0), {
    due: true,
    occurrence_ms: t0 + 30 * 60_000,
    late: false,
  })
  assert.deepEqual(occurrence(spec, t0 + 75 * 60_000, t0), {
    due: true,
    occurrence_ms: t0 + 30 * 60_000,
    late: true,
  })
})

test("nextDue for intervals stays one boundary ahead", () => {
  const spec = ok("1h")
  const t0 = ms("2026-11-01T09:00:00Z")
  assert.equal(nextDue(spec, t0, t0), t0 + 3_600_000)
  assert.equal(nextDue(spec, t0 + 90 * 60_000, t0), t0 + 3_600_000)
  assert.equal(nextDue(spec, t0, null), null)
})

test("cron waits for the next occurrence instead of firing at first sight", () => {
  const spec = ok("daily 09:00")
  assert.deepEqual(occurrence(spec, ms("2026-11-01T10:00:00+01:00"), null), { due: false })
  assert.deepEqual(occurrence(spec, ms("2026-11-01T08:59:00+01:00"), null), { due: false })
  assert.equal(nextDue(spec, ms("2026-11-01T10:00:00+01:00"), null), ms("2026-11-02T09:00:00+01:00"))
})

test("cron fires once for a missed window and coalesces several misses", () => {
  const spec = ok("0 9 * * *")
  const last = ms("2026-11-01T09:00:00+01:00")
  assert.deepEqual(occurrence(spec, ms("2026-11-02T10:00:00+01:00"), last), {
    due: true,
    occurrence_ms: ms("2026-11-02T09:00:00+01:00"),
    late: false,
  })
  assert.deepEqual(occurrence(spec, ms("2026-11-03T10:00:00+01:00"), last), {
    due: true,
    occurrence_ms: ms("2026-11-03T09:00:00+01:00"),
    late: true,
  })
  assert.deepEqual(occurrence(spec, ms("2026-11-01T09:00:00+01:00"), last), { due: false })
})

test("one-shot fires once after its at time", () => {
  const spec = ok("at 2026-11-02T09:00:00Z")
  const at = ms("2026-11-02T09:00:00Z")
  assert.deepEqual(occurrence(spec, at - 1_000, null), { due: false })
  assert.deepEqual(occurrence(spec, at + 1_000, null), {
    due: true,
    occurrence_ms: at,
    late: false,
  })
  assert.deepEqual(occurrence(spec, at + 1_000, at), { due: false })
  assert.equal(nextDue(spec, at - 1_000, null), at)
  assert.equal(nextDue(spec, at + 1_000, at), null)
})

test("spring-forward skips the nonexistent wall time once", () => {
  const spec = ok("30 2 * * *")
  const last = ms("2026-03-28T02:30:00+01:00")
  assert.equal(nextDue(spec, ms("2026-03-28T12:00:00+01:00"), last), ms("2026-03-29T03:00:00+02:00"))
  assert.deepEqual(occurrence(spec, ms("2026-03-29T03:00:00+02:00"), last), {
    due: true,
    occurrence_ms: ms("2026-03-29T03:00:00+02:00"),
    late: false,
  })
})

test("fall-back does not fire the repeated wall time twice", () => {
  const spec = ok("30 2 * * *")
  const last = ms("2026-10-24T02:30:00+02:00")
  const first = ms("2026-10-25T02:30:00+02:00")
  assert.equal(nextDue(spec, ms("2026-10-24T12:00:00+02:00"), last), first)
  assert.deepEqual(occurrence(spec, ms("2026-10-25T03:00:00+01:00"), first), { due: false })
  assert.equal(nextDue(spec, ms("2026-10-25T03:00:00+01:00"), first), ms("2026-10-26T02:30:00+01:00"))
})
