import type {
  AgentRuntime,
  RuntimeUsage,
  RuntimeUsageByAgent,
} from "@multica/core/types";

// A live local daemon re-registers itself within seconds of a server-side
// delete (daemon self-heal, #2404), so deleting an online local runtime from
// the UI has no lasting effect. Both the detail page and the list row menu
// gate their Delete affordance on this same predicate.
export function isSelfHealingRuntime(runtime: AgentRuntime): boolean {
  return runtime.runtime_mode === "local" && runtime.status === "online";
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

// Compound-unit relative timestamp ("2m 14s ago", "1d 4h ago", "6d 19h ago")
// — gives the user enough precision to tell "just lost" from "long lost"
// at a glance without forcing them to mouse-over for a full timestamp.
export function formatLastSeen(lastSeenAt: string | null): string {
  if (!lastSeenAt) return "Never";
  const diffMs = Date.now() - new Date(lastSeenAt).getTime();
  if (diffMs < 5_000) return "Just now";

  const seconds = Math.floor(diffMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (minutes < 1) return `${seconds}s ago`;
  if (hours < 1) {
    const s = seconds % 60;
    return s > 0 ? `${minutes}m ${s}s ago` : `${minutes}m ago`;
  }
  if (days < 1) {
    const m = minutes % 60;
    return m > 0 ? `${hours}h ${m}m ago` : `${hours}h ago`;
  }
  const h = hours % 24;
  return h > 0 ? `${days}d ${h}h ago` : `${days}d ago`;
}

// Turns the back-end's `device_info` string ("MacBook-Pro · darwin-amd64",
// "some-host · linux-amd64") into something humans recognise. We don't have
// hardware model or geo data on the wire today, so we settle for an OS-aware
// rewrite of the GOOS/GOARCH suffix while preserving the hostname.
export function formatDeviceInfo(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed
    .split(" · ")
    .map((part) => prettifyOsArch(part))
    .join(" · ");
}

function prettifyOsArch(part: string): string {
  const lower = part.toLowerCase();
  // Pattern: <os>-<arch>; e.g. darwin-amd64, linux-arm64, windows-amd64.
  const match = lower.match(/^(darwin|linux|windows|freebsd|openbsd|netbsd)-(amd64|arm64|386|arm)$/);
  if (!match) return part;
  const os = match[1] ?? "";
  const arch = match[2] ?? "";
  const osLabel = OS_LABEL[os] ?? os;
  const archLabel = ARCH_LABEL[arch] ?? arch;
  return `${osLabel} (${archLabel})`;
}

const OS_LABEL: Record<string, string> = {
  darwin: "macOS",
  linux: "Linux",
  windows: "Windows",
  freebsd: "FreeBSD",
  openbsd: "OpenBSD",
  netbsd: "NetBSD",
};

const ARCH_LABEL: Record<string, string> = {
  amd64: "x86_64",
  arm64: "arm64",
  "386": "x86",
  arm: "arm",
};

// Strip leading "v" from version strings — GitHub releases ship `v0.2.17`,
// daemon metadata reports `0.2.15`; normalising lets us compare both.
function stripVersionPrefix(v: string): string {
  return v.replace(/^v/, "");
}

// True iff `latest` is strictly newer than `current` by dotted-numeric
// comparison. Non-numeric / missing segments compare as 0 ("0.2" < "0.2.1").
// Used by the runtime-list CLI column to decide whether to surface the ↑
// marker; same logic also lives inline in update-section.tsx for now.
export function isVersionNewer(latest: string, current: string): boolean {
  const l = stripVersionPrefix(latest).split(".").map(Number);
  const c = stripVersionPrefix(current).split(".").map(Number);
  for (let i = 0; i < Math.max(l.length, c.length); i++) {
    const lv = l[i] ?? 0;
    const cv = c[i] ?? 0;
    if (lv > cv) return true;
    if (lv < cv) return false;
  }
  return false;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return m % 1 < 0.05 ? `${Math.round(m)}M` : `${m.toFixed(1)}M`;
  }
  if (n >= 1_000) {
    const k = n / 1_000;
    return k % 1 < 0.05 ? `${Math.round(k)}K` : `${k.toFixed(1)}K`;
  }
  return n.toLocaleString();
}

// ---------------------------------------------------------------------------
// Data aggregation
// ---------------------------------------------------------------------------

export interface DailyTokenData {
  date: string;
  label: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ModelDistribution {
  model: string;
  tokens: number;
}

export interface WeeklyTokenData {
  weekStart: string;
  weekEnd: string;
  // X-axis tick — Monday of the week, e.g. "May 12".
  label: string;
  // Tooltip header — inclusive range, e.g. "May 12 – May 18".
  rangeLabel: string;
  // True when `weekEnd` is in the future (today is mid-week). Surface this
  // in the chart so the bar can be drawn at reduced opacity / striped to
  // signal "don't read this as a finished week".
  partial: boolean;
  daysCovered: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export function aggregateByDate(usage: RuntimeUsage[]): {
  dailyTokens: DailyTokenData[];
  modelDist: ModelDistribution[];
} {
  const dateMap = new Map<string, Omit<DailyTokenData, "label">>();
  const modelMap = new Map<string, { tokens: number }>();

  for (const u of usage) {
    const existing = dateMap.get(u.date) ?? {
      date: u.date,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    };
    existing.input += u.input_tokens;
    existing.output += u.output_tokens;
    existing.cacheRead += u.cache_read_tokens;
    existing.cacheWrite += u.cache_write_tokens;
    dateMap.set(u.date, existing);

    const modelName = u.model || u.provider;
    const m = modelMap.get(modelName) ?? { tokens: 0 };
    m.tokens +=
      u.input_tokens + u.output_tokens + u.cache_read_tokens + u.cache_write_tokens;
    modelMap.set(modelName, m);
  }

  const formatLabel = (d: string) => {
    const date = new Date(d + "T00:00:00");
    return `${date.getMonth() + 1}/${date.getDate()}`;
  };

  const dailyTokens = Array.from(dateMap.values())
    .toSorted((a, b) => a.date.localeCompare(b.date))
    .map((d) => ({ ...d, label: formatLabel(d.date) }));

  const modelDist = [...modelMap.entries()]
    .map(([model, data]) => ({ model, ...data }))
    .sort((a, b) => b.tokens - a.tokens);

  return { dailyTokens, modelDist };
}

// Fold daily-grain rows into ISO calendar weeks (Mon–Sun). Reuses the same
// 180-day cache the daily aggregation reads from — no extra request. The
// latest week is flagged `partial` when today (in the runtime's tz) is
// before Sunday, so the chart can render the in-progress bar at half
// opacity instead of letting the user misread "this week" as a dip.
//
// `weekCount` pins the output to exactly that many trailing calendar weeks
// ending at the week that contains today (in `tz`). Buckets are pre-zeroed,
// so sparse data — including weeks with no usage — renders as empty bars
// rather than disappearing. Rows whose week falls outside the window are
// dropped; without this guard `.slice(-weekCount)` on a sparse 180-day
// aggregate would surface old populated weeks instead of the empty
// in-range buckets the user asked for (MUL-2382 weekly window scoping).
// Accepts any row carrying `date` + token counts. Both `RuntimeUsage`
// (runtime detail) and `DashboardUsageDaily` (workspace dashboard) match
// this shape — there's no behavioural difference, just slightly different
// surrounding fields neither aggregator cares about.
type WeeklyAggregable = Pick<
  RuntimeUsage,
  | "date"
  | "input_tokens"
  | "output_tokens"
  | "cache_read_tokens"
  | "cache_write_tokens"
>;

export function aggregateByWeek(
  usage: readonly WeeklyAggregable[],
  tz: string,
  weekCount: number,
): {
  weeklyTokens: WeeklyTokenData[];
} {
  const count = Math.max(1, Math.floor(weekCount));
  const today = todayIso(tz);
  const currentWeekStart = weekStartIso(today);
  const firstWeekStart = addDaysIso(currentWeekStart, -(count - 1) * 7);

  type TokenAgg = Omit<WeeklyTokenData, "label" | "rangeLabel" | "partial" | "daysCovered" | "weekEnd">;
  const tokenMap = new Map<string, TokenAgg>();

  // Pre-seed every trailing calendar week in the window so sparse / empty
  // weeks still render as zero bars instead of being dropped.
  for (let i = 0; i < count; i++) {
    const wkStart = addDaysIso(firstWeekStart, i * 7);
    tokenMap.set(wkStart, {
      weekStart: wkStart,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
  }

  for (const u of usage) {
    const wkStart = weekStartIso(u.date);
    if (wkStart < firstWeekStart || wkStart > currentWeekStart) continue;
    const tokens = tokenMap.get(wkStart);
    if (!tokens) continue;
    tokens.input += u.input_tokens;
    tokens.output += u.output_tokens;
    tokens.cacheRead += u.cache_read_tokens;
    tokens.cacheWrite += u.cache_write_tokens;
  }

  const decorate = (weekStart: string) => {
    const weekEnd = addDaysIso(weekStart, 6);
    const partial = today < weekEnd;
    // Inclusive count of how many days of this week have actually elapsed.
    // Sits at 7 for closed weeks, 1..6 for the current week.
    const elapsedDays = Math.min(
      7,
      Math.max(
        1,
        // Day index of `today` within [weekStart, weekEnd] + 1.
        diffDaysIso(weekStart, today < weekStart ? weekStart : today < weekEnd ? today : weekEnd) + 1,
      ),
    );
    return {
      weekStart,
      weekEnd,
      label: formatShortDate(weekStart),
      rangeLabel: `${formatShortDate(weekStart)} – ${formatShortDate(weekEnd)}`,
      partial,
      daysCovered: partial ? elapsedDays : 7,
    };
  };

  const weeklyTokens: WeeklyTokenData[] = Array.from(tokenMap.values())
    .toSorted((a, b) => a.weekStart.localeCompare(b.weekStart))
    .map((t) => ({ ...t, ...decorate(t.weekStart) }));

  return { weeklyTokens };
}

// Slice a daily-grain usage series into the user's selected window AND the
// immediately prior window of equal length. "Today" is read in the runtime's
// timezone so the cutoff lands on the same calendar boundary the backend
// used when bucketing rows — without this the browser/runtime tz gap could
// shift the boundary by a day at the edges (#MUL-2382 sliceWindow tz bug).
export function sliceWindow(
  usage: readonly RuntimeUsage[],
  days: number,
  tz: string,
): { filtered: RuntimeUsage[]; prevFiltered: RuntimeUsage[] } {
  const today = todayIso(tz);
  const isoCurrent = addDaysIso(today, -days);
  const isoPrev = addDaysIso(today, -days * 2);
  return {
    filtered: usage.filter((u) => u.date >= isoCurrent),
    prevFiltered: usage.filter(
      (u) => u.date >= isoPrev && u.date < isoCurrent,
    ),
  };
}

function diffDaysIso(from: string, to: string): number {
  const [y1, m1, d1] = from.split("-").map(Number);
  const [y2, m2, d2] = to.split("-").map(Number);
  const a = Date.UTC(y1 ?? 1970, (m1 ?? 1) - 1, d1 ?? 1);
  const b = Date.UTC(y2 ?? 1970, (m2 ?? 1) - 1, d2 ?? 1);
  return Math.round((b - a) / 86_400_000);
}

// ---------------------------------------------------------------------------
// Calendar helpers — all date math runs on YYYY-MM-DD strings in the
// runtime's IANA timezone. The backend already groups daily usage by
// `start-of-day in runtime tz`, so we keep the entire frontend aggregation
// on the same axis (Daily / Weekly) to avoid one-day drift when the browser
// and runtime sit in different time zones.
// ---------------------------------------------------------------------------

// Today's calendar date (YYYY-MM-DD) in the given IANA timezone. `en-CA`
// gives ISO-shaped output without us having to assemble Intl parts by hand.
export function todayIso(tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

// Pure date arithmetic on a YYYY-MM-DD string. Uses UTC under the hood so
// DST transitions never shift the result by an hour and round to a
// neighbouring day.
export function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

// Monday-of-week as YYYY-MM-DD. ISO 8601 week-start, matching the heatmap
// and the team's day-to-day "this week" mental model. Pure string math —
// no `new Date()` reads — so it's stable under any host timezone.
export function weekStartIso(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
  const day = dt.getUTCDay(); // 0 = Sun, 1 = Mon, ..., 6 = Sat
  const offset = (day + 6) % 7; // distance back to Monday
  dt.setUTCDate(dt.getUTCDate() - offset);
  return dt.toISOString().slice(0, 10);
}

// "May 12" — short, locale-aware month/day for a YYYY-MM-DD string. Parsing
// via UTC keeps the displayed day stable regardless of the browser's tz.
export function formatShortDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
  return dt.toLocaleString("en", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

// ---------------------------------------------------------------------------
// Tokens-by-X aggregations
//
// Both "Tokens by …" tabs share the same shape: a sorted list of rows
// where each row carries a key (agent name or model name), total tokens
// and task count. The list components are oblivious to which axis they're
// rendering — they just see {key, tokens, taskCount}.
// ---------------------------------------------------------------------------

export interface TokenByKey {
  key: string;
  tokens: number;
  taskCount: number;
}

// Per-(agent, model) rows → per-agent totals. Sorted by tokens desc so the
// heaviest-usage agent appears first.
export function aggregateTokensByAgent(rows: RuntimeUsageByAgent[]): TokenByKey[] {
  const map = new Map<string, TokenByKey>();
  for (const r of rows) {
    const entry = map.get(r.agent_id) ?? {
      key: r.agent_id,
      tokens: 0,
      taskCount: 0,
    };
    entry.tokens +=
      r.input_tokens + r.output_tokens + r.cache_read_tokens + r.cache_write_tokens;
    entry.taskCount += r.task_count;
    map.set(r.agent_id, entry);
  }
  return Array.from(map.values()).toSorted((a, b) => b.tokens - a.tokens);
}

// Per-(date, model) rows → per-model totals (the "By model" tab reuses the
// daily-grain data we already cache, so no extra request is needed).
export function aggregateTokensByModel(rows: RuntimeUsage[]): TokenByKey[] {
  const map = new Map<string, TokenByKey>();
  for (const r of rows) {
    const key = r.model || r.provider || "unknown";
    const entry = map.get(key) ?? { key, tokens: 0, taskCount: 0 };
    entry.tokens +=
      r.input_tokens + r.output_tokens + r.cache_read_tokens + r.cache_write_tokens;
    map.set(key, entry);
  }
  return Array.from(map.values()).toSorted((a, b) => b.tokens - a.tokens);
}

export function pctChange(current: number, previous: number): number | null {
  if (previous <= 0) return null;
  return Math.round(((current - previous) / previous) * 100);
}
