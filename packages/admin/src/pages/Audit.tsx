import { useEffect, useState } from "react";
import { getAudit } from "../api.js";
import type { AuditEntry } from "../types.js";

const resultTone = (r: AuditEntry["result"]) =>
  r === "Accepted"
    ? "bg-slate-100 text-slate-600"
    : r === "Success"
      ? "bg-emerald-50 text-emerald-700"
      : r === "Refused"
        ? "bg-amber-50 text-amber-700"
        : "bg-red-50 text-red-700";

export function Audit() {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getAudit()
      .then((d) => setEntries(d.entries))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  return (
    <div>
      <h1 className="mb-1 text-2xl font-bold text-slate-900">
        Audit log <span className="ml-2 text-sm font-normal text-slate-500">Who did what, and when. Newest first.</span>
      </h1>
      <div className="my-4 rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600">
        Entries are append-only: nobody can edit or delete them from this interface. Reading brick pages, secrets and GraphQL request bodies
        are never recorded. Refused attempts are.
      </div>
      {error && <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
      {entries === null ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : entries.length === 0 ? (
        <div className="rounded-lg border border-slate-200 bg-white px-4 py-8 text-center text-sm text-slate-500">
          No entry yet. Each action run from the Bricks page (add, enable, disable, remove, deploy) adds two lines here.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                {["Time", "User", "Action", "Brick", "Result", "Details"].map((h) => (
                  <th key={h} className="px-4 py-3 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {entries.map((e, i) => (
                <tr key={i} className="border-b border-slate-100 last:border-0">
                  <td className="px-4 py-3 text-slate-600">{e.time}</td>
                  <td className="px-4 py-3">
                    <div className="text-slate-900">{e.user}</div>
                    <div className="text-xs text-slate-500">{e.role}</div>
                  </td>
                  <td className="px-4 py-3 text-slate-800">{e.action}</td>
                  <td className="px-4 py-3 text-slate-600">{e.brick || "—"}</td>
                  <td className="px-4 py-3">
                    <span className={`rounded px-2 py-0.5 text-xs ${resultTone(e.result)}`}>{e.result}</span>
                  </td>
                  <td className="px-4 py-3 text-slate-600">{e.details}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-4 text-xs text-slate-500">
        Stored as one JSON line per action, in a file next to the project. Moving it to a database later does not change this screen.
      </p>
    </div>
  );
}
