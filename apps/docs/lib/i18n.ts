import { defineI18n } from "fumadocs-core/i18n";

// English-only. hideLocale: 'default-locale' keeps English URLs prefix-free
// (`/docs/`). parser: 'dot' picks up `page.mdx` and `meta.json`.
export const i18n = defineI18n({
  languages: ["en"],
  defaultLanguage: "en",
  hideLocale: "default-locale",
  parser: "dot",
});

export type Lang = (typeof i18n.languages)[number];
