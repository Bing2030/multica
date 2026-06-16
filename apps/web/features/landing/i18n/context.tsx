"use client";

import { createContext, use, useMemo } from "react";
import { useConfigStore } from "@multica/core/config";
import { createEnDict } from "./en";
import { type LandingDict, type Locale } from "./types";

type LocaleContextValue = {
  locale: Locale;
  t: LandingDict;
};

const LocaleContext = createContext<LocaleContextValue | null>(null);

// English is the only supported locale.
export function LocaleProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const locale: Locale = "en";
  const allowSignup = useConfigStore((state) => state.allowSignup);
  const t = useMemo(() => createEnDict(allowSignup), [allowSignup]);

  return (
    <LocaleContext.Provider value={{ locale, t }}>
      {children}
    </LocaleContext.Provider>
  );
}

export function useLocale() {
  const ctx = use(LocaleContext);
  if (!ctx) throw new Error("useLocale must be used within LocaleProvider");
  return ctx;
}