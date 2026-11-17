// Small helpers of the end-to-end tests that talk to the router over HTTP: wait for a condition, GET a path, send
// a GraphQL request and print what was asked and what came back (so a run can be read, and quoted, afterwards).

// The shape of "data" depends on the query sent, so it is not typed here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Answer = { status: number; body: any };

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function until(what: string, check: () => Promise<boolean>, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await check()) return;
    } catch {
      // not yet: the connection is refused until the router listens
    }
    if (Date.now() > deadline) throw new Error(`gave up waiting for ${what} after ${timeoutMs / 1000}s`);
    await sleep(500);
  }
}

/** The HTTP status of GET http://127.0.0.1:<port><path>; rejects when nothing listens. */
export const get = async (port: number, path: string): Promise<number> => (await fetch(`http://127.0.0.1:${port}${path}`)).status;

/** One GraphQL request to the router on 127.0.0.1:<port>, and its real answer (printed for the record). */
export async function through(port: number, label: string, query: string, variables?: Record<string, unknown>): Promise<Answer> {
  const res = await fetch(`http://127.0.0.1:${port}/graphql`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const answer = { status: res.status, body: await res.json() };
  console.log(
    `${label}\n  request:  ${query.replace(/\s+/g, " ").trim()}${variables ? ` ${JSON.stringify(variables)}` : ""}\n  response: HTTP ${answer.status} ${JSON.stringify(answer.body)}`,
  );
  return answer;
}
