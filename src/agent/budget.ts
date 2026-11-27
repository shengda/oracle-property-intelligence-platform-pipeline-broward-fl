import { createRateLimiter } from "../mcp/rate-limit.ts";

/** Per-IP request limit plus a daily token budget for the whole server (UTC day). */
export interface BudgetGuard {
  /** null when allowed, else a friendly reason (→ HTTP 429). */
  check(ip: string): string | null;
  record(tokens: number): void;
  status(): { day: string; used: number; limit: number };
}

export function createBudgetGuard(opts: {
  dailyTokens: number;
  perIpPerMinute: number;
  now?: () => number;
}): BudgetGuard {
  const now = opts.now ?? Date.now;
  const limiter = createRateLimiter({ limit: opts.perIpPerMinute, now });
  let day = new Date(now()).toISOString().slice(0, 10);
  let used = 0;
  const roll = () => {
    const d = new Date(now()).toISOString().slice(0, 10);
    if (d !== day) {
      day = d;
      used = 0;
    }
  };
  return {
    check(ip) {
      roll();
      if (used >= opts.dailyTokens)
        return "The agent's daily budget is used up. It resets at midnight UTC — the map, search and MCP tools still work.";
      if (!limiter.allow(ip))
        return "Too many questions in a minute from this address. Please wait a moment and ask again.";
      return null;
    },
    record(tokens) {
      roll();
      used += Math.max(0, tokens);
    },
    status() {
      roll();
      return { day, used, limit: opts.dailyTokens };
    },
  };
}

export function budgetFromEnv(env = process.env): BudgetGuard {
  return createBudgetGuard({
    dailyTokens: Number(env.ORACLE_AGENT_DAILY_TOKENS ?? 3_000_000),
    perIpPerMinute: Number(env.ORACLE_AGENT_PER_IP_PER_MINUTE ?? 6),
  });
}
