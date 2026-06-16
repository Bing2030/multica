import { beforeEach, describe, expect, it, vi } from "vitest";

const mockUseCasesSource = vi.hoisted(() => ({
  getPages: vi.fn(),
  getPage: vi.fn(),
}));

vi.mock("fumadocs-core/source", () => ({
  loader: vi.fn(() => mockUseCasesSource),
}));

vi.mock("@/.source", () => ({
  useCases: {
    toFumadocsSource: vi.fn(() => ({})),
  },
}));

import { mergeUseCasePagesWithEnglishFallback } from "./use-case-locale-fallback";
import {
  getUseCasePageForLocale,
  getUseCasePagesForLocale,
  useCasesSource,
} from "./use-cases-source";

beforeEach(() => {
  vi.mocked(useCasesSource.getPages).mockReset();
  vi.mocked(useCasesSource.getPage).mockReset();
});

describe("mergeUseCasePagesWithEnglishFallback", () => {
  it("keeps localized pages ahead of English fallback pages", () => {
    const localizedPages = [
      { slugs: ["localized"], data: { title: "Localized" } },
    ];
    const englishPages = [
      { slugs: ["localized"], data: { title: "English duplicate" } },
      { slugs: ["english-only"], data: { title: "English only" } },
    ];

    expect(
      mergeUseCasePagesWithEnglishFallback(localizedPages, englishPages),
    ).toEqual([
      { slugs: ["localized"], data: { title: "Localized" } },
      { slugs: ["english-only"], data: { title: "English only" } },
    ]);
  });

  it("dedupes nested slugs by full path", () => {
    const localizedPages = [{ slugs: ["teams", "ops"] }];
    const englishPages = [
      { slugs: ["teams", "ops"] },
      { slugs: ["teams", "support"] },
    ];

    expect(
      mergeUseCasePagesWithEnglishFallback(localizedPages, englishPages).map(
        (page) => page.slugs.join("/"),
      ),
    ).toEqual(["teams/ops", "teams/support"]);
  });
});

describe("use case source (English only)", () => {
  it("returns English pages directly", () => {
    const englishPages = [
      { slugs: ["page-one"], data: { title: "Page One" } },
      { slugs: ["page-two"], data: { title: "Page Two" } },
    ];

    vi.mocked(useCasesSource.getPages).mockReturnValue(
      englishPages as ReturnType<typeof useCasesSource.getPages>,
    );

    expect(getUseCasePagesForLocale()).toEqual(englishPages);
  });

  it("returns English detail pages directly", () => {
    const page = { slugs: ["some-slug"], data: { title: "Some Page" } };

    vi.mocked(useCasesSource.getPage).mockReturnValue(
      page as ReturnType<typeof useCasesSource.getPage>,
    );

    expect(getUseCasePageForLocale(["some-slug"])).toBe(page);
  });
});