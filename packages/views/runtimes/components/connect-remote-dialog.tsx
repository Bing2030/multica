"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronRight, Copy, Download, Terminal } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useWorkspaceId } from "@multica/core/hooks";
import { runtimeKeys } from "@multica/core/runtimes/queries";
import { useWSEvent } from "@multica/core/realtime";
import { paths, useWorkspaceSlug } from "@multica/core/paths";
import { useConfigStore } from "@multica/core/config";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@multica/ui/components/ui/dialog";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { Label } from "@multica/ui/components/ui/label";
import { CODE_LIGATURE_CLASS } from "@multica/ui/lib/code-style";
import { copyText } from "@multica/ui/lib/clipboard";
import { cn } from "@multica/ui/lib/utils";
import { useNavigation } from "../../navigation";
import { useT } from "../../i18n";

type Step = "instructions" | "success";

const CLOUD_SERVER_URL = "https://api.multica.ai";
const CLOUD_APP_URL = "https://multica.ai";
const DAEMON_START_CMD = "multica daemon start";
const CONFIG_PATH = "~/.multica/config.json";

function normalizeUrl(url: string | undefined) {
  return url?.trim().replace(/\/+$/, "") ?? "";
}

/** Build the JSON config content for ~/.multica/config.json. */
function buildConfigJson(serverUrl: string, appUrl: string, token: string) {
  const cfg: Record<string, string> = {};
  if (serverUrl) cfg.server_url = serverUrl;
  if (appUrl) cfg.app_url = appUrl;
  if (token) cfg.token = token;
  return JSON.stringify(cfg, null, 2);
}

