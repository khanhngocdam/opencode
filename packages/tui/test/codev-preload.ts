import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Codev: app fixtures render with an empty model list, which is exactly what opens the forced first-run configure gate
// in app.tsx. Turn the gate off so upstream app tests see the screens they expect; the gate's decision is covered by
// test/configure-gate.test.ts.
process.env.CODEV_CONFIGURE_GATE ??= "0"

// The startup key check and the sign-in nudge read the shared gateway auth file. Point it at an empty home so a test
// never reads a developer's real credentials or calls the real gateway.
process.env.CODEV_TEST_HOME ??= mkdtempSync(join(tmpdir(), "codev-tui-test-home-"))
