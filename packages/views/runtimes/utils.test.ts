import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import type { AgentRuntime, RuntimeUsage, RuntimeUsageByAgent } from "@multica/core/types";

import {
  addDaysIso,
  aggregateByWeek,
  aggregateTokensByAgent,
  aggregateTokensByModel,
  isSelfHealingRuntime,
  sliceWindow,
  todayIso,
  weekStartIso,
} from "./utils";

const zeroUsage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
};

describe("isSelfHealingRuntime", () => {
  function makeRuntime(overrides: Partial<AgentRuntime>): AgentRuntime {
    return {
      id: "rt-1",
      workspace_id: "ws-1",
      daemon_id: null,
      name: "rt",
      runtime_mode: "local",
      provider: "claude",
      launch_header: "",
      status: "online",
      device_info: "",
      metadata: {},
      owner_id: null,
      visibility: "private",
      last_seen_at: null,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      ...overrides,
    };
  }

  it("flags an online local runtime as self-healing", () => {
    expect(
      isSelfHealingRuntime(
        makeRuntime({ runtime_mode: "local", status: "online" }),
      ),
    ).toBe(true);
  });

  it("treats an offline local runtime as safe to delete", () => {
    // Daemon isn't running, so the server-side delete is final — no
    // re-registration race to worry about.
    expect(
      isSelfHealingRuntime(
        makeRuntime({ runtime_mode: "local", status: "offline" }),
      ),
    ).toBe(false);
  });

  it("treats cloud runtimes as safe to delete regardless of status", () => {
    // Cloud workers are managed by Fleet, not a self-restarting local daemon.
    expect(
      isSelfHealingRuntime(
        makeRuntime({ runtime_mode: "cloud", status: "online" }),
      ),
    ).toBe(false);
    expect(
      isSelfHealingRuntime(
        makeRuntime({ runtime_mode: "cloud", status: "offline" }),
      ),
    ).toBe(false);
  });
});

describe("aggregateTokensByModel", () => {
  it("folds per-(date, model) rows into per-model token totals, sorted desc", () => {
    const rows = [
      {
        ...zeroUsage,
        model: "claude-sonnet-4-6",
        input_tokens: 1_000,
        output_tokens: 500,
        date: "2026-05-10",
        provider: "anthropic",
        runtime_id: "r",
      },
      {
        ...zeroUsage,
        model: "gpt-5-codex",
        input_tokens: 5_000,
        output_tokens: 0,
        date: "2026-05-10",
        provider: "openai",
        runtime_id: "r",
      },
      {
        ...zeroUsage,
        model: "claude-sonnet-4-6",
        input_tokens: 2_000,
        output_tokens: 0,
        date: "2026-05-11",
        provider: "anthropic",
        runtime_id: "r",
      },
    ] as RuntimeUsage[];
    const byModel = aggregateTokensByModel(rows);
    // Sorted by tokens desc: gpt-5-codex (5000) before claude-sonnet-4-6 (3500).
    expect(byModel.map((r) => r.key)).toEqual([
      "gpt-5-codex",
      "claude-sonnet-4-6",
    ]);
    // claude-sonnet-4-6: 1000+500+2000 = 3500; gpt-5-codex: 5000.
    expect(byModel[0]?.tokens).toBe(5000);
    expect(byModel[1]?.tokens).toBe(3500);
  });
});

