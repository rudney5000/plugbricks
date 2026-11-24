import { useCallback, useEffect, useMemo, useState } from "react";
import { getBricks } from "../api.js";
import { allTags, filterByTag, hostsOf, needsDeploy, reachability, summary, tone } from "../lib.js";
import { BrickPanel } from "../components/BrickPanel.js";
import { useAction } from "../useAction.js";
import type { AdminBrick, BricksResponse, Session } from "../types.js";

function Switch({ on, disabled, onToggle, label }: { on: boolean; disabled: boolean; onToggle: () => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onToggle}
      className={`inline-flex h-5 w-9 items-center rounded-full px-0.5 transition-colors ${on ? "bg-blue-600" : "bg-slate-300"} ${disabled ? "cursor-not-allowed opacity-50" : ""}`}
    >
      <span className={`h-4 w-4 rounded-full bg-white transition-transform ${on ? "translate-x-4" : ""}`} />
    </button>
  );
}

function NameCell({ brick, selected, onSelect }: { brick: AdminBrick; selected: boolean; onSelect: () => void }) {
  const detail = [brick.provides.length ? `provides ${brick.provides.join(", ")}` : "", brick.requires ? `requires ${brick.requires}` : ""]
    .filter(Boolean)
    .join(" · ");
  return (
    <div>
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        title={`Show what ${brick.name} needs`}
        className="font-medium text-slate-900 hover:text-blue-700 hover:underline"
      >
        {brick.name}
      </button>
      {detail && <div className="text-xs text-slate-500">{detail}</div>}
    </div>
  );
}

function HostCell({ brick, router, runtime }: { brick: AdminBrick; router: BricksResponse["router"]; runtime: string }) {
  const hosts = hostsOf(brick, router);
  if (hosts.length === 0) return <span className="text-slate-400">—</span>;
  return (
    <div className="flex flex-col gap-2">
      {hosts.map((h) => (
        <div key={h.url}>
          {/* On Compose these addresses are on this machine. On Kubernetes the router's is the cluster IP of its
              Service, and a page answers on 127.0.0.1 only through kubectl port-forward: shown, not linked. */}
          {runtime === "compose" ? (
            <a href={h.url} className="break-all font-mono text-xs text-blue-700 hover:underline">
              {h.url}
            </a>
          ) : (
            <span className="break-all font-mono text-xs text-slate-700">{h.url}</span>
          )}
          <div className="text-xs text-slate-500">{h.note}</div>
        </div>
      ))}
    </div>
  );
}

