import { describe, expect, it } from "vitest";
import { docsHrefForLocale } from "./docs-href";

describe("docsHrefForLocale", () => {
  it("routes English locale to the docs root", () => {
    expect(docsHrefForLocale("en")).toBe("/docs");
  });
});