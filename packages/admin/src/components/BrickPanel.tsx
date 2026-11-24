import { useState } from "react";
import { dependencyGraph, requiredBy, tone } from "../lib.js";
import type { DependencyGraph, GraphEdge, GraphNode } from "../lib.js";
import type { AdminBrick, AdminDependency, LiveState } from "../types.js";

const NODE_W = 176;
const NODE_H = 52;
const GAP_X = 110;
const GAP_Y = 24;
const PAD = 8;
/** Room above the first row for the arrows that arc over a brick. */
const ARC = 36;

const KIND: Record<AdminDependency["kind"], string> = {
  capability: "capability",
  extends: "extends",
  declared: "declared",
};

/** Written out in full: Tailwind finds a class only where its whole name is in the source. */
const DOT: Record<LiveState, string> = {
  healthy: "fill-emerald-500",
  starting: "fill-amber-500",
  unhealthy: "fill-red-500",
  stopped: "fill-slate-400",
  "not deployed": "fill-slate-300",
  unknown: "fill-slate-400",
};

/** What is written on an arrow: short, because the space between two bricks is; the whole reason is in the list below. */
function shortLabel(e: GraphEdge): string {
  if (e.kind === "declared") return "needs";
  if (e.kind === "extends") return "extends";
  return e.label.length > 16 ? `${e.label.slice(0, 15)}…` : e.label;
}

const x = (n: GraphNode) => PAD + n.layer * (NODE_W + GAP_X);
const y = (n: GraphNode, top: number) => PAD + top + n.row * (NODE_H + GAP_Y);

/** The arrows run right, from the brick that needs to the brick it needs; one that points back is drawn from edge to edge. */
function edgePath(a: GraphNode, b: GraphNode, top: number): { d: string; mx: number; my: number } {
  if (b.layer > a.layer) {
    const x1 = x(a) + NODE_W;
    const y1 = y(a, top) + NODE_H / 2;
    const x2 = x(b);
    const y2 = y(b, top) + NODE_H / 2;
    const mid = (x1 + x2) / 2;
    // An arrow that skips a column would run behind the bricks in between: it arcs over them instead.
    if (b.layer - a.layer > 1) {
      const lift = Math.min(y1, y2) - NODE_H;
      return {
        d: `M${x1},${y1} C${x1 + GAP_X / 2},${lift} ${x2 - GAP_X / 2},${lift} ${x2},${y2}`,
        mx: mid,
        my: (y1 + y2) / 2 - NODE_H * 0.75 - 4,
      };
    }
    return { d: `M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`, mx: mid, my: (y1 + y2) / 2 };
  }
  const down = y(b, top) >= y(a, top);
  const x1 = x(a) + NODE_W / 2;
  const y1 = down ? y(a, top) + NODE_H : y(a, top);
  const x2 = x(b) + NODE_W / 2;
  const y2 = down ? y(b, top) : y(b, top) + NODE_H;
  return { d: `M${x1},${y1} L${x2},${y2}`, mx: (x1 + x2) / 2, my: (y1 + y2) / 2 };
}

