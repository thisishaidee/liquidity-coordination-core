import { describe, expect, it } from "vitest";
import {
  canCreateTelegramRequest,
  canReviewTelegramRequest,
  isTelegramDraftCancellable,
  isValidTelegramRequestPurpose,
  parseTelegramRequestAmount
} from "../src/telegram-request";

describe("Telegram request permissions", () => {
  it("allows request creation only for explicitly authorised approvers", () => {
    expect(canCreateTelegramRequest("approver")).toBe(true);
    expect(canCreateTelegramRequest("viewer")).toBe(false);
    expect(canCreateTelegramRequest(undefined)).toBe(false);
    expect(canCreateTelegramRequest("admin")).toBe(false);
  });

  it("allows a different approver to review a Telegram-originated request", () => {
    expect(canReviewTelegramRequest("approver", "100", "user-a", "200", "user-b")).toBe(true);
    expect(canReviewTelegramRequest("viewer", "100", "user-a", "200", "user-b")).toBe(false);
  });

  it("prevents the exact requesting Telegram identity from approving its own request", () => {
    expect(canReviewTelegramRequest("approver", "100", "user-a", "100", "user-a")).toBe(false);
    expect(canReviewTelegramRequest("approver", "100", "user-a", "100", "user-b")).toBe(true);
    expect(canReviewTelegramRequest("approver", "100", "user-a", "200", "user-a")).toBe(true);
  });
});

describe("Telegram request draft controls", () => {
  it("allows cancellation before submission but not after submission begins", () => {
    expect(isTelegramDraftCancellable("agent")).toBe(true);
    expect(isTelegramDraftCancellable("amount")).toBe(true);
    expect(isTelegramDraftCancellable("purpose")).toBe(true);
    expect(isTelegramDraftCancellable("confirm")).toBe(true);
    expect(isTelegramDraftCancellable("submitting")).toBe(false);
    expect(isTelegramDraftCancellable(null)).toBe(false);
  });

  it("accepts positive USDC amounts at six-decimal precision", () => {
    expect(parseTelegramRequestAmount("25")).toBe(25_000_000n);
    expect(parseTelegramRequestAmount("12.50")).toBe(12_500_000n);
    expect(parseTelegramRequestAmount("0.000001")).toBe(1n);
  });

  it("rejects zero, negative, malformed, over-precision and out-of-range amounts", () => {
    for (const value of ["0", "-1", "abc", "1.0000001", "9000000000001"]) {
      expect(() => parseTelegramRequestAmount(value)).toThrow();
    }
  });

  it("enforces a trimmed purpose of at least three characters and a 300-character maximum", () => {
    expect(isValidTelegramRequestPurpose("Payroll")).toBe(true);
    expect(isValidTelegramRequestPurpose("  rent  ")).toBe(true);
    expect(isValidTelegramRequestPurpose("  a ")).toBe(false);
    expect(isValidTelegramRequestPurpose("x".repeat(301))).toBe(false);
  });
});
