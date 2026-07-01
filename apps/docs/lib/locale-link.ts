import { i18n } from "./i18n";

// Add the active locale prefix to root-relative MDX links so internal
// navigation stays in the right locale. English is the default and its
// URLs are prefix-less under `hideLocale: 'default-locale'`, so this is a
// pass-through in the current English-only setup but is kept for when a
// non-default locale is added back.
//
// We deliberately do NOT touch:
//   - external links (`https:`, `mailto:`, `tel:`, etc.)
//   - in-page anchors (`#section`)
//   - relative paths (`./foo`, `../bar`)
//   - paths already prefixed with a known locale
//   - the default language (URLs are intentionally prefix-less)
export function prefixLocale(href: string, lang: string): string {
  if (!href) return href;
  if (lang === i18n.defaultLanguage) return href;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return href;
  if (href.startsWith("#")) return href;
  if (!href.startsWith("/")) return href;

  const segments = href.split("/").filter(Boolean);
  const first = segments[0];
  if (first && (i18n.languages as readonly string[]).includes(first)) {
    return href;
  }

  return href === "/" ? `/${lang}` : `/${lang}${href}`;
}
