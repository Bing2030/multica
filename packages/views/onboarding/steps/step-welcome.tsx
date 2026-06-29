"use client";

import { useState } from "react";
import { ArrowRight, Download, Loader2 } from "lucide-react";
import { Button, buttonVariants } from "@multica/ui/components/ui/button";
import { MulticaIcon } from "@multica/ui/components/common/multica-icon";
import { captureDownloadIntent } from "@multica/core/analytics";
import { DragStrip } from "@multica/views/platform";
import { useT } from "../../i18n";

/**
 * Step 0 — the one-shot product intro shown on every onboarding
 * entry (which-step-are-you-on is not persisted). Returning users
 * who are already onboarded never reach this screen; they're gated
 * out earlier by `!hasOnboarded`.
 *
 * Clean + simple: a single centered column — wordmark, one headline,
 * one line of subtext, a primary CTA, and a subtle "I've done this
 * before" skip link for returning users who already have a workspace.
 *
 * `onSkip`, when provided, renders as the skip link and marks
 * onboarding complete server-side, sending the user straight to their
 * existing workspace. OnboardingFlow only passes it when the user has
 * ≥ 1 workspace — without that, skipping lands in limbo.
 *
 * `isWeb` flips the primary CTA label (web users have an extra runtime
 * step) and surfaces a "Download Desktop" secondary link before they
 * invest in workspace creation. Desktop bundles a daemon, so the same
 * prompt would be noise there.
 */
export function StepWelcome({
  onNext,
  onSkip,
  isWeb = false,
}: {
  onNext: () => void | Promise<void>;
  onSkip?: () => void | Promise<void>;
  isWeb?: boolean;
}) {
  const { t } = useT("onboarding");
  // Tracks which button is mid-flight so we can show a per-button
  // spinner and disable both while one is in progress.
  const [pending, setPending] = useState<"next" | "skip" | null>(null);

  const handleNext = async () => {
    if (pending) return;
    setPending("next");
    try {
      await onNext();
    } finally {
      setPending(null);
    }
  };

  const handleSkip = async () => {
    if (pending || !onSkip) return;
    setPending("skip");
    try {
      await onSkip();
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="animate-onboarding-enter flex h-full min-h-[640px] flex-col items-center justify-center px-6">
      <DragStrip />
      <div className="flex w-full max-w-[480px] flex-col items-center gap-6 text-center">
        <div className="flex items-center gap-2.5">
          <MulticaIcon className="size-5 text-foreground" noSpin />
          <span className="font-serif text-xl font-medium tracking-tight">
            {t(($) => $.welcome.wordmark)}
          </span>
        </div>

        <h1 className="text-balance font-serif text-4xl font-medium leading-[1.1] tracking-tight sm:text-5xl">
          {t(($) => $.welcome.headline_line1)}{" "}
          <em className="italic text-brand">
            {t(($) => $.welcome.headline_emphasis)}
          </em>
        </h1>

        <p className="text-base leading-relaxed text-muted-foreground">
          {isWeb ? t(($) => $.welcome.lede_web) : t(($) => $.welcome.lede_desktop)}
        </p>

        <div className="flex flex-col items-center gap-3 pt-2">
          <Button
            size="lg"
            onClick={handleNext}
            disabled={pending !== null}
          >
            {pending === "next" && <Loader2 className="h-4 w-4 animate-spin" />}
            {isWeb
              ? t(($) => $.welcome.continue_on_web)
              : t(($) => $.welcome.start_exploring)}
            <ArrowRight className="h-4 w-4" />
          </Button>

          {isWeb ? (
            // `<a>` rather than `<Button onClick={window.open}>` so
            // middle-click / cmd-click / "Copy link" all behave and
            // screen readers announce it as a link. New tab preserves
            // this onboarding tab in case the desktop install stalls.
            <a
              href="/download"
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => captureDownloadIntent("welcome")}
              className={buttonVariants({ variant: "ghost", size: "sm" })}
            >
              <Download className="h-4 w-4" />
              {t(($) => $.welcome.download_desktop)}
            </a>
          ) : null}

          {onSkip && (
            <Button
              variant="link"
              size="sm"
              onClick={handleSkip}
              disabled={pending !== null}
              className="text-muted-foreground"
            >
              {pending === "skip" && <Loader2 className="h-4 w-4 animate-spin" />}
              {t(($) => $.welcome.skip_existing)}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}