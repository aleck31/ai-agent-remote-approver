import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Returns true if the entry belongs to this tool (its hook command contains our
 * name). Used to find/replace/remove only our own hook entries.
 */
function isCraEntry(entry) {
  const marks = ["remote-approver"];
  const hit = (s) => typeof s === "string" && marks.some((m) => s.includes(m));
  if (entry.hooks?.some((h) => hit(h.command))) return true;
  if (hit(entry.command)) return true;
  return false;
}

const BIN_NAME = "remote-approver";

/**
 * True if `remote-approver` is resolvable on $PATH (installed globally via
 * `npm i -g` / `npm link`). Injectable for tests.
 */
export function isGloballyInstalled(env = process.env) {
  const dirs = (env.PATH || "").split(path.delimiter).filter(Boolean);
  return dirs.some((d) => {
    try {
      return fs.existsSync(path.join(d, BIN_NAME));
    } catch {
      return false;
    }
  });
}

/**
 * The hook command Claude Code will run per event.
 *
 * Prefers the stable global command `remote-approver hook` when the tool
 * is installed on $PATH — that survives the repo being moved/renamed/deleted.
 * Falls back to `node "<abs>/bin/cli.mjs" hook` for a not-yet-installed checkout
 * (dev use); note this absolute path breaks if the repo later moves, so install
 * globally (`npm link`) for a durable hook.
 */
export function getHookCommand({ globallyInstalled = isGloballyInstalled() } = {}) {
  if (globallyInstalled) {
    return `${BIN_NAME} hook`;
  }
  const cliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "cli.mjs");
  if (!fs.existsSync(cliPath)) {
    throw new Error(`CLI entry point not found: ${cliPath}`);
  }
  return `node "${cliPath}" hook`;
}

/**
 * Registers our hook command under settings.hooks[event]. Creates the file if
 * it does not exist. Preserves all existing settings and hooks. Idempotent:
 * replaces our own entry in place if already present.
 */
function registerForEvent(settingsPath, event, hookCommand) {
  let settings = {};

  try {
    const raw = fs.readFileSync(settingsPath, "utf-8");
    settings = JSON.parse(raw);
  } catch (err) {
    if (err.code !== "ENOENT") {
      throw err;
    }
  }

  if (!settings.hooks) {
    settings.hooks = {};
  }

  if (!Array.isArray(settings.hooks[event])) {
    settings.hooks[event] = [];
  }

  const existingIndex = settings.hooks[event].findIndex(isCraEntry);
  const hookEntry = { hooks: [{ type: "command", command: hookCommand }] };

  if (existingIndex >= 0) {
    settings.hooks[event][existingIndex] = hookEntry;
  } else {
    settings.hooks[event].push(hookEntry);
  }

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

/**
 * Removes our hook entry from settings.hooks[event]. No-op if file/event absent.
 */
function unregisterForEvent(settingsPath, event) {
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
  } catch (err) {
    if (err.code === "ENOENT") return;
    throw err;
  }

  if (!settings.hooks?.[event]) return;

  const original = settings.hooks[event];
  const filtered = original.filter((entry) => !isCraEntry(entry));

  if (filtered.length === original.length) return;

  if (filtered.length === 0) {
    delete settings.hooks[event];
  } else {
    settings.hooks[event] = filtered;
  }

  if (Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
  }

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

/**
 * Registers the PermissionRequest hook in Claude's settings.json.
 * Creates the file if it does not exist. Preserves all existing settings and hooks.
 */
export function registerHook(settingsPath, hookCommand) {
  registerForEvent(settingsPath, "PermissionRequest", hookCommand);
}

/**
 * Removes the PermissionRequest hook entry from Claude's settings.json.
 * If the file does not exist, does nothing.
 */
export function unregisterHook(settingsPath) {
  unregisterForEvent(settingsPath, "PermissionRequest");
}

/**
 * Registers/removes the Stop hook (completion notification). Same command as the
 * PermissionRequest hook; the handler no-ops unless config.notifyOnStop is true.
 */
export function registerStopHook(settingsPath, hookCommand) {
  registerForEvent(settingsPath, "Stop", hookCommand);
}

export function unregisterStopHook(settingsPath) {
  unregisterForEvent(settingsPath, "Stop");
}

/**
 * Runs first-time configuration only (no hook registration):
 * 1. Generate a topic
 * 2. Set ntfyServer / auth from `opts` (non-interactive) or prompt for them
 * 3. Save the config
 * Hook registration is a separate concern — run `enable` after this.
 *
 * Non-interactive (agent/script friendly): pass `opts.server` / `opts.username`
 * / `opts.password` and it won't prompt. Interactive: pass `prompt`/`promptSecret`
 * and omit those opts. If neither is available for a field, the default stands.
 *
 * @param {object} deps
 * @param {{ server?: string, username?: string, password?: string, interactive?: boolean }} [opts]
 * @returns {{ topic, ntfyServer, configPath }}
 */
export async function runInit({
  configPath,
  generateTopic,
  saveConfig,
  loadConfig,
  prompt,
  promptSecret,
}, opts = {}) {
  const topic = generateTopic();

  const config = loadConfig(configPath);
  config.topic = topic;

  // ntfy server: explicit flag wins; else keep whatever loadConfig had (default
  // or pre-written). Interactive mode may also ask.
  if (typeof opts.server === "string" && opts.server) {
    config.ntfyServer = opts.server;
  }

  // Auth: flags take precedence and imply non-interactive. Otherwise prompt
  // (only when a prompt fn is provided AND opts.interactive isn't false).
  if (opts.username != null || opts.password != null) {
    if (opts.username != null) config.ntfyUsername = opts.username;
    if (opts.password != null) config.ntfyPassword = opts.password;
  } else if (prompt && opts.interactive !== false) {
    if (typeof opts.server !== "string") {
      const server = await prompt(`ntfy server URL (blank = ${config.ntfyServer}): `);
      if (server?.trim()) config.ntfyServer = server.trim();
    }
    const useAuth = await prompt("Use authenticated topics? (only for self-hosted ntfy servers) (y/n): ");
    if (useAuth?.toLowerCase() === "y") {
      config.ntfyUsername = await prompt("Username: ");
      const promptSecretFn = promptSecret || prompt;
      config.ntfyPassword = await promptSecretFn("Password: ");
    }
  }

  saveConfig(config, configPath);

  return { topic, ntfyServer: config.ntfyServer, configPath };
}
