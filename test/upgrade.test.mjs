import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { compareVersions, fetchLatestRelease, assetUrl } from "../src/upgrade.mjs";
import { main } from "../bin/cli.mjs";

const writer = () => {
  const c = [];
  return { write: (s) => c.push(s), output: () => c.join("") };
};

function deps(over = {}) {
  return {
    version: "0.5.1",
    compareVersions,
    fetchLatestRelease: mock.fn(async () => ({ tag: "v0.6.0", version: "0.6.0", url: assetUrl("v0.6.0") })),
    loadConfig: mock.fn(() => ({ topic: "cra-x" })),
    run: mock.fn(() => {}),
    stdout: writer(),
    stderr: writer(),
    exit: mock.fn(() => {}),
    ...over,
  };
}

describe("compareVersions", () => {
  it("orders numerically, tolerates v prefix", () => {
    assert.equal(compareVersions("0.5.1", "0.5.1"), 0);
    assert.equal(compareVersions("v0.6.0", "0.5.9"), 1);
    assert.equal(compareVersions("0.5.10", "0.5.9"), 1);
    assert.equal(compareVersions("0.5", "0.5.1"), -1);
  });
});

describe("fetchLatestRelease", () => {
  it("maps tag to version and asset url", async () => {
    const f = async () => ({ ok: true, json: async () => ({ tag_name: "v1.2.3" }) });
    const r = await fetchLatestRelease(f, "o/r");
    assert.deepEqual(r, { tag: "v1.2.3", version: "1.2.3", url: "https://github.com/o/r/releases/download/v1.2.3/remote-approver.tgz" });
  });
  it("throws on HTTP error", async () => {
    await assert.rejects(fetchLatestRelease(async () => ({ ok: false, status: 404 })), /404/);
  });
});

describe("upgrade subcommand", () => {
  it("installs the new asset then re-runs enable via the new binary", async () => {
    const d = deps();
    await main(["upgrade"], d);
    assert.deepEqual(d.run.mock.calls.map((c) => c.arguments), [
      ["npm", ["install", "-g", assetUrl("v0.6.0")]],
      ["remote-approver", ["enable"]],
    ]);
    assert.match(d.stdout.output(), /0\.5\.1 -> 0\.6\.0/);
  });
  it("--check reports without installing", async () => {
    const d = deps();
    await main(["upgrade", "--check"], d);
    assert.equal(d.run.mock.callCount(), 0);
    assert.match(d.stdout.output(), /Update available/);
  });
  it("is a no-op when already latest", async () => {
    const d = deps({ version: "0.6.0" });
    await main(["upgrade"], d);
    assert.equal(d.run.mock.callCount(), 0);
    assert.match(d.stdout.output(), /up to date/);
  });
  it("skips enable when no topic is configured", async () => {
    const d = deps({ loadConfig: mock.fn(() => ({ topic: "" })) });
    await main(["upgrade"], d);
    assert.equal(d.run.mock.callCount(), 1);
  });
  it("exits 1 when the release check fails", async () => {
    const d = deps({ fetchLatestRelease: mock.fn(async () => { throw new Error("offline"); }) });
    await main(["upgrade"], d);
    assert.equal(d.exit.mock.calls[0].arguments[0], 1);
    assert.match(d.stderr.output(), /offline/);
  });
  it("exits 1 when npm install fails", async () => {
    const d = deps({ run: mock.fn(() => { throw new Error("EACCES"); }) });
    await main(["upgrade"], d);
    assert.equal(d.exit.mock.calls[0].arguments[0], 1);
  });
});

describe("enable upgrades config", () => {
  it("calls upgradeConfig and reports added fields", async () => {
    const d = deps({
      registerHook: () => {},
      getHookCommand: () => "x",
      settingsPath: "/s",
      configPath: "/c",
      upgradeConfig: mock.fn(() => ({ added: ["notify"] })),
    });
    await main(["enable"], d);
    assert.equal(d.upgradeConfig.mock.calls[0].arguments[0], "/c");
    assert.match(d.stdout.output(), /added notify/);
  });
});
