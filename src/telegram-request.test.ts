import { describe, expect, it } from "vitest";
import { canCreateTelegramRequest, canReviewTelegramRequest, normalizeTelegramCommand } from "./telegram-request";

describe("Telegram permission roles", () => {
  it("allows requesters to create requests", () => {
    expect(canCreateTelegramRequest("requester")).toBe(true);
  });

  it("allows approvers to create requests for independent review", () => {
    expect(canCreateTelegramRequest("approver")).toBe(true);
  });

  it("keeps viewers read-only", () => {
    expect(canCreateTelegramRequest("viewer")).toBe(false);
  });

  it("allows an approver to review another user's request", () => {
    expect(canReviewTelegramRequest("approver", "100", "200", "300", "400")).toBe(true);
  });

  it("blocks an approver from reviewing their own request", () => {
    expect(canReviewTelegramRequest("approver", "100", "200", "100", "200")).toBe(false);
  });

  it("does not let requesters or viewers approve", () => {
    expect(canReviewTelegramRequest("requester", "100", "200", "300", "400")).toBe(false);
    expect(canReviewTelegramRequest("viewer", "100", "200", "300", "400")).toBe(false);
  });
});

describe("Telegram command naming", () => {
  it("uses the clearer command names", () => {
    expect(normalizeTelegramCommand("/newrequest")).toBe("/newrequest");
    expect(normalizeTelegramCommand("/review")).toBe("/review");
  });

  it("keeps the previous request commands as aliases", () => {
    expect(normalizeTelegramCommand("/request")).toBe("/newrequest");
    expect(normalizeTelegramCommand("/requests")).toBe("/review");
  });

  it("leaves unrelated commands unchanged", () => {
    expect(normalizeTelegramCommand("/status")).toBe("/status");
  });
});