/** Trigger a browser download of the config file. */
function downloadConfigFile(json: string) {
  const blob = new Blob([json + "\n"], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "config.json";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function ConnectRemoteDialog({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState<Step>("instructions");
  const wsId = useWorkspaceId();
  const slug = useWorkspaceSlug();
  const qc = useQueryClient();
  const navigation = useNavigation();
  const newRuntimeIdRef = useRef<string | null>(null);

  const handleDaemonRegister = useCallback(
    (payload: unknown) => {
      if (step !== "instructions") return;
      qc.invalidateQueries({ queryKey: runtimeKeys.all(wsId) });
      const p = payload as Record<string, unknown> | null;
      if (p?.runtime_id && typeof p.runtime_id === "string") {
        newRuntimeIdRef.current = p.runtime_id;
      }
      setStep("success");
    },
    [step, qc, wsId],
  );
  useWSEvent("daemon:register", handleDaemonRegister);

  const handleGoToAgents = () => {
    onClose();
    if (slug) {
      navigation.push(paths.workspace(slug).agents());
    }
  };

  const handleGoToRuntime = () => {
    onClose();
    if (slug && newRuntimeIdRef.current) {
      navigation.push(
        paths.workspace(slug).runtimeDetail(newRuntimeIdRef.current),
      );
    }
  };

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 p-0 sm:max-w-lg">
        {step === "instructions" && <InstructionsStep onClose={onClose} />}
        {step === "success" && (
          <SuccessStep
            onGoToAgents={handleGoToAgents}
            onGoToRuntime={
              newRuntimeIdRef.current ? handleGoToRuntime : undefined
            }
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Copy button
// ---------------------------------------------------------------------------

function CopyButton({ text, ariaLabel }: { text: string; ariaLabel: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);

  const handleCopy = () => {
    void copyText(text).then((ok) => {
      if (ok) setCopied(true);
    });
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={ariaLabel}
      className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-success" aria-hidden />
      ) : (
        <Copy className="h-3.5 w-3.5" aria-hidden />
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Step 1: Instructions — configure in UI, save config file, start daemon
// ---------------------------------------------------------------------------

function InstructionsStep({ onClose }: { onClose: () => void }) {
  const { t } = useT("runtimes");
  const storedServerUrl = useConfigStore((s) => s.daemonServerUrl);
  const storedAppUrl = useConfigStore((s) => s.daemonAppUrl);

  const [serverUrl, setServerUrl] = useState(() =>
    normalizeUrl(storedServerUrl || CLOUD_SERVER_URL),
  );
  const [appUrl, setAppUrl] = useState(() =>
    normalizeUrl(storedAppUrl || CLOUD_APP_URL),
  );
  const [token, setToken] = useState("");

  const configJson = useMemo(
    () => buildConfigJson(normalizeUrl(serverUrl), normalizeUrl(appUrl), token.trim()),
    [serverUrl, appUrl, token],
  );

  const canDownload = token.trim().length > 0;

  return (
    <>
      <DialogHeader className="px-6 pt-6 pb-2">
        <DialogTitle className="text-base text-balance">
          {t(($) => $.connect.title)}
        </DialogTitle>
        <DialogDescription className="text-xs text-balance">
          {t(($) => $.connect.description)}
        </DialogDescription>
      </DialogHeader>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        <div className="space-y-4">
          {/* Config inputs */}
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="cfg-server-url" className="text-xs">
                {t(($) => $.connect.field_server_url)}
              </Label>
              <Input
                id="cfg-server-url"
                value={serverUrl}
                onChange={(e) => setServerUrl(e.target.value)}
                spellCheck={false}
                className="font-mono text-xs"
                autoComplete="off"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cfg-app-url" className="text-xs">
                {t(($) => $.connect.field_app_url)}
              </Label>
              <Input
                id="cfg-app-url"
                value={appUrl}
                onChange={(e) => setAppUrl(e.target.value)}
                spellCheck={false}
                className="font-mono text-xs"
                autoComplete="off"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cfg-token" className="text-xs">
                {t(($) => $.connect.field_token)}
              </Label>
              <Input
                id="cfg-token"
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder={t(($) => $.connect.field_token_placeholder)}
                spellCheck={false}
                className="font-mono text-xs"
                autoComplete="off"
              />
              <p className="text-[11px] leading-[1.55] text-muted-foreground">
                {t(($) => $.connect.field_token_hint_prefix)}
                <span className="font-medium text-foreground">
                  {t(($) => $.connect.field_token_hint_destination)}
                </span>
                {t(($) => $.connect.field_token_hint_suffix)}
              </p>
            </div>
          </div>

          {/* Step 1: save config file */}
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <p className="text-xs font-medium text-foreground">
                {t(($) => $.connect.step1_label)}
              </p>
              <div className="flex items-center gap-1">
                <CopyButton text={configJson} ariaLabel={t(($) => $.connect.copy_aria)} />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1.5 px-2 text-xs"
                  disabled={!canDownload}
                  onClick={() => downloadConfigFile(configJson)}
                >
                  <Download className="h-3 w-3" aria-hidden />
                  {t(($) => $.connect.download)}
                </Button>
              </div>
            </div>
            <div className="flex items-start gap-2 rounded-lg bg-muted px-3 py-2.5 font-mono text-xs">
              <code
                className={cn(
                  "min-w-0 flex-1 break-all whitespace-pre-wrap tabular-nums",
                  CODE_LIGATURE_CLASS,
                )}
              >
                {configJson}
              </code>
            </div>
            <p className="mt-1.5 text-[11px] leading-[1.55] text-muted-foreground">
              {t(($) => $.connect.step1_hint_prefix)}
              <code
                className={cn(
                  "mx-0.5 rounded bg-muted px-1 py-0.5 font-mono text-[10px] text-foreground",
                  CODE_LIGATURE_CLASS,
                )}
              >
                {CONFIG_PATH}
              </code>
              {t(($) => $.connect.step1_hint_suffix)}
            </p>
          </div>

          {/* Step 2: start daemon */}
          <div>
            <p className="mb-1.5 text-xs font-medium text-foreground">
              {t(($) => $.connect.step2_label)}
            </p>
            <div className="flex items-start gap-2 rounded-lg bg-muted px-3 py-2.5 font-mono text-sm">
              <Terminal
                className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground"
                aria-hidden
              />
              <code
                className={cn(
                  "min-w-0 flex-1 break-all whitespace-pre-wrap tabular-nums",
                  CODE_LIGATURE_CLASS,
                )}
              >
                {DAEMON_START_CMD}
              </code>
              <CopyButton text={DAEMON_START_CMD} ariaLabel={t(($) => $.connect.copy_aria)} />
            </div>
          </div>

          <LiveListening />
        </div>
      </div>

      <DialogFooter className="m-0 rounded-b-xl border-t bg-muted/30 px-6 py-3">
        <Button variant="outline" size="sm" onClick={onClose}>
          {t(($) => $.connect.cancel)}
        </Button>
      </DialogFooter>
    </>
  );
}

// ---------------------------------------------------------------------------
// Live-listening indicator
// ---------------------------------------------------------------------------

function LiveListening() {
  const { t } = useT("runtimes");
  return (
    <div
      className="flex items-center gap-2.5 rounded-lg border bg-muted/40 px-3 py-2.5 text-xs"
      role="status"
      aria-live="polite"
    >
      <span className="relative inline-flex shrink-0" aria-hidden>
        <span className="absolute inline-flex h-2 w-2 animate-ping rounded-full bg-success opacity-60 motion-reduce:hidden" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
      </span>
      <span className="font-medium text-foreground">
        {t(($) => $.connect.live_listening)}
      </span>
      <span className="text-muted-foreground">
        {t(($) => $.connect.live_listening_hint)}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 2: Success
// ---------------------------------------------------------------------------

function SuccessStep({
  onGoToAgents,
  onGoToRuntime,
}: {
  onGoToAgents: () => void;
  onGoToRuntime?: () => void;
}) {
  const { t } = useT("runtimes");
  return (
    <>
      <DialogHeader className="px-6 pt-6 pb-2">
        <DialogTitle className="text-base text-balance">
          {t(($) => $.connect.success_title)}
        </DialogTitle>
        <DialogDescription className="text-xs text-balance">
          {t(($) => $.connect.success_description)}
        </DialogDescription>
      </DialogHeader>

      <div className="flex flex-col items-center gap-3 px-6 py-8">
        <div
          className="flex h-12 w-12 items-center justify-center rounded-full bg-success/10"
          aria-hidden
        >
          <Check className="h-6 w-6 text-success" />
        </div>
      </div>

      <DialogFooter className="m-0 rounded-b-xl border-t bg-muted/30 px-6 py-3">
        {onGoToRuntime && (
          <Button variant="ghost" size="sm" onClick={onGoToRuntime}>
            {t(($) => $.connect.view_runtime)}
          </Button>
        )}
        <Button size="sm" onClick={onGoToAgents}>
          {t(($) => $.connect.create_agent)}
          <ChevronRight className="h-3.5 w-3.5" aria-hidden />
        </Button>
      </DialogFooter>
    </>
  );
}
