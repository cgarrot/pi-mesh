// test/renderer.test.ts — D41: colored rendering (aliases in accent, batch header).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@mariozechner/pi-tui";
import { colorizeAliases, memoRender, renderLiveEntry, renderMeshInbound, renderVerdictEntry } from "../src/extension/renderer.js";

import { agentColor } from "../src/extension/colors.js";

const theme = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
};

describe("colorizeAliases (D41)", () => {
  it("highlights @aliases with the AGENT color, leaves the rest untouched", () => {
    const c = agentColor("agent-2");
    const out = colorizeAliases("[mesh] @agent-2 (room cs-room, normal) hello", theme as never);
    assert.ok(out.includes(`<${c}>@agent-2</${c}>`));
    assert.ok(out.includes("(room cs-room, normal) hello"));
  });
});

describe("renderMeshInbound (D41)", () => {
  it("batch: colored header then the numbered content", () => {
    const content = "[mesh batch — 2 messages]\n1) [mesh] @agent-2 (room cs-room, normal) done";
    const lines = renderMeshInbound(content, { kind: "mesh-batch", count: 2 }, 200, theme as never);
    assert.ok(lines[0]!.includes("<accent>▚ mesh batch — 2 messages</accent>"));
    assert.ok(lines.some((l) => l.includes(`<${agentColor("agent-2")}>@agent-2</${agentColor("agent-2")}>`)));
  });

  it("simple message: sender colored, instruction line muted", () => {
    const lines = renderMeshInbound(
      "[mesh] @agent-4 (room cs-room, normal) MISSION TERMINÉE\n↩ reply with the mesh_reply tool using msgId \"m_x\"",
      { kind: "mesh-inbound", from: "agent-4" },
      200,
      theme as never,
    );
    const c = agentColor("agent-4");
    assert.ok(lines.some((l) => l.includes(`<${c}>@agent-4</${c}>`)));
    assert.ok(lines.some((l) => l.includes("<muted>↩ reply with the mesh_reply tool")));
  });

  it("wraps long lines to the width", () => {
    const long = "x".repeat(100);
    const lines = renderMeshInbound(`[mesh] @a (room r, normal) ${long}`, undefined, 40, theme as never);
    assert.ok(lines.length >= 3, `expected wrapping, got ${lines.length} lines`);
  });
});

describe("per-agent colors (D43)", () => {
  it("agentColor is stable and distinct for different aliases", () => {
    const a1 = agentColor("agent-1");
    const a2 = agentColor("agent-2");
    const again = agentColor("agent-1");
    assert.equal(a1, again, "stable for the same alias");
    assert.notEqual(a1, a2, "different agents get different colors");
  });

  it("renderLiveEntry shows the sender in its agent color", () => {
    const lines = renderLiveEntry(
      { from: "agent-7", room: "cs-room", body: "MISSION TERMINÉE", at: "2026-08-12T08:00:00.000Z" },
      200,
      theme as never,
    );
    const c = agentColor("agent-7");
    assert.ok(lines.some((l) => l.includes(`<${c}>@agent-7</${c}>`)));
    assert.ok(lines.some((l) => l.includes("MISSION TERMINÉE")));
  });
});

describe("boxed rendering (D45)", () => {
  const boxTheme = {
    fg: (c: string, t: string) => `<fg:${c}>${t}</fg:${c}>`,
    bg: (c: string, t: string) => `<bg:${c}>${t}</bg:${c}>`,
    bold: (t: string) => `<b>${t}</b>`,
  };

  it("wraps the content in the customMessageBg frame with label and padding", () => {
    const lines = renderMeshInbound(
      "[mesh] @agent-2 (room cs-room, normal) hello\n↩ reply with the mesh_reply tool",
      undefined,
      40,
      boxTheme as never,
    );
    assert.ok(lines[0]!.includes("<bg:customMessageBg>"), "top padding line has the bg");
    assert.ok(lines[1]!.includes("<fg:customMessageLabel>"), "label line");
    assert.ok(lines[1]!.includes("<b>[mesh-inbound]</b>"), "bold label");
    assert.ok(lines.some((l) => l.includes("<bg:customMessageBg>") && l.includes("<fg:accent>@agent-2</fg:accent>") || l.includes("<bg:customMessageBg>") && l.includes("@agent-2")), "content line carries the bg");
    const last = lines[lines.length - 1]!;
    assert.ok(last.includes("<bg:customMessageBg>"), "bottom padding line has the bg");
  });

  it("content lines are padded to the full width", () => {
    const lines = renderMeshInbound("x", undefined, 20, boxTheme as never);
    const content = lines.find((l) => l.includes("x"))!;
    const visible = content.replace(/<[^>]+>/g, "").length;
    assert.equal(visible, 20, "each line spans exactly the box width");
  });

  it("falls back to plain lines when the theme has no bg (headless/tests)", () => {
    const lines = renderMeshInbound("plain", undefined, 20, theme as never);
    assert.equal(lines.length, 1);
    assert.equal(lines[0], "plain");
  });
});

