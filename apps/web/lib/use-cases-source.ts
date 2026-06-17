import { loader } from "fumadocs-core/source";
import { useCases } from "@/.source";

// Use-case content uses dot-suffixed MDX files. English is the only supported language.
export const useCasesSource = loader({
  baseUrl: "/usecases",
  source: useCases.toFumadocsSource(),
});

export function getUseCasePagesForLocale() {
  return useCasesSource.getPages("en");
}

export function getUseCasePageForLocale(slugs: string[]) {
  return useCasesSource.getPage(slugs, "en");
}