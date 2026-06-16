import { describe, expect, it } from "vitest";
import { pickContentLang } from "./index";

describe("pickContentLang", () => {
  it("always returns English as the only supported language", () => {
    expect(pickContentLang("en-US")).toBe("en");
    expect(pickContentLang("zh-Hant")).toBe("en");
    expect(pickContentLang("ko-KR")).toBe("en");
    expect(pickContentLang("ja-JP")).toBe("en");
  });

  it("returns English for unsupported or missing languages", () => {
    expect(pickContentLang("fr-FR")).toBe("en");
    expect(pickContentLang(null)).toBe("en");
    expect(pickContentLang(undefined)).toBe("en");
  });
});