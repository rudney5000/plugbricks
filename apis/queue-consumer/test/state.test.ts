import { describe, expect, it } from "vitest";
import { ConsumerState } from "../src/state.js";

describe("the consumer's health", () => {
  it("is healthy only after a connection and a delivered message", () => {
    const s = new ConsumerState();
    expect(s.healthy).toBe(false);
    s.markConnected();
    expect(s.healthy).toBe(false);
    s.markDelivered({ from: "queue-consumer", at: "2026-11-19T00:00:00.000Z" });
    expect(s.healthy).toBe(true);
    expect(s.body).toEqual({ connected: true, delivered: true, last: { from: "queue-consumer", at: "2026-11-19T00:00:00.000Z" } });
  });

  it("goes unhealthy when the connection closes, and healthy again after a new round-trip", () => {
    const s = new ConsumerState();
    s.markConnected();
    s.markDelivered({ from: "a", at: "1" });
    s.markDisconnected();
    expect(s.healthy).toBe(false);
    expect(s.body.delivered).toBe(true);
    s.markConnected();
    s.markDelivered({ from: "a", at: "2" });
    expect(s.healthy).toBe(true);
    expect(s.body.last).toEqual({ from: "a", at: "2" });
  });
});
