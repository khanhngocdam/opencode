import { expect, test } from "bun:test"
import { createVzHelperEventReader, parseVzHelperEvent } from "./protocol"

test("parses helper state and error events", () => {
  expect(parseVzHelperEvent('{"event":"state","state":"running"}')).toEqual({ event: "state", state: "running" })
  expect(parseVzHelperEvent('{"event":"error","message":"boom"}')).toEqual({ event: "error", message: "boom" })
})

test("ignores lines that are not well-formed events", () => {
  expect(parseVzHelperEvent("")).toBe(null)
  expect(parseVzHelperEvent("guest kernel noise")).toBe(null)
  expect(parseVzHelperEvent('{"event":"state","state":"warping"}')).toBe(null)
  expect(parseVzHelperEvent('{"event":"error"}')).toBe(null)
  expect(parseVzHelperEvent("{not json")).toBe(null)
  expect(parseVzHelperEvent("[1,2]")).toBe(null)
})

test("line-buffers chunks that split or batch events", () => {
  const seen: unknown[] = []
  const read = createVzHelperEventReader((event) => seen.push(event))
  read('{"event":"state","sta')
  expect(seen).toEqual([])
  read('te":"starting"}\n{"event":"state","state":"running"}\nnoise\n{"event":"err')
  expect(seen).toEqual([
    { event: "state", state: "starting" },
    { event: "state", state: "running" },
  ])
  read('or","message":"late"}\n')
  expect(seen).toEqual([
    { event: "state", state: "starting" },
    { event: "state", state: "running" },
    { event: "error", message: "late" },
  ])
})
