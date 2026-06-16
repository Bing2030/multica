"use client";

import { useEffect, useState } from "react";
import { Eraser, Loader2, Save, Settings } from "lucide-react";
import type { Agent, RuntimeDevice } from "@multica/core/types";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { toast } from "sonner";
import { useT } from "../../../i18n";

// Provider determines how the path is applied:
//   - claude: --settings <path>
//   - opencode: OPENCODE_CONFIG=<path>
const SETTINGS_PATH_PROVIDERS = new Set(["claude", "opencode"]);

export function providerSupportsSettingsPath(provider: string | undefined | null): boolean {
  if (!provider) return false;
  return SETTINGS_PATH_PROVIDERS.has(provider);
}

export function SettingsTab({
  agent,
  runtimeDevice,
  onSave,
  onDirtyChange,
}: {
  agent: Agent;
  runtimeDevice?: RuntimeDevice;
  onSave: (updates: Partial<Agent>) => Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const { t } = useT("agents");
  const [path, setPath] = useState(agent.settings_path ?? "");
  const [saving, setSaving] = useState(false);

  const original = agent.settings_path ?? "";
  const dirty = path !== original;

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  const handleSave = async () => {
    setSaving(true);
    try {
      // Tri-state: non-empty → set, empty string → clear (sends "" to backend)
      await onSave({ settings_path: path || "" });
      toast.success(t(($) => $.tab_body.settings.saved_toast));
    } catch (err) {
      toast.error(
        err instanceof Error && err.message
          ? err.message
          : t(($) => $.tab_body.settings.save_failed_toast),
      );
    } finally {
      setSaving(false);
    }
  };

  const handleClear = () => {
    setPath("");
  };

  const provider = runtimeDevice?.provider;
  const launchHeader = runtimeDevice?.launch_header;

  // Provider-specific hint about how the path is applied
  const providerHint =
    provider === "claude"
      ? t(($) => $.tab_body.settings.claude_hint)
      : provider === "opencode"
        ? t(($) => $.tab_body.settings.opencode_hint)
        : null;

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">
            {t(($) => $.tab_body.settings.intro)}
          </p>
          {providerHint && (
            <p className="text-xs text-muted-foreground">{providerHint}</p>
          )}
          {launchHeader && (
            <p className="text-xs text-muted-foreground">
              {t(($) => $.tab_body.settings.launch_mode_prefix)}
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">
                {launchHeader}{" "}
                {provider === "claude"
                  ? `--settings ${path || "<path>"}`
                  : provider === "opencode"
                    ? `OPENCODE_CONFIG=${path || "<path>"}`
                    : ""}
              </code>
            </p>
          )}
        </div>
        {path !== "" && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleClear}
            className="shrink-0"
          >
            <Eraser className="h-3 w-3" />
            {t(($) => $.tab_body.settings.clear_action)}
          </Button>
        )}
      </div>

      <div className="flex items-center gap-2">
        <Settings className="h-4 w-4 shrink-0 text-muted-foreground" />
        <Input
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder={t(($) => $.tab_body.settings.input_placeholder)}
          className="flex-1 font-mono text-xs"
        />
      </div>

      <div className="flex items-center justify-end gap-3">
        {dirty && (
          <span className="text-xs text-muted-foreground">
            {t(($) => $.tab_body.common.unsaved_changes)}
          </span>
        )}
        <Button onClick={handleSave} disabled={!dirty || saving} size="sm">
          {saving ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Save className="h-3.5 w-3.5" />
          )}
          {t(($) => $.tab_body.common.save)}
        </Button>
      </div>
    </div>
  );
}