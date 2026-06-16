import { describe, expect, it } from "vitest";
import {
  isSupportedLocale,
  resolveLocaleFromSignals,
} from "./locale-routing";

describe("locale routing", () => {
  it("accepts only 'en' as a supported locale", () => {
    expect(isSupportedLocale("en")).toBe(true);
    expect(isSupportedLocale("zh")).toBe(false);
    expect(isSupportedLocale("ko")).toBe(false);
    expect(isSupportedLocale("ja")).toBe(false);
    expect(isSupportedLocale(null)).toBe(false);
  });

  it("always returns English", () => {
    expect(resolveLocaleFromSignals()).toBe("en");
  });
});