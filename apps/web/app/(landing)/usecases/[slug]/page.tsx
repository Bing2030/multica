import type { Metadata } from "next";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cn } from "@multica/ui/lib/utils";
import { LandingHeader } from "@/features/landing/components/landing-header";
import { LandingFooter } from "@/features/landing/components/landing-footer";
import { Screenshot } from "@/features/landing/components/mdx/screenshot";
import { getUseCasePageForLocale } from "@/lib/use-cases-source";
import { USE_CASE_TEXT_EN } from "@/lib/use-cases-i18n";

type Params = { slug: string };

type TocItem = { title: ReactNode; url: string; depth: number };

export async function generateMetadata(props: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const { slug } = await props.params;
  const page = getUseCasePageForLocale([slug]);
  if (!page) return {};

  return {
    title: page.data.title,
    description: page.data.description,
    openGraph: {
      title: page.data.title,
      description: page.data.description,
      url: `/usecases/${slug}`,
    },
    alternates: {
      canonical: `/usecases/${slug}`,
    },
  };
}

function nodeToString(node: ReactNode): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeToString).join("");
  return "";
}

function PlaceholderImage({ label }: { label: string }) {
  return (
    <div className="flex aspect-[16/9] items-center justify-center rounded-lg bg-[#0a0d12]/[0.04]">
      <span className="text-sm text-[#0a0d12]/40">{label}</span>
    </div>
  );
}