/** The confirmation of a removal, with the CLI's refusal shown before trying when there is one. */
function RemoveDialog({ brick, onCancel, onConfirm }: { brick: AdminBrick; onCancel: () => void; onConfirm: () => void }) {
  const blocked = brick.removeBlockedBy.length > 0;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);
  return (
    <div className="fixed inset-0 z-10 flex items-center justify-center bg-slate-900/40 p-4">
      <div role="dialog" aria-modal="true" aria-labelledby="remove-title" className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl">
        <h2 id="remove-title" className="text-lg font-semibold text-slate-900">
          Remove {brick.name}?
        </h2>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          This stops its services and removes it from <code>platform.json</code>. No data is deleted from the admin: volumes marked for
          deletion are deleted only by <code>plugbricks up --prune-volumes</code> in a terminal. Its secrets are kept.
        </p>
        {blocked && (
          <div className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
            {brick.removeBlockedBy.map((r) => (
              <div key={r.code + r.message}>
                <strong>{r.code}</strong>: {r.message}
              </div>
            ))}
          </div>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button
            autoFocus
            onClick={onCancel}
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={blocked}
            className="rounded-md border border-red-200 bg-white px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Remove {brick.name}
          </button>
        </div>
      </div>
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

export function Bricks({ session }: { session: Session }) {
  const canAdmin = session.role === "admin";
  const [data, setData] = useState<BricksResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tag, setTag] = useState("all");
  const [updated, setUpdated] = useState<string>("");
  const [showAdd, setShowAdd] = useState(false);
  const [source, setSource] = useState("");
  const [removing, setRemoving] = useState<AdminBrick | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const cancelRemove = useCallback(() => setRemoving(null), []);

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

  const { run, action, error: actionError, busy } = useAction(load);
  const tags = useMemo(() => (data ? allTags(data.bricks) : []), [data]);
  const rows = useMemo(() => (data ? filterByTag(data.bricks, tag) : []), [data, tag]);
  const counts = useMemo(() => (data ? summary(data.bricks) : { total: 0, healthy: 0, down: 0, stopped: 0 }), [data]);
  const disabled = !canAdmin || busy;
  // The panel follows the brick by name: it closes when a refresh no longer lists it (removed).
  const open = data?.bricks.find((b) => b.name === selected) ?? null;

  const add = () => {
    if (!source.trim()) return;
    void run({ action: "add", source: source.trim() });
    setSource("");
    setShowAdd(false);
  };

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
          <span className="text-slate-500">
            {reachability(data.router).reachable} of {reachability(data.router).total} subgraphs reachable
          </span>
        </div>
      )}

      {error && <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
      {!canAdmin && (
        <div className="mb-4 rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600">
          Read-only: your role is <strong>viewer</strong>. Enabling, adding, removing or deploying a brick needs{" "}
          <strong>plugbricks-admin</strong>.
        </div>
      )}

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button
          onClick={() => setShowAdd((v) => !v)}
          disabled={disabled}
          title={canAdmin ? "Add a brick from a path relative to the platform" : "Your role is viewer"}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          + Add brick
        </button>
        <button
          onClick={() => void run({ action: "up" })}
          disabled={disabled}
          title={canAdmin ? "Run plugbricks up with this admin's runtime" : "Your role is viewer"}
          className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Deploy
        </button>
        <button
          onClick={load}
          className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100"
        >
          Refresh
        </button>
        {updated && <span className="text-xs text-slate-500">Updated {updated}</span>}
        {busy && <span className="text-xs text-amber-700">an action is running…</span>}
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

      {showAdd && canAdmin && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
          className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white p-3"
        >
          <label className="text-sm text-slate-700" htmlFor="source">
            Source
          </label>
          <input
            id="source"
            value={source}
            onChange={(e) => setSource(e.target.value)}
            placeholder="relative to the platform root, e.g. examples/postgres"
            className="min-w-80 flex-1 rounded-md border border-slate-300 px-3 py-1.5 text-sm"
            disabled={busy}
          />
          <button
            type="submit"
            disabled={busy || !source.trim()}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            Add
          </button>
          <button
            type="button"
            onClick={() => setShowAdd(false)}
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700"
          >
            Cancel
          </button>
        </form>
      )}

      {(action || actionError || busy) && (
        <section className="mb-4 rounded-lg border border-slate-200 bg-white p-4">
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="font-medium text-slate-900">
              {action ? `${action.action}${action.brick ? ` ${action.brick}` : action.source ? ` ${action.source}` : ""}` : "Action"}
            </span>
            {action && (
              <span
                className={`rounded px-2 py-0.5 text-xs ${
                  action.state === "succeeded"
                    ? "bg-emerald-50 text-emerald-700"
                    : action.state === "failed"
                      ? "bg-red-50 text-red-700"
                      : "bg-amber-50 text-amber-700"
                }`}
              >
                {action.state}
              </span>
            )}
            {action?.exitCode !== null && action && <span className="text-xs text-slate-500">exit {action.exitCode}</span>}
            {action && <span className="text-xs text-slate-500">{action.user}</span>}
            {!action && busy && <span className="text-xs text-amber-700">starting…</span>}
          </div>
          {actionError && <p className="mt-2 text-sm text-red-700">{actionError}</p>}
          {action && action.issues.length > 0 && <p className="mt-2 text-xs text-amber-700">codes: {action.issues.join(", ")}</p>}
          {action && (
            <pre className="mt-3 max-h-64 overflow-auto rounded-md bg-slate-950 p-3 text-xs leading-5 text-slate-100">
              {action.output.join("\n") || "No output."}
            </pre>
          )}
        </section>
      )}

      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
              {["Name", "Version", "Tags", "Port", "Subgraph", "Extends", "Enabled", "Deployed", "Status", "Hosts", "Actions"].map((h) => (
                <th key={h} className="px-4 py-3 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((b) => (
              <tr
                key={b.name}
                onClick={(e) => {
                  // A click on a button, switch or link does its own thing; only the rest of the row selects.
                  if (!(e.target as HTMLElement).closest("button, a")) setSelected(b.name);
                }}
                className={`cursor-pointer border-b border-slate-100 last:border-0 ${selected === b.name ? "bg-blue-50/60" : "hover:bg-slate-50"}`}
              >
                <td className="px-4 py-4">
                  <NameCell brick={b} selected={selected === b.name} onSelect={() => setSelected(b.name)} />
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
                  <Switch
                    on={b.enabled}
                    disabled={disabled}
                    label={b.enabled ? `Disable ${b.name}` : `Enable ${b.name}`}
                    onToggle={() => void run({ action: b.enabled ? "disable" : "enable", brick: b.name })}
                  />
                </td>
                <td className="px-4 py-4 text-slate-700">
                  <div>{b.deployed ? "Yes" : "No"}</div>
                  {needsDeploy(b) && <div className="text-xs text-amber-700">Needs deploy</div>}
                </td>
                <td className="px-4 py-4">
                  <StatusCell brick={b} />
                </td>
                <td className="px-4 py-4">
                  <HostCell brick={b} router={data?.router ?? null} runtime={data?.runtime ?? ""} />
                </td>
                <td className="px-4 py-4">
                  <button
                    onClick={() => setRemoving(b)}
                    disabled={disabled}
                    title={canAdmin ? `Remove ${b.name}` : "Your role is viewer"}
                    className="rounded-md border border-red-200 px-2.5 py-1 text-xs text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={11} className="px-4 py-8 text-center text-sm text-slate-500">
                  No brick installed.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {open && <BrickPanel bricks={data?.bricks ?? []} brick={open} onClose={() => setSelected(null)} />}

      <p className="mt-4 text-xs text-slate-500">
        Enabled is what <code>platform.json</code> asks for. Deployed is what the runtime reports. Actions run the same CLI as a terminal,
        one at a time; each attempt is written to the audit log.
      </p>

      {removing && (
        <RemoveDialog
          brick={removing}
          onCancel={cancelRemove}
          onConfirm={() => {
            void run({ action: "remove", brick: removing.name });
            setRemoving(null);
          }}
        />
      )}
    </div>
  );
}
