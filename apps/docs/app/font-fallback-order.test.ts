import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const chineseFonts = ["PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC"];

function expectChineseFontsPresent(source: string) {
  const chineseIndexes = chineseFonts.map((font) => source.indexOf(font));
  expect(chineseIndexes).not.toContain(-1);
}

describe("CJK font fallback order", () => {
  it("includes Chinese font fallbacks in the default font stack", () => {
    const cssSource = readFileSync(
      resolve(process.cwd(), "app/global.css"),
      "utf8",
    );

    expectChineseFontsPresent(cssSource);
  });

  it("does not ship a Japanese-scoped override (English-only docs)", () => {
    const cssSource = readFileSync(
      resolve(process.cwd(), "app/global.css"),
      "utf8",
    );

    expect(cssSource).not.toContain('html[lang|="ja"]');
  });
});
