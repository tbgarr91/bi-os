import { describe, expect, it } from "vitest";
import { add, format, money, MoneyError, parseDecimal, ratioBps, sub, sum } from "./money";

describe("money", () => {
  it("parses decimals exactly with no float drift", () => {
    expect(parseDecimal("50.99", "USD").cents).toBe(5099);
    expect(parseDecimal("0.10", "USD").cents).toBe(10);
    expect(parseDecimal("-25", "USD").cents).toBe(-2500);
    // classic float trap: 0.1 + 0.2
    expect(add(parseDecimal("0.1", "USD"), parseDecimal("0.2", "USD")).cents).toBe(30);
  });
  it("rejects sub-cent and malformed input instead of guessing", () => {
    expect(() => parseDecimal("1.234", "USD")).toThrow(MoneyError);
    expect(() => parseDecimal("abc", "USD")).toThrow(MoneyError);
    expect(() => parseDecimal("", "USD")).toThrow(MoneyError);
  });
  it("refuses to mix currencies", () => {
    expect(() => add(money(100, "USD"), money(100, "EUR"))).toThrow(/currency mismatch/);
    expect(() => sub(money(100, "USD"), money(100, "EUR"))).toThrow(/currency mismatch/);
  });
  it("sums and formats", () => {
    expect(format(sum([money(2045, "USD"), money(550, "USD")], "USD"))).toBe("25.95 USD");
    expect(format(money(-5, "USD"))).toBe("-0.05 USD");
  });
  it("ratio is null (not zero) when the denominator is zero", () => {
    expect(ratioBps(money(100, "USD"), money(0, "USD"))).toBeNull();
    expect(ratioBps(money(2266, "USD"), money(5099, "USD"))).toBe(4444);
  });
});
