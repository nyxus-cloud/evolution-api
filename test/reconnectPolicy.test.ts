import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  backoffDelayMs,
  decideReconnect,
  isPaired,
  RECONNECT_POLICY,
  ReconnectInput,
  wasStableOpen,
} from '@api/integrations/channel/whatsapp/helpers/reconnectPolicy.helper';

const noJitter = () => 0;
const fullJitter = () => 1;

const paired = (statusCode: number | undefined, extra: Partial<ReconnectInput> = {}): ReconnectInput => ({
  statusCode,
  paired: true,
  initialConnection: false,
  attempt: 0,
  replacedCount: 0,
  ...extra,
});

const unpaired = (statusCode: number | undefined, extra: Partial<ReconnectInput> = {}): ReconnectInput => ({
  statusCode,
  paired: false,
  initialConnection: false,
  attempt: 0,
  replacedCount: 0,
  ...extra,
});

describe('paired', () => {
  test('only after pair-success wrote the account', () => {
    assert.equal(isPaired(undefined), false);
    assert.equal(isPaired({}), false);
    assert.equal(isPaired({ me: { id: '5511999999999@s.whatsapp.net' } }), false, 'requestPairingCode sets me first');
    assert.equal(isPaired({ account: {} }), false);
    assert.equal(isPaired({ me: { id: '5511999999999:12@s.whatsapp.net' }, account: { details: 'x' } }), true);
  });
});

describe('QR/pairing phase (unpaired) keeps the upstream behaviour', () => {
  test('the first close before any QR code waits for the QR code, whatever the code', () => {
    for (const code of [undefined, 408, 428, 440, 500, 503, 515, 401]) {
      assert.deepEqual(decideReconnect(unpaired(code, { initialConnection: true })), { action: 'wait' }, `code ${code}`);
    }
  });

  test('408 after a QR code (QR refs ran out) ends the attempt instead of looping', () => {
    assert.deepEqual(decideReconnect(unpaired(408)), { action: 'logout' });
    assert.deepEqual(decideReconnect(unpaired(408, { attempt: 7 })), { action: 'logout' });
  });

  test('401, 402, 403 and 406 end the attempt', () => {
    for (const code of [401, 402, 403, 406]) {
      assert.deepEqual(decideReconnect(unpaired(code)), { action: 'logout' }, `code ${code}`);
    }
  });

  test('other codes reconnect after the fixed 3 s, without backoff', () => {
    for (const code of [undefined, 428, 440, 500, 503, 515]) {
      for (const attempt of [0, 4]) {
        assert.deepEqual(
          decideReconnect(unpaired(code, { attempt }), noJitter),
          { action: 'reconnect', delayMs: 3_000 },
          `code ${code} attempt ${attempt}`,
        );
      }
    }
  });
});

describe('paired instance', () => {
  test('408 (connectionLost/timedOut) reconnects and never logs out, however many attempts', () => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const decision = decideReconnect(paired(408, { attempt }), noJitter);
      assert.equal(decision.action, 'reconnect', `attempt ${attempt}`);
    }
  });

  test('408 reconnects even when the instance never opened in this process (boot after a restart)', () => {
    assert.equal(decideReconnect(paired(408, { initialConnection: true }), noJitter).action, 'reconnect');
  });

  test('transient codes reconnect with the same backoff', () => {
    for (const code of [undefined, 408, 411, 428, 500, 503, 515, 440]) {
      assert.deepEqual(
        decideReconnect(paired(code, { attempt: 2, replacedCount: code === 440 ? 1 : 0 }), noJitter),
        { action: 'reconnect', delayMs: 8_000 },
        `code ${code}`,
      );
    }
  });

  test('401, 403 and 406 mean the session is gone: logout', () => {
    for (const code of [401, 403, 406]) {
      assert.deepEqual(decideReconnect(paired(code)), { action: 'logout' }, `code ${code}`);
    }
  });

  test('402 (temporary ban) stops and keeps the credentials', () => {
    assert.deepEqual(decideReconnect(paired(402)), { action: 'stop' });
  });

  test('440 reconnects until the fifth replacement without a stable open, then stops', () => {
    for (let replacedCount = 1; replacedCount < RECONNECT_POLICY.replacedLimit; replacedCount++) {
      const decision = decideReconnect(paired(440, { attempt: replacedCount - 1, replacedCount }), noJitter);
      assert.equal(decision.action, 'reconnect', `replacement ${replacedCount}`);
    }
    assert.deepEqual(decideReconnect(paired(440, { attempt: 4, replacedCount: 5 })), { action: 'stop' });
    assert.deepEqual(decideReconnect(paired(440, { attempt: 9, replacedCount: 9 })), { action: 'stop' });
  });

  test('a ping-pong of replacements stops within two minutes', () => {
    let attempt = 0;
    let replacedCount = 0;
    let elapsedMs = 0;
    let stopped = false;

    while (!stopped) {
      replacedCount++;
      const decision = decideReconnect(paired(440, { attempt, replacedCount }), noJitter);
      if (decision.action === 'stop') stopped = true;
      else if (decision.action === 'reconnect') {
        attempt++;
        elapsedMs += decision.delayMs + 500;
      } else assert.fail(`unexpected ${decision.action}`);
    }

    assert.equal(replacedCount, 5);
    assert.ok(elapsedMs < 2 * 60_000, `stopped after ${elapsedMs} ms`);
  });
});

describe('backoff', () => {
  test('doubles from 2 s and is capped at 60 s', () => {
    const delays = [0, 1, 2, 3, 4, 5, 6, 50, 5000].map((attempt) => backoffDelayMs(attempt, noJitter));
    assert.deepEqual(delays, [2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000, 60_000]);
  });

  test('jitter only shortens the delay, by at most 20%', () => {
    assert.equal(backoffDelayMs(0, fullJitter), 1_600);
    assert.equal(backoffDelayMs(10, fullJitter), 48_000);
    for (let i = 0; i < 100; i++) {
      const delay = backoffDelayMs(3);
      assert.ok(delay > 12_800 - 1 && delay <= 16_000, `delay ${delay}`);
    }
  });
});

describe('stable open', () => {
  test('resets only after the connection stayed open for three minutes', () => {
    const now = 1_000_000_000;
    assert.equal(wasStableOpen(null, now), false);
    assert.equal(wasStableOpen(now - 3_500, now), false);
    assert.equal(wasStableOpen(now - RECONNECT_POLICY.stableOpenMs + 1, now), false);
    assert.equal(wasStableOpen(now - RECONNECT_POLICY.stableOpenMs, now), true);
  });
});
