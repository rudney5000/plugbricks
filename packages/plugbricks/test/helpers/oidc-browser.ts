import { expect } from "vitest";

// What a browser does when it signs into `plugbricks admin` through Keycloak: it keeps cookies per host, follows the
// admin's redirect to Keycloak, posts Keycloak's login form, and follows the redirect back to the admin's callback.

export interface Browser {
  /** fetch with this browser's cookies, redirects not followed (each one is checked by the caller). */
  req: (url: string, init?: RequestInit) => Promise<Response>;
}

export function browser(): Browser {
  const jars = new Map<string, Map<string, string>>();
  const of = (host: string) => {
    let j = jars.get(host);
    if (!j) jars.set(host, (j = new Map()));
    return j;
  };
  return {
    req: async (url, init = {}) => {
      const host = new URL(url).host;
      const headers = new Headers(init.headers);
      const c = [...of(host)].map(([k, v]) => `${k}=${v}`).join("; ");
      if (c) headers.set("cookie", c);
      const res = await fetch(url, { ...init, headers, redirect: "manual" });
      for (const cookie of res.headers.getSetCookie()) {
        const [pair] = cookie.split(";");
        const i = pair.indexOf("=");
        if (i > 0) of(host).set(pair.slice(0, i), pair.slice(i + 1));
      }
      return res;
    },
  };
}

/**
 * Signs `username` into the admin at `adminBase` through the Keycloak at `keycloakOrigin`, and returns the session the
 * admin then reports (/api/session).
 */
export async function signInThroughKeycloak(
  b: Browser,
  adminBase: string,
  keycloakOrigin: string,
  username: string,
  password: string,
): Promise<Record<string, unknown>> {
  const login = await b.req(`${adminBase}/auth/login`);
  expect(login.status).toBe(302);
  const idp = new URL(login.headers.get("location")!);
  expect(idp.origin).toBe(keycloakOrigin);

  const page = await b.req(idp.href);
  expect(page.status).toBe(200);
  const html = await page.text();
  const form = /<form[^>]*id="kc-form-login"[^>]*action="([^"]+)"/.exec(html);
  expect(form, "the Keycloak login form").not.toBeNull();
  const action = form![1].replaceAll("&amp;", "&");
  const hidden = [...html.matchAll(/<input\b[^>]*type="hidden"[^>]*>/g)]
    .map(([tag]) => [/name="([^"]*)"/.exec(tag)?.[1], /value="([^"]*)"/.exec(tag)?.[1] ?? ""] as const)
    .filter(([name]) => name !== undefined);
  const params = new URLSearchParams({ username, password, credentialId: "" });
  for (const [name, value] of hidden) params.set(name!, value);
  const posted = await b.req(action, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  expect(posted.status).toBe(302);
  const callback = await b.req(posted.headers.get("location")!);
  expect(callback.status).toBe(302);
  expect(callback.headers.get("location")).toBe("/");

  const session = await b.req(`${adminBase}/api/session`);
  expect(session.status).toBe(200);
  return (await session.json()) as Record<string, unknown>;
}
