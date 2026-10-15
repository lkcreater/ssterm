import { accessSync, constants, lstatSync, realpathSync, statSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fail } from './errors.ts';
/** Source metadata is plaintext: require a private POSIX directory and 0600 file.
 * Inspect only; never repair permissions or apply this policy to user-selected backups.
 * POSIX mode checks do not establish the absence of additional ACL grants.
 */
export function privateStore(path: string): void {
  const directory = statSync(realpathSync(dirname(path)));
  if (!directory.isDirectory() || (directory.mode & 0o077) !== 0) fail('unwritable');
  try {
    const file = lstatSync(path);
    if (!file.isFile() || file.isSymbolicLink() || (file.mode & 0o777) !== 0o600) fail('unwritable');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
export function writable(path: string): void {
  const parent = dirname(path);
  const directory = statSync(parent);
  if (!directory.isDirectory() || !(directory.mode & 0o222)) fail('unwritable');
  accessSync(parent, constants.W_OK);
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || !(info.mode & 0o222)) fail('unwritable');
    accessSync(path, constants.W_OK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
export function canonicalDestination(path: string): string {
  return resolve(realpathSync(dirname(path)), path.split('/').at(-1)!);
}
export function removeOwned(path: string, owned: {
  dev: number;
  ino: number;
}): void {
  try {
    const current = lstatSync(path);
    if (current.dev === owned.dev && current.ino === owned.ino) unlinkSync(path);
  } catch {/* Preserve foreign/replaced files and original diagnostics. */}
}
