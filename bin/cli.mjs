#!/usr/bin/env node

/**
 * CLI entry point for remote-approver.
 *
 * Subcommands: init | enable | disable | test | status | uninstall | hook
 * All I/O goes through the injected `deps` object so the module is fully testable.
 */

import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import qrcode from "qrcode-terminal";
import { ASK } from "../src/adapters/claude-code.mjs";

const USAGE =
  "Usage: remote-approver <command>\n\nCommands:\n  init        Generate a topic and write config (no hook)\n              flags (non-interactive): --server <url> --user <name> --password <pw> [--no-input]\n  enable      Register the hooks\n  disable     Remove the hooks (keeps config)\n  test        Send a test notification (add --wait to verify the round trip)\n  status      Show current configuration\n  uninstall   Remove hooks and delete configuration\n  hook        Process a Claude Code hook (internal)\n";

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

export async function main(args, deps) {
  if (args.includes("--help") || args.includes("-h")) {
    deps.stdout.write(USAGE);
    return;
  }
  if (args.includes("--version") || args.includes("-v")) {
    deps.stdout.write(`${deps.version}\n`);
    return;
  }

  const command = args[0];

  switch (command) {
    case "init": {
      // Flags for non-interactive / scripted setup (agent-friendly):
      //   --server <url> --user <name> --password <pw>   (or --no-input)
      const flag = (name) => {
        const i = args.indexOf(name);
        return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
      };
      const server = flag("--server");
      const username = flag("--user");
      const password = flag("--password");
      // Non-interactive when any flag is given, --no-input is passed, or stdin isn't a TTY.
      const anyFlag = server !== undefined || username !== undefined || password !== undefined;
      const nonInteractive = anyFlag || args.includes("--no-input") || deps.isTTY === false;

      const opts = { server, username, password, interactive: !nonInteractive };
      const result = await deps.runInit(deps, opts);
      deps.stdout.write(`Config initialized. Topic: ${result.topic}\n\n`);

      try {
        const serverUrl = new URL(result.ntfyServer);
        const isHttps = serverUrl.protocol === "https:";
        const ntfyUrl = isHttps
          ? `ntfy://${serverUrl.host}/${result.topic}`
          : `ntfy://${serverUrl.host}/${result.topic}?secure=false`;
        const subscribeUrl = `${result.ntfyServer.replace(/\/+$/, "")}/${result.topic}`;

        deps.stdout.write("Scan this QR code in the ntfy app to subscribe:\n\n");
        // qrcode-terminal invokes the callback synchronously
        deps.generateQR(ntfyUrl, { small: true }, (qrString) => {
          deps.stdout.write(qrString + "\n\n");
          deps.stdout.write(`Subscribe URL: ${subscribeUrl}\n`);
        });
      } catch {
        deps.stderr.write(`Warning: Invalid ntfyServer URL in config: ${result.ntfyServer}\n`);
        deps.stdout.write(`Subscribe to topic "${result.topic}" in the ntfy app.\n`);
      }

      deps.stdout.write("\nNext: run 'remote-approver enable' to register the hooks.\n");
      break;
    }

    case "test": {
      const config = deps.loadConfig();
      if (!config.topic) {
        deps.stderr.write("Error: No topic configured. Run 'remote-approver init' first.\n");
        break;
      }
      const auth = deps.resolveAuth(config);

      // `--wait` verifies the full round trip (publish → push → tap → SSE),
      // not just that the publish returned 200. It blocks on an "Ack" button.
      if (args.includes("--wait")) {
        const requestId = deps.randomUUID();
        const authHeaders = auth ? deps.buildAuthHeader(auth) : undefined;
        const actions = [{
          action: "http",
          label: "Ack",
          url: `${config.ntfyServer}/${config.topic}-response`,
          body: JSON.stringify({ requestId, answer: "ack" }),
          method: "POST",
          ...(authHeaders && { headers: authHeaders }),
        }];
        try {
          const response = await deps.waitForResponse({
            server: config.ntfyServer,
            topic: config.topic,
            requestId,
            timeout: config.timeout * 1000,
            ...(auth && { auth }),
            onReady: () => deps.sendNotification({
              server: config.ntfyServer,
              topic: config.topic,
              title: "Claude Remote Approver",
              message: "Round-trip test — tap Ack to confirm delivery.",
              actions,
              requestId,
              auth,
            }),
          });
          if (response?.answer || response?.approved) {
            deps.stdout.write("Round-trip OK — the Ack reached this machine.\n");
          } else {
            deps.stdout.write(`No Ack received (${response?.timeout ? "timed out" : "no response"}). The push may not have reached your phone, or you didn't tap Ack.\n`);
          }
        } catch (err) {
          deps.stderr.write(`Error: Round-trip test failed: ${err.message}\n`);
        }
        break;
      }

      try {
        await deps.sendNotification({
          server: config.ntfyServer,
          topic: config.topic,
          title: "Claude Remote Approver",
          message: "Test notification — if you see this, it works!",
          actions: [],
          requestId: "test",
          auth,
        });
        deps.stdout.write("Test notification sent successfully.\n");
        deps.stdout.write("Tip: run 'remote-approver test --wait' to verify the full round trip (tap a button on your phone).\n");
      } catch (err) {
        deps.stderr.write(`Error: Failed to send notification: ${err.message}\n`);
      }
      break;
    }

    case "status": {
      const config = deps.loadConfig();
      deps.stdout.write(`Topic:   ${config.topic}\n`);
      deps.stdout.write(`Server:  ${config.ntfyServer}\n`);
      deps.stdout.write(`Timeout: ${config.timeout}s\n`);
      const auth = deps.resolveAuth(config);
      if (auth) {
        deps.stdout.write(`Auth:    configured (username: ${auth.username})\n`);
      } else {
        deps.stdout.write(`Auth:    not configured\n`);
      }
      break;
    }

    case "hook": {
      let input;
      try {
        input = JSON.parse(deps.stdin);
      } catch {
        deps.stderr.write("[remote-approver] Invalid hook input. Falling back to CLI.\n");
        deps.stdout.write(JSON.stringify(ASK) + "\n");
        break;
      }

      let result;
      try {
        result = await deps.processHook(input, deps);
      } catch {
        deps.stderr.write("[remote-approver] Hook processing failed. Falling back to CLI.\n");
        deps.stdout.write(JSON.stringify(ASK) + "\n");
        break;
      }

      deps.stdout.write(JSON.stringify(result) + "\n");
      break;
    }

    case "uninstall": {
      try {
        deps.unregisterHook(deps.settingsPath);
        if (deps.unregisterStopHook) deps.unregisterStopHook(deps.settingsPath);
      } catch (err) {
        deps.stderr.write(`Error: Failed to remove hook: ${err.message}\n`);
        break;
      }
      try {
        deps.unlinkSync(deps.configPath);
      } catch (err) {
        if (err.code !== "ENOENT") {
          deps.stderr.write(`Error: Failed to delete config: ${err.message}\n`);
          break;
        }
      }
      deps.stdout.write("Uninstalled. Hook removed and configuration deleted.\n");
      break;
    }

    case "disable": {
      try {
        deps.unregisterHook(deps.settingsPath);
        if (deps.unregisterStopHook) deps.unregisterStopHook(deps.settingsPath);
      } catch (err) {
        deps.stderr.write(`Error: Failed to disable hook: ${err.message}\n`);
        break;
      }
      deps.stdout.write("Hook disabled. Run 'remote-approver enable' to re-enable.\n");
      break;
    }

    case "enable": {
      const config = deps.loadConfig();
      if (!config.topic) {
        deps.stderr.write("Error: No topic configured. Run 'remote-approver init' first.\n");
        deps.exit(1);
        break;
      }
      try {
        deps.registerHook(deps.settingsPath, deps.getHookCommand());
        if (deps.registerStopHook) deps.registerStopHook(deps.settingsPath, deps.getHookCommand());
      } catch (err) {
        deps.stderr.write(`Error: Failed to enable hook: ${err.message}\n`);
        break;
      }
      deps.stdout.write("Hook enabled.\n");
      break;
    }

    default: {
      deps.stderr.write(USAGE);
      deps.exit(1);
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Auto-execute when run directly (not imported)
// ---------------------------------------------------------------------------

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] &&
  (() => {
    try {
      return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1]);
    } catch {
      return false;
    }
  })();

