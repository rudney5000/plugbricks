// A token for the router (D19): asked with the client credentials the platform injected, kept until shortly before it
// expires, and asked again then. One request at a time: concurrent callers share the same pending request.

type Fetch = typeof fetch;

/** Seconds before its expiry that a token is no longer used: a request must not reach the router with a token that died on the way. */
export const EXPIRY_MARGIN_SECONDS = 30;

export class TokenSource {
  private token: string | undefined;
  private expiresAt = 0;
  private pending: Promise<string> | undefined;

  constructor(
    readonly url: string,
    readonly clientId: string,
    private readonly secret: string,
    private readonly http: Fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  /** From OIDC_TOKEN_URL, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET; undefined when the platform has no oidc provider. */
  static fromEnv(env: NodeJS.ProcessEnv): TokenSource | undefined {
    const { OIDC_TOKEN_URL: url, OIDC_CLIENT_ID: id, OIDC_CLIENT_SECRET: secret } = env;
    return url && id && secret ? new TokenSource(url, id, secret) : undefined;
  }

  async get(): Promise<string> {
    if (this.token && this.now() < this.expiresAt) return this.token;
    this.pending ??= this.ask().finally(() => (this.pending = undefined));
    return this.pending;
  }

  private async ask(): Promise<string> {
    const res = await this.http(this.url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: this.clientId, client_secret: this.secret }),
      signal: AbortSignal.timeout(5000),
    });
    const body = (await res.json()) as { access_token?: string; expires_in?: number; error?: string };
    if (!res.ok || !body.access_token) throw new Error(`the token endpoint answered ${res.status} ${body.error ?? ""}`.trim());
    this.token = body.access_token;
    this.expiresAt = this.now() + Math.max(0, (body.expires_in ?? 0) - EXPIRY_MARGIN_SECONDS) * 1000;
    return this.token;
  }
}
