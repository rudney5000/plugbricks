// The Go template of "create" names the types and methods gqlgen generates (D39), so it names them as gqlgen does. The
// expected names are those gqlgen 0.17.98 wrote when it generated the code of these schemas (checked on 44 brick names);
// the Go brick of e2e-compose builds with one of the awkward ones.
import { describe, expect, it } from "vitest";
import { goName } from "../src/create.js";

describe("the Go names of the Go template", () => {
  it.each([
    ["InventoryItem", "InventoryItem"],
    ["inventoryItems", "InventoryItems"],
    ["UserUrlItem", "UserURLItem"],
    ["userUrlItems", "UserURLItems"],
    ["ApiItem", "APIItem"],
    ["ApiGatewayItem", "APIGatewayItem"],
    ["Api2Item", "API2Item"],
    ["S3Item", "S3Item"],
    ["s3Items", "S3Items"],
    ["UuidServiceItem", "UUIDServiceItem"],
    ["Utf8Item", "Utf8Item"],
    ["ApisItem", "ApisItem"],
    // A single letter before a word: the type and the field of one brick are split differently.
    ["XIdItem", "XIdItem"],
    ["xIdItems", "XIDItems"],
    ["BUrlItem", "BUrlItem"],
    ["bUrlItems", "BURLItems"],
  ])("%s -> %s", (name, go) => {
    expect(goName(name)).toBe(go);
  });
});
