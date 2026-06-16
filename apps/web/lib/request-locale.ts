import { cache } from "react";
import { type SupportedLocale } from "@multica/core/i18n";

// With English as the only supported locale, this always returns "en".

export const getRequestLocale = cache(
  async (): Promise<SupportedLocale> => {
    return "en";
  },
);