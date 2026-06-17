import { DEFAULT_LOCALE, type SupportedLocale } from "./types";

// With English as the only supported locale, locale resolution is trivial.
// These functions exist for API compatibility with existing callers.

export function matchLocale(_candidates: string[]): SupportedLocale {
  return DEFAULT_LOCALE;
}

export function pickLocale(): SupportedLocale {
  return DEFAULT_LOCALE;
}