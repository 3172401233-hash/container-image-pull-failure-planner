/**
 * Pull-decision state machine.
 *
 * Every node decision starts at PENDING and moves into exactly one state.
 * Wait states may later be re-entered into PULL once their condition clears;
 * terminal states (CACHE_HIT, FAILED) never leave.
 *
 * See README.md for the full transition diagram and semantics.
 */
export const STATES = Object.freeze({
  PENDING: 'PENDING',
  CACHE_HIT: 'CACHE_HIT',
  PULL: 'PULL',
  WAIT_QUOTA: 'WAIT_QUOTA',
  WAIT_CREDENTIAL: 'WAIT_CREDENTIAL',
  WAIT_SLOT: 'WAIT_SLOT',
  SWITCH_SOURCE: 'SWITCH_SOURCE',
  RESCHEDULE: 'RESCHEDULE',
  USE_STALE_CACHE: 'USE_STALE_CACHE',
  FAILED: 'FAILED',
});

export const TRANSITIONS = Object.freeze({
  [STATES.PENDING]: [
    STATES.CACHE_HIT,
    STATES.PULL,
    STATES.WAIT_QUOTA,
    STATES.WAIT_CREDENTIAL,
    STATES.WAIT_SLOT,
    STATES.SWITCH_SOURCE,
    STATES.RESCHEDULE,
    STATES.USE_STALE_CACHE,
    STATES.FAILED,
  ],
  [STATES.WAIT_QUOTA]: [STATES.PULL, STATES.SWITCH_SOURCE, STATES.RESCHEDULE, STATES.USE_STALE_CACHE, STATES.FAILED],
  [STATES.WAIT_CREDENTIAL]: [STATES.PULL, STATES.SWITCH_SOURCE, STATES.FAILED],
  [STATES.WAIT_SLOT]: [STATES.PULL, STATES.RESCHEDULE, STATES.FAILED],
  [STATES.SWITCH_SOURCE]: [STATES.PULL, STATES.FAILED],
  [STATES.RESCHEDULE]: [STATES.CACHE_HIT, STATES.PULL, STATES.FAILED],
  [STATES.USE_STALE_CACHE]: [STATES.PULL],
  [STATES.PULL]: [STATES.CACHE_HIT, STATES.FAILED],
  [STATES.CACHE_HIT]: [],
  [STATES.FAILED]: [],
});

export function assertTransition(from, to) {
  const allowed = TRANSITIONS[from];
  if (!allowed || !allowed.includes(to)) {
    throw new Error(`illegal transition ${from} -> ${to}`);
  }
}
