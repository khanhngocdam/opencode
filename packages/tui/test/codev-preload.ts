// Codev: app fixtures render with an empty model list, which is exactly what opens the forced first-run configure gate
// in app.tsx. Turn the gate off so upstream app tests see the screens they expect; the gate's decision is covered by
// test/configure-gate.test.ts.
process.env.CODEV_CONFIGURE_GATE ??= "0"
