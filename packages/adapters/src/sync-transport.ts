/** Main-only bounded ciphertext transport. Never accepts catalog plaintext or private keys. */
import { createHash } from 'node:crypto';
import { frame } from './sync-crypto.ts';
import {
  SYNC_HTTP_MAX,
  isSyncInfo,
  isSyncScope,
  isSyncChallenge,
  isSyncControlsResponse,
  isSyncControlPublication,
  isSyncExchangeRequest,
  isSyncExchangeResponse,
  isSyncReceipt,
  isSyncWraps,
  isSyncRecovery,
  syncObject,
  syncInteger,
  syncTransportCodes,
  syncUuid,
  type SyncEndpoint,
  type SyncInfo,
  type SyncControlsResponse,
  type SyncControlPublication,
  type SyncPublicationReceipt,
  type SyncExchangeRequest,
  type SyncExchangeResponse,
  type SyncRecoveryResponse,
  type SyncTransportResult,
} from '../../domain/src/sync.ts';
export interface SyncTransport {
  info(signal?: AbortSignal): Promise<SyncTransportResult<SyncInfo>>;
  controls(afterGeneration: number, signal?: AbortSignal): Promise<SyncTransportResult<SyncControlsResponse>>;
  publishControl(
    publication: SyncControlPublication,
    signal?: AbortSignal,
  ): Promise<SyncTransportResult<SyncPublicationReceipt>>;
  exchange(
    request: SyncExchangeRequest,
    signal?: AbortSignal,
  ): Promise<SyncTransportResult<SyncExchangeResponse>>;
  wraps(epoch: number, signal?: AbortSignal): Promise<SyncTransportResult<{ wraps: string[] }>>;
  recovery(signal?: AbortSignal): Promise<SyncTransportResult<SyncRecoveryResponse>>;
}
export interface SyncTransportOptions {
  endpoint: SyncEndpoint;
  readToken(): Promise<Uint8Array>;
  signRequest(transcript: Uint8Array): Promise<{ deviceId: string; signature: Uint8Array }>;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}
