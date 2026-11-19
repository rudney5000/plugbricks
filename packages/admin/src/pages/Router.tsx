import { useEffect, useState } from "react";
import { getBricks } from "../api.js";
import { tone } from "../lib.js";
import type { BricksResponse, RouterView } from "../types.js";

export function RouterPage() {
  const [router, setRouter] = useState<RouterView | null | undefined>(undefined);
  const [runtime, setRuntime] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getBricks()
      .then((d: BricksResponse) => {
        setRouter(d.router);
        setRuntime(d.runtime);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  return (
    <div>
      <h1 className="mb-1 text-2xl font-bold text-slate-900">Router</h1>
      <p className="mb-4 text-sm text-slate-500">The single GraphQL entry point, assembled from the subgraphs of your bricks.</p>
      {error && <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
      {router === null ? (
        <div className="rounded-lg border border-slate-200 bg-white px-4 py-6 text-sm text-slate-500">
          No router: no installed brick serves a subgraph.
        </div>
      ) : router ? (
        <div className="space-y-4">
          <section className="rounded-lg border border-slate-200 bg-white p-5">
            <h2 className="mb-3 text-sm font-semibold text-slate-900">State</h2>
            <dl className="grid grid-cols-[10rem_1fr] gap-y-2 text-sm">
              <dt className="text-slate-500">State</dt>
              <dd className="flex items-center gap-2 capitalize">
                <span className={`h-2 w-2 rounded-full ${tone(router.state).dot}`} />
                {router.state}
              </dd>
              <dt className="text-slate-500">Address</dt>
              <dd className="text-slate-800">{router.address ?? "not published"}</dd>
              <dt className="text-slate-500">Image</dt>
              <dd className="break-all text-slate-800">{router.image.split("@")[0]}</dd>
              <dt className="text-slate-500">Digest</dt>
              <dd className="break-all text-slate-800">{router.digest ?? "unknown"}</dd>
              <dt className="text-slate-500">Runtime</dt>
              <dd className="text-slate-800">{runtime}</dd>
            </dl>
          </section>
          <section className="rounded-lg border border-slate-200 bg-white p-5">
            <h2 className="mb-3 text-sm font-semibold text-slate-900">Subgraphs</h2>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="py-2 font-medium">Brick</th>
                  <th className="py-2 font-medium">Service</th>
                  <th className="py-2 font-medium">Reachability</th>
                </tr>
              </thead>
              <tbody>
                {router.subgraphs.map((s) => (
                  <tr key={s.name} className="border-b border-slate-100 last:border-0">
                    <td className="py-2.5 text-slate-800">{s.brick}</td>
                    <td className="py-2.5 text-slate-600">{s.name}</td>
                    <td className="py-2.5">
                      <span className={`rounded px-2 py-0.5 text-xs capitalize ${tone(s.state).badge}`}>{s.state}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <p className="text-xs text-slate-500">The configuration hash, its size and the composed schema arrive with the next step.</p>
        </div>
      ) : (
        <div className="text-sm text-slate-500">Loading…</div>
      )}
    </div>
  );
}
