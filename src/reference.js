const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

/**
 * Parse an image reference into registry / repo / tag / digest.
 *
 * A reference carrying `@sha256:...` is content-addressed ("digest" kind):
 * the bytes it names can never change, so pull failures can only come from
 * transport concerns (quota, auth, network, missing blob).
 *
 * A reference with only a tag (defaulting to `latest`) is "floating": the
 * registry may point it at a new digest at any time, so a cached digest is
 * merely a hint that must be revalidated.
 */
export function parseReference(image) {
  if (typeof image !== 'string' || image.length === 0) {
    throw new TypeError('image reference must be a non-empty string');
  }

  let name = image;
  let digest = null;
  const at = name.lastIndexOf('@');
  if (at !== -1) {
    digest = name.slice(at + 1);
    name = name.slice(0, at);
    if (!DIGEST_RE.test(digest)) {
      throw new TypeError(`unsupported or malformed digest in reference: ${image}`);
    }
  }

  let tag = null;
  const lastSlash = name.lastIndexOf('/');
  const lastColon = name.lastIndexOf(':');
  if (lastColon > lastSlash) {
    tag = name.slice(lastColon + 1);
    name = name.slice(0, lastColon);
  }

  const parts = name.split('/');
  let registry = 'docker.io';
  let repo = name;
  const first = parts[0];
  if (parts.length > 1 && (first.includes('.') || first.includes(':') || first === 'localhost')) {
    registry = first;
    repo = parts.slice(1).join('/');
  }

  if (digest) {
    return { kind: 'digest', registry, repo, tag, digest, raw: image };
  }
  return { kind: 'tag', registry, repo, tag: tag ?? 'latest', raw: image };
}
