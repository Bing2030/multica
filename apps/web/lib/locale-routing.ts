import { type SupportedLocale } from "@multica/core/i18n";

export const MULTICA_LOCALE_HEADER = "x-multica-locale";

// With English as the only supported locale, all checks are trivial.

export function isSupportedLocale(
  value: string | null,
): value is SupportedLocale {
  return value === "en";
}

export function resolveLocaleFromSignals(): SupportedLocale {
  return "en";
}