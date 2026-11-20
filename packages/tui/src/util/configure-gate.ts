import { isKeyRefusal } from "@codev/gateway"

export const RETRIES = 3

/**
 * Whether app startup should open the Codev gateway configure dialog: `codev2 configure` sets
 * `CODEV_CONFIGURE=1`, and the dialog only opens into an idle home screen, never over another dialog
 * or a draft prompt.
 */
export function shouldOpenConfigure(input: {
  env: string | undefined
  route: string
  dialogs: number
  draft: string | undefined
}) {
  return input.env === "1" && input.route === "home" && input.dialogs === 0 && !input.draft
}

/**
 * Whether the forced first-run gate should (re)open the configure dialog: the server has answered with no usable
 * model and nothing else is on screen. `models` is undefined until the list has loaded, which never opens the gate.
 * OpenCode's free hosted models are disabled for Codev2, so an empty list means nothing has been set up yet.
 * `expired` (the startup key check found the SSO session dead) forces the gate even when models are listed, since
 * their gateway key can no longer be trusted.
 */
export function shouldOpenConfigureGate(input: { models: number | undefined; dialogs: number; expired?: boolean }) {
  return (input.models === 0 || input.expired === true) && input.dialogs === 0
}

/**
 * Retries a transient network step up to `RETRIES` times, reporting each retry. A key refusal is a policy
 * answer rather than a flaky network, so it is thrown immediately for the caller's manual fallback.
 */
export async function withRetries<T>(label: string, onStatus: (text: string) => void, operation: () => Promise<T>) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation()
    } catch (error) {
      if (attempt >= RETRIES || isKeyRefusal(error)) throw error
      onStatus(`${label} failed — retrying (${attempt + 1}/${RETRIES})...`)
    }
  }
}
