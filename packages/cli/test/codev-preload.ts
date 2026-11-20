// Codev: launch handlers spawn the detached stats push; tests that run the CLI must never upload a developer's real
// sessions, so metrics stay off unless a test opts back in.
process.env.CODEV_DISABLE_METRICS ??= "1"
