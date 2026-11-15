import { describe, expect, it } from "vitest";
import {
  canTransitionFundingLeg,
  transitionFundingLeg,
  type FundingLegStatus
} from "../src/funding-legs";

describe("multi-leg funding state machine", () => {
  it("allows the normal manual-signature lifecycle", () => {
    const states: FundingLegStatus[] = [
      "planned", "reserved", "awaiting_signature", "submitted", "confirmed"
    ];
    for (let index = 0; index < states.length - 1; index++) {
      expect(canTransitionFundingLeg(states[index], states[index + 1])).toBe(true);
      expect(transitionFundingLeg(states[index], states[index + 1])).toBe(states[index + 1]);
    }
  });

  it("allows pre-authorized execution only after reservation", () => {
    expect(canTransitionFundingLeg("planned", "authorized_for_execution")).toBe(false);
    expect(canTransitionFundingLeg("reserved", "authorized_for_execution")).toBe(true);
    expect(canTransitionFundingLeg("authorized_for_execution", "submitted")).toBe(true);
  });

  it("keeps ambiguous submissions reconcilable without allowing resubmission", () => {
    expect(canTransitionFundingLeg("submitted", "ambiguous")).toBe(true);
    expect(canTransitionFundingLeg("ambiguous", "confirmed")).toBe(true);
    expect(canTransitionFundingLeg("ambiguous", "failed")).toBe(true);
    expect(canTransitionFundingLeg("ambiguous", "submitted")).toBe(false);
  });

  it("makes confirmed and other terminal states immutable", () => {
    for (const terminal of ["confirmed", "failed", "released", "expired", "cancelled"] as const) {
      expect(canTransitionFundingLeg(terminal, terminal)).toBe(true);
      expect(canTransitionFundingLeg(terminal, "submitted")).toBe(false);
    }
  });

  it("rejects skipped or backwards transitions", () => {
    expect(() => transitionFundingLeg("planned", "submitted")).toThrow("invalid_funding_leg_transition");
    expect(() => transitionFundingLeg("confirmed", "failed")).toThrow("invalid_funding_leg_transition");
    expect(canTransitionFundingLeg("submitted", "awaiting_signature")).toBe(false);
  });
});
