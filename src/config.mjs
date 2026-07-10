import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

// XDG Base Directory: ~/.config/remote-approver/config.json (honoring $XDG_CONFIG_HOME).
const XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
export const CONFIG_PATH = path.join(XDG_CONFIG_HOME, "remote-approver", "config.json");

export const DEFAULT_CONFIG = {
  topic: "",
  ntfyServer: "https://ntfy.sh",
  timeout: 120,
  planTimeout: 300,
  // autoApprove/autoDeny are reserved for future use and not yet implemented
  autoApprove: [],
  autoDeny: [],
  ntfyUsername: "",
  ntfyPassword: "",
  // When true, a Stop hook sends a one-shot "finished" notification (no buttons).
  notifyOnStop: false,
};

export function loadConfig(configPath = CONFIG_PATH) {
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const fileConfig = JSON.parse(raw);
    const config = { ...DEFAULT_CONFIG, ...fileConfig };
    if (typeof config.topic !== "string") config.topic = DEFAULT_CONFIG.topic;
    if (typeof config.ntfyServer !== "string") config.ntfyServer = DEFAULT_CONFIG.ntfyServer;
    if (!Number.isFinite(config.timeout) || config.timeout <= 0) config.timeout = DEFAULT_CONFIG.timeout;
    if (!Number.isFinite(config.planTimeout) || config.planTimeout <= 0) config.planTimeout = DEFAULT_CONFIG.planTimeout;
    if (!Array.isArray(config.autoApprove)) config.autoApprove = DEFAULT_CONFIG.autoApprove;
    if (!Array.isArray(config.autoDeny)) config.autoDeny = DEFAULT_CONFIG.autoDeny;
    if (typeof config.ntfyUsername !== "string") config.ntfyUsername = DEFAULT_CONFIG.ntfyUsername;
    if (typeof config.ntfyPassword !== "string") config.ntfyPassword = DEFAULT_CONFIG.ntfyPassword;
    if (typeof config.notifyOnStop !== "boolean") config.notifyOnStop = DEFAULT_CONFIG.notifyOnStop;
    return config;
  } catch (err) {
    if (err.code === "ENOENT") {
      return { ...DEFAULT_CONFIG };
    }
    throw err;
  }
}

export function saveConfig(config, configPath = CONFIG_PATH) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
}

export function generateTopic() {
  return `cra-${crypto.randomBytes(16).toString("hex")}`;
}

export function resolveAuth(config, env = process.env) {
  // Take the credential PAIR from a single source. Env wins as a whole when it
  // provides a username, so we never mix an env username with a file password
  // (which would silently produce a bogus pair). Presence of NTFY_USERNAME is
  // the switch; the password then also comes from env.
  const useEnv = !!env.NTFY_USERNAME;
  const username = useEnv ? env.NTFY_USERNAME : (config.ntfyUsername || "");
  const password = useEnv ? (env.NTFY_PASSWORD || "") : (config.ntfyPassword || "");
  if (!username || !password) return null;
  return { username, password };
}
