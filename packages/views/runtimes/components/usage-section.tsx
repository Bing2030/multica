"use client";

import { useMemo, useState } from "react";
import { BarChart3, ChevronRight } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import { useWorkspaceId } from "@multica/core/hooks";
import { agentListOptions } from "@multica/core/workspace/queries";
import type { RuntimeUsage, AgentRuntime } from "@multica/core/types";
import {
  runtimeUsageOptions,
  runtimeUsageByAgentOptions,
} from "@multica/core/runtimes/queries";
import { useViewingTimezone } from "../../common/use-viewing-timezone";
import {
  formatTokens,
  aggregateByDate,
  aggregateByWeek,
  aggregateTokensByAgent,
  aggregateTokensByModel,
  pctChange,
  sliceWindow,
  type TokenByKey,
} from "../utils";
import { KpiCard } from "./shared";
import { ActorAvatar } from "../../common/actor-avatar";
import {
  DailyTokensChart,
  WeeklyTokensChart,
  ActivityHeatmap,
} from "./charts";
import { useT } from "../../i18n";

// Single source of truth for the period selector. KPIs, the When-chart, the
// Cost-by tabs, and the CSV export all read from the same `days` value so
// the labels ("· 30D") and the data slice never disagree.
//
// `dims` declares which dimensions each range is allowed in. 7 days at the
// weekly grain is one bar, so 7d is daily-only; 180d is weekly-only because
// 180 daily bars are visually unreadable.
const TIME_RANGES = [
  { label: "7d", days: 7, dims: ["daily"] as const },
  { label: "30d", days: 30, dims: ["daily", "weekly"] as const },
  { label: "90d", days: 90, dims: ["daily", "weekly"] as const },
  { label: "180d", days: 180, dims: ["weekly"] as const },
] as const;

type TimeRange = (typeof TIME_RANGES)[number]["days"];
type WhenTab = "daily" | "weekly" | "heatmap";

// Default time range per dimension. Switching dimensions resets the period
// to its default rather than keeping a now-invalid value.
const DEFAULT_DAYS_BY_DIM: Record<Exclude<WhenTab, "heatmap">, TimeRange> = {
  daily: 30,
  weekly: 90,
};

function rangesForDim(dim: Exclude<WhenTab, "heatmap">) {
  return TIME_RANGES.filter((r) =>
    (r.dims as readonly string[]).includes(dim),
  );
}

// ---------------------------------------------------------------------------
// Local segmented control. shadcn's Tabs is wired for full tab pages with
// keyboard nav and ARIA semantics that a compact toolbar pill doesn't need.
// Visual: light-grey track + white "raised" active pill.
// ---------------------------------------------------------------------------

