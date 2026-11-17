import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import {
  countReason,
  CountsByReason,
  describePersistError,
  insertManyResilient,
  missingMessageColumns,
  topLevelMessageKeys,
} from '@api/integrations/channel/whatsapp/helpers/messagePersistence.helper';
import { PrismaClient } from '@prisma/client';
import { getContentType, getDevice, WAMessage } from 'baileys';

const SECRET = 'confidential-message-body';

const textMessage = (id: string, text = `hello ${id}`): WAMessage => ({
  key: { id, remoteJid: '5511999999999@s.whatsapp.net', fromMe: false },
  message: { conversation: text },
  messageTimestamp: 1763300000,
});

const historyNotice = (id: string): WAMessage =>
  ({
    key: { id, remoteJid: '5511999999999@s.whatsapp.net', fromMe: true },
    message: {
      messageHistoryNotice: { messageHistoryMetadata: { historyReceivers: ['5511888888888@s.whatsapp.net'] } },
      messageContextInfo: {},
    },
    messageTimestamp: 1763300001,
  }) as WAMessage;

const senderKeyOnly = (id: string): WAMessage =>
  ({
    key: { id, remoteJid: '120363000000000000@g.us', fromMe: false },
    message: { senderKeyDistributionMessage: { groupId: '120363000000000000@g.us' }, messageContextInfo: {} },
    messageTimestamp: 1763300002,
  }) as WAMessage;

// The columns `prepareMessage` fills, with `messageType` from Baileys' `getContentType` as in production.
const prepare = (message: WAMessage, instanceId: string) => ({
  key: { ...message.key },
  pushName: 'Someone',
  message: { ...message.message },
  messageType: getContentType(message.message),
  messageTimestamp: message.messageTimestamp as number,
  source: getDevice(message.key.id),
  instanceId,
  status: 'DELIVERY_ACK',
});

// The history handler's selection step.
const selectStorable = (messages: WAMessage[], instanceId: string) => {
  const skipped: CountsByReason = {};
  const rows = [];

  for (const message of messages) {
    const row = prepare(message, instanceId);
    const missing = missingMessageColumns(row);

    if (missing.length > 0) {
      countReason(skipped, `${missing.join(',')} missing [${topLevelMessageKeys(message.message)}]`);
      continue;
    }

    rows.push(row);
  }

  return { rows, skipped };
};

const historyBatch = () => [
  textMessage('A1'),
  textMessage('A2'),
  historyNotice('N1'),
  textMessage('A3'),
  senderKeyOnly('S1'),
  textMessage('A4'),
];

describe('missingMessageColumns', () => {
  test('accepts a prepared text message', () => {
    assert.deepEqual(missingMessageColumns(prepare(textMessage('X'), 'inst')), []);
  });

  test('getContentType does not map messageHistoryNotice, so messageType is missing', () => {
    assert.equal(getContentType(historyNotice('N').message), undefined);
    assert.deepEqual(missingMessageColumns(prepare(historyNotice('N'), 'inst')), ['messageType']);
  });

  test('reports every missing required column', () => {
    assert.deepEqual(missingMessageColumns({}), [
      'key',
      'messageType',
      'message',
      'messageTimestamp',
      'source',
      'instanceId',
    ]);
  });
});

describe('history batch selection', () => {
  test('skips notice and protocol-only messages and keeps the rest', () => {
    const { rows, skipped } = selectStorable(historyBatch(), 'inst');

    assert.deepEqual(
      rows.map((row) => row.key.id),
      ['A1', 'A2', 'A3', 'A4'],
    );
    assert.deepEqual(skipped, {
      'messageType missing [messageContextInfo+messageHistoryNotice]': 1,
      'messageType missing [messageContextInfo+senderKeyDistributionMessage]': 1,
    });
  });
});

describe('describePersistError', () => {
  test('names class, code and field without the message text', () => {
    const validation = Object.assign(
      new Error(
        `Invalid invocation: { data: [{ message: { conversation: "${SECRET}" } }] }\nArgument \`messageType\` is missing.`,
      ),
      { name: 'PrismaClientValidationError' },
    );
    const tooLong = Object.assign(new Error(`value ${SECRET} too long`), {
      name: 'PrismaClientKnownRequestError',
      code: 'P2000',
      meta: { column_name: 'pushName' },
    });

    assert.equal(describePersistError(validation), 'PrismaClientValidationError (messageType)');
    assert.equal(describePersistError(tooLong), 'PrismaClientKnownRequestError P2000 (pushName)');
    assert.ok(!describePersistError(validation).includes(SECRET));
  });
});