function Graph({ graph, root }: { graph: DependencyGraph; root: string }) {
  const byName = new Map(graph.nodes.map((n) => [n.name, n]));
  const layerOf = (name: string) => byName.get(name)?.layer ?? 0;
  const top = graph.edges.some((e) => layerOf(e.to) - layerOf(e.from) > 1) ? ARC : 0;
  const width =
    PAD * 2 + (Math.max(...graph.nodes.map((n) => n.layer)) + 1) * NODE_W + Math.max(...graph.nodes.map((n) => n.layer)) * GAP_X;
  const rows = Math.max(...graph.nodes.map((n) => n.row)) + 1;
  const height = PAD * 2 + top + rows * NODE_H + (rows - 1) * GAP_Y;
  return (
    <svg width={width} height={height} role="img" aria-label={`What ${root} needs`} className="block">
      <defs>
        <marker id="dep-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" className="fill-slate-500" />
        </marker>
      </defs>
      {graph.edges.map((e) => {
        const a = byName.get(e.from);
        const b = byName.get(e.to);
        if (!a || !b) return null;
        const p = edgePath(a, b, top);
        const text = shortLabel(e);
        return (
          <g key={`${e.from}>${e.to}`}>
            <title>{`${e.from} needs ${e.to} (${KIND[e.kind]}${e.optional ? ", optional" : ""}): ${e.label}`}</title>
            <path
              d={p.d}
              fill="none"
              className="stroke-slate-400"
              strokeWidth={1.5}
              strokeDasharray={e.optional ? "5 4" : undefined}
              markerEnd="url(#dep-arrow)"
            />
            <text
              x={p.mx}
              y={p.my - 4}
              textAnchor="middle"
              fontSize={10}
              className="fill-slate-500"
              stroke="white"
              strokeWidth={3}
              paintOrder="stroke"
            >
              {text}
            </text>
          </g>
        );
      })}
      {graph.nodes.map((n) => {
        const missing = !n.installed;
        return (
          <g key={n.name} transform={`translate(${x(n)},${y(n, top)})`}>
            <title>
              {missing ? `${n.name} is needed but not installed` : `${n.name} ${n.version ?? ""}${n.enabled ? "" : " (disabled)"}`}
            </title>
            <rect
              width={NODE_W}
              height={NODE_H}
              rx={8}
              strokeWidth={n.name === root ? 2 : 1}
              strokeDasharray={missing ? "5 4" : undefined}
              className={
                missing ? "fill-red-50 stroke-red-400" : n.name === root ? "fill-blue-50 stroke-blue-500" : "fill-white stroke-slate-300"
              }
            />
            <text x={12} y={21} fontSize={13} fontWeight={600} className="fill-slate-900">
              {n.name}
            </text>
            <text x={12} y={39} fontSize={11} className={missing ? "fill-red-700" : "fill-slate-500"}>
              {missing ? "not installed" : `${n.version ?? ""} · ${n.enabled ? (n.state ?? "unknown") : "disabled"}`}
            </text>
            {n.state && n.enabled && <circle cx={NODE_W - 14} cy={15} r={4} className={DOT[n.state]} />}
          </g>
        );
      })}
    </svg>
  );
}

function Chip({ children, tip }: { children: React.ReactNode; tip?: string }) {
  return (
    <span title={tip} className="rounded border border-slate-300 bg-slate-100 px-2 py-0.5 text-xs text-slate-700">
      {children}
    </span>
  );
}

