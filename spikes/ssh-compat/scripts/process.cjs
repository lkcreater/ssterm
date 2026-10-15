'use strict';

// Bound the runner even when the child ignores SIGTERM or never emits close.
function waitForExit(child, { timeout = 180_000, grace = 3_000, killWait = 1_000 } = {}) {
  return new Promise((resolve, reject) => {
    let done = false;
    let timedOut = false;
    let forced = false;
    let graceTimer;
    let killTimer;
    const finish = (code, error) => {
      if (done) return;
      done = true;
      clearTimeout(timer); clearTimeout(graceTimer); clearTimeout(killTimer);
      if (error) reject(new Error('PACKAGED_LAUNCH_FAILED'));
      else resolve({ code, timedOut, forced });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      graceTimer = setTimeout(() => {
        forced = true;
        child.kill('SIGKILL');
        killTimer = setTimeout(() => finish(null), killWait);
      }, grace);
    }, timeout);
    child.once('error', (error) => finish(null, error));
    child.once('close', (code) => finish(code));
  });
}

module.exports = { waitForExit };
