import { expect, test } from "bun:test"
import { createAppFixture } from "./fixture/app"
import { directory, json } from "./fixture/tui-client"

// The test preload turns the forced configure gate off for every app fixture; these tests turn it back on.
async function withGate(run: () => Promise<void>) {
  const previous = process.env.CODEV_CONFIGURE_GATE
  delete process.env.CODEV_CONFIGURE_GATE
  try {
    await run()
  } finally {
    process.env.CODEV_CONFIGURE_GATE = previous
  }
}

test("an install with no usable model opens the configure gate, and escape does not dismiss it", () =>
  withGate(async () => {
    await using setup = await createAppFixture()
    await setup.ready
    await setup.waitForFrame((frame) => frame.includes("Configure Codev Code 2.0") && frame.includes("Login with SSO"))

    setup.mockInput.pressEscape()
    // Give the escape time to close the dialog and the gate effect time to react before reading the frame.
    await Bun.sleep(300)
    const frame = await setup.waitForFrame((frame) => frame.includes("Configure Codev Code 2.0"))
    expect(frame).toContain("Login with SSO")
  }))

test("a usable model keeps the configure gate closed", () =>
  withGate(async () => {
    await using setup = await createAppFixture({
      fetch: (url) => {
        if (url.pathname === "/api/model")
          return json({ location: { directory }, data: [{ id: "model", providerID: "aigw", name: "Model", variants: [] }] })
      },
    })
    await setup.ready
    const frame = await setup.waitForFrame((frame) => frame.includes("commands"))
    expect(frame).not.toContain("Configure Codev Code 2.0")
  }))
