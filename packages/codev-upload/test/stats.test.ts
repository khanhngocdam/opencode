import { describe, expect, test } from "bun:test"
import { networkVolumeFilter, parseNetworkMounts } from "../src/network"
import { buildSessionStats, type StatsMessage } from "../src/stats"

const T0 = Date.UTC(2026, 7, 1, 10, 15, 0)

const tool = (name: string, status: "completed" | "error", input: object, metadata: object = {}) => ({
  type: "tool",
  tool: name,
  state: { status, input, metadata },
})

const assistant = (parts: unknown[], extra: object = {}): StatsMessage => ({
  info: { role: "assistant", modelID: "m1", providerID: "aigw", time: { created: T0, completed: T0 + 1000 }, ...extra },
  parts,
})

describe("buildSessionStats", () => {
  test("returns null for a session without messages", () => {
    expect(buildSessionStats({ id: "s", origin: "local", project: "p", messages: [], descendants: [] })).toBeNull()
  })

  test("counts accepted and rejected edits apart, and files only once", () => {
    const stats = buildSessionStats({
      id: "s",
      origin: "local",
      project: "p",
      messages: [
        { info: { role: "user", time: { created: T0 } }, parts: [{ type: "text", text: "go" }] },
        // A synthetic user part (injected attachment) is not a user turn.
        { info: { role: "user", time: { created: T0 } }, parts: [{ type: "text", text: "x", synthetic: true }] },
        assistant([
          tool("edit", "completed", { filePath: "/r/a.ts" }, { filediff: { additions: 3, deletions: 1 } }),
          tool("write", "completed", { filePath: "/r/b.md", content: "one\ntwo\n" }),
          tool("edit", "error", { filePath: "/r/a.ts", oldString: "x", newString: "y\nz" }),
          tool("apply_patch", "completed", {}, { files: [{ filePath: "/r/a.ts", additions: 2, deletions: 2 }] }),
          tool("read", "completed", { filePath: "/r/.claude/skills/deploy/SKILL.md" }),
          tool("skill", "completed", { name: "review" }),
        ]),
      ],
      descendants: [],
    })!
    expect(stats.user_turns).toBe(1)
    expect(stats.totals.loc).toEqual({ added: 7, deleted: 3, rejected_added: 2, rejected_deleted: 1 })
    expect(stats.files_changed).toBe(2)
    expect(stats.totals.tools.edit).toEqual({ ok: 1, error: 1 })
    expect(stats.skills).toEqual({ deploy: 1, review: 1 })
    expect(stats.file_extensions).toEqual({ ".ts": 1, ".md": 2 })
  })

  test("buckets usage by hour, provider and model", () => {
    const stats = buildSessionStats({
      id: "s",
      origin: "local",
      project: "p",
      messages: [assistant([], { tokens: { input: 10, output: 2 }, cost: 0.1 })],
      descendants: [[assistant([], { modelID: "m2", tokens: { input: 1, output: 1 } })]],
    })!
    expect(stats.buckets.map((b) => [b.hour, b.provider, b.model, b.tokens.input])).toEqual([
      ["2026-08-01T10:00:00.000Z", "aigw", "m1", 10],
      ["2026-08-01T10:00:00.000Z", "aigw", "m2", 1],
    ])
    expect(stats.totals.tokens.input).toBe(11)
    expect(stats.subagents).toBe(1)
  })
})

describe("network volumes", () => {
  const table = [
    "/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)",
    "//me@nas/share on /Volumes/share (smbfs, nodev, nosuid, mounted by me)",
    "nas:/export on /System/Volumes/Data/mnt/nfs (nfs, asynchronous)",
  ].join("\n")

  test("parses only network filesystems from the mount table", () => {
    expect(parseNetworkMounts(table)).toEqual(["/Volumes/share", "/System/Volumes/Data/mnt/nfs"])
  })

  test("matches dirs under a network mount, including the firmlinked path", () => {
    const onNetwork = networkVolumeFilter("darwin", () => table)
    expect(onNetwork("/Volumes/share/proj")).toBe(true)
    expect(onNetwork("/mnt/nfs/proj")).toBe(true)
    expect(onNetwork("/Users/me/proj")).toBe(false)
    expect(networkVolumeFilter("linux", () => table)("/Volumes/share")).toBe(false)
  })
})
