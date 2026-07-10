/**
 * Test suite for src/ntfy.mjs — stripMarkdown
 *
 * Coverage:
 * - stripMarkdown (all phases + edge cases)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { stripMarkdown } from "../src/ntfy.mjs";

// ---------------------------------------------------------------------------
// stripMarkdown
// ---------------------------------------------------------------------------

describe("stripMarkdown", () => {
  it("should be a function exported from the module", () => {
    assert.equal(typeof stripMarkdown, "function");
  });

  // ==================== Phase 1: Block-level ====================

  describe("Phase 1: Block-level regex removal", () => {
    it("should strip h1 headers", () => {
      assert.equal(stripMarkdown("# Header"), "Header");
    });

    it("should strip h2 through h6 headers", () => {
      assert.equal(stripMarkdown("## Header 2"), "Header 2");
      assert.equal(stripMarkdown("### Header 3"), "Header 3");
      assert.equal(stripMarkdown("#### Header 4"), "Header 4");
      assert.equal(stripMarkdown("##### Header 5"), "Header 5");
      assert.equal(stripMarkdown("###### Header 6"), "Header 6");
    });

    it("should strip unordered list markers (-, *, +)", () => {
      assert.equal(stripMarkdown("- Item one"), "Item one");
      assert.equal(stripMarkdown("* Item two"), "Item two");
      assert.equal(stripMarkdown("+ Item three"), "Item three");
    });

    it("should strip ordered list markers", () => {
      assert.equal(stripMarkdown("1. First"), "First");
      assert.equal(stripMarkdown("23. Twenty-third"), "Twenty-third");
    });

    it("should strip fenced code blocks with closing fence", () => {
      const input = "Before\n\n```javascript\nconsole.log('hello');\n```\n\nAfter";
      const result = stripMarkdown(input);
      assert.ok(!result.includes("```"), `Should not contain fence markers, got: "${result}"`);
      assert.ok(!result.includes("console.log"), `Should not contain code block content, got: "${result}"`);
      assert.ok(result.includes("Before"), `Should keep text before code block`);
      assert.ok(result.includes("After"), `Should keep text after code block`);
    });

    it("should strip unclosed fenced code blocks to end of string", () => {
      const input = "Before\n\n```python\nprint('leaked')\n# no closing fence";
      const result = stripMarkdown(input);
      assert.ok(!result.includes("```"), `Should not contain fence markers, got: "${result}"`);
      assert.ok(!result.includes("print"), `Should not contain code block content, got: "${result}"`);
      assert.ok(result.includes("Before"), `Should keep text before code block`);
    });

    it("should not process markdown syntax inside code blocks", () => {
      const input = "Text\n\n```\n# Not a header\n**not bold**\n[not a link](url)\n```\n\nEnd";
      const result = stripMarkdown(input);
      assert.ok(!result.includes("# Not a header"), `Code block content should be removed entirely, got: "${result}"`);
      assert.ok(!result.includes("**not bold**"), `Code block content should be removed entirely, got: "${result}"`);
      assert.ok(result.includes("Text"), `Should keep text before code block`);
      assert.ok(result.includes("End"), `Should keep text after code block`);
    });
  });

  // ==================== Phase 2: Inline-level ====================

  describe("Phase 2: Inline-level character-scanning parser", () => {
    it("should strip inline code backticks", () => {
      assert.equal(stripMarkdown("Use `code` here"), "Use code here");
    });

    it("should strip basic markdown links", () => {
      assert.equal(stripMarkdown("[text](url)"), "text");
    });

    it("should strip links with nested brackets in link text", () => {
      assert.equal(stripMarkdown("[text [inner]](url)"), "text [inner]");
    });

    it("should strip links with parentheses in URL", () => {
      assert.equal(
        stripMarkdown("[Foo](https://en.wikipedia.org/wiki/Foo_(bar))"),
        "Foo"
      );
    });

    it("should strip bold markers", () => {
      assert.equal(stripMarkdown("**bold**"), "bold");
    });

    it("should strip italic markers", () => {
      assert.equal(stripMarkdown("*italic*"), "italic");
    });

    it("should preserve arithmetic asterisks", () => {
      assert.equal(stripMarkdown("3*4*5"), "3*4*5");
    });

    it("should strip bold inside link text", () => {
      assert.equal(stripMarkdown("[**bold link**](url)"), "bold link");
    });

    it("should preserve literal backtick when unclosed", () => {
      assert.equal(stripMarkdown("text ` more"), "text ` more");
    });
  });

  // ==================== Phase 3: Whitespace normalization ====================

  describe("Phase 3: Whitespace normalization", () => {
    it("should collapse multiple newlines to single newline", () => {
      assert.equal(stripMarkdown("Line one\n\n\n\nLine two"), "Line one\nLine two");
    });

    it("should trim leading and trailing whitespace", () => {
      assert.equal(stripMarkdown("  hello world  "), "hello world");
    });
  });

  // ==================== Edge Cases ====================

  describe("Edge cases", () => {
    it("should return empty string for empty input", () => {
      assert.equal(stripMarkdown(""), "");
    });

    it("should return string unchanged when no markdown is present", () => {
      assert.equal(stripMarkdown("plain text here"), "plain text here");
    });

    it("should return empty string for whitespace-only input", () => {
      assert.equal(stripMarkdown("   \n\n  \t  "), "");
    });
  });

  // ==================== MAJOR-2: Triple asterisk bold+italic ====================

  describe("Triple asterisk bold+italic", () => {
    it("should strip triple asterisk bold+italic", () => {
      assert.equal(stripMarkdown("***text***"), "text");
    });
  });

  // ==================== MINOR-1: Underscore emphasis ====================

  describe("Underscore emphasis", () => {
    it("should strip underscore italic", () => {
      assert.equal(stripMarkdown("_italic_"), "italic");
    });

    it("should strip double underscore bold", () => {
      assert.equal(stripMarkdown("__bold__"), "bold");
    });

    it("should preserve underscores within words", () => {
      assert.equal(stripMarkdown("foo_bar_baz"), "foo_bar_baz");
    });
  });

  // ==================== MINOR-2: Image syntax ====================

  describe("Image syntax", () => {
    it("should strip image syntax and keep alt text", () => {
      assert.equal(stripMarkdown("![alt text](image.png)"), "alt text");
    });
  });

  // ==================== MINOR-3: Indented list markers ====================

  describe("Indented list markers", () => {
    it("should strip indented unordered list markers", () => {
      assert.equal(stripMarkdown("  - indented item"), "indented item");
    });

    it("should strip indented ordered list markers", () => {
      assert.equal(stripMarkdown("    1. deep item"), "deep item");
    });
  });

  // ==================== MINOR-4: Block quotes ====================

  describe("Block quotes", () => {
    it("should strip block quote markers", () => {
      assert.equal(stripMarkdown("> quoted text"), "quoted text");
    });

    it("should strip nested block quote markers", () => {
      assert.equal(stripMarkdown("> > deeply quoted"), "deeply quoted");
    });
  });

  // ==================== MINOR-5: Horizontal rules ====================

  describe("Horizontal rules", () => {
    it("should strip horizontal rules (---)", () => {
      assert.equal(stripMarkdown("above\n---\nbelow"), "above\nbelow");
    });

    it("should strip horizontal rules (***)", () => {
      assert.equal(stripMarkdown("above\n***\nbelow"), "above\nbelow");
    });

    it("should strip horizontal rules (___)", () => {
      assert.equal(stripMarkdown("above\n___\nbelow"), "above\nbelow");
    });

    it("should strip horizontal rules with 4+ underscores (____)", () => {
      assert.equal(stripMarkdown("above\n____\nbelow"), "above\nbelow");
    });

    it("should strip horizontal rules with 4+ asterisks (****)", () => {
      assert.equal(stripMarkdown("above\n****\nbelow"), "above\nbelow");
    });

    it("should strip spaced horizontal rules with 4+ chars (* * * *)", () => {
      assert.equal(stripMarkdown("above\n* * * *\nbelow"), "above\nbelow");
    });
  });

  // ==================== MINOR-6: Empty emphasis ====================

  describe("Empty emphasis", () => {
    it("should treat inline **** as literal when there is no content between markers", () => {
      assert.equal(stripMarkdown("text **** text"), "text **** text");
    });
  });

  // ==================== MINOR-7: Backslash escapes ====================

  describe("Backslash escapes", () => {
    it("should handle backslash-escaped asterisks", () => {
      assert.equal(stripMarkdown("\\*not bold\\*"), "*not bold*");
    });

    it("should handle backslash-escaped brackets", () => {
      assert.equal(stripMarkdown("\\[not a link\\](url)"), "[not a link](url)");
    });
  });

  // ==================== Suggestion-3: Strikethrough ====================

  describe("Strikethrough", () => {
    it("should strip strikethrough syntax", () => {
      assert.equal(stripMarkdown("~~removed~~"), "removed");
    });

    it("should strip strikethrough in context", () => {
      assert.equal(stripMarkdown("keep ~~removed~~ keep"), "keep removed keep");
    });

    it("should treat empty strikethrough ~~~~ as literal", () => {
      assert.equal(stripMarkdown("~~~~"), "~~~~");
    });

    it("should treat inline ~~~~ as literal", () => {
      assert.equal(stripMarkdown("text ~~~~ text"), "text ~~~~ text");
    });
  });

  // ==================== Cross-construct interactions ====================

  describe("Cross-construct interactions", () => {
    it("should not treat escaped asterisk as emphasis closer", () => {
      assert.equal(stripMarkdown("*foo \\* bar*"), "foo * bar");
    });

    it("should handle double backtick code spans", () => {
      assert.equal(stripMarkdown("``code with ` inside``"), "code with ` inside");
    });

    it("should not treat brackets inside code spans as link structure", () => {
      assert.equal(stripMarkdown("[outside `]`](url)"), "outside ]");
    });

    it("should handle multiple brackets with code spans in between", () => {
      assert.equal(stripMarkdown("[a `]` b](url)"), "a ] b");
    });
  });
});
