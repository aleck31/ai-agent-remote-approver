/**
 * Test suite for src/ntfy.mjs — formatting functions
 *
 * Coverage:
 * - formatToolInfo (basic + rich enrichment + title prefixing)
 * - sessionTag
 * - formatStopNotification
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatToolInfo, PRIORITY, sessionTag, formatStopNotification } from "../src/ntfy.mjs";

// ---------------------------------------------------------------------------
// formatToolInfo
// ---------------------------------------------------------------------------

describe("formatToolInfo", () => {
  it("should be a function exported from the module", () => {
    assert.equal(typeof formatToolInfo, "function");
  });

  it("should return an object with title and message properties", () => {
    const result = formatToolInfo({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls -la" },
    });

    assert.ok(
      typeof result === "object" && result !== null,
      "should return an object"
    );
    assert.ok("title" in result, "result should have a title property");
    assert.ok("message" in result, "result should have a message property");
  });

  it("should include the tool name in the title", () => {
    const result = formatToolInfo({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "echo hello" },
    });

    assert.ok(
      result.title.includes("Bash"),
      `Title should include tool name "Bash", got: "${result.title}"`
    );
  });

  it("should format Bash tool input showing the command", () => {
    const result = formatToolInfo({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "npm install express" },
    });

    assert.ok(
      result.message.includes("npm install express"),
      `Message should include the command, got: "${result.message}"`
    );
  });

  it("should format Read tool input showing the file path", () => {
    const result = formatToolInfo({
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      tool_input: { file_path: "/home/user/project/src/index.ts" },
    });

    assert.ok(
      result.message.includes("/home/user/project/src/index.ts"),
      `Message should include the file path, got: "${result.message}"`
    );
  });

  it("should format Write tool input showing the file path", () => {
    const result = formatToolInfo({
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: {
        file_path: "/home/user/project/config.json",
        content: '{ "key": "value" }',
      },
    });

    assert.ok(
      result.message.includes("/home/user/project/config.json"),
      `Message should include the file path, got: "${result.message}"`
    );
  });

  it("should return string values for both title and message", () => {
    const result = formatToolInfo({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "pwd" },
    });

    assert.equal(typeof result.title, "string", "title should be a string");
    assert.equal(typeof result.message, "string", "message should be a string");
  });

  it("should handle Bash tool input with missing command property", () => {
    const result = formatToolInfo({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { description: "no command here" },
    });

    assert.equal(typeof result.message, "string");
    // Should fall back to JSON.stringify since command is undefined
    assert.ok(
      result.message.includes("no command here"),
      `Message should contain the stringified toolInput, got: "${result.message}"`
    );
  });

  it("should handle Read tool input with missing file_path property", () => {
    const result = formatToolInfo({
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      tool_input: { content: "some content" },
    });

    assert.equal(typeof result.message, "string");
    // Should fall back to JSON.stringify since file_path is undefined
    assert.ok(
      result.message.includes("some content"),
      `Message should contain the stringified toolInput, got: "${result.message}"`
    );
  });

  it("should handle Edit tool input with missing file_path property", () => {
    const result = formatToolInfo({
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: { old_string: "foo", new_string: "bar" },
    });

    assert.equal(typeof result.message, "string");
    // Should fall back to JSON.stringify since file_path is undefined
    assert.ok(
      result.message.includes("foo"),
      `Message should contain the stringified toolInput, got: "${result.message}"`
    );
  });

  it("should handle unknown tool names gracefully", () => {
    const result = formatToolInfo({
      hook_event_name: "PreToolUse",
      tool_name: "UnknownTool",
      tool_input: { some: "data" },
    });

    assert.ok(
      typeof result === "object" && result !== null,
      "should still return an object"
    );
    assert.equal(typeof result.title, "string");
    assert.equal(typeof result.message, "string");
  });

  // ==================== Plan Approval Notification ====================

  it("should return title 'Claude Code: Plan Review' when tool_input contains a plan field", () => {
    const result = formatToolInfo({
      hook_event_name: "PermissionRequest",
      tool_name: "ExitPlanMode",
      tool_input: { plan: "# My Plan\n\n## Steps\n1. Do something" },
    });

    assert.equal(
      result.title,
      "Claude Code: Plan Review",
      `Title should be "Claude Code: Plan Review" for plan inputs, got: "${result.title}"`
    );
  });

  it("should strip markdown headers from plan text in the message", () => {
    const result = formatToolInfo({
      hook_event_name: "PermissionRequest",
      tool_name: "ExitPlanMode",
      tool_input: {
        plan: "# My Plan\n\n## Context\nSome context here\n\n## Steps\n1. First step",
      },
    });

    assert.ok(
      !result.message.includes("#"),
      `Message should not contain markdown "#" headers, got: "${result.message}"`
    );
    assert.ok(
      result.message.includes("My Plan"),
      `Message should contain plan title text, got: "${result.message}"`
    );
    assert.ok(
      result.message.includes("Some context here"),
      `Message should contain plan body text, got: "${result.message}"`
    );
  });

  it("should truncate plan text to 1000 characters and append '...' when it exceeds the limit", () => {
    const longPlan = "# Plan\n\n" + "A".repeat(1500);
    const result = formatToolInfo({
      hook_event_name: "PermissionRequest",
      tool_name: "ExitPlanMode",
      tool_input: { plan: longPlan },
    });

    assert.ok(
      result.message.length <= 1003,
      `Message should be at most 1003 characters (1000 + "..."), got length: ${result.message.length}`
    );
    assert.ok(
      result.message.length > 303,
      `Message should use 1000-char limit (not old 300-char limit), got length: ${result.message.length}`
    );
    assert.ok(
      result.message.endsWith("..."),
      `Message should end with "..." when truncated, got: "${result.message.slice(-10)}"`
    );
  });

  it("should truncate long Bash command to 1000 characters and append '...'", () => {
    const longCommand = "x".repeat(1500);
    const result = formatToolInfo({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: longCommand },
    });

    assert.ok(
      result.message.length <= 1003,
      `Message should be at most 1003 characters (1000 + "..."), got length: ${result.message.length}`
    );
    assert.ok(
      result.message.endsWith("..."),
      `Message should end with "..." when truncated`
    );
  });

  it("should not truncate messages shorter than 1000 characters", () => {
    const shortCommand = "x".repeat(500);
    const result = formatToolInfo({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: shortCommand },
    });

    assert.equal(
      result.message,
      shortCommand,
      "Short messages should not be truncated"
    );
  });

  it("should not truncate a message that is exactly 1000 characters", () => {
    const exactCommand = "x".repeat(1000);
    const result = formatToolInfo({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: exactCommand },
    });
    assert.equal(
      result.message,
      exactCommand,
      "Exactly 1000-char message should not be truncated"
    );
  });

  it("should truncate long messages from unknown tools via default branch", () => {
    const largeInput = { data: "y".repeat(1500) };
    const result = formatToolInfo({
      hook_event_name: "PreToolUse",
      tool_name: "UnknownTool",
      tool_input: largeInput,
    });
    assert.ok(
      result.message.length <= 1003,
      `Message should be at most 1003 characters (1000 + "..."), got length: ${result.message.length}`
    );
    assert.ok(
      result.message.endsWith("..."),
      "Message should end with '...' when truncated"
    );
  });

  // ==================== Plan Detection Edge Cases ====================

  it("should not crash when tool_input.plan is a non-string truthy value", () => {
    const result = formatToolInfo({
      hook_event_name: 'PermissionRequest',
      tool_name: 'ExitPlanMode',
      tool_input: { plan: true },
    });
    assert.equal(typeof result.title, "string");
    assert.equal(typeof result.message, "string");
    // Should NOT be "Claude Code: Plan Review" since plan is not a string
    assert.ok(!result.title.includes("Plan Review"), `Non-string plan should not trigger plan detection, got: "${result.title}"`);
  });

  it("should not crash when tool_input.plan is a number", () => {
    const result = formatToolInfo({
      hook_event_name: 'PermissionRequest',
      tool_name: 'ExitPlanMode',
      tool_input: { plan: 42 },
    });
    assert.equal(typeof result.title, "string");
    assert.equal(typeof result.message, "string");
  });

  it("should return a fallback message when plan is an empty string", () => {
    const result = formatToolInfo({
      hook_event_name: 'PermissionRequest',
      tool_name: 'ExitPlanMode',
      tool_input: { plan: '' },
    });
    assert.equal(result.title, "Claude Code: Plan Review");
    assert.equal(result.message, "(empty plan)");
  });

  it("should not trigger plan detection for non-ExitPlanMode tools with a plan field", () => {
    const result = formatToolInfo({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'echo test', plan: 'some field' },
    });
    assert.equal(result.title, "Claude Code: Bash");
    assert.ok(result.message.includes("echo test"), `Should format as Bash command, got: "${result.message}"`);
  });

  // ==================== Markdown Stripping Edge Cases ====================

  it("should return '(empty plan)' when plan contains only markdown headers", () => {
    const result = formatToolInfo({
      hook_event_name: 'PermissionRequest',
      tool_name: 'ExitPlanMode',
      tool_input: { plan: '# \n## \n### ' },
    });
    assert.equal(result.title, "Claude Code: Plan Review");
    assert.equal(result.message, "(empty plan)");
  });
});

// ---------------------------------------------------------------------------
// formatToolInfo — rich enrichment cherry-picked from claude-ntfy-hook
// ---------------------------------------------------------------------------

describe("formatToolInfo (rich enrichment)", () => {
  it("should attach a numeric priority and emoji tags to every result", () => {
    const result = formatToolInfo({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls" },
    });
    assert.equal(typeof result.priority, "number");
    assert.ok(result.priority >= 1 && result.priority <= 5);
    assert.ok(Array.isArray(result.tags) && result.tags.length > 0);
  });

  it("should prepend the Bash description when present", () => {
    const result = formatToolInfo({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "rm -rf build", description: "Clean build dir" },
    });
    assert.ok(result.message.includes("Clean build dir"));
    assert.ok(result.message.includes("rm -rf build"));
  });

  it("should render Edit as a diff with old and new strings", () => {
    const result = formatToolInfo({
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: { file_path: "/a/b.ts", old_string: "foo", new_string: "bar" },
    });
    assert.ok(result.message.includes("/a/b.ts"));
    assert.ok(result.message.includes("- foo"));
    assert.ok(result.message.includes("+ bar"));
  });

  it("should show line count for Write", () => {
    const result = formatToolInfo({
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: "/a/c.json", content: "line1\nline2\nline3" },
    });
    assert.ok(result.message.includes("/a/c.json"));
    assert.ok(result.message.includes("3 lines"));
  });

  it("should use the clipboard tag and default priority for Plan Review", () => {
    const result = formatToolInfo({
      hook_event_name: "PermissionRequest",
      tool_name: "ExitPlanMode",
      tool_input: { plan: "# Plan\nDo it" },
    });
    assert.deepEqual(result.tags, ["clipboard"]);
    assert.equal(result.priority, PRIORITY.default);
  });
});

// ---------------------------------------------------------------------------
// sessionTag + title prefixing (concurrent session distinction)
// ---------------------------------------------------------------------------

describe("sessionTag", () => {
  it("returns empty string when no cwd/session_id", () => {
    assert.equal(sessionTag({}), "");
    assert.equal(sessionTag(), "");
  });

  it("uses the basename of cwd", () => {
    assert.equal(sessionTag({ cwd: "/Users/alex/playground/ai-stack" }), "ai-stack");
  });

  it("appends a short session_id with a middle dot", () => {
    assert.equal(
      sessionTag({ cwd: "/a/b/myproj", session_id: "abcdef123456" }),
      "myproj\u00b7abcdef"
    );
  });

  it("handles session_id only", () => {
    assert.equal(sessionTag({ session_id: "abcdef123456" }), "abcdef");
  });
});

describe("formatToolInfo title prefixing", () => {
  it("prefixes the title with [project·sid] when cwd/session_id present", () => {
    const result = formatToolInfo({
      hook_event_name: "PermissionRequest",
      tool_name: "Bash",
      tool_input: { command: "ls" },
      cwd: "/home/u/ai-stack",
      session_id: "abcdef123456",
    });
    assert.equal(result.title, "[ai-stack\u00b7abcdef] Claude Code: Bash");
  });

  it("leaves the title unprefixed when no session context", () => {
    const result = formatToolInfo({
      hook_event_name: "PermissionRequest",
      tool_name: "Bash",
      tool_input: { command: "ls" },
    });
    assert.equal(result.title, "Claude Code: Bash");
  });

  it("prefixes the Plan Review title too", () => {
    const result = formatToolInfo({
      hook_event_name: "PermissionRequest",
      tool_name: "ExitPlanMode",
      tool_input: { plan: "# Plan" },
      cwd: "/x/proj",
    });
    assert.equal(result.title, "[proj] Claude Code: Plan Review");
  });
});

// ---------------------------------------------------------------------------
// formatStopNotification (completion notification)
// ---------------------------------------------------------------------------

describe("formatStopNotification", () => {
  it("prefixes title with session tag and uses last_assistant_message as body", () => {
    const r = formatStopNotification({
      cwd: "/home/u/ai-stack",
      session_id: "abcdef123456",
      last_assistant_message: "All done. Refactored auth.",
    });
    assert.equal(r.title, "[ai-stack\u00b7abcdef] Claude \u5e72\u5b8c\u4e86");
    assert.equal(r.message, "All done. Refactored auth.");
    assert.deepEqual(r.tags, ["white_check_mark"]);
    assert.equal(r.priority, PRIORITY.default);
  });

  it("falls back to 'Task complete.' when no message", () => {
    const r = formatStopNotification({ cwd: "/x/proj" });
    assert.equal(r.title, "[proj] Claude \u5e72\u5b8c\u4e86");
    assert.equal(r.message, "Task complete.");
  });

  it("clips a long message to 403 chars with ellipsis", () => {
    const r = formatStopNotification({ last_assistant_message: "y".repeat(600) });
    assert.ok(r.message.length <= 403);
    assert.ok(r.message.endsWith("..."));
  });

  it("has no session prefix when cwd/session_id absent", () => {
    const r = formatStopNotification({ last_assistant_message: "hi" });
    assert.equal(r.title, "Claude \u5e72\u5b8c\u4e86");
  });
});
