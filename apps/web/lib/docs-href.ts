import type { SupportedLocale } from "@multica/core/i18n";

// English is the only supported locale, so docs are always at /docs.
export function docsHrefForLocale(_locale: SupportedLocale): string {
  return "/docs";
}