describe('insertManyResilient', () => {
  const fakeTable = (isBad: (row: { id: string }) => boolean) => {
    const saved: string[] = [];
    let calls = 0;

    const insert = async (rows: { id: string }[]) => {
      calls += 1;
      if (rows.some(isBad)) {
        throw Object.assign(new Error(`row ${SECRET}`), { name: 'PrismaClientValidationError' });
      }
      saved.push(...rows.map((row) => row.id));
    };

    return { saved, insert, calls: () => calls };
  };

  test('inserts everything in one call when nothing fails', async () => {
    const table = fakeTable(() => false);
    const result = await insertManyResilient([{ id: '1' }, { id: '2' }], table.insert);

    assert.deepEqual(result, { failed: 0, reasons: {} });
    assert.deepEqual(table.saved, ['1', '2']);
    assert.equal(table.calls(), 1);
  });

  test('saves every row except the bad ones, through chunks and then row by row', async () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({ id: String(i) }));
    const table = fakeTable((row) => row.id === '7' || row.id === '21');

    const result = await insertManyResilient(rows, table.insert, 10);

    assert.equal(result.failed, 2);
    assert.deepEqual(result.reasons, { PrismaClientValidationError: 2 });
    assert.deepEqual(
      [...table.saved].sort((a, b) => Number(a) - Number(b)),
      rows.map((row) => row.id).filter((id) => id !== '7' && id !== '21'),
    );
  });

  test('rethrows errors that are not about a row', async () => {
    const insert = async () => {
      throw Object.assign(new Error("Can't reach database server"), {
        name: 'PrismaClientKnownRequestError',
        code: 'P1001',
      });
    };

    await assert.rejects(insertManyResilient([{ id: '1' }], insert), { code: 'P1001' });
  });
});

const databaseUrl = process.env.TEST_DATABASE_CONNECTION_URI;

describe('history batch against Postgres', { skip: !databaseUrl && 'TEST_DATABASE_CONNECTION_URI not set' }, () => {
  let prisma: PrismaClient;
  let instanceId: string;

  before(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    const instance = await prisma.instance.create({ data: { name: `history-test-${Date.now()}` } });
    instanceId = instance.id;
  });

  after(async () => {
    await prisma?.instance.deleteMany({ where: { id: instanceId } });
    await prisma?.$disconnect();
  });

  const savedIds = async () =>
    (await prisma.message.findMany({ where: { instanceId }, select: { key: true } }))
      .map((row) => (row.key as { id: string }).id)
      .sort();

  test('before the fix: one notice in the batch makes createMany store nothing', async () => {
    const rows = historyBatch().map((message) => prepare(message, instanceId));

    await assert.rejects(prisma.message.createMany({ data: rows as any, skipDuplicates: true }), {
      name: 'PrismaClientValidationError',
    });
    assert.deepEqual(await savedIds(), []);
  });

  test('after the fix: notices are skipped and only rows the database rejects are lost', async () => {
    const { rows, skipped } = selectStorable(historyBatch(), instanceId);
    const tooLongPushName = { ...prepare(textMessage('B1'), instanceId), pushName: 'x'.repeat(150) };
    const wrongStatusType = { ...prepare(textMessage('B2', SECRET), instanceId), status: 123 };
    const nullByteText = prepare(textMessage('B3', `${SECRET}\u0000`), instanceId);
    const batch = [...rows.slice(0, 2), tooLongPushName, ...rows.slice(2), nullByteText, wrongStatusType];

    const result = await insertManyResilient(batch, (data) =>
      prisma.message.createMany({ data: data as any, skipDuplicates: true }),
    );

    assert.equal(
      Object.values(skipped).reduce((a, b) => a + b, 0),
      2,
    );
    assert.equal(result.failed, 3);
    assert.deepEqual(await savedIds(), ['A1', 'A2', 'A3', 'A4']);

    const reasons = Object.keys(result.reasons);
    assert.ok(
      reasons.some((reason) => reason.startsWith('PrismaClientValidationError')),
      reasons.join(' | '),
    );
    assert.ok(
      reasons.some((reason) => reason.includes('P2000')),
      reasons.join(' | '),
    );
    assert.ok(reasons.includes('PrismaClientUnknownRequestError'), reasons.join(' | '));
    assert.ok(!JSON.stringify(result.reasons).includes(SECRET));
    console.log('reasons:', JSON.stringify(result.reasons));
  });
});
