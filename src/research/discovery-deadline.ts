export type DiscoveryAdapterOptions = {
  signal: AbortSignal;
  timeoutMs: number;
};

export class DiscoveryDeadlineError extends Error {
  constructor() {
    super("Discovery elapsed-time budget was exhausted");
    this.name = "DiscoveryDeadlineError";
  }
}

export async function withDiscoveryDeadline<T>(
  remainingMs: number,
  operation: (options: DiscoveryAdapterOptions) => Promise<T>
): Promise<T> {
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
    throw new DiscoveryDeadlineError();
  }
  const timeoutMs = Math.max(1, Math.ceil(remainingMs));
  const controller = new AbortController();
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      const error = new DiscoveryDeadlineError();
      controller.abort(error);
      reject(error);
    }, timeoutMs);

    Promise.resolve().then(async () => await operation({
      signal: controller.signal,
      timeoutMs
    })).then(
      (value) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}
