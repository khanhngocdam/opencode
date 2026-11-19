import {
  buildGatewayConfig,
  fetchApiKey,
  fetchCodevConfig,
  fetchModels,
  fetchModelWindows,
  cacheModelLimits,
  GATEWAY_PROVIDER,
  isKeyRefusal,
  isLoginCancelled,
  loadGatewayUrl,
  login,
  mergeConfigFragment,
  saveApiKey,
  saveCodevConfig,
  silentSso,
} from "@codev/gateway"
import { spawnStatsDaemon } from "@codev/upload/spawn"
import { Global } from "@opencode/util/global"
import { openUrl } from "@opencode/util/open"
import { createSignal, Show, type Accessor } from "solid-js"
import { useClient } from "../context/client"
import { useData } from "../context/data"
import { useTheme } from "../context/theme"
import { DialogHeader, DialogLayout, useDialog } from "../ui/dialog"
import { DialogPrompt } from "../ui/dialog-prompt"
import { DialogSelect } from "../ui/dialog-select"
import { Link } from "../ui/link"
import { useToast } from "../ui/toast"
import { errorMessage } from "../util/error"
import { RETRIES, withRetries } from "../util/configure-gate"
import { credentialConnections, DialogIntegration } from "./dialog-integration"
import { DialogModel } from "./dialog-model"
import { Spinner } from "./spinner"

// Fork-only: the in-agent equivalent of `codev2 configure`. Sign in with SSO (the CoDev backend mints a gateway
// key) or enter a gateway key by hand, then:
//   1. merge the keyless `aigw` provider block into the global v2 config document,
//   2. store the key as a v2 SQLite credential for the `aigw` integration, and
//   3. open the model picker for the new provider.
// `config.update` only patches `shell` in v2, so the provider block is written to the config file directly; the
// server's config watcher reloads it. The v2 dialog stack has no persistent (non-dismissable) mode, so escape
// always closes the flow; on an install with no usable model the first-run gate in app.tsx reopens it at once, and
// otherwise `/configure` or `codev2 configure` does.
//
// Flow state lives in the awaited controller functions below; the components they render are pure views over
// controller-owned signals, so a remount is invisible.

type FlowContext = {
  dialog: ReturnType<typeof useDialog>
  client: ReturnType<typeof useClient>
  data: ReturnType<typeof useData>
  toast: ReturnType<typeof useToast>
}

export function DialogConfigure(props: { expired?: boolean } = {}) {
  const root = useTheme()
  const ctx: FlowContext = {
    dialog: useDialog(),
    client: useClient(),
    data: useData(),
    toast: useToast(),
  }

  return (
    <DialogSelect
      title="Configure Codev Code 2.0"
      titleView={
        props.expired ? (
          <box>
            <text fg={root.text.base}>Configure Codev Code 2.0</text>
            <text fg={root.text.feedback.warning.base}>
              Your sign-in has expired. Log in with SSO again to continue.
            </text>
          </box>
        ) : undefined
      }
      renderFilter={false}
      options={[
        { title: "Login with SSO", value: "sso", onSelect: () => void runSsoFlow(ctx) },
        { title: "Enter API key", value: "key", onSelect: () => void runKeyFlow(ctx) },
        {
          title: "Connect provider",
          value: "provider",
          description: "Anthropic, OpenAI, and others",
          onSelect: () => ctx.dialog.replace(() => <DialogIntegration />),
        },
      ]}
    />
  )
}

async function runSsoFlow(ctx: FlowContext) {
  const [status, setStatus] = createSignal("Starting SSO login...")
  const [authUrl, setAuthUrl] = createSignal<string>()
  const [pasteError, setPasteError] = createSignal<string>()
  // Locks the paste field once a code is accepted or the browser callback lands: the token exchange and every
  // gateway call after it are async.
  const [busy, setBusy] = createSignal(false)
  let submitManualCode: ((pasted: string) => string | null) | undefined
  // Closing the step aborts the attempt so login() closes its loopback server instead of finishing behind the
  // user's back. replace()/clear() also fire onClose, but by then login() has settled and the abort is a no-op.
  const abort = new AbortController()

  ctx.dialog.replace(
    () => (
      <SsoView
        status={status}
        authUrl={authUrl}
        pasteError={pasteError}
        busy={busy}
        onPaste={(value) => {
          if (busy() || !submitManualCode) return
          const error = submitManualCode(value)
          setPasteError(error ?? undefined)
          if (!error) setBusy(true)
        }}
      />
    ),
    () => abort.abort(),
  )

  try {
    const session =
      (await silentSso()) ??
      (await login({
        onLog: setStatus,
        onReady(openBrowser, url, submit) {
          submitManualCode = submit
          setAuthUrl(url)
          openBrowser()
        },
        openUrl,
        signal: abort.signal,
      }))

    setBusy(true)
    setStatus("Fetching gateway configuration...")
    const config = await withRetries("Fetching gateway configuration", setStatus, () =>
      fetchCodevConfig(session.access_token),
    )
    saveCodevConfig(config)

    setStatus("Fetching gateway API key...")
    // A refusal means the gateway declined this account (for example an email domain outside its allowlist). It is
    // neither retryable nor fatal: a key issued by hand still works, so fall through to manual entry with the
    // gateway's own reason.
    const minted = await withRetries("Fetching gateway API key", setStatus, () => fetchApiKey(session.access_token))
      .then((key) => ({ key, refusal: undefined as string | undefined }))
      .catch((error: unknown) => {
        if (!isKeyRefusal(error)) throw error
        return { key: "", refusal: error.reason }
      })
    if (minted.key) return await configureGateway(ctx, { apiKey: minted.key, baseUrl: config.gatewayUrl })

    ctx.toast.show({
      variant: minted.refusal ? "warning" : "info",
      message: minted.refusal
        ? `${minted.refusal}. Retrying won't change this — enter an API key issued to you by hand.`
        : "Your account has no gateway API key. Enter it manually.",
    })
    const pasted = await ask(ctx.dialog, "API Key", { placeholder: "sk-..." })
    if (!pasted) return
    await configureGateway(ctx, { apiKey: pasted, baseUrl: config.gatewayUrl })
  } catch (error) {
    if (isLoginCancelled(error)) return
    failSetup(ctx, errorMessage(error))
  }
}

