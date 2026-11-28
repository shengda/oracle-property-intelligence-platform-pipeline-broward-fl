import { expect, test } from "vitest";
import { budgetFromEnv, createBudgetGuard } from "../../src/agent/budget.ts";
import { envPositiveNumber } from "../../src/util/env.ts";

test("unset or empty settings fall back to the default; set ones are used", () => {
  expect(envPositiveNumber({}, "X", 6)).toBe(6);
  expect(envPositiveNumber({ X: "" }, "X", 6)).toBe(6);
  expect(envPositiveNumber({ X: "  " }, "X", 6)).toBe(6);
  expect(envPositiveNumber({ X: "12" }, "X", 6)).toBe(12);
});

test("a zero, negative or non-numeric setting is a configuration error naming the variable", () => {
  for (const v of ["0", "-1", "abc"]) {
    expect(() => envPositiveNumber({ X: v }, "X", 6)).toThrow(/X must be a positive number/);
  }
});

test("a .env with the optional agent lines left empty gets the default budget, not zero", () => {
  const guard = budgetFromEnv({ ORACLE_AGENT_DAILY_TOKENS: "", ORACLE_AGENT_PER_IP_PER_MINUTE: "" });
  expect((guard as ReturnType<typeof createBudgetGuard>).status().limit).toBe(3_000_000);
  expect(guard.check("1.2.3.4")).toBeNull();
});
