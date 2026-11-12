import { parseTokenAmount } from "./core";

const MAX_LEDGER_ATOMS = 9_000_000_000_000_000_000n;

export function normalizeTelegramCommand(command: string): string {
  if (command === "/request") return "/newrequest";
  if (command === "/requests") return "/review";
  return command;
}

export function canCreateTelegramRequest(permission: string | null | undefined): boolean {
  return permission === "requester" || permission === "approver";
}

export function canReviewTelegramRequest(
  permission: string | null | undefined,
  originChatId: string | null | undefined,
  originUserId: string | null | undefined,
  chatId: string,
  userId: string
): boolean {
  if (permission !== "approver") return false;
  const isSameRequester = originChatId === chatId && originUserId === userId;
  return !isSameRequester;
}

export function isTelegramDraftCancellable(step: string | null | undefined): boolean {
  return Boolean(step) && step !== "submitting";
}

export function parseTelegramRequestAmount(value: string): bigint {
  const atoms = parseTokenAmount(value);
  if (atoms > MAX_LEDGER_ATOMS) throw new Error("amount exceeds supported ledger range");
  return atoms;
}

export function isValidTelegramRequestPurpose(value: string): boolean {
  return value.trim().length >= 3 && value.length <= 300;
}
