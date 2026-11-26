// The images of the examples that the images workflow builds and publishes (D29): every one comes from an example
// manifest and an apis/ folder with a Dockerfile, under the registry of this repository, pinned to a version.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkImagePin } from "../src/image.js";
import { exampleImages, REGISTRY } from "../scripts/example-images.mjs";

const pkg = fileURLToPath(new URL("../", import.meta.url));
const script = join(pkg, "scripts/example-images.mjs");

describe("the images of the examples (D29)", () => {
  it("lists one image per application example, built from apis/, pinned to a version", () => {
    const images = exampleImages();
    expect(images.map((i) => i.brick)).toEqual(["catalog-grpc", "keycloak", "orders-api", "orders-web", "queue-consumer", "shipping-api"]);
    for (const i of images) {
      expect(i.image, i.brick).toBe(`${REGISTRY}${i.context.slice("apis/".length)}:0.1.0`);
      expect(checkImagePin(i.image).ok, i.image).toBe(true);
    }
  });

  it("leaves no example on an image only this repository can build", () => {
    for (const brick of readdirSync(join(pkg, "examples"))) {
      expect(readFileSync(join(pkg, "examples", brick, "plugin.json"), "utf8"), brick).not.toContain("plugbricks-example/");
    }
  });

  it("prints '<folder> <image>' per line for the workflow", () => {
    const r = spawnSync(process.execPath, [script], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim().split("\n")).toEqual(exampleImages().map((i) => `${i.context} ${i.image}`));
  });
});
