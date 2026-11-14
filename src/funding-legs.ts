export const FUNDING_LEG_STATUSES = [
  "planned",
  "reserved",
  "awaiting_signature",
  "authorized_for_execution",
  "submitted",
  "confirmed",
  "failed",
  "released",
  "expired",
  "ambiguous",
  "cancelled"
] as const;

export type FundingLegStatus = typeof FUNDING_LEG_STATUSES[number];

const ALLOWED_TRANSITIONS: Record<FundingLegStatus, readonly FundingLegStatus[]> = {
  planned: ["reserved", "failed", "expired", "cancelled"],
  reserved: ["awaiting_signature", "authorized_for_execution", "failed", "released", "expired", "cancelled"],
  awaiting_signature: ["submitted", "failed", "expired", "cancelled"],
  authorized_for_execution: ["submitted", "failed", "expired", "cancelled"],
  submitted: ["confirmed", "failed", "ambiguous"],
  confirmed: [],
  failed: [],
  released: [],
  expired: [],
  ambiguous: ["confirmed", "failed"],
  cancelled: []
};

export function canTransitionFundingLeg(from: FundingLegStatus, to: FundingLegStatus): boolean {
  return from === to || ALLOWED_TRANSITIONS[from].includes(to);
}

export function transitionFundingLeg(from: FundingLegStatus, to: FundingLegStatus): FundingLegStatus {
  if (!canTransitionFundingLeg(from, to)) {
    throw new Error("invalid_funding_leg_transition:" + from + "->" + to);
  }
  return to;
}
