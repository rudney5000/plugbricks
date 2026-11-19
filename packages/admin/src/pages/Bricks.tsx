import { useCallback, useEffect, useMemo, useState } from "react";
import { getBricks } from "../api.js";
import { allTags, filterByTag, summary, tone } from "../lib.js";
import type { AdminBrick, BricksResponse } from "../types.js";

function Switch({ on }: { on: boolean }) {
  return (
    <span
      role="switch"
      aria-checked={on}
      aria-readonly="true"
      className={`inline-flex h-5 w-9 items-center rounded-full px-0.5 ${on ? "bg-blue-600" : "bg-slate-300"}`}
    >
      <span className={`h-4 w-4 rounded-full bg-white transition-transform ${on ? "translate-x-4" : ""}`} />
    </span>
  );
}

function NameCell({ brick }: { brick: AdminBrick }) {
  const detail = [brick.provides.length ? `provides ${brick.provides.join(", ")}` : "", brick.requires ? `requires ${brick.requires}` : ""]
    .filter(Boolean)
    .join(" · ");
  return (
    <div>
      <div className="font-medium text-slate-900">{brick.name}</div>
      {detail && <div className="text-xs text-slate-500">{detail}</div>}
    </div>
  );
}

function StatusCell({ brick }: { brick: AdminBrick }) {
  const t = tone(brick.state);
  return (
    <div className="flex items-start gap-2">
      <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${t.dot}`} />
      <div>
        <div className="capitalize text-slate-800">{brick.state}</div>
        {brick.reason && <div className="text-xs text-slate-500">{brick.reason}</div>}
      </div>
    </div>
  );
}

export function Bricks() {
  const [data, setData] = useState<BricksResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tag, setTag] = useState("all");
  const [updated, setUpdated] = useState<string>("");

  const load = useCallback(() => {
    getBricks()
      .then((d) => {
        setData(d);
        setError(null);
        setUpdated(new Date().toLocaleTimeString());
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(load, [load]);

  const tags = useMemo(() => (data ? allTags(data.bricks) : []), [data]);
  const rows = useMemo(() => (data ? filterByTag(data.bricks, tag) : []), [data, tag]);
  const counts = useMemo(() => (data ? summary(data.bricks) : { total: 0, healthy: 0, down: 0, stopped: 0 }), [data]);

  return (
    <div>
      <div className="mb-4">
        <h1 className="text-2xl font-bold text-slate-900">
          Bricks{" "}
          <span className="ml-2 text-sm font-normal text-slate-500">
            {counts.total} bricks · {counts.healthy} healthy · {counts.down} down · {counts.stopped} stopped
          </span>
        </h1>
      </div>

      {data?.router && (
        <div className="mb-4 flex flex-wrap items-center gap-4 rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm">
          <span className="font-medium text-slate-900">Router</span>
          <span className="flex items-center gap-1.5 capitalize">
            <span className={`h-2 w-2 rounded-full ${tone(data.router.state).dot}`} />
            {data.router.state}
          </span>
          <span className="text-slate-600">{data.router.address ?? "not published"}</span>
          <span className="text-slate-500">{data.router.image.split("@")[0]}</span>
          <span className="text-slate-500">{data.router.subgraphs.length} subgraph(s)</span>
        </div>
      )}

      {error && <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button
          disabled
          title="Actions arrive in the next step"
          className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white opacity-50"
        >
          + Add brick
        </button>
        <button
          onClick={load}
          className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100"
        >
          Refresh
        </button>
        {updated && <span className="text-xs text-slate-500">Updated {updated}</span>}
        <span className="ml-auto text-xs text-slate-500">Filter by tag</span>
        <div className="flex flex-wrap gap-1">
          {["all", ...tags].map((t) => (
            <button
              key={t}
              onClick={() => setTag(t)}
              className={`rounded-full px-2.5 py-1 text-xs ${tag === t ? "bg-blue-600 text-white" : "border border-slate-300 bg-white text-slate-600"}`}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
              {["Name", "Version", "Tags", "Port", "Subgraph", "Extends", "Enabled", "Deployed", "Status"].map((h) => (
                <th key={h} className="px-4 py-3 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((b) => (
              <tr key={b.name} className="border-b border-slate-100 last:border-0">
                <td className="px-4 py-4">
                  <NameCell brick={b} />
                </td>
                <td className="px-4 py-4 text-slate-700">{b.version}</td>
                <td className="px-4 py-4">
                  <div className="flex flex-wrap gap-1">
                    {b.tags.map((t) => (
                      <span key={t} className="rounded bg-blue-50 px-2 py-0.5 text-xs text-blue-700">
                        {t}
                      </span>
                    ))}
                  </div>
                </td>
                <td className="px-4 py-4 text-slate-700">{b.port ?? "—"}</td>
                <td className="px-4 py-4 text-slate-700">{b.subgraph ? "Yes" : "—"}</td>
                <td className="px-4 py-4 text-slate-700">{b.extends || "—"}</td>
                <td className="px-4 py-4">
                  <Switch on={b.enabled} />
                </td>
                <td className="px-4 py-4 text-slate-700">{b.deployed ? "Yes" : "No"}</td>
                <td className="px-4 py-4">
                  <StatusCell brick={b} />
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={9} className="px-4 py-8 text-center text-sm text-slate-500">
                  No brick installed.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="mt-4 text-xs text-slate-500">
        Enabled is what <code>platform.json</code> asks for. Deployed is what the runtime reports. A viewer can read everything above and
        change nothing.
      </p>
    </div>
  );
}
