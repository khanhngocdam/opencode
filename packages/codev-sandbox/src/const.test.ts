import { expect, test } from "bun:test"
import { SANDBOX_MANIFEST_URL, sandboxStorageObjectKey } from "./const"

// The invariant that matters: what publish-image.ts uploads to and what a
// client GETs are the same location. Asserting the suffix rather than the
// literal prefix keeps a deliberate bucket move a one-line change here.
test("the publish key is the tail of the url clients read", () => {
  expect(SANDBOX_MANIFEST_URL.endsWith(`/${sandboxStorageObjectKey(SANDBOX_MANIFEST_URL)}`)).toBe(true)
})

test("drops the bucket segment, keeps the version folder", () => {
  expect(sandboxStorageObjectKey("https://storage.test/bucket/codev/sandbox/1.2.3/vz-arm64.tar.gz")).toBe(
    "codev/sandbox/1.2.3/vz-arm64.tar.gz",
  )
})
