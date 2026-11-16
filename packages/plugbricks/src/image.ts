/**
 * Image reference parsing and the pinning rule.
 *
 * Reference grammar (simplified OCI): [registry[:port]/]repository[:tag][@digest]
 * Pinned means: a sha256 digest, or a tag that starts with an explicit version of
 * at least MAJOR.MINOR (16.4-alpine, v1.2.3, 0.1.0). Tags such as latest, stable,
 * 16 or alpine move over time and are rejected.
 */
export interface ImageRef {
  repository: string;
  tag?: string;
  digest?: string;
}

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const COMPONENT = "[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*";
const REPO = new RegExp(`^${COMPONENT}(?:/${COMPONENT})*$`);
const PINNED_TAG = /^v?\d+\.\d+(?:[.+-][A-Za-z0-9_.+-]*)?$/;

export type ImageCheck =
  | { ok: true; ref: ImageRef }
  | { ok: false; code: "IMAGE_INVALID"; reason: string }
  | { ok: false; code: "IMAGE_NOT_PINNED" }
  | { ok: false; code: "IMAGE_FLOATING_TAG"; tag: string };

export function parseImageRef(image: string): ImageRef | { error: string } {
  let rest = image;
  let digest: string | undefined;
  const at = rest.indexOf("@");
  if (at !== -1) {
    digest = rest.slice(at + 1);
    rest = rest.slice(0, at);
    if (!DIGEST.test(digest)) return { error: "digest must be sha256:<64 hex>" };
  }

  // A ':' after the last '/' is a tag; one before it belongs to a registry port.
  let tag: string | undefined;
  const colon = rest.lastIndexOf(":");
  if (colon > rest.lastIndexOf("/")) {
    tag = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
    if (!TAG.test(tag)) return { error: `tag "${tag}" is malformed` };
  }

  // Drop the registry host (first segment with a '.' or ':' or equal to localhost).
  const parts = rest.split("/");
  if (parts.length > 1 && (/[.:]/.test(parts[0]) || parts[0] === "localhost")) parts.shift();
  const repository = parts.join("/");
  if (!REPO.test(repository)) return { error: `repository "${repository}" is malformed` };

  return { repository, tag, digest };
}

export function checkImagePin(image: string): ImageCheck {
  const ref = parseImageRef(image);
  if ("error" in ref) return { ok: false, code: "IMAGE_INVALID", reason: ref.error };
  if (ref.digest) return { ok: true, ref };
  if (!ref.tag) return { ok: false, code: "IMAGE_NOT_PINNED" };
  if (!PINNED_TAG.test(ref.tag)) return { ok: false, code: "IMAGE_FLOATING_TAG", tag: ref.tag };
  return { ok: true, ref };
}
