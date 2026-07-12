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

  it("should include the tool name in the message subtitle", () => {
    const result = formatToolInfo({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "echo hello" },
    });

    // Tool name moved out of the plain-text title into the card subtitle (in message).
    assert.ok(
      result.message.includes("Bash"),
      `Message should include tool name "Bash", got: "${result.message}"`
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

  it("should label the card 'Plan Review' when tool_input contains a plan field", () => {
    const result = formatToolInfo({
      hook_event_name: "PermissionRequest",
      tool_name: "ExitPlanMode",
      tool_input: { plan: "# My Plan\n\n## Steps\n1. Do something" },
    });

    // The "Plan Review" label lives in the card subtitle (and message), not the title.
    assert.equal(
      result.subtitle,
      "Claude Code: `Plan Review`",
      `Subtitle should be "Claude Code: \`Plan Review\`" for plan inputs, got: "${result.subtitle}"`
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

    // The card subtitle uses a "####" heading, so assert on the plan body preview
    // (result.body), which is the plan text after markdown stripping.
    assert.ok(
      !result.body.includes("#"),
      `Plan body should not contain markdown "#" headers, got: "${result.body}"`
    );
    assert.ok(
      result.body.includes("My Plan"),
      `Body should contain plan title text, got: "${result.body}"`
    );
    assert.ok(
      result.body.includes("Some context here"),
      `Body should contain plan body text, got: "${result.body}"`
    );
  });

  it("should truncate plan text to 1000 characters and append '...' when it exceeds the limit", () => {
    const longPlan = "# Plan\n\n" + "A".repeat(1500);
    const result = formatToolInfo({
      hook_event_name: "PermissionRequest",
      tool_name: "ExitPlanMode",
      tool_input: { plan: longPlan },
    });

    // Clip is applied to the body (the card header adds a fixed prefix in message).
    assert.ok(
      result.body.length <= 1003,
      `Body should be at most 1003 characters (1000 + "..."), got length: ${result.body.length}`
    );
    assert.ok(
      result.body.length > 303,
      `Body should use 1000-char limit (not old 300-char limit), got length: ${result.body.length}`
    );
    assert.ok(
      result.body.endsWith("..."),
      `Body should end with "..." when truncated, got: "${result.body.slice(-10)}"`
    );
  });

  it("should clip a long Bash command to 300 chars (inside a code fence) and append '...'", () => {
    const longCommand = "x".repeat(1500);
    const result = formatToolInfo({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: longCommand },
    });

    // Command is fenced; the clipped preview is 300 chars + "..." between the fences.
    assert.ok(result.body.startsWith("```\n") && result.body.endsWith("\n```"), `should be fenced, got: ${result.body.slice(0, 12)}…`);
    const fenced = result.body.slice(4, -4);
    assert.equal(fenced, "x".repeat(300) + "...", "command body should be clipped to 300 chars + ...");
  });

  it("should fence a short Bash command without clipping", () => {
    const shortCommand = "echo hello";
    const result = formatToolInfo({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: shortCommand },
    });

    assert.equal(result.body, "```\n" + shortCommand + "\n```", "short command should be fenced verbatim");
  });

  it("should render a leading '#' in a Bash command literally (fenced), not as an H1", () => {
    const result = formatToolInfo({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "# cleanup\nrm -rf build/*" },
    });
    // The '#' and '*' survive verbatim inside the fence.
    assert.ok(result.body.includes("# cleanup"), "comment line preserved");
    assert.ok(result.body.includes("rm -rf build/*"), "glob preserved");
    assert.ok(result.body.startsWith("```\n"), "wrapped in a code fence");
  });

  it("should widen the fence when the command itself contains a triple backtick", () => {
    const result = formatToolInfo({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "echo '```'" },
    });
    // A 3-backtick run inside forces a 4-backtick fence so the block isn't cut short.
    assert.ok(result.body.startsWith("````\n"), `expected a 4-backtick fence, got: ${result.body.slice(0, 6)}`);
    assert.ok(result.body.includes("```"), "inner triple backtick preserved");
  });

  it("should truncate long messages from unknown tools via default branch", () => {
    const largeInput = { data: "y".repeat(1500) };
    const result = formatToolInfo({
      hook_event_name: "PreToolUse",
      tool_name: "UnknownTool",
      tool_input: largeInput,
    });
    assert.ok(
      result.body.length <= 1003,
      `Body should be at most 1003 characters (1000 + "..."), got length: ${result.body.length}`
    );
    assert.ok(
      result.body.endsWith("..."),
      "Body should end with '...' when truncated"
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
    assert.equal(result.subtitle, "Claude Code: `Plan Review`");
    assert.equal(result.body, "(empty plan)");
  });

  it("should not trigger plan detection for non-ExitPlanMode tools with a plan field", () => {
    const result = formatToolInfo({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'echo test', plan: 'some field' },
    });
    assert.equal(result.subtitle, "Claude Code: `Bash`");
    assert.ok(result.message.includes("echo test"), `Should format as Bash command, got: "${result.message}"`);
  });

  // ==================== Markdown Stripping Edge Cases ====================

  it("should return '(empty plan)' when plan contains only markdown headers", () => {
    const result = formatToolInfo({
      hook_event_name: 'PermissionRequest',
      tool_name: 'ExitPlanMode',
      tool_input: { plan: '# \n## \n### ' },
    });
    assert.equal(result.subtitle, "Claude Code: `Plan Review`");
    assert.equal(result.body, "(empty plan)");
  });
});