describe("aggregateTokensByAgent", () => {
  it("folds per-(agent, model) rows into per-agent token totals, sorted desc", () => {
    const rows = [
      {
        agent_id: "agent-a",
        model: "claude-sonnet-4-6",
        input_tokens: 1_000,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        task_count: 1,
      },
      {
        agent_id: "agent-b",
        model: "gpt-5-codex",
        input_tokens: 5_000,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        task_count: 2,
      },
      {
        agent_id: "agent-a",
        model: "gpt-5-codex",
        input_tokens: 2_000,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        task_count: 1,
      },
    ] as RuntimeUsageByAgent[];
    const byAgent = aggregateTokensByAgent(rows);
    // Sorted by tokens desc: agent-b (5000) before agent-a (3000).
    expect(byAgent.map((r) => r.key)).toEqual(["agent-b", "agent-a"]);
    // agent-a: 1000 + 2000 = 3000; agent-b: 5000.
    expect(byAgent[0]?.tokens).toBe(5000);
    expect(byAgent[0]?.taskCount).toBe(2);
    expect(byAgent[1]?.tokens).toBe(3000);
    expect(byAgent[1]?.taskCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Calendar helpers + weekly aggregation. All of these run on YYYY-MM-DD
// strings (the wire shape of RuntimeUsage.date) and on a runtime-supplied
// IANA timezone — the host browser's tz should never affect the result.
// ---------------------------------------------------------------------------

describe("weekStartIso", () => {
  it("returns the Monday of the same ISO week", () => {
    // 2026-05-19 is a Tuesday → Monday is 2026-05-18.
    expect(weekStartIso("2026-05-19")).toBe("2026-05-18");
  });

  it("treats Monday as the start of its own week (idempotent)", () => {
    expect(weekStartIso("2026-05-18")).toBe("2026-05-18");
  });

  it("rolls Sunday back to the previous Monday", () => {
    // 2026-05-17 is a Sunday → Monday is 2026-05-11.
    expect(weekStartIso("2026-05-17")).toBe("2026-05-11");
  });

  it("crosses month and year boundary", () => {
    // 2026-01-03 is a Saturday → Monday is 2025-12-29.
    expect(weekStartIso("2026-01-03")).toBe("2025-12-29");
  });
});

describe("addDaysIso", () => {
  it("adds across month boundary", () => {
    expect(addDaysIso("2026-05-30", 3)).toBe("2026-06-02");
  });

  it("subtracts across year boundary", () => {
    expect(addDaysIso("2026-01-02", -5)).toBe("2025-12-28");
  });
});

describe("todayIso", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses the runtime's timezone, not the host's, to decide today", () => {
    // 2026-05-19 16:00 UTC. In Asia/Shanghai (UTC+8) it's already 2026-05-20.
    // In America/Los_Angeles (UTC-7 on this date) it's still 2026-05-19.
    vi.setSystemTime(new Date("2026-05-19T16:00:00Z"));
    expect(todayIso("Asia/Shanghai")).toBe("2026-05-20");
    expect(todayIso("America/Los_Angeles")).toBe("2026-05-19");
    expect(todayIso("UTC")).toBe("2026-05-19");
  });
});

describe("sliceWindow (timezone-aware)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function makeUsage(date: string): RuntimeUsage {
    return {
      runtime_id: "r",
      date,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    };
  }

  it("cuts the current window at today-in-tz, not today-in-host-utc", () => {
    // Host clock is 2026-05-19 23:00 UTC → still May 19 in UTC, May 20 in Shanghai.
    // A daily-usage row dated 2026-05-20 (the runtime's "today" in Shanghai)
    // should be included in the current window when tz=Asia/Shanghai.
    vi.setSystemTime(new Date("2026-05-19T23:00:00Z"));
    const usage = [
      makeUsage("2026-05-13"),
      makeUsage("2026-05-19"),
      makeUsage("2026-05-20"),
    ];
    const { filtered } = sliceWindow(usage, 7, "Asia/Shanghai");
    expect(filtered.map((u) => u.date)).toEqual([
      "2026-05-13",
      "2026-05-19",
      "2026-05-20",
    ]);
  });

  it("returns the immediately prior window of equal length", () => {
    vi.setSystemTime(new Date("2026-05-19T12:00:00Z"));
    const usage = [
      makeUsage("2026-05-01"),
      makeUsage("2026-05-08"),
      makeUsage("2026-05-15"),
      makeUsage("2026-05-19"),
    ];
    const { filtered, prevFiltered } = sliceWindow(usage, 7, "UTC");
    expect(filtered.map((u) => u.date)).toEqual(["2026-05-15", "2026-05-19"]);
    expect(prevFiltered.map((u) => u.date)).toEqual(["2026-05-08"]);
  });
});

