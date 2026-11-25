import { describe, expect, it } from "vitest";
import { checkImagePin, parseImageRef } from "../src/image.js";

const DIGEST = "sha256:" + "a".repeat(64);

describe("parseImageRef", () => {
  it.each([
    ["postgres:16.4-alpine", { repository: "postgres", tag: "16.4-alpine" }],
    ["ghcr.io/example/orders-api-app:0.1.0", { repository: "example/orders-api-app", tag: "0.1.0" }],
    ["localhost:5000/orders-api-app:1.2.3", { repository: "orders-api-app", tag: "1.2.3" }],
    ["localhost:5000/orders-api-app", { repository: "orders-api-app" }],
    [`nats@${DIGEST}`, { repository: "nats", digest: DIGEST }],
    [`nats:2.10.1@${DIGEST}`, { repository: "nats", tag: "2.10.1", digest: DIGEST }],
  ])("%s", (image, ref) => {
    expect(parseImageRef(image)).toEqual(ref);
  });
});

describe("checkImagePin", () => {
  it.each(["postgres:16.4-alpine", "nats:2.10.1", "app:v1.2.3", "app:1.2", `nats@${DIGEST}`, `nats:latest@${DIGEST}`])(
    "accepts %s",
    (image) => {
      expect(checkImagePin(image).ok).toBe(true);
    },
  );

  it.each([
    ["postgres", "IMAGE_NOT_PINNED"],
    ["registry.local:5000/app", "IMAGE_NOT_PINNED"],
    ["postgres:latest", "IMAGE_FLOATING_TAG"],
    ["postgres:16", "IMAGE_FLOATING_TAG"],
    ["postgres:alpine", "IMAGE_FLOATING_TAG"],
    ["node:lts-bookworm", "IMAGE_FLOATING_TAG"],
    ["app@sha256:abc", "IMAGE_INVALID"],
    ["Upper/Case:1.0.0", "IMAGE_INVALID"],
    ["app:", "IMAGE_INVALID"],
  ])("rejects %s with %s", (image, code) => {
    expect(checkImagePin(image)).toMatchObject({ ok: false, code });
  });
});
