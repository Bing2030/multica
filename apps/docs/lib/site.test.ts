import { beforeEach, describe, expect, it, vi } from "vitest";

const existingDocs = vi.hoisted(() => new Set<string>());

vi.mock("node:fs", () => ({
  existsSync: vi.fn((path: string) => {
    const normalized = path.replaceAll("\\", "/");
    return [...existingDocs].some((suffix) => normalized.endsWith(suffix));
  }),
}));

const pages = new Map<string, { url: string }>([
  ["en:", { url: "/" }],
  ["en:agents", { url: "/agents" }],
]);

vi.mock("@/lib/source", () => ({
  source: {
    getPage: vi.fn((slugs: string[], lang: string) => {
      return pages.get(`${lang}:${slugs.join("/")}`) ?? null;
    }),
  },
}));

beforeEach(() => {
  existingDocs.clear();
  existingDocs.add("index.mdx");
  existingDocs.add("agents.mdx");
});

describe("docsAlternates", () => {
  it("emits an English-only hreflang block for a page", async () => {
    const { docsAlternates } = await import("./site");

    expect(docsAlternates(["agents"])).toEqual({
      canonical: "https://www.multica.ai/docs/agents",
      languages: {
        en: "https://www.multica.ai/docs/agents",
        "x-default": "https://www.multica.ai/docs/agents",
      },
    });
  });

  it("emits an English-only hreflang block for the docs root", async () => {
    const { docsAlternates } = await import("./site");

    expect(docsAlternates([])).toEqual({
      canonical: "https://www.multica.ai/docs",
      languages: {
        en: "https://www.multica.ai/docs",
        "x-default": "https://www.multica.ai/docs",
      },
    });
  });
});
