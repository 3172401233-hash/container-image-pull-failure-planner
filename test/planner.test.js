import test from 'node:test';
import assert from 'node:assert/strict';

import { plan } from '../src/planner.js';
import { parseReference } from '../src/reference.js';
import { STATES } from '../src/machine.js';

const NOW = 1_800_000_000_000;
const REG = 'registry.example.com';
const DIGEST_A = `sha256:${'a'.repeat(64)}`;
const DIGEST_B = `sha256:${'b'.repeat(64)}`;

const validCred = { id: 'cred-ok', registry: REG, status: 'valid' };
const ampleQuota = { [REG]: { remaining: 10, resetAt: NOW + 60_000 } };
const deadline = NOW + 5 * 60_000;

function node(name, extra = {}) {
  return { name, cache: [], inflightPulls: 0, ...extra };
}

test('parseReference separates pinned digests from floating tags', () => {
  const pinned = parseReference(`${REG}/app:v1@${DIGEST_A}`);
  assert.equal(pinned.kind, 'digest');
  assert.equal(pinned.registry, REG);
  assert.equal(pinned.repo, 'app');
  assert.equal(pinned.digest, DIGEST_A);

  const floating = parseReference(`${REG}/app:v1`);
  assert.equal(floating.kind, 'tag');
  assert.equal(floating.tag, 'v1');

  const implicit = parseReference('docker.io/library/nginx');
  assert.equal(implicit.kind, 'tag');
  assert.equal(implicit.tag, 'latest');
});

test('cache hit: pinned digest served from node cache without touching quota', () => {
  const result = plan(
    {
      image: `${REG}/app@${DIGEST_A}`,
      nodes: [node('n1', { cache: [{ repo: 'app', digest: DIGEST_A, fetchedAt: NOW - 1_000 }] })],
      credentials: [validCred],
      quota: { [REG]: { remaining: 0, resetAt: NOW + 60_000 } },
      deadline,
    },
    NOW,
  );

  assert.equal(result.decisions.length, 1);
  assert.equal(result.decisions[0].action, 'schedule');
  assert.equal(result.decisions[0].state, STATES.CACHE_HIT);
  assert.equal(result.decisions[0].delayMs, 0);
  assert.equal(result.recommendation.action, 'schedule');
});

test('cache hit: fresh cache satisfies a floating tag; stale cache triggers revalidation', () => {
  const fresh = plan(
    {
      image: `${REG}/app:v1`,
      nodes: [node('n1', { cache: [{ repo: 'app', digest: DIGEST_A, fetchedAt: NOW - 60_000 }] })],
      credentials: [validCred],
      quota: ampleQuota,
      deadline,
    },
    NOW,
  );
  assert.equal(fresh.decisions[0].action, 'schedule');

  const stale = plan(
    {
      image: `${REG}/app:v1`,
      nodes: [node('n1', { cache: [{ repo: 'app', digest: DIGEST_A, fetchedAt: NOW - 60 * 60_000 }] })],
      credentials: [validCred],
      quota: ampleQuota,
      deadline,
    },
    NOW,
  );
  assert.equal(stale.decisions[0].action, 'pull');
  assert.equal(stale.decisions[0].state, STATES.PULL);
});

test('multi-node contention: shared quota grants one pull and defers the rest', () => {
  const result = plan(
    {
      image: `${REG}/app@${DIGEST_A}`,
      nodes: [node('n1'), node('n2'), node('n3')],
      credentials: [validCred],
      quota: { [REG]: { remaining: 1, resetAt: NOW + 30_000 } },
      deadline,
    },
    NOW,
  );

  const pulls = result.decisions.filter((d) => d.action === 'pull');
  const waits = result.decisions.filter((d) => d.action === 'wait');
  assert.equal(pulls.length, 1);
  assert.equal(waits.length, 2);
  for (const w of waits) {
    assert.equal(w.state, STATES.WAIT_QUOTA);
    assert.equal(w.delayMs, 30_000);
  }
});

test('multi-node contention: nodes defer to a peer that already caches the image', () => {
  const result = plan(
    {
      image: `${REG}/app@${DIGEST_A}`,
      nodes: [
        node('cached', { cache: [{ repo: 'app', digest: DIGEST_A, fetchedAt: NOW - 1_000 }] }),
        node('busy-a', { inflightPulls: 5, maxConcurrentPulls: 2 }),
        node('busy-b', { inflightPulls: 3, maxConcurrentPulls: 2 }),
      ],
      credentials: [validCred],
      quota: ampleQuota,
      deadline,
    },
    NOW,
  );

  const byNode = Object.fromEntries(result.decisions.map((d) => [d.node, d]));
  assert.equal(byNode.cached.action, 'schedule');
  assert.equal(byNode['busy-a'].action, 'reschedule');
  assert.equal(byNode['busy-a'].targetNode, 'cached');
  assert.equal(byNode['busy-b'].action, 'reschedule');
});

