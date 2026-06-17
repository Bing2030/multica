import {
  render,
  type RenderOptions,
  type RenderResult,
} from "@testing-library/react";
import { I18nProvider } from "@multica/core/i18n/react";
import type { ReactElement, ReactNode } from "react";
import { RESOURCES } from "../locales";

// Single i18n test wrapper for the whole package. Wraps the production
// `RESOURCES` map (every namespace registered there is available to the
// component under test) so when a new namespace lands the test never
// silently renders translation keys-as-text — the test sees the same
// resource set users do.

type RenderArgs = Omit<RenderOptions, "wrapper">;

export function renderWithI18n(
  ui: ReactElement,
  options: RenderArgs = {},
): RenderResult {
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <I18nProvider locale="en" resources={RESOURCES}>
        {children}
      </I18nProvider>
    );
  }
  return render(ui, { wrapper: Wrapper, ...options });
}

export { RESOURCES };