export function validSyncEndpoint(endpoint: SyncEndpoint): boolean {
  try {
    if (!isSyncScope(endpoint.scope) || typeof endpoint.url !== 'string' || endpoint.url.length > 2048)
      return false;
    const url = new URL(endpoint.url);
    return (
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (url.pathname === '/' || url.pathname === '') &&
      (url.protocol === 'https:' ||
        (url.protocol === 'http:' && /^http:\/\/(?:127\.0\.0\.1|\[::1\])(?::[0-9]+)?\/?$/.test(endpoint.url)))
    );
  } catch {
    return false;
  }
}
export function syncRequestTranscript(
  method: string,
  path: string,
  scope: SyncEndpoint['scope'],
  nonce: string,
  body: Uint8Array,
): Buffer {
  return frame(
    'ssterm-sync-http-v1',
    method,
    path,
    scope.deploymentId,
    scope.accountId,
    scope.vaultId,
    nonce,
    createHash('sha256').update(body).digest('hex'),
  );
}
export function createSyncTransport(options: SyncTransportOptions): SyncTransport {
  if (!validSyncEndpoint(options.endpoint)) throw new Error('Invalid sync endpoint');
  const origin = new URL(options.endpoint.url).origin;
  const scope = { ...options.endpoint.scope };
  const fetcher = options.fetch ?? globalThis.fetch;
  async function request<T>(
    method: string,
    path: string,
    body: string,
    validator: (v: unknown) => v is T,
    signed: boolean,
    signal?: AbortSignal,
  ): Promise<SyncTransportResult<T>> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) return { ok: false, code: 'cancelled' };
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, options.timeoutMs ?? 15000);
    timer.unref();
    try {
      if (Buffer.byteLength(body) > SYNC_HTTP_MAX) return { ok: false, code: 'too-large' };
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (body) headers['Content-Type'] = 'application/json';
      if (path !== '/v1/info') {
        const token = await options.readToken();
        try {
          if (token.length !== 32 || controller.signal.aborted)
            return { ok: false, code: controller.signal.aborted ? 'cancelled' : 'unauthorized' };
          headers.Authorization = `Bearer ${Buffer.from(token).toString('base64url')}`;
          headers['X-SSTerm-Deployment'] = scope.deploymentId;
          headers['X-SSTerm-Account'] = scope.accountId;
          headers['X-SSTerm-Vault'] = scope.vaultId;
        } finally {
          token.fill(0);
        }
      }
      if (signed) {
        const challenge = await request(
          'GET',
          '/v1/challenge',
          '',
          isSyncChallenge,
          false,
          controller.signal,
        );
        if (!challenge.ok) return challenge;
        if (
          challenge.value.expiresAt <= Math.floor(Date.now() / 1000) ||
          challenge.value.expiresAt > Math.floor(Date.now() / 1000) + 60
        )
          return { ok: false, code: 'invalid' };
        const signedRequest = await options.signRequest(
          syncRequestTranscript(method, path, scope, challenge.value.nonce, Buffer.from(body)),
        );
        try {
          if (!syncUuid(signedRequest.deviceId) || signedRequest.signature.length !== 64)
            return { ok: false, code: 'invalid' };
          if (controller.signal.aborted) return { ok: false, code: 'cancelled' };
          headers['X-SSTerm-Device'] = signedRequest.deviceId;
          headers['X-SSTerm-Nonce'] = challenge.value.nonce;
          headers['X-SSTerm-Signature'] = Buffer.from(signedRequest.signature).toString('base64url');
        } finally {
          signedRequest.signature.fill(0);
        }
      }
      const response = await fetcher(`${origin}${path}`, {
        method,
        headers,
        body: method === 'GET' ? undefined : body,
        redirect: 'manual',
        signal: controller.signal,
        credentials: 'omit',
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        return { ok: false, code: 'unavailable' };
      }
      if (!response.headers.get('content-type')?.startsWith('application/json')) {
        await response.body?.cancel();
        return { ok: false, code: 'invalid' };
      }
      const contentLength = response.headers.get('content-length');
      if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > SYNC_HTTP_MAX)) {
        await response.body?.cancel();
        return { ok: false, code: 'too-large' };
      }
      const reader = response.body?.getReader();
      if (!reader) return { ok: false, code: 'invalid' };
      const parts: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > SYNC_HTTP_MAX) {
          await reader.cancel();
          return { ok: false, code: 'too-large' };
        }
        parts.push(value);
      }
      const raw = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts));
      const parsed: unknown = JSON.parse(raw);
      if (JSON.stringify(parsed) !== raw) return { ok: false, code: 'invalid' };
      if (
        syncObject(parsed, ['ok', 'code']) &&
        parsed.ok === false &&
        syncTransportCodes.includes(parsed.code as never)
      )
        return { ok: false, code: parsed.code as (typeof syncTransportCodes)[number] };
      if (
        !response.ok ||
        !syncObject(parsed, ['ok', 'value']) ||
        parsed.ok !== true ||
        !validator(parsed.value)
      )
        return { ok: false, code: 'invalid' };
      return { ok: true, value: parsed.value };
    } catch {
      return { ok: false, code: signal?.aborted ? 'cancelled' : 'unavailable' };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }
  return {
    info: (s) => request('GET', '/v1/info', '', isSyncInfo, false, s),
    controls: (n, s) =>
      syncInteger(n, 0, 0xffffffff)
        ? request('GET', `/v1/controls/${n}`, '', isSyncControlsResponse, false, s)
        : Promise.resolve({ ok: false, code: 'invalid' }),
    publishControl: (p, s) =>
      isSyncControlPublication(p)
        ? request('POST', '/v1/controls', JSON.stringify(p), isSyncReceipt, false, s)
        : Promise.resolve({ ok: false, code: 'invalid' }),
    exchange: (r, s) =>
      isSyncExchangeRequest(r)
        ? request('POST', '/v1/exchange', JSON.stringify(r), isSyncExchangeResponse, true, s)
        : Promise.resolve({ ok: false, code: 'invalid' }),
    wraps: (n, s) =>
      syncInteger(n, 1, 0xffffffff)
        ? request('GET', `/v1/wraps/${n}`, '', isSyncWraps, true, s)
        : Promise.resolve({ ok: false, code: 'invalid' }),
    recovery: (s) => request('GET', '/v1/recovery', '', isSyncRecovery, false, s),
  };
}
