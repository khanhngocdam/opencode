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
