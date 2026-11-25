// What "add" proposes to add with a brick (D26): the bricks of the project's bricks/ folder that provide what it
// requires and the bricks its manifest declares in "dependencies", and in turn what those need. Never the other way
// round: adding orders proposes postgres, never orders-web. Reads only; "add" writes, brick by brick.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { validateManifest } from "./manifest.js";
import { BRICK_FOLDER, brickIntegrity, type Project } from "./platform.js";

/** The part of a manifest this file reads. */
interface Needs {
  name: string;
  provides?: Record<string, unknown>;
  requires?: Record<string, { optional?: boolean }>;
  dependencies?: { plugin: string; optional?: boolean }[];
}

/** A brick "add" would add before the one asked for. */
export interface Proposal {
  name: string;
  /** Its folder, bricks/<name>. */
  dir: string;
  /** Why: `provides "database" to orders`, or `declared in the dependencies of orders-web`. */
  reason: string;
  /**
   * Whether the brick asked for cannot be added without it: it provides a capability that the brick, or a brick it
   * cannot do without, requires. A brick reached only through a declared dependency is not (D21: a dependency is
   * a warning, not a refusal).
   */
  required: boolean;
}

/** A capability that several bricks of bricks/ provide: the person chooses, nothing is picked silently. */
export interface Choice {
  capability: string;
  /** The brick that requires it. */
  consumer: string;
  /** The bricks of bricks/ that provide it, sorted. */
  candidates: string[];
}

export interface NeedsPlan {
  /** In the order to add them: each one after what it needs. */
  add: Proposal[];
  /** Choices left open (no `choose`, or it gave no answer). */
  open: Choice[];
  /**
   * A need that no brick of bricks/ can meet. "add" then proposes nothing and behaves as before: the refusal
   * (REQUIRED_CAPABILITY_MISSING) or the warning of a missing dependency.
   */
  unmet: boolean;
}

/** Picks one of the candidates, or undefined to leave the choice open. */
export type Choose = (choice: Choice) => string | undefined;

/** The valid bricks of bricks/ whose folder is named after the brick (as "add <name>" requires, D25). */
function catalogue(root: string): Map<string, { dir: string; m: Needs }> {
  const folder = join(resolve(root), BRICK_FOLDER);
  const bricks = new Map<string, { dir: string; m: Needs }>();
  if (!existsSync(folder)) return bricks;
  for (const e of readdirSync(folder, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const dir = join(folder, e.name);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(join(dir, "plugin.json"), "utf8"));
    } catch {
      continue;
    }
    // A brick that would be refused anyway is not proposed: "add" by its name says why.
    if (!validateManifest(raw).ok || (raw as Needs).name !== e.name) continue;
    bricks.set(e.name, { dir, m: raw as Needs });
  }
  return bricks;
}

/** What `m` needs from bricks/ that the platform does not have yet. */
export function planNeeds(project: Project, m: Needs, choose: Choose = () => undefined): NeedsPlan {
  const bricks = catalogue(project.root);
  const installed = new Set(Object.keys(project.lock.bricks));
  const provided = new Set(Object.keys(project.lock.capabilities));
  const planned = new Map<string, Proposal>();
  const open: Choice[] = [];
  let unmet = false;
  const visiting = new Set<string>([m.name]);
  /** consumer -> the bricks planned for what it requires: "required" follows these links only. */
  const requiredLinks = new Map<string, string[]>();
  const provider = new Map<string, string>();

  function plan(name: string, reason: string) {
    if (planned.has(name) || visiting.has(name)) return;
    const b = bricks.get(name)!;
    visiting.add(name);
    for (const cap of Object.keys(b.m.provides ?? {})) {
      provided.add(cap);
      provider.set(cap, name);
    }
    visit(b.m);
    planned.set(name, { name, dir: b.dir, reason, required: false });
  }

  function visit(n: Needs) {
    for (const [cap, r] of Object.entries(n.requires ?? {})) {
      if (r.optional) continue;
      if (provided.has(cap)) {
        const by = provider.get(cap);
        if (by) requiredLinks.set(n.name, [...(requiredLinks.get(n.name) ?? []), by]);
        continue;
      }
      const candidates = [...bricks.entries()]
        .filter(([name, b]) => !installed.has(name) && name !== m.name && Object.hasOwn(b.m.provides ?? {}, cap))
        .map(([name]) => name)
        .sort();
      if (candidates.length === 0) {
        unmet = true;
        continue;
      }
      let pick: string | undefined = candidates[0];
      if (candidates.length > 1) {
        pick = choose({ capability: cap, consumer: n.name, candidates });
        if (pick === undefined || !candidates.includes(pick)) {
          open.push({ capability: cap, consumer: n.name, candidates });
          continue;
        }
      }
      requiredLinks.set(n.name, [...(requiredLinks.get(n.name) ?? []), pick]);
      plan(pick, `provides "${cap}" to ${n.name}`);
    }
    for (const d of n.dependencies ?? []) {
      if (d.optional || installed.has(d.plugin) || d.plugin === m.name) continue;
      // A declared dependency that bricks/ does not have stays what it was: a warning of "add" (D21).
      if (!bricks.has(d.plugin)) continue;
      plan(d.plugin, `declared in the dependencies of ${n.name}`);
    }
  }

  visit(m);
  // Required: what the brick asked for requires, and what that requires in turn; not what is reached through a
  // declared dependency only.
  const todo = [m.name];
  while (todo.length) {
    for (const next of requiredLinks.get(todo.pop()!) ?? []) {
      const p = planned.get(next);
      if (p && !p.required) {
        p.required = true;
        todo.push(next);
      }
    }
  }
  // Insertion order of `planned` is the order of the end of each visit: what a brick needs comes before it.
  return { add: [...planned.values()], open, unmet };
}

/**
 * What "add" should propose with the brick at `brickPath` (a folder or its plugin.json): undefined when there is
 * nothing to propose, or when the brick would be refused, so that "add" says why as before. A brick already installed
 * as it is still gets what it lacks (a declared dependency left out earlier); another brick of the same name does not.
 */
export function needsOf(project: Project, brickPath: string, choose?: Choose): (NeedsPlan & { brick: string }) | undefined {
  const file = brickPath.endsWith(".json") ? brickPath : join(brickPath, "plugin.json");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
  if (!validateManifest(raw).ok) return undefined;
  const m = raw as Needs;
  const installed = project.lock.bricks[m.name];
  if (installed && installed.integrity !== brickIntegrity(dirname(file), m.name)) return undefined;
  const plan = planNeeds(project, m, choose);
  if (plan.unmet || (plan.add.length === 0 && plan.open.length === 0)) return undefined;
  return { ...plan, brick: m.name };
}