// Manual path for installs without SSO: the gateway URL (prefilled from an earlier login) and a key issued by hand.
async function runKeyFlow(ctx: FlowContext) {
  const baseUrl = await ask(ctx.dialog, "Gateway URL", {
    placeholder: "https://gateway.example.com",
    value: loadGatewayUrl() ?? undefined,
  })
  if (!baseUrl) return
  const apiKey = await ask(ctx.dialog, "API Key", { placeholder: "sk-..." })
  if (!apiKey) return
  await configureGateway(ctx, { apiKey, baseUrl }).catch((error: unknown) => failSetup(ctx, errorMessage(error)))
}

async function configureGateway(ctx: FlowContext, creds: { apiKey: string; baseUrl: string }) {
  const [status, report] = createSignal("Fetching models...")
  ctx.dialog.replace(() => <StatusView status={status} />)

  // No fallback model: a config pointing at an unreachable gateway or a bad key would only fail on the first chat.
  const models = await withRetries("Fetching models", report, () => fetchModels(creds.apiKey, creds.baseUrl)).catch(
    (error: unknown) => {
      failSetup(ctx, `couldn't fetch models after ${RETRIES} retries: ${errorMessage(error)}`)
    },
  )
  if (!models) return
  if (models.length === 0) return failSetup(ctx, "the gateway returned no models")
  // Gateway-reported windows override the static table in the config block written below. Never blocks the flow.
  cacheModelLimits(await fetchModelWindows(creds.apiKey, creds.baseUrl))

  report("Applying configuration...")
  // Config first: the integration exists once the provider block loads, and a credential without its provider
  // would be unusable.
  mergeConfigFragment(
    process.env.OPENCODE_CONFIG_DIR ?? Global.Path.config,
    buildGatewayConfig({ baseUrl: creds.baseUrl, model: models[0], models }),
  )
  const existing = ctx.data.location.integration.list()?.find((item) => item.id === GATEWAY_PROVIDER.id)
  const previous = existing ? credentialConnections(existing) : []
  await ctx.client.api.credential.create({
    integrationID: GATEWAY_PROVIDER.id,
    label: "CoDev gateway",
    value: { type: "key", key: creds.apiKey },
  })
  // Reconfiguring replaces the earlier gateway key instead of piling up accounts.
  await Promise.all(previous.map((connection) => ctx.client.api.credential.remove({ credentialID: connection.id })))
  // The hub-shared auth file keeps the key for the stats daemon and the hub; the config block stays keyless.
  saveApiKey({ apiKey: creds.apiKey, model: models[0] })
  // A fresh sign-in un-stalls the background stats push; send any backlog now. Detached, gated inside.
  spawnStatsDaemon()

  ctx.toast.show({ variant: "success", message: "Codev Code 2.0 configured. Choose a model." })
  ctx.dialog.replace(() => <DialogModel providerID={GATEWAY_PROVIDER.id} />)
}

function failSetup(ctx: FlowContext, message: string) {
  ctx.toast.show({
    variant: "error",
    title: "Codev Code 2.0 setup failed",
    message: `${message}. Run /configure to try again.`,
    duration: 10000,
  })
  ctx.dialog.clear()
}

function ask(
  dialog: FlowContext["dialog"],
  title: string,
  options: { placeholder: string; value?: string },
): Promise<string | null> {
  return new Promise((resolve) => {
    dialog.replace(
      () => (
        <DialogPrompt
          title={title}
          placeholder={options.placeholder}
          value={options.value}
          onConfirm={(value) => value.trim() && resolve(value.trim())}
        />
      ),
      () => resolve(null),
    )
  })
}

function StatusView(props: { status: Accessor<string> }) {
  const theme = useTheme().surface("dialog")
  return (
    <DialogLayout header={<DialogHeader title="Configure Codev Code 2.0" />}>
      <Spinner color={theme.text.muted}>{props.status()}</Spinner>
    </DialogLayout>
  )
}

// Pure view over the SSO controller's signals; safe to remount at any time.
function SsoView(props: {
  status: Accessor<string>
  authUrl: Accessor<string | undefined>
  pasteError: Accessor<string | undefined>
  busy: Accessor<boolean>
  onPaste: (value: string) => void
}) {
  const root = useTheme()
  const theme = root.surface("dialog")
  return (
    <DialogPrompt
      title="Login with SSO"
      busy={props.busy()}
      busyText="Signing in..."
      placeholder="Paste the callback URL or code here if the browser can't reach this machine"
      onConfirm={props.onPaste}
      description={() => (
        <box gap={1}>
          <text fg={theme.text.muted}>{props.status()}</text>
          <Show when={props.authUrl()}>
            {(url) => (
              <>
                <text fg={theme.text.muted}>Complete the login in your browser, or open:</text>
                <Link href={url()} fg={root.markdown.link} />
              </>
            )}
          </Show>
          <Show when={props.pasteError()}>
            {(error) => <text fg={theme.text.feedback.error.base}>{error()}</text>}
          </Show>
        </box>
      )}
    />
  )
}