test('auth failure: one invalid credential trips a single circuit, no node retries it', () => {
  const result = plan(
    {
      image: `${REG}/app:v1`,
      nodes: [node('n1'), node('n2'), node('n3')],
      credentials: [{ id: 'cred-bad', registry: REG, status: 'expired', refreshAt: NOW + 30_000 }],
      quota: ampleQuota,
      deadline,
    },
    NOW,
  );

  assert.deepEqual(result.credentialCircuit, { id: 'cred-bad', state: 'open', reason: 'expired' });
  assert.equal(result.decisions.filter((d) => d.action === 'pull').length, 0);
  for (const d of result.decisions) {
    assert.equal(d.action, 'wait');
    assert.equal(d.state, STATES.WAIT_CREDENTIAL);
    assert.equal(d.delayMs, 30_000);
  }
});

test('auth failure: usable mirror with healthy credentials becomes the recommendation', () => {
  const result = plan(
    {
      image: `${REG}/app:v1`,
      nodes: [node('n1'), node('n2')],
      credentials: [
        { id: 'cred-bad', registry: REG, status: 'invalid' },
        { id: 'cred-mirror', registry: 'mirror.example.com', status: 'valid' },
      ],
      quota: { ...ampleQuota, 'mirror.example.com': { remaining: 5, resetAt: NOW + 60_000 } },
      mirrors: [{ registry: 'mirror.example.com', image: `mirror.example.com/cache/app:v1` }],
      deadline,
    },
    NOW,
  );

  assert.equal(result.credentialCircuit.state, 'open');
  for (const d of result.decisions) {
    assert.equal(d.action, 'switch-source');
    assert.equal(d.state, STATES.SWITCH_SOURCE);
    assert.equal(d.source, 'mirror.example.com/cache/app:v1');
  }
});

test('auth failure: no mirror and no rotation before deadline means fail, never retry', () => {
  const result = plan(
    {
      image: `${REG}/app:v1`,
      nodes: [node('n1')],
      credentials: [{ id: 'cred-bad', registry: REG, status: 'invalid' }],
      quota: ampleQuota,
      deadline,
    },
    NOW,
  );

  assert.equal(result.decisions[0].action, 'fail');
  assert.equal(result.decisions[0].state, STATES.FAILED);
});

test('digest conflict: a pinned digest is never satisfied by a different cached digest', () => {
  const result = plan(
    {
      image: `${REG}/app@${DIGEST_B}`,
      nodes: [node('n1', { cache: [{ repo: 'app', digest: DIGEST_A, fetchedAt: NOW - 1_000 }] })],
      credentials: [validCred],
      quota: ampleQuota,
      deadline,
    },
    NOW,
  );

  const d = result.decisions[0];
  assert.equal(d.action, 'pull');
  assert.equal(d.conflictWith, DIGEST_A);
  assert.match(d.reason, /conflicts with pinned digest/);
});

test('digest conflict: pinned digest may never fall back to stale cache, floating tag may', () => {
  const blockedQuota = { [REG]: { remaining: 0, resetAt: NOW + 60 * 60_000 } };
  const tightDeadline = NOW + 60_000;
  const cache = [{ repo: 'app', digest: DIGEST_A, fetchedAt: NOW - 60 * 60_000 }];

  const pinned = plan(
    {
      image: `${REG}/app@${DIGEST_B}`,
      nodes: [node('n1', { cache })],
      credentials: [validCred],
      quota: blockedQuota,
      deadline: tightDeadline,
    },
    NOW,
  );
  assert.equal(pinned.decisions[0].action, 'fail');
  assert.equal(pinned.decisions[0].state, STATES.FAILED);

  const floating = plan(
    {
      image: `${REG}/app:v1`,
      nodes: [node('n1', { cache })],
      credentials: [validCred],
      quota: blockedQuota,
      deadline: tightDeadline,
    },
    NOW,
  );
  assert.equal(floating.decisions[0].action, 'use-stale-cache');
  assert.equal(floating.decisions[0].state, STATES.USE_STALE_CACHE);
  assert.equal(floating.decisions[0].digest, DIGEST_A);
});

test('digest conflict: floating tag re-pulls when the registry moved the tag', () => {
  const result = plan(
    {
      image: `${REG}/app:v1`,
      nodes: [node('n1', { cache: [{ repo: 'app', digest: DIGEST_A, fetchedAt: NOW - 1_000 }] })],
      credentials: [validCred],
      quota: ampleQuota,
      resolvedDigest: DIGEST_B,
      deadline,
    },
    NOW,
  );

  const d = result.decisions[0];
  assert.equal(d.action, 'pull');
  assert.equal(d.tagMoved, true);
  assert.match(d.reason, /different digest/);
});
