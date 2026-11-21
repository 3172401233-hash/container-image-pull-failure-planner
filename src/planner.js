import { parseReference } from './reference.js';
import { STATES, assertTransition } from './machine.js';

const DEFAULTS = {
  tagTtlMs: 5 * 60_000,
  estimatedPullMs: 30_000,
  maxConcurrentPullsPerNode: 2,
};

const ACTION_PRIORITY = ['schedule', 'pull', 'use-stale-cache', 'switch-source', 'reschedule', 'wait', 'fail'];

/**
 * Plan what each candidate node should do about an image that failed to pull.
 *
 * @param {object} input
 * @param {string} input.image            image reference (tagged or digest-pinned)
 * @param {Array}  input.nodes            [{ name, cache: [{ repo, digest, fetchedAt }], inflightPulls, maxConcurrentPulls }]
 * @param {Array}  [input.credentials]    [{ id, registry, status: 'valid'|'expired'|'invalid', refreshAt }]
 * @param {object} [input.quota]          { [registry]: { remaining, resetAt } }
 * @param {Array}  [input.mirrors]        [{ registry, image }] alternative sources
 * @param {number} [input.deadline]       pod deadline, ms epoch
 * @param {string} [input.resolvedDigest] digest the tag currently resolves to (if known)
 * @param {object} [input.options]        overrides for tagTtlMs / estimatedPullMs / maxConcurrentPullsPerNode
 * @param {number} [now]                  current time, ms epoch (injectable for tests)
 */
export function plan(input, now = Date.now()) {
  if (!input || typeof input !== 'object') throw new TypeError('plan(input) requires an object');
  if (!input.image) throw new TypeError('input.image is required');
  if (!Array.isArray(input.nodes) || input.nodes.length === 0) {
    throw new TypeError('input.nodes must be a non-empty array');
  }

  const opts = { ...DEFAULTS, ...(input.options ?? {}) };
  const ref = parseReference(input.image);
  const deadline = input.deadline ?? now + 10 * 60_000;

  const cred = resolveCredential(input.credentials ?? [], ref.registry);
  const quota = resolveQuota(input.quota, ref.registry, now);
  const mirrors = (input.mirrors ?? []).map((m) => ({
    registry: m.registry,
    image: m.image ?? null,
    cred: resolveCredential(input.credentials ?? [], m.registry),
    quota: resolveQuota(input.quota, m.registry, now),
  }));

  const ctx = {
    ref,
    cred,
    quota,
    mirrors,
    now,
    deadline,
    budgetMs: deadline - now,
    opts,
    resolvedDigest: input.resolvedDigest ?? null,
  };

  const classified = input.nodes.map((node) => classify(ctx, node));
  const cacheHitNodes = classified.filter((c) => c.type === 'cache').map((c) => c.node.name);

  // Registry quota is shared across all nodes, so pulls are allocated from a
  // single capacity pool instead of letting every node retry independently.
  let pullCapacity = cred.status === 'ok' ? Math.max(0, quota.remaining) : 0;
  const shared = {
    takeCapacity: () => pullCapacity-- > 0,
    cacheHitNodes,
  };

  const ordered = [...classified].sort(
    (a, b) => (a.node.inflightPulls ?? 0) - (b.node.inflightPulls ?? 0) || a.node.name.localeCompare(b.node.name),
  );

  const decisions = ordered.map((item) =>
    item.type === 'cache'
      ? decision(item.node, 'schedule', STATES.CACHE_HIT, item.reason)
      : decidePull(ctx, item, shared),
  );

  decisions.sort(
    (a, b) => input.nodes.findIndex((n) => n.name === a.node) - input.nodes.findIndex((n) => n.name === b.node),
  );

  return {
    image: input.image,
    reference: ref,
    now,
    deadline,
    credentialCircuit:
      cred.status === 'blocked'
        ? { id: cred.id, state: 'open', reason: cred.reason }
        : { id: cred.id ?? null, state: 'closed' },
    decisions,
    recommendation: pickRecommendation(decisions),
  };
}

function classify(ctx, node) {
  const { ref, now, opts, resolvedDigest } = ctx;
  const cache = node.cache ?? [];
  const entry = cache.find((e) => e.repo === ref.repo) ?? null;

  if (ref.kind === 'digest') {
    if (cache.some((e) => e.digest === ref.digest)) {
      return { type: 'cache', node, reason: `pinned digest ${short(ref.digest)} already in node cache` };
    }
    // A pinned digest can never be satisfied by a different cached digest:
    // the mismatch is a hard conflict, not staleness.
    return {
      type: 'pull',
      node,
      extra: { conflictWith: entry && entry.digest !== ref.digest ? entry.digest : null, tagMoved: false, staleEntry: null },
    };
  }

  if (entry) {
    const fresh = now - (entry.fetchedAt ?? 0) <= opts.tagTtlMs;
    const moved = resolvedDigest !== null && resolvedDigest !== entry.digest;
    if (fresh && !moved) {
      return { type: 'cache', node, reason: `fresh cached digest for floating tag ${ref.tag}` };
    }
    // Floating tags may have moved; the stale entry stays as a last-resort fallback.
    return { type: 'pull', node, extra: { conflictWith: null, tagMoved: moved, staleEntry: entry } };
  }

  return { type: 'pull', node, extra: { conflictWith: null, tagMoved: false, staleEntry: null } };
}

