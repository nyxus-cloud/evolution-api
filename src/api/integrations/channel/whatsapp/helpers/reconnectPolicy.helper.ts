export const RECONNECT_POLICY = {
  baseDelayMs: 2_000,
  maxDelayMs: 60_000,
  /** Up to this share of the delay is taken off at random, so numbers dropped together do not reconnect together. */
  jitterRatio: 0.2,
  /** An open connection that lasts this long resets the attempt and replacement counters. */
  stableOpenMs: 3 * 60_000,
  /** QR/pairing phase: same fixed delay as before the backoff existed. */
  qrPhaseDelayMs: 3_000,
  /** Consecutive `connectionReplaced` (440) closes, without a stable open between them, that stop reconnecting. */
  replacedLimit: 5,
};

/** WhatsApp ended the session (401 logged out, 403 main device gone, 406 unknown logout): the credentials are useless. */
export const SESSION_GONE_CODES: readonly number[] = [401, 403, 406];

/** 402: the account is temporarily banned. The session may come back, so credentials are kept. */
export const TEMP_BANNED_CODE = 402;

export const CONNECTION_REPLACED_CODE = 440;

/** QR/pairing phase codes that end the attempt (408: the QR codes ran out). Unchanged from upstream. */
export const QR_PHASE_END_CODES: readonly number[] = [401, 402, 403, 406, 408];

export type ReconnectInput = {
  statusCode: number | undefined;
  /** The auth state has `creds.me`: the device finished pairing, so Baileys logs in instead of showing a QR code. */
  paired: boolean;
  /** Unpaired and no QR code shown yet. */
  initialConnection: boolean;
  /** Reconnects scheduled since the last stable open, before this one. */
  attempt: number;
  /** `connectionReplaced` closes since the last stable open, this one included. */
  replacedCount: number;
};

export type ReconnectDecision =
  | { action: 'reconnect'; delayMs: number }
  /** Close the instance and keep the credentials: a manual connect still works. */
  | { action: 'stop' }
  /** Close the instance and remove the credentials. */
  | { action: 'logout' }
  /** First connection of an unpaired instance: the QR code comes next, nothing to do. */
  | { action: 'wait' };

export function backoffDelayMs(attempt: number, random: () => number = Math.random): number {
  const exponent = Math.max(0, Math.min(attempt, 30));
  const capped = Math.min(RECONNECT_POLICY.baseDelayMs * 2 ** exponent, RECONNECT_POLICY.maxDelayMs);

  return Math.round(capped * (1 - RECONNECT_POLICY.jitterRatio * random()));
}

export function decideReconnect(input: ReconnectInput, random: () => number = Math.random): ReconnectDecision {
  const { statusCode, paired, initialConnection, attempt, replacedCount } = input;

  if (!paired) {
    if (initialConnection) return { action: 'wait' };
    if (QR_PHASE_END_CODES.includes(statusCode)) return { action: 'logout' };

    return { action: 'reconnect', delayMs: RECONNECT_POLICY.qrPhaseDelayMs };
  }

  if (SESSION_GONE_CODES.includes(statusCode)) return { action: 'logout' };
  if (statusCode === TEMP_BANNED_CODE) return { action: 'stop' };
  if (statusCode === CONNECTION_REPLACED_CODE && replacedCount >= RECONNECT_POLICY.replacedLimit) {
    return { action: 'stop' };
  }

  return { action: 'reconnect', delayMs: backoffDelayMs(attempt, random) };
}

/** Whether a connection opened at `openedAt` and closed at `closedAt` stayed up long enough to reset the counters. */
export function wasStableOpen(openedAt: number | null, closedAt: number): boolean {
  return openedAt !== null && closedAt - openedAt >= RECONNECT_POLICY.stableOpenMs;
}
