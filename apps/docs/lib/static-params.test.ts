import { describe, expect, it } from "vitest";
import { docsSlugStaticParams } from "./static-params";

// `source.generateParams()` hands back loosely-typed params (`lang: string`),
// so the inputs here mirror that shape — the `lang` strings are validated and
// narrowed by `docsSlugStaticParams` itself.
type RawParam = { lang: string; slug: string[] };

describe("docsSlugStaticParams", () => {
  it("returns every English slug page and drops the home param", () => {
    // The only transform is dropping the empty-slug home param (rendered by
    // `[lang]/page.tsx`, not the catch-all route).
    const params: RawParam[] = [
      { lang: "en", slug: [] },
      { lang: "en", slug: ["agents"] },
      { lang: "en", slug: ["cli", "reference"] },
    ];

    expect(docsSlugStaticParams(params)).toEqual([
      { lang: "en", slug: ["agents"] },
      { lang: "en", slug: ["cli", "reference"] },
    ]);
  });

  it("drops unknown languages and de-duplicates repeated params", () => {
    const params: RawParam[] = [
      { lang: "en", slug: ["agents"] },
      { lang: "en", slug: ["agents"] },
      { lang: "fr", slug: ["agents"] },
    ];

    expect(docsSlugStaticParams(params)).toEqual([
      { lang: "en", slug: ["agents"] },
    ]);
  });
});
