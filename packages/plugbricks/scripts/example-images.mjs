#!/usr/bin/env node
// The images of the example bricks that this repository builds and publishes (D29): every image of an example
// manifest under ghcr.io/rudney5000/plugbricks/, with the folder of apis/ it is built from. One line per image,
// "<folder> <image>", for the images workflow; the tests tag their local builds the same way. The manifest is the
// only place that says which image and version an example uses.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const REGISTRY = "ghcr.io/rudney5000/plugbricks/";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const examples = join(repo, "packages/plugbricks/examples");

/** [{ brick, context, image }], sorted by brick; throws when an image names no folder of apis/ with a Dockerfile. */
export function exampleImages() {
  const out = new Map();
  for (const brick of readdirSync(examples).sort()) {
    const manifest = JSON.parse(readFileSync(join(examples, brick, "plugin.json"), "utf8"));
    const images = [
      ...manifest.services.map((s) => s.image),
      ...Object.values(manifest.provides ?? {}).map((p) => p.provision?.image),
    ].filter((i) => typeof i === "string" && i.startsWith(REGISTRY));
    for (const image of images) {
      const name = image.slice(REGISTRY.length).split(":")[0];
      const context = `apis/${name}`;
      if (!existsSync(join(repo, context, "Dockerfile"))) throw new Error(`${brick}: ${image} has no ${context}/Dockerfile`);
      out.set(image, { brick, context, image });
    }
  }
  return [...out.values()];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  for (const i of exampleImages()) console.log(`${i.context} ${i.image}`);
}