// ---------------------------------------------------------------------------
// formatToolInfo — rich enrichment cherry-picked from claude-ntfy-hook
// ---------------------------------------------------------------------------

describe("formatToolInfo (rich enrichment)", () => {
  it("should attach a numeric priority and NOT emit ntfy tags (emoji is the state, added by the caller)", () => {
    const result = formatToolInfo({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls" },
    });
    assert.equal(typeof result.priority, "number");
    assert.ok(result.priority >= 1 && result.priority <= 5);
    assert.ok(!("tags" in result), "formatToolInfo must not emit tags (would render a second emoji)");
    // Title holds only the session tag (empty here); the tool name is in the subtitle.
    assert.equal(result.title, "");
    assert.equal(result.subtitle, "Claude Code: `Bash`");
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

  it("should use default priority and no tags for Plan Review", () => {
    const result = formatToolInfo({
      hook_event_name: "PermissionRequest",
      tool_name: "ExitPlanMode",
      tool_input: { plan: "# Plan\nDo it" },
    });
    assert.ok(!("tags" in result), "no tags emitted");
    assert.equal(result.subtitle, "Claude Code: `Plan Review`");
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
    // Title carries only the [proj\u00b7sid] tag now; the tool name is in the subtitle.
    assert.equal(result.title, "[ai-stack\u00b7abcdef]");
    assert.equal(result.subtitle, "Claude Code: `Bash`");
  });

  it("leaves the title empty when no session context", () => {
    const result = formatToolInfo({
      hook_event_name: "PermissionRequest",
      tool_name: "Bash",
      tool_input: { command: "ls" },
    });
    assert.equal(result.title, "");
    assert.equal(result.subtitle, "Claude Code: `Bash`");
  });

  it("prefixes the Plan Review title with the tag too", () => {
    const result = formatToolInfo({
      hook_event_name: "PermissionRequest",
      tool_name: "ExitPlanMode",
      tool_input: { plan: "# Plan" },
      cwd: "/x/proj",
    });
    assert.equal(result.title, "[proj]");
    assert.equal(result.subtitle, "Claude Code: `Plan Review`");
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
    // Title = \ud83c\udfc1 [proj\u00b7sid]; the "Claude Code: Done" label is the card subtitle in message.
    assert.equal(r.title, "\ud83c\udfc1 [ai-stack\u00b7abcdef]");
    assert.equal(r.message, "##### Claude Code: `Done`\n---\nAll done. Refactored auth.");
    assert.ok(!("tags" in r), "no tags emitted (\ud83c\udfc1 state emoji is in the title)");
    assert.equal(r.priority, PRIORITY.default);
  });

  it("falls back to 'Task complete.' when no message", () => {
    const r = formatStopNotification({ cwd: "/x/proj" });
    assert.equal(r.title, "\ud83c\udfc1 [proj]");
    assert.equal(r.message, "##### Claude Code: `Done`\n---\nTask complete.");
  });

  it("clips a long message body to 400 chars with ellipsis", () => {
    const r = formatStopNotification({ last_assistant_message: "y".repeat(600) });
    // The card header ("##### Claude Code: `Done`\n---\n") prefixes a body clipped to 400 + "...".
    const body = r.message.slice("##### Claude Code: `Done`\n---\n".length);
    assert.ok(body.length <= 403);
    assert.ok(body.endsWith("..."));
  });

  it("has no session prefix when cwd/session_id absent", () => {
    const r = formatStopNotification({ last_assistant_message: "hi" });
    assert.equal(r.title, "\ud83c\udfc1");
  });
});
