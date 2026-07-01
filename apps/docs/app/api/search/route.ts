import { source } from "@/lib/source";
import { createFromSource } from "fumadocs-core/search/server";

// English-only docs search. If a non-English locale is added back, a CJK
// tokenizer (character-level for Han/Kana) will be needed here — Orama's
// built-in English regex strips Han/Kana characters entirely.
export const { GET } = createFromSource(source);