if (isMain) {
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf-8"));

  const { loadConfig, saveConfig, generateTopic, resolveAuth } = await import(
    "../src/config.mjs"
  );
  const { sendNotification, waitForResponse, formatToolInfo, buildAuthHeader } = await import(
    "../src/ntfy.mjs"
  );
  const { randomUUID } = await import("node:crypto");
  const { processHook } = await import("../src/adapters/claude-code.mjs");
  const { runInit, registerHook, getHookCommand, unregisterHook, registerStopHook, unregisterStopHook } = await import("../src/hooks.mjs");

  const args = process.argv.slice(2);

  let stdinData = "";
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    stdinData = Buffer.concat(chunks).toString("utf-8");
  }

  const deps = {
    loadConfig,
    saveConfig,
    generateTopic,
    resolveAuth,
    sendNotification,
    updateNotification: sendNotification,
    waitForResponse,
    formatToolInfo,
    buildAuthHeader,
    randomUUID,
    processHook,
    runInit,
    registerHook,
    getHookCommand,
    unregisterHook,
    registerStopHook,
    unregisterStopHook,
    version: pkg.version,
    generateQR: (text, opts, cb) => qrcode.generate(text, opts, cb),
    unlinkSync: fs.unlinkSync,
    configPath: (await import("../src/config.mjs")).CONFIG_PATH,
    settingsPath: path.join(os.homedir(), ".claude", "settings.json"),
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: stdinData,
    isTTY: process.stdin.isTTY === true,
    exit: process.exit,
    prompt: async (question) => {
      const { createInterface } = await import("node:readline");
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); resolve(answer); }));
    },
    promptSecret: async (question) => {
      process.stdout.write(question);
      return new Promise((resolve) => {
        let input = '';
        process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.setEncoding('utf8');
        const onData = (ch) => {
          if (ch === '\r' || ch === '\n') {
            process.stdin.setRawMode(false);
            process.stdin.pause();
            process.stdin.removeListener('data', onData);
            process.stdout.write('\n');
            resolve(input);
          } else if (ch === '\u007f' || ch === '\b') {
            if (input.length > 0) {
              input = input.slice(0, -1);
              process.stdout.write('\b \b');
            }
          } else if (ch === '\u0003') {
            process.exit(0);
          } else {
            input += ch;
            process.stdout.write('*');
          }
        };
        process.stdin.on('data', onData);
      });
    },
  };

  await main(args, deps);
}
