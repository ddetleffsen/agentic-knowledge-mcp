/**
 * Tests for the docset searcher (ADR-001 Option C: Node.js streaming regex grep)
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deflateRawSync } from "node:zlib";
import {
  searchDocset,
  buildFileIndex,
  formatSearchResult,
  stripBinary,
  extractDrawioXml,
} from "../search/searcher.js";

// ---------------------------------------------------------------------------
// Test fixture setup
// ---------------------------------------------------------------------------

let fixtureDir: string;

const FIXTURES: Record<string, string> = {
  "docs/auth.md": `# Authentication

This module handles user authentication and login.

## JWT Tokens

The system uses JSON Web Tokens for session management.
Tokens expire after 24 hours.

## OAuth2

Supports OAuth2 for third-party authentication via Google and GitHub.
`,
  "docs/api.md": `# API Reference

## useData Hook

The \`useData()\` hook returns the current page's data.

\`\`\`ts
const { page, frontmatter, theme } = useData()
\`\`\`

## useState

React's useState hook for local component state.
`,
  "docs/sidebar.md": `# Sidebar Configuration

Configure \`sidebar.items\` to define navigation structure.

\`\`\`yaml
sidebar:
  items:
    - text: Guide
      link: /guide/
    - text: Reference
      link: /reference/
\`\`\`
`,
  "docs/nested/deep.md": `# Deep Nested File

This file tests deep directory traversal.

Authentication deep dive: verify credentials before granting access.
`,
  // A file that should be skipped (binary-like — null byte injected in test)
  "images/ignored.png": "PNG\x00binary content here",
  // A file in an ignored directory
  "node_modules/pkg/index.js": "module.exports = {}; // should be skipped",
  // A file in dist/
  "dist/output.js": "// built output — should be skipped",
};

beforeAll(async () => {
  fixtureDir = join(tmpdir(), `searcher-test-${Date.now()}`);
  await mkdir(fixtureDir, { recursive: true });

  for (const [relPath, content] of Object.entries(FIXTURES)) {
    const absPath = join(fixtureDir, relPath);
    await mkdir(join(absPath, ".."), { recursive: true });
    await writeFile(absPath, content);
  }
});

afterAll(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Basic search
// ---------------------------------------------------------------------------

describe("searchDocset – basic matching", () => {
  test("finds a simple keyword", async () => {
    const result = await searchDocset(fixtureDir, "authentication");
    expect(result.total_matches).toBeGreaterThan(0);
    expect(result.matches.every((m) => /authentication/i.test(m.content))).toBe(
      true,
    );
  });

  test("returns correct 1-based line numbers", async () => {
    const result = await searchDocset(fixtureDir, "JWT Tokens");
    expect(result.matches.length).toBeGreaterThan(0);
    // Line numbers must be positive integers
    expect(result.matches.every((m) => m.line >= 1)).toBe(true);
  });

  test("returns relative file paths", async () => {
    const result = await searchDocset(fixtureDir, "authentication");
    expect(result.matches.every((m) => !m.file.startsWith("/"))).toBe(true);
  });

  test("is case-insensitive", async () => {
    const upper = await searchDocset(fixtureDir, "AUTHENTICATION");
    const lower = await searchDocset(fixtureDir, "authentication");
    expect(upper.total_matches).toBe(lower.total_matches);
  });
});

// ---------------------------------------------------------------------------
// Regex / OR syntax
// ---------------------------------------------------------------------------

describe("searchDocset – regex syntax", () => {
  test("supports OR pattern", async () => {
    const result = await searchDocset(fixtureDir, "authentication|login");
    expect(result.total_matches).toBeGreaterThan(0);
    expect(
      result.matches.every(
        (m) => /authentication/i.test(m.content) || /login/i.test(m.content),
      ),
    ).toBe(true);
  });

  test("supports wildcard (.*)", async () => {
    const result = await searchDocset(fixtureDir, "use.*Hook");
    expect(result.total_matches).toBeGreaterThan(0);
  });

  test("supports anchors (^)", async () => {
    // Lines starting with #
    const result = await searchDocset(fixtureDir, "^# ");
    expect(result.total_matches).toBeGreaterThan(0);
    expect(result.matches.every((m) => m.content.startsWith("# "))).toBe(true);
  });

  test("handles invalid regex gracefully (treats as literal)", async () => {
    // "[unclosed" is an invalid regex
    await expect(searchDocset(fixtureDir, "[unclosed")).resolves.toBeDefined();
  });

  test("dotted path syntax", async () => {
    const result = await searchDocset(fixtureDir, "sidebar\\.items");
    expect(result.total_matches).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Context lines
// ---------------------------------------------------------------------------

describe("searchDocset – context lines", () => {
  test("includes context_before and context_after by default", async () => {
    const result = await searchDocset(fixtureDir, "JWT Tokens");
    const match = result.matches[0];
    expect(match).toBeDefined();
    expect(Array.isArray(match!.context_before)).toBe(true);
    expect(Array.isArray(match!.context_after)).toBe(true);
  });

  test("respects contextLines=0", async () => {
    const result = await searchDocset(fixtureDir, "JWT Tokens", {
      contextLines: 0,
    });
    const match = result.matches[0];
    expect(match!.context_before).toHaveLength(0);
    expect(match!.context_after).toHaveLength(0);
  });

  test("respects contextLines=1", async () => {
    const result = await searchDocset(fixtureDir, "JWT Tokens", {
      contextLines: 1,
    });
    const match = result.matches[0];
    expect(match!.context_before.length).toBeLessThanOrEqual(1);
    expect(match!.context_after.length).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Ignored paths
// ---------------------------------------------------------------------------

describe("searchDocset – ignored paths", () => {
  test("skips node_modules", async () => {
    const result = await searchDocset(fixtureDir, "module.exports");
    expect(result.total_matches).toBe(0);
  });

  test("skips dist/", async () => {
    const result = await searchDocset(fixtureDir, "built output");
    expect(result.total_matches).toBe(0);
  });

  test("skips binary files (null byte)", async () => {
    const result = await searchDocset(fixtureDir, "binary content");
    expect(result.total_matches).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Result cap / truncation
// ---------------------------------------------------------------------------

describe("searchDocset – result cap", () => {
  test("respects maxMatches and sets truncated flag", async () => {
    // "the" appears in almost every line — enough to hit a tiny cap
    const result = await searchDocset(fixtureDir, "the", { maxMatches: 2 });
    expect(result.matches.length).toBeLessThanOrEqual(2);
    if (result.total_matches >= 2) {
      expect(result.truncated).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Multi-file results
// ---------------------------------------------------------------------------

describe("searchDocset – multi-file", () => {
  test("returns matches from multiple files", async () => {
    const result = await searchDocset(fixtureDir, "authentication");
    const files = new Set(result.matches.map((m) => m.file));
    // auth.md and nested/deep.md both contain "authentication"
    expect(files.size).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Index integration (MiniSearch pre-filter)
// ---------------------------------------------------------------------------

describe("buildFileIndex + searchDocset with index", () => {
  test("index-assisted search returns consistent results with non-indexed", async () => {
    const index = await buildFileIndex(fixtureDir);
    const withIndex = await searchDocset(
      fixtureDir,
      "authentication",
      {},
      index,
    );
    const withoutIndex = await searchDocset(fixtureDir, "authentication");
    // Both paths should find matches (exact count may differ due to ranking)
    expect(withIndex.total_matches).toBeGreaterThan(0);
    expect(withoutIndex.total_matches).toBeGreaterThan(0);
  });

  test("index is reusable across multiple calls", async () => {
    const index = await buildFileIndex(fixtureDir);
    const r1 = await searchDocset(fixtureDir, "authentication", {}, index);
    const r2 = await searchDocset(fixtureDir, "OAuth2", {}, index);
    expect(r1.total_matches).toBeGreaterThan(0);
    expect(r2.total_matches).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// formatSearchResult
// ---------------------------------------------------------------------------

describe("formatSearchResult", () => {
  test("returns no-match message when matches array is empty", () => {
    const text = formatSearchResult({
      matches: [],
      total_matches: 0,
      searched_files: 5,
      used_pattern: "xyzzy",
      truncated: false,
    });
    expect(text).toContain("No matches");
    expect(text).toContain("xyzzy");
  });

  test("formats matches in file:line: content style", async () => {
    const result = await searchDocset(fixtureDir, "authentication");
    const text = formatSearchResult(result);
    // Should contain file headers and line numbers
    expect(text).toMatch(/==>/);
    expect(text).toMatch(/\d+: /);
  });

  test("includes truncation notice when truncated", () => {
    const text = formatSearchResult({
      matches: [
        {
          file: "docs/auth.md",
          line: 3,
          content: "authentication line",
          context_before: [],
          context_after: [],
        },
      ],
      total_matches: 1,
      searched_files: 3,
      used_pattern: "auth",
      truncated: true,
    });
    expect(text).toContain("truncated");
  });

  test("includes summary line with match count and pattern", async () => {
    const result = await searchDocset(fixtureDir, "OAuth2");
    const text = formatSearchResult(result);
    expect(text).toContain("OAuth2");
    expect(text).toMatch(/\d+ match/);
  });
});

// ---------------------------------------------------------------------------
// stripBinary — base64 payload removal
// ---------------------------------------------------------------------------

describe("stripBinary", () => {
  test("removes data-URI base64 payload but keeps the prefix and text", () => {
    const huge = "A".repeat(100_000);
    const line = `{"label":"Box A","dataURL":"data:image/png;base64,${huge}"}`;
    const out = stripBinary(line);
    expect(out).not.toContain(huge);
    expect(out).toContain("data:image/png;base64,…[omitted]");
    expect(out).toContain('"label":"Box A"');
    expect(out.length).toBeLessThan(200);
  });

  test("removes long free-standing base64 runs", () => {
    const blob = "Zm9vYmFy".repeat(200); // > 500 chars, pure base64
    const out = stripBinary(`<diagram>${blob}</diagram>`);
    expect(out).toBe("<diagram>[base64 omitted]</diagram>");
  });

  test("leaves ordinary text untouched", () => {
    const text = "The quick brown fox jumps over the lazy dog.";
    expect(stripBinary(text)).toBe(text);
  });

  test("preserves line count when run on a multi-line blob", () => {
    const blob = "ABCD".repeat(200);
    const input = `line1\ndata:image/png;base64,${blob}\nline3`;
    expect(stripBinary(input).split("\n")).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// extractDrawioXml + .drawio.png search integration
// ---------------------------------------------------------------------------

/** Build a minimal PNG carrying a `tEXt`/`mxfile` chunk (CRC is not validated). */
function buildDrawioPng(mxfileXml: string, keyword = "mxfile"): Buffer {
  const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    return Buffer.concat([
      len,
      Buffer.from(type, "ascii"),
      data,
      Buffer.alloc(4), // dummy CRC — extractDrawioXml does not verify it
    ]);
  };
  const textData = Buffer.concat([
    Buffer.from(`${keyword}\0`, "latin1"),
    Buffer.from(mxfileXml, "latin1"),
  ]);
  // tEXt chunk must precede IDAT; add a fake IDAT to prove we stop before pixels.
  return Buffer.concat([
    PNG_SIG,
    chunk("tEXt", textData),
    chunk("IDAT", Buffer.from("PIXELDATA_NOT_SEARCHABLE")),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** drawio's compressed diagram body: raw-deflate( urlencode(innerXml) ) → base64. */
function compressDiagram(innerXml: string): string {
  const encoded = encodeURIComponent(innerXml);
  return deflateRawSync(Buffer.from(encoded, "latin1")).toString("base64");
}

describe("extractDrawioXml", () => {
  let dir: string;

  beforeAll(async () => {
    dir = join(tmpdir(), `drawio-test-${Date.now()}`);
    await mkdir(dir, { recursive: true });
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("returns null for a non-PNG file", async () => {
    const p = join(dir, "notpng.png");
    await writeFile(p, "this is plain text, not a png");
    expect(await extractDrawioXml(p)).toBeNull();
  });

  test("extracts uncompressed diagram XML from a tEXt chunk", async () => {
    const xml = "<mxfile><diagram>Plain Label Here</diagram></mxfile>";
    const p = join(dir, "plain.drawio.png");
    await writeFile(p, buildDrawioPng(xml));
    const out = await extractDrawioXml(p);
    expect(out).toContain("Plain Label Here");
    expect(out).not.toContain("PIXELDATA_NOT_SEARCHABLE");
  });

  test("inflates a compressed diagram body so labels become readable", async () => {
    const inner =
      '<mxGraphModel><root><mxCell value="SearchableShapeLabel"/></root></mxGraphModel>';
    const xml = `<mxfile><diagram id="x" name="Page-1">${compressDiagram(inner)}</diagram></mxfile>`;
    const p = join(dir, "compressed.drawio.png");
    await writeFile(p, buildDrawioPng(xml));
    const out = await extractDrawioXml(p);
    expect(out).toContain("SearchableShapeLabel");
  });
});

describe("searchDocset – diagram content", () => {
  let dir: string;

  beforeAll(async () => {
    dir = join(tmpdir(), `diagram-search-test-${Date.now()}`);
    await mkdir(dir, { recursive: true });

    // 1. excalidraw-like JSON: searchable label next to a multi-MB base64 image.
    const huge = "iVBORw0KGgo".repeat(200_000); // ~2 MB single-line payload
    await writeFile(
      join(dir, "diagram.excalidraw"),
      `{"type":"excalidraw","elements":[{"type":"text","text":"DeploymentView"}],` +
        `"files":{"img1":{"dataURL":"data:image/png;base64,${huge}"}}}`,
    );

    // 2. compressed .drawio.png with a searchable shape label.
    const inner =
      '<mxGraphModel><root><mxCell value="ResilienceGateway"/></root></mxGraphModel>';
    const xml = `<mxfile><diagram name="P1">${compressDiagram(inner)}</diagram></mxfile>`;
    await writeFile(join(dir, "arch.drawio.png"), buildDrawioPng(xml));

    // 3. a plain screenshot PNG (no mxfile chunk) → must be skipped cleanly.
    const PNG_SIG = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    await writeFile(
      join(dir, "screenshot.png"),
      Buffer.concat([PNG_SIG, Buffer.from([0x00, 0x01, 0x02, 0x03])]),
    );
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("finds the text label inside an excalidraw file", async () => {
    const result = await searchDocset(dir, "DeploymentView");
    expect(result.total_matches).toBeGreaterThan(0);
  });

  test("does not leak the base64 payload into results (no Transport-blow-up)", async () => {
    const result = await searchDocset(dir, "DeploymentView");
    const text = formatSearchResult(result);
    expect(text).not.toContain("iVBORw0KGgo");
    expect(text.length).toBeLessThan(5_000);
  });

  test("makes a compressed .drawio.png shape label searchable", async () => {
    const result = await searchDocset(dir, "ResilienceGateway");
    expect(result.total_matches).toBeGreaterThan(0);
    expect(result.matches.some((m) => m.file.endsWith(".drawio.png"))).toBe(
      true,
    );
  });

  test("plain screenshot PNG yields no matches and no error", async () => {
    const result = await searchDocset(dir, "ResilienceGateway|anything");
    expect(result.matches.every((m) => m.file !== "screenshot.png")).toBe(true);
  });
});
