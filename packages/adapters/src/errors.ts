import type { StorageErrorCode, StoreResult } from '@ssterm/domain';
const messages: Record<StorageErrorCode, string> = {
  'invalid-request': 'The metadata request is invalid.',
  conflict: 'Metadata changed; reload before retrying.',
  constraint: 'The change violates metadata relationships.',
  busy: 'Storage is busy; retry the operation.',
  closed: 'Storage is closed.',
  io: 'Storage could not be accessed.',
  corrupt: 'Storage integrity validation failed.',
  'foreign-database': 'This file is not ssterm metadata.',
  'unsupported-schema': 'This storage version requires a compatible app.',
  'unsupported-protection': 'Protected data requires a compatible provider.',
  'recovery-required': 'Storage requires explicit recovery or reconciliation.',
  unwritable: 'Storage is not writable.',
  'migration-failed': 'A storage migration failed; the original backup is retained.',
  unavailable: 'This storage operation is unavailable.'
};
export class StorageFault extends Error {
  constructor(readonly code: StorageErrorCode) {
    super(messages[code]);
  }
}
export function fail(code: StorageErrorCode): never {
  throw new StorageFault(code);
}
export function failure<T>(error: unknown, fallback: StorageErrorCode = 'io'): StoreResult<T> {
  let code = fallback;
  if (error instanceof StorageFault) code = error.code;else if (error && typeof error === 'object') {
    const e = error as {
      code?: string;
      errcode?: number;
    };
    const primary = typeof e.errcode === 'number' ? e.errcode & 0xff : 0;
    if (primary === 5 || primary === 6) code = 'busy';else if (primary === 19) code = 'constraint';else if (primary === 11 || primary === 26) code = 'corrupt';else if (primary === 8 || e.code === 'EACCES' || e.code === 'EPERM' || e.code === 'EROFS') code = 'unwritable';
  }
  return {
    ok: false,
    error: {
      code,
      message: messages[code]
    }
  };
}
export const success = <T,>(value: T): StoreResult<T> => ({
  ok: true,
  value
});
