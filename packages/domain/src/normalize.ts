import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';
/** Deterministic metadata normalization; never resolves DNS. */
export function normalizeEndpoint(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024 || value !== value.trim() || /[\s\u0000-\u001f\u007f/@?#%\\]/u.test(value)) throw new Error('invalid endpoint');
  let host = value;
  if (host.startsWith('[') && host.endsWith(']')) {
    host = host.slice(1, -1);
    if (isIP(host) !== 6) throw new Error('invalid endpoint');
  }
  const family = isIP(host);
  if (family === 6) return new URL(`http://[${host}]/`).hostname.slice(1, -1);
  if (family === 4) return host;
  if (host.includes(':') || host.includes('[') || host.includes(']') || /^[\d.]+$/u.test(host)) throw new Error('invalid endpoint');
  if (host.endsWith('.')) host = host.slice(0, -1);
  host = domainToASCII(host).toLowerCase();
  if (isIP(host)) throw new Error('invalid endpoint');
  if (!host || host.length > 253 || !host.split('.').every(part => part.length > 0 && part.length <= 63 && /^[a-z\d](?:[a-z\d-]*[a-z\d])?$/u.test(part))) throw new Error('invalid endpoint');
  return host;
}
export function normalizeLabel(value: string): string {
  if (typeof value !== 'string') throw new Error('invalid label');
  const label = value.trim();
  if ([...label].length < 1 || [...label].length > 200 || /[\u0000-\u001f\u007f]/u.test(label)) throw new Error('invalid label');
  return label;
}
export const normalizeTag = (label: string): string => normalizeLabel(label).normalize('NFC').toLowerCase();
