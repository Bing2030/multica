import { describe, expect, it } from "vitest";
import { fullDateLabel, monthYearLabel } from "./changelog-page-client";

describe("changelog date labels", () => {
  it("formats month labels for English locale", () => {
    expect(monthYearLabel(2026, 1, "en")).toBe("January 2026");
  });

  it("formats full dates for English locale", () => {
    expect(fullDateLabel("2026-01-15", "en")).toBe("January 15, 2026");
  });

  it("keeps invalid release dates unchanged", () => {
    expect(fullDateLabel("not-a-date", "en")).toBe("not-a-date");
  });
});