describe("verdict entry (mesh-verdict, agent-colored backgrounds)", () => {
  const verdictTheme = {
    fg: (c: string, t: string) => `<fg:${c}>${t}</fg:${c}>`,
    bg: (c: string, t: string) => `<bg:${c}>${t}</bg:${c}>`,
    fgAnsi: (c: string) => `\x1b[38;5;${c.length}m`,
  };

  it("each agent line carries the agent color as text AND background", () => {
    const lines = renderVerdictEntry(
      { head: "6/8 answered after 3m12s", answers: [{ to: "agent-3", response: "done" }], missing: [{ to: "agent-7", msgId: "m_xxx" }] },
      40,
      verdictTheme as never,
    );
    const c3 = agentColor("agent-3");
    const c7 = agentColor("agent-7");
    assert.ok(lines[0]!.includes("<bg:customMessageBg>"), "empty line above the header");
    assert.ok(lines[1]!.includes("<bg:customMessageBg>"), "header on the neutral box bg");
    const a3 = lines.find((l) => l.includes("@agent-3"))!;
    assert.ok(a3.includes(`\x1b[48;5;${c3.length}m`), "agent-3 color as BACKGROUND (38→48)");
    const a7 = lines.find((l) => l.includes("@agent-7"))!;
    assert.ok(a7.includes(`\x1b[48;5;${c7.length}m`), "agent-7 color as BACKGROUND");
    assert.ok(a7.includes("NOT ANSWERED"), "missing marker");
  });

  it("adaptive contrast: light background → dark text, dark background → light text", () => {
    const lightTheme = {
      fg: (c: string, t: string) => `<fg:${c}>${t}</fg:${c}>`,
      bg: (c: string, t: string) => `<bg:${c}>${t}</bg:${c}>`,
      fgAnsi: () => "\x1b[38;5;15m", // white — LIGHT background
    };
    const darkTheme = {
      fg: (c: string, t: string) => `<fg:${c}>${t}</fg:${c}>`,
      bg: (c: string, t: string) => `<bg:${c}>${t}</bg:${c}>`,
      fgAnsi: () => "\x1b[38;5;21m", // blue — DARK background
    };
    const light = renderVerdictEntry({ answers: [{ to: "agent-3", response: "x" }] }, 40, lightTheme as never);
    const dark = renderVerdictEntry({ answers: [{ to: "agent-3", response: "x" }] }, 40, darkTheme as never);
    const lightLine = light.find((l) => l.includes("@agent-3"))!;
    const darkLine = dark.find((l) => l.includes("@agent-3"))!;
    assert.ok(lightLine.includes("\x1b[38;5;232m"), "light bg → near-black text");
    assert.ok(darkLine.includes("\x1b[38;5;255m"), "dark bg → near-white text");
  });

  it("empty neutral line between the answer lines", () => {
    const lines = renderVerdictEntry(
      { head: "2/2 answered", answers: [{ to: "agent-3", response: "a" }, { to: "agent-7", response: "b" }] },
      40,
      verdictTheme as never,
    );
    // layout: empty, header, empty, line, EMPTY, line, EMPTY(trailing)
    const gap = lines[4]!;
    assert.ok(gap.includes("<bg:customMessageBg>"), "spacing line between the two answers");
    assert.ok(!gap.includes("@agent-"), "spacing line is empty (no agent text)");
    assert.ok(lines[6]!.includes("<bg:customMessageBg>"), "trailing empty line after the last answer");
    assert.ok(!lines[6]!.includes("@agent-"), "trailing line is empty");
  });

  it("falls back to plain colored lines without a theme", () => {
    const lines = renderVerdictEntry(
      { head: "1/1 answered", answers: [{ to: "agent-2", response: "ok" }] },
      40,
      theme as never, // no fgAnsi, no bg
    );
    assert.ok(lines.some((l) => l.includes("@agent-2")));
    assert.ok(!lines.some((l) => l.includes("\x1b[48")), "no background without fgAnsi");
  });
});