function SmartParagraph({
  children,
  href,
}: {
  children: ReactNode;
  href: string;
}) {
  const text = nodeToString(children);
  const isCodeBlock = text.startsWith("```");

  if (isCodeBlock) {
    const langMatch = text.match(/^```(\w+)\n/);
    const lang = langMatch?.[1] ?? "code";
    const code = text
      .replace(/^```(\w*)\n/, "")
      .replace(/\n```$/, "");

    return (
      <pre className="my-6 overflow-x-auto rounded-lg bg-[#0a0d12]/[0.04] p-4 text-[13px] leading-[1.65]">
        <code className="font-mono">{code}</code>
      </pre>
    );
  }

  return (
    <p className="mb-4 text-[15px] leading-[1.75] text-[#0a0d12]/80 sm:text-[16px]">
      {children}
    </p>
  );
}

function createMdxComponents() {
  const secondaryHref = "/docs";

  return {
    SmartParagraph: (props: { children: ReactNode }) => (
      <SmartParagraph href={secondaryHref} {...props} />
    ),
    Screenshot,
    a: ({
      href,
      className,
      children,
      ...props
    }: ComponentPropsWithoutRef<"a">) => {
      const isExternal = href?.startsWith("http");
      if (isExternal) {
        return (
          <a
            href={href}
            className={cn("text-[#0066ff] hover:underline", className)}
            target="_blank"
            rel="noopener noreferrer"
            {...props}
          >
            {children}
          </a>
        );
      }
      return (
        <Link
          href={href ?? "#"}
          className={cn("text-[#0066ff] hover:underline", className)}
          {...props}
        >
          {children}
        </Link>
      );
    },
    img: (props: ComponentPropsWithoutRef<"img">) => (
      <img
        className="my-6 rounded-lg"
        {...props}
        alt={props.alt ?? ""}
      />
    ),
    blockquote: (props: ComponentPropsWithoutRef<"blockquote">) => (
      <blockquote
        className="my-6 border-l-4 border-[#0a0d12]/20 pl-4 text-[15px] italic text-[#0a0d12]/70"
        {...props}
      />
    ),
    ul: (props: ComponentPropsWithoutRef<"ul">) => (
      <ul
        className="my-4 ml-6 list-disc space-y-2 text-[15px] leading-[1.7] text-[#0a0d12]/80"
        {...props}
      />
    ),
    ol: (props: ComponentPropsWithoutRef<"ol">) => (
      <ol
        className="my-4 ml-6 list-decimal space-y-2 text-[15px] leading-[1.7] text-[#0a0d12]/80"
        {...props}
      />
    ),
    li: (props: ComponentPropsWithoutRef<"li">) => (
      <li className="text-[15px] leading-[1.7] text-[#0a0d12]/80" {...props} />
    ),
    h2: (props: ComponentPropsWithoutRef<"h2">) => (
      <h2
        className="mb-4 mt-10 text-[22px] font-semibold leading-[1.3] text-[#0a0d12]"
        {...props}
      />
    ),
    h3: (props: ComponentPropsWithoutRef<"h3">) => (
      <h3
        className="mb-3 mt-8 text-[18px] font-semibold leading-[1.35] text-[#0a0d12]"
        {...props}
      />
    ),
    h4: (props: ComponentPropsWithoutRef<"h4">) => (
      <h4
        className="mb-2 mt-6 text-[16px] font-semibold leading-[1.4] text-[#0a0d12]"
        {...props}
      />
    ),
    p: (props: ComponentPropsWithoutRef<"p">) => (
      <p className="mb-4 text-[15px] leading-[1.75] text-[#0a0d12]/80" {...props} />
    ),
    strong: (props: ComponentPropsWithoutRef<"strong">) => (
      <strong className="font-semibold text-[#0a0d12]" {...props} />
    ),
    em: (props: ComponentPropsWithoutRef<"em">) => (
      <em className="italic" {...props} />
    ),
    hr: () => <hr className="my-8 border-t border-[#0a0d12]/10" />,
    table: (props: ComponentPropsWithoutRef<"table">) => (
      <div className="my-6 overflow-x-auto">
        <table className="min-w-full divide-y divide-[#0a0d12]/10" {...props} />
      </div>
    ),
    thead: (props: ComponentPropsWithoutRef<"thead">) => (
      <thead className="bg-[#0a0d12]/[0.02]" {...props} />
    ),
    tbody: (props: ComponentPropsWithoutRef<"tbody">) => (
      <tbody className="divide-y divide-[#0a0d12]/10" {...props} />
    ),
    tr: (props: ComponentPropsWithoutRef<"tr">) => (
      <tr className="even:bg-[#0a0d12]/[0.01]" {...props} />
    ),
    th: (props: ComponentPropsWithoutRef<"th">) => (
      <th
        className="px-4 py-3 text-left text-[12px] font-medium uppercase tracking-[0.05em] text-[#0a0d12]/70"
        {...props}
      />
    ),
    td: (props: ComponentPropsWithoutRef<"td">) => (
      <td className="px-4 py-3 text-[14px] text-[#0a0d12]/80" {...props} />
    ),
    code: (props: ComponentPropsWithoutRef<"code">) => (
      <code
        className="rounded bg-[#0a0d12]/[0.06] px-1.5 py-0.5 font-mono text-[0.88em] text-[#0a0d12]"
        {...props}
      />
    ),
    pre: (props: ComponentPropsWithoutRef<"pre">) => (
      <pre
        className="my-6 overflow-x-auto rounded-lg bg-[#0a0d12]/[0.04] p-4 text-[13px] leading-[1.65]"
        {...props}
      />
    ),
  };
}

export default async function UseCasePage(props: { params: Promise<Params> }) {
  const { slug } = await props.params;
  const text = USE_CASE_TEXT_EN;
  const page = getUseCasePageForLocale([slug]);
  if (!page) notFound();

  const MDX = page.data.body;
  const toc = ((page.data as { toc?: TocItem[] }).toc ?? []).filter(
    (item) => item.depth === 2 || item.depth === 3,
  );
  const mdxComponents = createMdxComponents();

  return (
    <>
      <div className="sticky top-0 z-40 bg-white">
        <LandingHeader variant="light" />
      </div>
      <main className="bg-white text-[#0a0d12]">
        <div
          className={cn(
            "mx-auto max-w-[720px] px-4 py-16 sm:px-6 sm:py-20",
            "lg:max-w-[1100px] lg:py-24",
            "lg:grid lg:grid-cols-[minmax(0,720px)_220px] lg:gap-x-20",
          )}
        >
          <article>
            <h1 className="font-[family-name:var(--font-serif)] text-[2.6rem] leading-[1.05] tracking-[-0.03em] sm:text-[3.4rem]">
              {page.data.title}
            </h1>
            <div className="mt-10 text-[16px] leading-[1.85] text-[#0a0d12]/72 [&>:first-child]:mt-0 [&>p]:my-5 sm:text-[17px]">
              <MDX components={mdxComponents} />
            </div>
          </article>

          {toc.length > 0 ? (
            <aside className="hidden lg:block">
              <nav className="sticky top-[100px] max-h-[calc(100vh-120px)] overflow-y-auto">
                <div className="mb-3 text-[11px] font-medium uppercase tracking-[0.14em] text-[#0a0d12]/40">
                  {text.tableOfContents}
                </div>
                <ul className="border-l border-[#0a0d12]/8">
                  {toc.map((item, i) => (
                    <li key={i}>
                      <a
                        href={item.url}
                        className={cn(
                          "-ml-px block border-l border-transparent py-1.5 pl-4 text-[13px] leading-snug transition-colors",
                          "hover:border-[#0a0d12]/40 hover:text-[#0a0d12]",
                          item.depth === 2
                            ? "font-medium text-[#0a0d12]/70"
                            : "pl-7 text-[12px] text-[#0a0d12]/50",
                        )}
                      >
                        {item.title}
                      </a>
                    </li>
                  ))}
                </ul>
              </nav>
            </aside>
          ) : null}
        </div>
      </main>
      <LandingFooter />
    </>
  );
}