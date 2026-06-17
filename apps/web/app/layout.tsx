import type { Metadata, Viewport } from "next";
import { Inter, Geist_Mono, Source_Serif_4 } from "next/font/google";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@multica/ui/components/ui/sonner";
import { cn } from "@multica/ui/lib/utils";
import { WebProviders } from "@/components/web-providers";
import { RESOURCES } from "@multica/views/locales";
import "./globals.css";

// Inter is the Latin UI face. next/font produces a hashed family (`__Inter_xxx`)
// plus a synthetic size-adjusted fallback face to prevent FOUT layout shift —
// both are exposed under the `--font-inter` CSS variable.
//
// The full `--font-sans` stack (Inter + the CJK fallback chain) is assembled in
// static CSS in ./globals.css, not here: a hashed next/font family name can only
// be referenced from CSS via a variable, and keeping the CJK chain in CSS keeps it
// CSP-safe and in sync with the desktop app (apps/desktop/src/renderer/src/globals.css).
const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
});
// Mono font has no explicit CJK fallback: CJK chars in code blocks are inherently
// non-aligned with a mono grid (Chinese is proportional), so listing CJK fonts
// here would falsely signal alignment guarantees. Browser default fallback handles
// the rare mixed case correctly.
const geistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  fallback: ["ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"],
});
// Editorial serif used for onboarding headlines. Italic support for h1 em
// accents (e.g. "...on one shared board."). Only loaded on routes that
// render the font; layout-shift-prevention handled by next/font's synthetic
// fallback metrics, same as Inter.
const sourceSerif = Source_Serif_4({
  subsets: ["latin"],
  style: ["normal", "italic"],
  variable: "--font-serif",
  fallback: [
    "ui-serif",
    "Iowan Old Style",
    "Apple Garamond",
    "Baskerville",
    "Times New Roman",
    "serif",
  ],
});

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#05070b" },
  ],
};

export const metadata: Metadata = {
  metadataBase: new URL("https://www.multica.ai"),
  title: {
    default: "Multica — Project Management for Human + Agent Teams",
    template: "%s | Multica",
  },
  description:
    "Open-source platform that turns coding agents into real teammates. Assign tasks, track progress, compound skills.",
  icons: {
    icon: [{ url: "/favicon.svg", type: "image/svg+xml" }],
    shortcut: ["/favicon.svg"],
  },
  openGraph: {
    type: "website",
    siteName: "Multica",
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    site: "@multica_hq",
    creator: "@multica_hq",
  },
  alternates: {
    canonical: "/",
  },
  robots: {
    index: true,
    follow: true,
  },
};

// English is the only supported locale.
export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // English is the only supported locale - RESOURCES.en is guaranteed to exist.
  const resources = { en: RESOURCES.en! };

  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={cn("antialiased font-sans h-full", inter.variable, geistMono.variable, sourceSerif.variable)}
    >
      <body className="h-full overflow-hidden">
        <ThemeProvider>
          <WebProviders locale="en" resources={resources}>
            {children}
          </WebProviders>
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}