function Segmented<T extends string | number>({
  value,
  onChange,
  options,
  disabled,
}: {
  value: T;
  onChange: (v: T) => void;
  options: readonly { label: string; value: T }[];
  disabled?: boolean;
}) {
  return (
    <div
      className={`inline-flex items-center gap-0.5 rounded-md bg-muted p-0.5 ${
        disabled ? "opacity-50" : ""
      }`}
    >
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          disabled={disabled}
          onClick={() => onChange(o.value)}
          className={`rounded-sm px-2.5 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed ${
            o.value === value
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Top-level orchestrator. Owns the time window, fetches a 180-day usage
// cache once, slices it into "current" / "prior" windows for delta math,
// and threads everything into the visual blocks below.
//
// 180 days (vs the older 90) is sized for the Heatmap tab — it shows 26
// weeks (~6 months) so the long view actually looks long. The 7d/30d/90d
// period selector slices client-side.
// ---------------------------------------------------------------------------

export function UsageSection({ runtime }: { runtime: AgentRuntime }) {
  const { t } = useT("runtimes");
  const runtimeId = runtime.id;
  // Reports render in the viewer's timezone — the backend slices the UTC
  // hourly rollup on the same `tz` we pass here, so every frontend window
  // calculation shares one axis with the server.
  const tz = useViewingTimezone();
  const { data: usage = [], isLoading: loading } = useQuery(
    runtimeUsageOptions(runtimeId, 180, tz),
  );
  const [dim, setDim] = useState<Exclude<WhenTab, "heatmap">>("daily");
  const [days, setDays] = useState<TimeRange>(30);

  if (loading) return <UsageSkeleton />;
  if (usage.length === 0) return <UsageEmpty />;

  // Slice the cached 180-day window into the user's selected sub-window AND
  // the immediately prior window of equal length. Tz-aware so the cutoff
  // lands on the same calendar boundary the backend used when bucketing rows.
  const { filtered, prevFiltered } = sliceWindow(usage, days, tz);

  const allowedRanges = rangesForDim(dim);
  const handleDimChange = (next: Exclude<WhenTab, "heatmap">) => {
    setDim(next);
    const stillAllowed = (rangesForDim(next) as readonly { days: number }[]).some(
      (r) => r.days === days,
    );
    if (!stillAllowed) {
      setDays(DEFAULT_DAYS_BY_DIM[next]);
    }
  };
  const totals = computeTotals(filtered);
  const prevTotals = computeTotals(prevFiltered);

  const tokensTotal =
    totals.input + totals.output + totals.cacheRead + totals.cacheWrite;
  const prevTokensTotal =
    prevTotals.input + prevTotals.output + prevTotals.cacheRead + prevTotals.cacheWrite;
  const cacheableTokens = totals.input + totals.cacheRead;
  const cacheHitRate =
    cacheableTokens > 0 ? Math.round((totals.cacheRead / cacheableTokens) * 100) : 0;
  const tokensDelta = pctChange(tokensTotal, prevTokensTotal);

  return (
    <div className="space-y-5">
      {/* Page-wide period selector. Lives at the top because it controls
          basically everything below: the KPI numbers and labels, the
          daily / weekly chart window, and the tokens-by aggregations. The
          Heatmap tab is the only sub-view that ignores it (always shows
          26 weeks), and its tab disables this control to telegraph that. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="text-xs uppercase tracking-wider text-muted-foreground">
            {t(($) => $.usage.dimension_label)}
          </span>
          <Segmented
            value={dim}
            onChange={handleDimChange}
            options={
              [
                { label: t(($) => $.usage.when_tab_daily), value: "daily" },
                { label: t(($) => $.usage.when_tab_weekly), value: "weekly" },
              ] as const
            }
          />
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs uppercase tracking-wider text-muted-foreground">
            {t(($) => $.usage.period_label)}
          </span>
          <Segmented
            value={days}
            onChange={setDays}
            options={allowedRanges.map((r) => ({
              label: r.label,
              value: r.days,
            }))}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 divide-x rounded-lg border bg-card">
        <KpiCard
          label={t(($) => $.usage.kpi_tokens_label, { days })}
          value={formatTokens(tokensTotal)}
          hint={
            <span>
              {t(($) => $.usage.kpi_tokens_hint, {
                input: formatTokens(totals.input),
                output: formatTokens(totals.output),
              })}
              {tokensDelta != null && (
                <span
                  className={
                    tokensDelta > 0
                      ? "ml-2 text-warning"
                      : tokensDelta < 0
                        ? "ml-2 text-success"
                        : "ml-2"
                  }
                >
                  {t(($) => $.usage.kpi_tokens_delta, {
                    sign: tokensDelta > 0 ? "+" : "",
                    pct: tokensDelta,
                  })}
                </span>
              )}
            </span>
          }
        />
        <KpiCard
          label={t(($) => $.usage.kpi_cache_label, { days })}
          value={`${cacheHitRate}%`}
          accent={cacheHitRate > 0 ? "success" : "default"}
          hint={
            <span>
              {t(($) => $.usage.kpi_cache_hint, {
                pct: cacheHitRate,
                reads: formatTokens(totals.cacheRead),
              })}
            </span>
          }
        />
      </div>

      {/* Layer 2 — WHEN chart. Dimension (Daily / Weekly) is owned by the
          parent so the period selector at the top can react to it. The
          Heatmap is an independent toggle inside this card — it ignores
          the period selector by design (it's a fixed 26-week long-view). */}
      <WhenChart
        usage={usage}
        filtered={filtered}
        days={days}
        dim={dim}
        tz={tz}
      />

      {/* Layer 3 — WHO/WHAT burned the tokens. */}
      <TokensByBlock runtimeId={runtimeId} days={days} usage={filtered} tz={tz} />

      {/* Layer 4 — Folded raw view. The Heatmap used to live here too; it
          was promoted into the WHEN chart's toggle, leaving only the
          breakdown table behind. */}
      <FoldedRow usage={filtered} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// WhenChart — answers "WHEN was this runtime spending money?".
// Dimension (Daily / Weekly) is owned by the parent so the page-level
// period selector can react to it. Heatmap is an independent view toggled
// inside this card; it ignores both the dimension and the period selector,
// always showing the long 26-week view.
// ---------------------------------------------------------------------------

type Dim = Exclude<WhenTab, "heatmap">;

function WhenChart({
  usage,
  filtered,
  days,
  dim,
  tz,
}: {
  usage: RuntimeUsage[];
  filtered: RuntimeUsage[];
  days: TimeRange;
  dim: Dim;
  tz: string;
}) {
  const { t } = useT("runtimes");
  // Heatmap is the "independent" sibling — toggled here, not part of the
  // page-level dimension segmented (per the RFC).
  const [showHeatmap, setShowHeatmap] = useState(false);

  const { dailyTokens } = useMemo(
    () => aggregateByDate(filtered),
    [filtered],
  );
  // Weekly aggregation builds exactly N trailing calendar weeks anchored at
  // today (in the runtime tz). Buckets are pre-zeroed inside aggregateByWeek
  // so weeks with no usage render as empty bars; rows outside the window are
  // dropped. This avoids the earlier bug where slicing on a sparse 180-day
  // aggregate surfaced old populated weeks instead of in-range empty ones.
  const weekCount = Math.max(1, Math.ceil(days / 7));
  const { weeklyTokens } = useMemo(
    () => aggregateByWeek(usage, tz, weekCount),
    [usage, tz, weekCount],
  );

  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h4 className="text-sm font-semibold">{t(($) => $.usage.when_title)}</h4>
          {/* Heatmap toggle — independent of the page-level dim segmented.
              "On" puts the card into a fixed 26-week long-view that ignores
              the period selector. */}
          <button
            type="button"
            onClick={() => setShowHeatmap((v) => !v)}
            className={`rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
              showHeatmap
                ? "border-foreground bg-foreground text-background"
                : "border-border text-muted-foreground hover:text-foreground"
            }`}
            aria-pressed={showHeatmap}
          >
            {t(($) => $.usage.when_tab_heatmap)}
          </button>
        </div>
        {!showHeatmap && <ChartLegend includeCacheRead />}
      </div>

      {showHeatmap && (
        <p className="mb-2 text-center text-xs text-muted-foreground">
          {t(($) => $.usage.heatmap_caption)}
        </p>
      )}

      <div className="min-h-[260px]">
        {showHeatmap ? (
          <ActivityHeatmap usage={usage} tz={tz} />
        ) : dim === "daily" ? (
          <DailyTab tokensData={dailyTokens} usage={filtered} />
        ) : (
          <WeeklyTab tokensData={weeklyTokens} usage={filtered} />
        )}
      </div>
    </div>
  );
}

function DailyTab({
  tokensData,
  usage,
}: {
  tokensData: Parameters<typeof DailyTokensChart>[0]["data"];
  usage: RuntimeUsage[];
}) {
  const totalTokens = tokensData.reduce(
    (s, d) => s + d.input + d.output + d.cacheRead + d.cacheWrite,
    0,
  );
  if (totalTokens === 0) return <EmptyChartState usage={usage} />;
  return <DailyTokensChart data={tokensData} />;
}

function WeeklyTab({
  tokensData,
  usage,
}: {
  tokensData: Parameters<typeof WeeklyTokensChart>[0]["data"];
  usage: RuntimeUsage[];
}) {
  const totalTokens = tokensData.reduce(
    (s, d) => s + d.input + d.output + d.cacheRead + d.cacheWrite,
    0,
  );
  if (totalTokens === 0) return <EmptyChartState usage={usage} />;
  return <WeeklyTokensChart data={tokensData} />;
}

// ---------------------------------------------------------------------------
// EmptyChartState — shown when no tokens were recorded in the window.
// ---------------------------------------------------------------------------

function EmptyChartState({ usage }: { usage: RuntimeUsage[] }) {
  const { t } = useT("runtimes");
  const hasTokens = usage.some(
    (u) =>
      u.input_tokens + u.output_tokens + u.cache_read_tokens + u.cache_write_tokens >
      0,
  );

  return (
    <div className="flex aspect-[3/1] flex-col items-center justify-center gap-2 rounded-md border border-dashed bg-muted/20 p-6 text-center">
      <BarChart3 className="h-5 w-5 text-muted-foreground/50" />
      {!hasTokens ? (
        <p className="text-xs text-muted-foreground">
          {t(($) => $.usage.empty_no_usage)}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          {t(($) => $.usage.empty_no_usage)}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chart legend — coloured dots + labels, rendered in WhenChart's header so
// the chart body keeps its full vertical real estate. The tokens stack has
// four segments (input / output / cache read / cache write).
// ---------------------------------------------------------------------------

function ChartLegend({ includeCacheRead = false }: { includeCacheRead?: boolean }) {
  const { t } = useT("runtimes");
  const items = [
    { label: t(($) => $.usage.legend_input), color: "var(--color-chart-1)" },
    { label: t(($) => $.usage.legend_output), color: "var(--color-chart-2)" },
    ...(includeCacheRead
      ? [{ label: t(($) => $.usage.legend_cache_read), color: "var(--color-chart-4)" }]
      : []),
    { label: t(($) => $.usage.legend_cache_write), color: "var(--color-chart-3)" },
  ];
  return (
    <div className="flex items-center gap-3 text-xs text-muted-foreground">
      {items.map((it) => (
        <span key={it.label} className="inline-flex items-center gap-1.5">
          <span
            className="h-2 w-2 rounded-sm"
            style={{ background: it.color }}
          />
          {it.label}
        </span>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tokens-by block: two-tab attribution view (by agent / by model).
// ---------------------------------------------------------------------------

function TokensByBlock({
  runtimeId,
  days,
  usage,
  tz,
}: {
  runtimeId: string;
  days: number;
  usage: RuntimeUsage[];
  tz: string;
}) {
  const { t } = useT("runtimes");
  const [tab, setTab] = useState<"agent" | "model">("agent");

  // by-agent is server-side aggregation (fetched lazily on tab activation).
  // by-model derives from the daily cache the parent already has — free.
  const { data: byAgentRows = [] } = useQuery({
    ...runtimeUsageByAgentOptions(runtimeId, days, tz),
    enabled: tab === "agent",
  });

  const wsId = useWorkspaceId();
  const { data: agents = [] } = useQuery(agentListOptions(wsId));

  const byAgent = useMemo(
    () => aggregateTokensByAgent(byAgentRows),
    [byAgentRows],
  );
  const byModel = useMemo(
    () => aggregateTokensByModel(usage),
    [usage],
  );

  const caption =
    tab === "agent"
      ? t(($) => $.usage.tokens_by_caption_agent, { count: byAgent.length })
      : t(($) => $.usage.tokens_by_caption_model, { count: byModel.length });

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-3">
        <div className="flex items-center gap-3">
          <h4 className="text-sm font-semibold">
            {tab === "agent"
              ? t(($) => $.usage.tokens_by_title_agent)
              : t(($) => $.usage.tokens_by_title_model)}
          </h4>
          <Segmented
            value={tab}
            onChange={setTab}
            options={
              [
                { label: t(($) => $.usage.tokens_by_tab_agent), value: "agent" },
                { label: t(($) => $.usage.tokens_by_tab_model), value: "model" },
              ] as const
            }
          />
        </div>
        <span className="text-xs text-muted-foreground">{caption}</span>
      </div>
      <div className="pt-4">
        {tab === "agent" && (
          <TokensByList
            rows={byAgent}
            renderKey={(key) => {
              const agent = agents.find((a) => a.id === key);
              return (
                <div className="flex min-w-0 items-center gap-2">
                  <ActorAvatar actorType="agent" actorId={key} size={22} enableHoverCard />
                  <span className="cursor-pointer truncate text-sm font-medium">
                    {agent?.name ?? key}
                  </span>
                </div>
              );
            }}
          />
        )}
        {tab === "model" && (
          <TokensByList
            rows={byModel}
            renderKey={(key) => (
              <span className="truncate font-mono text-xs text-foreground">
                {key}
              </span>
            )}
          />
        )}
      </div>
    </div>
  );
}

// Generic horizontal-bar list shared by both Tokens-by tabs. Each row scales
// its bar relative to the heaviest row in the set, so the visual ranking
// is always 0..max and the biggest user visually fills the column. The
// prominent figure is the token count; task count is the secondary hint.
function TokensByList({
  rows,
  renderKey,
  emptyHint,
}: {
  rows: TokenByKey[];
  renderKey: (key: string) => React.ReactNode;
  emptyHint?: string;
}) {
  const { t } = useT("runtimes");
  if (rows.length === 0) {
    return (
      <p className="py-4 text-center text-xs text-muted-foreground">
        {emptyHint ?? t(($) => $.usage.empty_no_usage)}
      </p>
    );
  }
  const maxTokens = rows.reduce((m, r) => Math.max(m, r.tokens), 0);
  return (
    <div className="space-y-2">
      {rows.map((row) => {
        const pct = maxTokens > 0 ? (row.tokens / maxTokens) * 100 : 0;
        return (
          <div
            key={row.key}
            className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)_6rem_5rem] items-center gap-3 py-1"
          >
            <div className="min-w-0">{renderKey(row.key)}</div>
            <div className="relative h-2 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-chart-1"
                style={{ width: `${pct}%` }}
              />
            </div>
            <div className="text-right text-sm font-medium tabular-nums">
              {formatTokens(row.tokens)}
            </div>
            <div className="text-right text-xs tabular-nums text-muted-foreground">
              {t(($) => $.usage.tokens_by_tasks, { count: row.taskCount })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Folded row — single chevron-toggle link revealing the raw breakdown
// table. The Activity heatmap used to live here too; it was promoted to a
// WhenChart toggle, leaving only the breakdown table behind.
// ---------------------------------------------------------------------------

function FoldedRow({ usage }: { usage: RuntimeUsage[] }) {
  const { t } = useT("runtimes");
  const [open, setOpen] = useState(false);
  return (
    <div className="border-t pt-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronRight
          className={`h-3 w-3 transition-transform ${open ? "rotate-90" : ""}`}
        />
        {t(($) => $.usage.daily_breakdown_toggle)}
      </button>
      {open && (
        <div className="mt-3 rounded-md border p-4">
          <DailyBreakdownTable usage={usage} />
        </div>
      )}
    </div>
  );
}

function DailyBreakdownTable({ usage }: { usage: RuntimeUsage[] }) {
  const { t } = useT("runtimes");
  const byDate = new Map<string, RuntimeUsage[]>();
  for (const u of usage) {
    const existing = byDate.get(u.date) ?? [];
    existing.push(u);
    byDate.set(u.date, existing);
  }
  return (
    <div className="rounded-lg border">
      <div className="grid grid-cols-[100px_1fr_80px_80px_80px_80px] gap-2 border-b px-3 py-2 text-xs font-medium text-muted-foreground">
        <div>{t(($) => $.usage.table_date)}</div>
        <div>{t(($) => $.usage.table_model)}</div>
        <div className="text-right">{t(($) => $.usage.table_input)}</div>
        <div className="text-right">{t(($) => $.usage.table_output)}</div>
        <div className="text-right">{t(($) => $.usage.table_cache_r)}</div>
        <div className="text-right">{t(($) => $.usage.table_cache_w)}</div>
      </div>
      <div className="max-h-64 overflow-y-auto divide-y">
        {[...byDate.entries()].map(([date, rows]) =>
          rows.map((row, i) => (
            <div
              key={`${date}-${row.model}-${i}`}
              className="grid grid-cols-[100px_1fr_80px_80px_80px_80px] gap-2 px-3 py-1.5 text-xs"
            >
              <div className="text-muted-foreground">{date}</div>
              <div className="truncate font-mono">{row.model}</div>
              <div className="text-right tabular-nums">
                {formatTokens(row.input_tokens)}
              </div>
              <div className="text-right tabular-nums">
                {formatTokens(row.output_tokens)}
              </div>
              <div className="text-right tabular-nums">
                {formatTokens(row.cache_read_tokens)}
              </div>
              <div className="text-right tabular-nums">
                {formatTokens(row.cache_write_tokens)}
              </div>
            </div>
          )),
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Loading + empty states
// ---------------------------------------------------------------------------

function UsageSkeleton() {
  return (
    <div className="space-y-5">
      <Skeleton className="h-28 rounded-lg" />
      <Skeleton className="h-56 rounded-lg" />
      <Skeleton className="h-32" />
    </div>
  );
}

function UsageEmpty() {
  const { t } = useT("runtimes");
  return (
    <div className="flex flex-col items-center rounded-lg border border-dashed py-8">
      <BarChart3 className="h-5 w-5 text-muted-foreground/40" />
      <p className="mt-2 text-xs text-muted-foreground">
        {t(($) => $.usage.no_data)}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

function computeTotals(rows: RuntimeUsage[]): UsageTotals {
  return rows.reduce<UsageTotals>(
    (acc, u) => ({
      input: acc.input + u.input_tokens,
      output: acc.output + u.output_tokens,
      cacheRead: acc.cacheRead + u.cache_read_tokens,
      cacheWrite: acc.cacheWrite + u.cache_write_tokens,
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  );
}