function Dependencies({ bricks, brick }: { bricks: AdminBrick[]; brick: AdminBrick }) {
  const graph = dependencyGraph(bricks, brick.name);
  const by = requiredBy(bricks, brick.name);
  const direct = brick.dependsOn;
  const missing = graph.nodes.filter((n) => !n.installed).map((n) => n.name);
  const off = graph.nodes.filter((n) => n.installed && !n.enabled && n.name !== brick.name).map((n) => n.name);
  return (
    <div className="space-y-4">
      <p className="text-xs text-slate-500">
        Everything <strong className="text-slate-700">{brick.name}</strong> needs, transitively. The label on an arrow is why: a capability
        it requires, the entities it extends, or what its manifest declares. A dashed arrow is optional.
      </p>
      {missing.length > 0 && (
        <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          Not installed: <strong>{missing.join(", ")}</strong>. {brick.name} will not work without {missing.length === 1 ? "it" : "them"}.
        </div>
      )}
      {off.length > 0 && (
        <div className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Disabled in platform.json: <strong>{off.join(", ")}</strong>.
        </div>
      )}
      {direct.length === 0 ? (
        <p className="text-sm text-slate-600">{brick.name} needs no other brick.</p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-slate-200 bg-slate-50 p-2">
          <Graph graph={graph} root={brick.name} />
        </div>
      )}
      {graph.edges.length > 0 && (
        <ul className="space-y-1 text-sm text-slate-700">
          {graph.edges.map((e) => (
            <li key={`${e.from}>${e.to}`}>
              <strong>{e.from}</strong> needs <strong>{e.to}</strong>
              <span className="text-slate-500">
                {" "}
                · {KIND[e.kind]}
                {e.optional ? ", optional" : ""} · {e.label}
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-slate-700">Needed first, in order:</span>
        {graph.order.length === 0 ? (
          <span className="text-slate-500">nothing</span>
        ) : (
          graph.order.map((n, i) => (
            <Chip key={n}>
              {i + 1}. {n}
            </Chip>
          ))
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-slate-700">Required by:</span>
        {by.length === 0 ? (
          <span className="text-slate-500">nothing depends on it</span>
        ) : (
          by.map((r) => (
            <Chip key={r.brick} tip={`${KIND[r.kind]}: ${r.label}`}>
              {r.brick}
              {r.optional ? " (optional)" : ""}
            </Chip>
          ))
        )}
      </div>
      <p className="text-xs text-slate-500">
        The order is the one the links give. When you deploy, plugbricks itself waits only for the capabilities a brick requires. A declared
        link keeps its target from being removed while this brick is installed, and from being disabled while this brick is enabled.
      </p>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[9rem_1fr] gap-2 py-1.5 text-sm">
      <dt className="text-slate-500">{label}</dt>
      <dd className="text-slate-800">{children}</dd>
    </div>
  );
}

function Details({ brick }: { brick: AdminBrick }) {
  const t = tone(brick.state);
  return (
    <dl className="divide-y divide-slate-100">
      <Row label="Version">{brick.version}</Row>
      <Row label="Status">
        <span className="inline-flex items-center gap-2 capitalize">
          <span className={`h-2 w-2 rounded-full ${t.dot}`} />
          {brick.state}
        </span>
        {brick.reason && <span className="ml-2 text-xs normal-case text-slate-500">{brick.reason}</span>}
      </Row>
      <Row label="Restarts">{brick.restarts}</Row>
      <Row label="Port">{brick.port ?? "—"}</Row>
      <Row label="Provides">{brick.provides.length ? brick.provides.join(", ") : "—"}</Row>
      <Row label="Requires">{brick.requires || "—"}</Row>
      <Row label="Extends">{brick.extends || "—"}</Row>
      <Row label="Needs">
        {brick.dependsOn.length
          ? brick.dependsOn.map((d) => `${d.brick} (${KIND[d.kind]}${d.optional ? ", optional" : ""})`).join(", ")
          : "—"}
      </Row>
      <Row label="Tags">{brick.tags.length ? brick.tags.join(", ") : "—"}</Row>
      {brick.webUrl && (
        <Row label="Page">
          <span className="break-all font-mono text-xs">{brick.webUrl}</span>
        </Row>
      )}
      {brick.removeBlockedBy.length > 0 && (
        <Row label="Cannot be removed">
          {brick.removeBlockedBy.map((r) => (
            <div key={r.code + r.message}>
              <strong>{r.code}</strong>: {r.message}
            </div>
          ))}
        </Row>
      )}
    </dl>
  );
}

const TABS = ["Dependencies", "Details"] as const;

/** The panel under the table: what the clicked brick needs, and its details. */
export function BrickPanel({ bricks, brick, onClose }: { bricks: AdminBrick[]; brick: AdminBrick; onClose: () => void }) {
  const [tab, setTab] = useState<(typeof TABS)[number]>("Dependencies");
  return (
    <section aria-label={`${brick.name} details`} className="mt-4 rounded-lg border border-slate-200 bg-white">
      <div role="tablist" className="flex items-center gap-1 border-b border-slate-200 px-3">
        <span className="mr-3 py-3 text-sm font-semibold text-slate-900">{brick.name}</span>
        {TABS.map((name) => (
          <button
            key={name}
            role="tab"
            aria-selected={tab === name}
            onClick={() => setTab(name)}
            className={`-mb-px border-b-2 px-3 py-3 text-sm ${tab === name ? "border-blue-600 text-blue-700" : "border-transparent text-slate-600 hover:text-slate-900"}`}
          >
            {name}
            {name === "Dependencies" && brick.dependsOn.length > 0 ? ` (${brick.dependsOn.length})` : ""}
          </button>
        ))}
        <button
          onClick={onClose}
          aria-label="Close the panel"
          className="ml-auto rounded px-2 py-1 text-sm text-slate-500 hover:bg-slate-100"
        >
          Close
        </button>
      </div>
      <div role="tabpanel" className="p-4">
        {tab === "Dependencies" ? <Dependencies bricks={bricks} brick={brick} /> : <Details brick={brick} />}
      </div>
    </section>
  );
}