function decidePull(ctx, item, shared) {
  const { cred, quota, mirrors, now, budgetMs, opts } = ctx;
  const { node, extra } = item;

  // A broken credential trips one cluster-wide circuit: no node gets a pull
  // or retry action until the credential is rotated or a mirror is used.
  if (cred.status === 'blocked' || cred.status === 'missing') {
    const mirror = pickMirror(mirrors);
    if (mirror) {
      return decision(
        node,
        'switch-source',
        STATES.SWITCH_SOURCE,
        `credential ${cred.id ?? '(none)'} unusable for ${ctx.ref.registry}; pull from mirror ${mirror.registry}`,
        { ...extra, source: mirror.image ?? mirror.registry },
      );
    }
    if (cred.status === 'blocked' && cred.refreshAt != null) {
      const delayMs = Math.max(0, cred.refreshAt - now);
      if (delayMs + opts.estimatedPullMs <= budgetMs) {
        return decision(
          node,
          'wait',
          STATES.WAIT_CREDENTIAL,
          `credential ${cred.id} is ${cred.reason}; wait once for rotation instead of retrying it on every node`,
          { ...extra, delayMs },
        );
      }
    }
    return decision(
      node,
      'fail',
      STATES.FAILED,
      cred.status === 'missing'
        ? 'no credential configured for registry'
        : `credential ${cred.id} is ${cred.reason} and no mirror fits the deadline`,
      extra,
    );
  }

  if (!shared.takeCapacity()) {
    const waitMs = Math.max(0, (quota.resetAt ?? now) - now);
    if (shared.cacheHitNodes.length > 0) {
      return decision(
        node,
        'reschedule',
        STATES.RESCHEDULE,
        `shared registry quota exhausted; reschedule to ${shared.cacheHitNodes[0]} which already caches the image`,
        { ...extra, targetNode: shared.cacheHitNodes[0] },
      );
    }
    if (waitMs + opts.estimatedPullMs <= budgetMs) {
      return decision(
        node,
        'wait',
        STATES.WAIT_QUOTA,
        'registry quota exhausted (HTTP 429); wait for reset before pulling',
        { ...extra, delayMs: waitMs },
      );
    }
    const mirror = pickMirror(mirrors);
    if (mirror) {
      return decision(
        node,
        'switch-source',
        STATES.SWITCH_SOURCE,
        `quota reset misses the pod deadline; use mirror ${mirror.registry}`,
        { ...extra, source: mirror.image ?? mirror.registry },
      );
    }
    if (extra.staleEntry) {
      // Only reachable for floating tags: a pinned digest never has a staleEntry.
      return decision(
        node,
        'use-stale-cache',
        STATES.USE_STALE_CACHE,
        'deadline too tight to wait for quota; fall back to cached digest for the floating tag',
        { ...extra, digest: extra.staleEntry.digest },
      );
    }
    return decision(node, 'fail', STATES.FAILED, 'quota exhausted and no fallback fits the deadline', extra);
  }

  const inflight = node.inflightPulls ?? 0;
  const maxConcurrent = node.maxConcurrentPulls ?? opts.maxConcurrentPullsPerNode;
  if (inflight >= maxConcurrent) {
    if (shared.cacheHitNodes.length > 0) {
      return decision(
        node,
        'reschedule',
        STATES.RESCHEDULE,
        `node pull slots busy; reschedule to ${shared.cacheHitNodes[0]} which already caches the image`,
        { ...extra, targetNode: shared.cacheHitNodes[0] },
      );
    }
    return decision(node, 'wait', STATES.WAIT_SLOT, 'node pull slots busy; wait for a free slot', {
      ...extra,
      delayMs: opts.estimatedPullMs,
    });
  }

  const reason = extra.conflictWith
    ? `cached digest ${short(extra.conflictWith)} conflicts with pinned digest ${short(ctx.ref.digest)}; cache cannot satisfy it, pull required`
    : extra.tagMoved
      ? 'tag now resolves to a different digest; re-pull to revalidate'
      : 'no usable cache entry; pull from registry';
  return decision(node, 'pull', STATES.PULL, reason, extra);
}

function decision(node, action, toState, reason, extra = {}) {
  assertTransition(STATES.PENDING, toState);
  const { delayMs = 0, staleEntry, ...rest } = extra;
  return { node: node.name, action, state: toState, reason, delayMs, ...rest };
}

function pickRecommendation(decisions) {
  return [...decisions].sort(
    (a, b) => ACTION_PRIORITY.indexOf(a.action) - ACTION_PRIORITY.indexOf(b.action) || a.delayMs - b.delayMs,
  )[0];
}

function pickMirror(mirrors) {
  return mirrors.find((m) => m.cred.status === 'ok' && m.quota.remaining > 0) ?? null;
}

function resolveCredential(credentials, registry) {
  const cred = credentials.find((c) => c.registry === registry) ?? credentials.find((c) => c.registry === '*') ?? null;
  if (!cred) return { status: 'missing', id: null };
  if (cred.status === 'valid') return { status: 'ok', id: cred.id ?? null };
  return { status: 'blocked', id: cred.id ?? null, reason: cred.status, refreshAt: cred.refreshAt ?? null };
}

function resolveQuota(quota, registry, now) {
  const q = quota?.[registry] ?? quota?.['*'] ?? null;
  if (!q) return { remaining: Number.POSITIVE_INFINITY, resetAt: now };
  return { remaining: q.remaining ?? 0, resetAt: q.resetAt ?? now };
}

function short(digest) {
  return digest.length > 19 ? `${digest.slice(0, 19)}…` : digest;
}