describe("aggregateByWeek", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function makeUsage(
    date: string,
    input: number,
    output: number,
  ): RuntimeUsage {
    return {
      runtime_id: "r",
      date,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      input_tokens: input,
      output_tokens: output,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    };
  }

  it("groups daily rows into Mon-anchored ISO weeks", () => {
    // 2026-05-24 is Sunday, so the calendar week containing "today" is
    // Mon=05-18..Sun=05-24. With weekCount=2 the window covers weeks
    // 2026-05-11 and 2026-05-18 — exactly the two weeks the rows fall in.
    vi.setSystemTime(new Date("2026-05-24T12:00:00Z"));
    // 2026-05-11 is Mon; 2026-05-17 is Sun (same week).
    // 2026-05-18 is Mon (next week).
    const rows = [
      makeUsage("2026-05-11", 1_000_000, 0),
      makeUsage("2026-05-17", 0, 1_000_000),
      makeUsage("2026-05-18", 2_000_000, 0),
    ];
    const { weeklyTokens } = aggregateByWeek(rows, "UTC", 2);
    expect(weeklyTokens).toHaveLength(2);
    expect(weeklyTokens[0]).toMatchObject({
      weekStart: "2026-05-11",
      weekEnd: "2026-05-17",
      input: 1_000_000,
      output: 1_000_000,
      partial: false,
      daysCovered: 7,
    });
    expect(weeklyTokens[1]).toMatchObject({
      weekStart: "2026-05-18",
      weekEnd: "2026-05-24",
      input: 2_000_000,
      partial: false,
      daysCovered: 7,
    });
  });

  it("flags the in-progress week as partial with days-elapsed count", () => {
    // 2026-05-20 is a Wednesday (Mon=05-18, Sun=05-24).
    vi.setSystemTime(new Date("2026-05-20T08:00:00Z"));
    const rows = [makeUsage("2026-05-18", 1_000_000, 0)];
    const { weeklyTokens } = aggregateByWeek(rows, "UTC", 1);
    expect(weeklyTokens[0]).toMatchObject({
      weekStart: "2026-05-18",
      weekEnd: "2026-05-24",
      partial: true,
      daysCovered: 3, // Mon, Tue, Wed
    });
  });

  it("emits trailing calendar weeks pinned to today, dropping older populated weeks", () => {
    // Regression for MUL-2382 weekly window scoping:
    // before the fix, aggregateByWeek built buckets only for weeks that had
    // data and the caller did `.slice(-weekCount)`. With sparse data (an old
    // populated week far outside the selected window plus an empty stretch
    // closer to today), that slice would surface the OLD populated week
    // instead of the trailing in-window weeks. The chart should now show
    // exactly the trailing calendar weeks, with the empty in-range weeks
    // present as zero-valued buckets rather than disappearing.
    vi.setSystemTime(new Date("2026-05-19T12:00:00Z"));
    // 30-day window @ 2026-05-19 → 5 trailing weeks (Mon=04-20, 04-27,
    // 05-04, 05-11, 05-18). 2026-04-13 (Mon) is one week earlier — outside
    // the window. No data in any of the 5 in-range weeks.
    const rows = [makeUsage("2026-04-13", 1_000_000, 1_000_000)];
    const { weeklyTokens } = aggregateByWeek(rows, "UTC", 5);

    expect(weeklyTokens.map((w) => w.weekStart)).toEqual([
      "2026-04-20",
      "2026-04-27",
      "2026-05-04",
      "2026-05-11",
      "2026-05-18",
    ]);
    // Every in-range week is empty — the old populated week was dropped.
    for (const w of weeklyTokens) {
      expect(w.input).toBe(0);
      expect(w.output).toBe(0);
      expect(w.cacheRead).toBe(0);
      expect(w.cacheWrite).toBe(0);
    }
  });

  it("keeps in-window weeks empty when nearby data sits inside the window", () => {
    // Sparse-but-in-range case: only the oldest in-window week has data;
    // the remaining trailing weeks must render as empty buckets, not be
    // collapsed to a single populated bar.
    vi.setSystemTime(new Date("2026-05-19T12:00:00Z"));
    const rows = [makeUsage("2026-04-22", 1_000_000, 1_000_000)]; // week of 04-20
    const { weeklyTokens } = aggregateByWeek(rows, "UTC", 5);
    expect(weeklyTokens).toHaveLength(5);
    expect(weeklyTokens[0]).toMatchObject({
      weekStart: "2026-04-20",
      input: 1_000_000,
      output: 1_000_000,
    });
    for (const w of weeklyTokens.slice(1)) {
      expect(w.input).toBe(0);
      expect(w.output).toBe(0);
    }
  });
});
