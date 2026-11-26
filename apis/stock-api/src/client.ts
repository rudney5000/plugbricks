// The REST API this adapter fronts, written from its contract (apis/stock-rest/openapi.json): one function per operation.
// Nothing of the REST API is trusted: an answer that is not what the contract says is a failure of the upstream.

export interface Item {
  sku: string;
  name: string;
  quantity: number;
}

/** The REST API cannot be used: unreachable, too slow, an unexpected status or an answer off the contract. */
export class UpstreamError extends Error {}

/** The REST API refused the request (400): its message is meant for the caller. */
export class RefusedError extends Error {}

/** The contract's pattern of a sku. Checked before it enters a URL: "..", "/" or "?" never do. */
export const isSku = (sku: string): boolean => /^[A-Za-z0-9-]{1,32}$/.test(sku);

const isItem = (v: unknown): v is Item => {
  const i = v as Partial<Item> | null;
  return typeof i?.sku === "string" && typeof i.name === "string" && Number.isInteger(i.quantity);
};

export interface StockClient {
  list(): Promise<Item[]>;
  /** Null when there is no such item. */
  get(sku: string): Promise<Item | null>;
  /** Null when there is no such item. */
  restock(sku: string, quantity: number): Promise<Item | null>;
}

export function stockClient(baseUrl: string, { timeoutMs = 5_000 }: { timeoutMs?: number } = {}): StockClient {
  const base = baseUrl.replace(/\/$/, "");

  /** The status and the JSON body of a call. The caller's Authorization header is not passed on: see the README. */
  async function call(path: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
    try {
      // No redirect is followed: the adapter calls the address it was given and no other.
      const response = await fetch(`${base}${path}`, { ...init, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
      return { status: response.status, body: await response.json() };
    } catch (e) {
      throw new UpstreamError(`${init.method ?? "GET"} ${path}: ${(e as Error).message}`);
    }
  }

  const unexpected = (what: string, status: number) => new UpstreamError(`${what}: unexpected answer (HTTP ${status})`);

  async function one(what: string, path: string, init?: RequestInit): Promise<Item | null> {
    const { status, body } = await call(path, init);
    if (status === 200 && isItem(body)) return body;
    if (status === 404) return null;
    const message = (body as { message?: unknown } | null)?.message;
    if (status === 400 && typeof message === "string") throw new RefusedError(message);
    throw unexpected(what, status);
  }

  return {
    async list() {
      const { status, body } = await call("/items");
      if (status === 200 && Array.isArray(body) && body.every(isItem)) return body;
      throw unexpected("GET /items", status);
    },
    get: (sku) => one("GET /items/{sku}", `/items/${sku}`),
    restock: (sku, quantity) =>
      one("POST /items/{sku}/restock", `/items/${sku}/restock`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ quantity }),
      }),
  };
}
