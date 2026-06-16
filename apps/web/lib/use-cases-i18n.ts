export { docsHrefForLocale } from "@/lib/docs-href";

type UseCaseText = {
  indexTitle: string;
  indexSubtitle: string;
  indexMetadataTitle: string;
  indexMetadataDescription: string;
  cardReadMore: string;
  tableOfContents: string;
};

// English is the only supported locale.
export const USE_CASE_TEXT_EN: UseCaseText = {
  indexTitle: "Use cases",
  indexSubtitle:
    "See how teams organize people and agents together with Multica.",
  indexMetadataTitle: "Use cases",
  indexMetadataDescription:
    "See how teams put people and agents to work together with Multica.",
  cardReadMore: "Read →",
  tableOfContents: "On this page",
};