describe("verdict width safety — every line fits the terminal (issue #1)", () => {
  // REAL ANSI codes (invisible to visibleWidth) — fake <tag> markers would
  // pollute the width measurement itself.
  const ansiTheme = {
    fg: (_c: string, t: string) => t,
    bg: (_c: string, t: string) => t,
    fgAnsi: (c: string) => `\x1b[38;5;${(c.length % 200) + 17}m`,
  };
  const plainAnsiTheme = { fg: (_c: string, t: string) => `\x1b[35m${t}\x1b[39m` };

  // pi-tui's renderer THROWS on any line wider than the terminal — CJK
  // graphemes are 2 columns each, so a char-count cap cannot bound the
  // rendered width. The crash input from the issue: ~80 CJK chars.
  const cases: { name: string; response: string; width: number; theme: unknown }[] = [
    { name: "the exact crash input (80 CJK chars on a 126-col terminal)", response: "测".repeat(80), width: 126, theme: ansiTheme },
    { name: "all-CJK worst case at 80 cols", response: "漢".repeat(200), width: 80, theme: ansiTheme },
    { name: "narrow terminal (40 cols), CJK answer", response: "日本語の回答です。".repeat(10), width: 40, theme: ansiTheme },
    { name: "very narrow terminal (12 cols)", response: "宽字符文本".repeat(20), width: 12, theme: ansiTheme },
    { name: "plain theme (no background) also fits", response: "测".repeat(80), width: 126, theme: plainAnsiTheme },
    { name: "emoji + CJK mix", response: "🎉任务完成✓ 已验证 ".repeat(20), width: 100, theme: ansiTheme },
  ];

  for (const c of cases) {
    it(`${c.name}: visibleWidth(line) <= ${c.width} for every rendered line`, () => {
      const lines = renderVerdictEntry(
        {
          head: "wait_all",
          answers: [{ to: "agent-3", response: c.response }],
          missing: [{ to: "a-very-long-alias-name-here-0123456789", msgId: "m_xxx" }],
        },
        c.width,
        c.theme as never,
      );
      assert.ok(lines.length > 0);
      for (const l of lines) {
        assert.ok(
          visibleWidth(l) <= c.width,
          `line exceeds terminal: ${visibleWidth(l)} > ${c.width}: ${JSON.stringify(l.slice(0, 60))}`,
        );
      }
    });
  }

  it("a CJK answer now WRAPS instead of overflowing (multi-line block, all parts colored)", () => {
    const lines = renderVerdictEntry(
      { answers: [{ to: "agent-3", response: "测".repeat(80) }] },
      126,
      ansiTheme as never,
    );
    assert.ok(lines.some((l) => l.includes("@agent-3")), "first line carries the agent name");
    assert.ok(
      lines.filter((l) => l.includes("\x1b[48;5;")).length >= 2,
      "the answer spans multiple full-width colored lines",
    );
  });
});

describe("memoRender", () => {
  it("builds once per width and returns the cached lines on later frames", () => {
    let builds = 0;
    const c = memoRender((width) => {
      builds += 1;
      return [`w=${width}`];
    });
    const first = c.render(80);
    assert.deepEqual(first, ["w=80"]);
    assert.equal(c.render(80), first); // same array, no rebuild
    assert.equal(c.render(80), first);
    assert.equal(builds, 1);
  });

  it("rebuilds when the width changes (terminal resize)", () => {
    let builds = 0;
    const c = memoRender((width) => {
      builds += 1;
      return [`w=${width}`];
    });
    assert.deepEqual(c.render(80), ["w=80"]);
    assert.deepEqual(c.render(120), ["w=120"]);
    assert.deepEqual(c.render(80), ["w=80"]);
    assert.equal(builds, 3);
  });

  it("invalidate() forces the next render to rebuild (theme change)", () => {
    let builds = 0;
    const c = memoRender(() => {
      builds += 1;
      return [`build ${builds}`];
    });
    assert.deepEqual(c.render(80), ["build 1"]);
    c.invalidate();
    assert.deepEqual(c.render(80), ["build 2"]);
    assert.equal(builds, 2);
  });

  it("caches real mesh output identically to an uncached render", () => {
    const content = "[mesh] @agent-4 (room cs-room, normal) hello\n↩ reply with the mesh_reply tool using msgId \"m_x\"";
    const details = { kind: "mesh-inbound", from: "agent-4" } as const;
    const c = memoRender((width) => renderMeshInbound(content, details, width, theme as never));
    assert.deepEqual(c.render(60), renderMeshInbound(content, details, 60, theme as never));
    assert.deepEqual(c.render(60), renderMeshInbound(content, details, 60, theme as never));
  });
});
