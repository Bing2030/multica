import { describe, expect, it } from "vitest";
import { prefixLocale } from "./locale-link";

describe("prefixLocale", () => {
  it("leaves the default language untouched (URLs are prefix-less)", () => {
    expect(prefixLocale("/workspaces", "en")).toBe("/workspaces");
    expect(prefixLocale("/", "en")).toBe("/");
  });

  it("preserves anchors and query strings on default-locale paths", () => {
    expect(prefixLocale("/providers#claude-code", "en")).toBe(
      "/providers#claude-code",
    );
    expect(prefixLocale("/agents?from=docs", "en")).toBe(
      "/agents?from=docs",
    );
  });

  it("does not double-prefix paths that already carry a known locale", () => {
    expect(prefixLocale("/en/workspaces", "en")).toBe("/en/workspaces");
  });

  it("leaves external URLs alone", () => {
    expect(prefixLocale("https://multica.ai/download", "en")).toBe(
      "https://multica.ai/download",
    );
    expect(prefixLocale("mailto:hello@multica.ai", "en")).toBe(
      "mailto:hello@multica.ai",
    );
    expect(prefixLocale("tel:+1234567890", "en")).toBe("tel:+1234567890");
  });

  it("leaves in-page anchors and relative paths alone", () => {
    expect(prefixLocale("#section", "en")).toBe("#section");
    expect(prefixLocale("./sibling", "en")).toBe("./sibling");
    expect(prefixLocale("../sibling", "en")).toBe("../sibling");
  });

  it("returns empty/undefined hrefs unchanged", () => {
    expect(prefixLocale("", "en")).toBe("");
  });
});
