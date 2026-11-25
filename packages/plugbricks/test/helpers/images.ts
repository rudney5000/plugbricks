// The tag a test gives its local build of an example API: the image its manifest names (D29), so that Compose and a
// k3d cluster use the local build and pull nothing.
import { exampleImages } from "../../scripts/example-images.mjs";

export function exampleImage(api: string): string {
  const found = exampleImages().find((i) => i.context === `apis/${api}`);
  if (!found) throw new Error(`no example manifest names an image built from apis/${api}`);
  return found.image;
}
