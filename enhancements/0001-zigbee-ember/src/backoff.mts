export const RETRY_INITIAL_MS = 2_000;
export const RETRY_MAX_MS = 60_000;

export function nextBackoffMs(currentMs: number) {
  return Math.min(Math.max(currentMs, RETRY_INITIAL_MS) * 2, RETRY_MAX_MS);
}

export function jitterBackoffMs(delayMs: number, random = Math.random) {
  const factor = 0.8 + random() * 0.4;
  return Math.min(Math.round(delayMs * factor), RETRY_MAX_MS);
}

export function waitForDelay(delayMs: number, signal?: AbortSignal) {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timeout);
      cleanup();
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    timeout.unref?.();
  });
}
