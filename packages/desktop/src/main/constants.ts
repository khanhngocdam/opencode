import { app } from "electron"

type Channel = "local" | "dev" | "beta" | "prod"

const raw = import.meta.env.OPENCODE_CHANNEL

export const CHANNEL: Channel = raw === "local" || raw === "dev" || raw === "beta" || raw === "prod" ? raw : "dev"

export const VERSION = app.isPackaged ? app.getVersion() : (process.env.OPENCODE_VERSION ?? app.getVersion())

const appNames: Record<string, string> = {
  dev: "CoDev Code 2 Dev",
  beta: "CoDev Code 2 Beta",
  prod: "CoDev Code 2",
}

const appIDs: Record<string, string> = {
  dev: "ai.codev2.desktop.dev",
  beta: "ai.codev2.desktop.beta",
  prod: "ai.codev2.desktop",
}

// Local renderer/server mode keeps the dev application identity.
export const APP_NAME = app.isPackaged ? appNames[CHANNEL] : "CoDev Code 2 Dev"

export const APP_ID = app.isPackaged ? appIDs[CHANNEL] : "ai.codev2.desktop.dev"
