const DEVICE_SOURCES = new Set(['ios', 'android', 'web', 'unknown', 'desktop']);

// Errors that say nothing about a single row: retrying row by row would only repeat them.
const NON_ROW_ERROR_NAMES = new Set([
  'PrismaClientInitializationError',
  'PrismaClientRustPanicError',
  'PrismaClientUnknownEngineError',
]);
const NON_ROW_ERROR_CODES = new Set(['P2024', 'P2028', 'P2034']);

export type CountsByReason = Record<string, number>;

export type ResilientInsertResult = {
  failed: number;
  reasons: CountsByReason;
};

const isObject = (value: unknown) => typeof value === 'object' && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown) => typeof value === 'string' && value.length > 0;

/** Required `Message` columns that a prepared row cannot fill. Empty when the row can be inserted. */
export function missingMessageColumns(row: Record<string, any>): string[] {
  const missing: string[] = [];

  if (!isObject(row?.key)) missing.push('key');
  if (!isNonEmptyString(row?.messageType)) missing.push('messageType');
  if (!isObject(row?.message)) missing.push('message');
  if (!Number.isInteger(row?.messageTimestamp)) missing.push('messageTimestamp');
  if (!DEVICE_SOURCES.has(row?.source)) missing.push('source');
  if (!isNonEmptyString(row?.instanceId)) missing.push('instanceId');

  return missing;
}

/** Proto field names at the top of a WhatsApp message, e.g. `messageContextInfo+messageHistoryNotice`. Never content. */
export function topLevelMessageKeys(message: unknown): string {
  if (!isObject(message)) return '(no message)';

  const keys = Object.keys(message as object).sort();

  return keys.length > 0 ? keys.join('+') : '(empty message)';
}

export function countReason(counts: CountsByReason, reason: string): void {
  counts[reason] = (counts[reason] ?? 0) + 1;
}

function errorName(error: any): string {
  if (typeof error?.name === 'string' && error.name !== 'Error') return error.name;

  return error?.constructor?.name ?? 'Error';
}

function errorField(error: any): string | undefined {
  const meta = error?.meta;
  const fromMeta = meta?.column_name ?? meta?.field_name ?? meta?.target;

  if (Array.isArray(fromMeta)) return fromMeta.join(',');
  if (typeof fromMeta === 'string' && /^[\w.,]+$/.test(fromMeta)) return fromMeta;

  const message = typeof error?.message === 'string' ? error.message : '';
  const matches = [...message.matchAll(/[Aa]rgument `(\w+)`/g)];

  return matches.length > 0 ? matches[matches.length - 1][1] : undefined;
}

/** Error class, code and field of a failed write. Never the message text, which can echo the row's content. */
export function describePersistError(error: unknown): string {
  const err = error as any;
  const code = typeof err?.code === 'string' && /^\w+$/.test(err.code) ? ` ${err.code}` : '';
  const field = errorField(err);

  return `${errorName(err)}${code}${field ? ` (${field})` : ''}`;
}

function isRowError(error: any): boolean {
  if (NON_ROW_ERROR_NAMES.has(errorName(error))) return false;

  const code = typeof error?.code === 'string' ? error.code : '';

  return !code.startsWith('P1') && !NON_ROW_ERROR_CODES.has(code);
}

function chunk<T>(rows: T[], size: number): T[][] {
  const chunks: T[][] = [];

  for (let i = 0; i < rows.length; i += size) chunks.push(rows.slice(i, i + size));

  return chunks;
}

/**
 * Inserts all rows at once and, if that fails because of some row, retries in chunks and then row by row,
 * so only the failing rows are lost. Errors unrelated to the rows (connection, pool) are rethrown.
 */
export async function insertManyResilient<T>(
  rows: T[],
  insert: (rows: T[]) => Promise<unknown>,
  chunkSize = 500,
): Promise<ResilientInsertResult> {
  const result: ResilientInsertResult = { failed: 0, reasons: {} };

  if (rows.length === 0) return result;

  try {
    await insert(rows);
    return result;
  } catch (error) {
    if (!isRowError(error)) throw error;
  }

  const chunks = rows.length > chunkSize ? chunk(rows, chunkSize) : [rows];

  for (const part of chunks) {
    if (chunks.length > 1) {
      try {
        await insert(part);
        continue;
      } catch (error) {
        if (!isRowError(error)) throw error;
      }
    }

    for (const row of part) {
      try {
        await insert([row]);
      } catch (error) {
        if (!isRowError(error)) throw error;

        result.failed += 1;
        countReason(result.reasons, describePersistError(error));
      }
    }
  }

  return result;
}
