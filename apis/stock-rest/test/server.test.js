import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createStockServer } from "../server.js";

// The REST API of the example, as its contract (openapi.json) says it answers.
let server;
let base;

before(async () => {
  server = createStockServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const restock = (sku, body) => fetch(`${base}/items/${sku}/restock`, { method: "POST", body });

describe("the stock REST API", () => {
  it("lists the items and gives one by sku", async () => {
    assert.deepEqual(
      (await (await fetch(`${base}/items`)).json()).map((i) => i.sku),
      ["BRK-1", "PLG-2"],
    );
    assert.equal((await (await fetch(`${base}/items/BRK-1`)).json()).name, "Brick");
  });

  it("answers 404 for an unknown sku and an unknown path", async () => {
    assert.equal((await fetch(`${base}/items/NOPE`)).status, 404);
    assert.equal((await fetch(`${base}/nope`)).status, 404);
    assert.equal((await restock("NOPE", '{"quantity":1}')).status, 404);
  });

  it("adds a delivery to the quantity", async () => {
    const response = await restock("PLG-2", '{"quantity":5}');
    assert.equal(response.status, 200);
    assert.equal((await response.json()).quantity, 5);
  });

  it("refuses a quantity that is not a whole number between 1 and 1000", async () => {
    for (const body of ['{"quantity":0}', '{"quantity":1001}', '{"quantity":1.5}', '{"quantity":"3"}', "{}", "not json"]) {
      const response = await restock("BRK-1", body);
      assert.equal(response.status, 400, body);
      assert.equal(typeof (await response.json()).message, "string");
    }
  });
});
