import { describe, expect, it } from "vitest";
import { pageHtml, readOrders, rowsHtml } from "../src/page.js";

describe("the orders page", () => {
  it("shows the orders and their shipment when every subgraph answers", () => {
    const view = readOrders({
      data: {
        orders: [
          { id: "2", total: 9.9, status: "pending", shipment: null },
          { id: "1", total: 42.5, status: "pending", shipment: { carrier: "dhl", status: "SHIPPED" } },
        ],
      },
    });
    expect(view.shippingUnavailable).toBe(false);
    expect(view.orders.map((o) => o.shipment)).toEqual([null, { carrier: "dhl", status: "SHIPPED" }]);
    const rows = rowsHtml(view);
    expect(rows).toContain("Not shipped");
    expect(rows).toContain("dhl · SHIPPED");
    expect(rows).toContain("42.50");
  });

  it("keeps the orders and marks the shipment unavailable when shipping does not answer", () => {
    const view = readOrders({
      data: { orders: [{ id: "1", total: 10, status: "pending", shipment: null }] },
      errors: [{ message: "Failed to fetch from Subgraph 'shipping'.", path: ["orders", 0, "shipment"] }],
    });
    expect(view.shippingUnavailable).toBe(true);
    expect(view.orders[0].shipment).toBeUndefined();
    expect(rowsHtml(view)).toContain("Unavailable");
    expect(pageHtml(view, "http://127.0.0.1:4000/graphql")).not.toContain('class="banner" hidden');
  });

  it("says why when no order can be read", () => {
    const view = readOrders({ data: null, errors: [{ message: "boom" }] });
    expect(view.error).toBe("boom");
    expect(rowsHtml(view)).toContain("Orders cannot be read: boom");
  });

  it("escapes what comes from the router", () => {
    const view = readOrders({ data: { orders: [{ id: "<script>", total: 1, status: '"x"', shipment: null }] } });
    const rows = rowsHtml(view);
    expect(rows).not.toContain("<script>");
    expect(rows).toContain("#&lt;script&gt;");
    expect(rows).toContain("&quot;x&quot;");
  });

  it("gives the browser the router address only when there is one", () => {
    const view = readOrders({ data: { orders: [] } });
    const withRouter = pageHtml(view, "http://127.0.0.1:4000/graphql");
    expect(withRouter).toContain('data-graphql="http://127.0.0.1:4000/graphql"');
    expect(withRouter).toContain('id="refresh"');
    const without = pageHtml(view, null);
    expect(without).not.toContain("<script>");
    expect(without).not.toContain('id="refresh"');
  });
});
