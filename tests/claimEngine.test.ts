import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { makeSandbox, makeOffer, eventsOfType, type Sandbox } from './helpers.js';
import { AppError } from '../src/shared/errors.js';

let box: Sandbox;

beforeEach(() => {
  box = makeSandbox();
});

afterEach(() => {
  box.cleanup();
});

describe('automatic claiming', () => {
  it('claims a genuinely free offer and verifies ownership', async () => {
    box.configStore.update({ claiming: { mode: 'auto' } });
    box.provider.offers = [makeOffer({ storeOfferId: 'free-1', title: 'Free One' })];

    const summary = await box.engine.runCycle('manual');

    expect(summary.discovered).toBe(1);
    expect(summary.claimed).toBe(1);
    expect(box.provider.claimCalls).toEqual(['free-1']);

    const offers = box.repos.offers.list({});
    expect(offers[0]?.status).toBe('claimed');
    expect(box.repos.ownership.get(offers[0]!.id)?.owned).toBe(true);

    const attempts = box.repos.claims.history(10);
    expect(attempts[0]?.status).toBe('succeeded');
    expect(attempts[0]?.verified).toBe(true);

    expect(eventsOfType(box.events, 'CLAIM_SUCCEEDED')).toHaveLength(1);
    expect(eventsOfType(box.events, 'GAME_DISCOVERED')).toHaveLength(1);
  });

  it('never claims twice, even across cycles and restarts', async () => {
    box.configStore.update({ claiming: { mode: 'auto' } });
    box.provider.offers = [makeOffer({ storeOfferId: 'free-2' })];

    await box.engine.runCycle('manual');
    await box.engine.runCycle('scheduled');
    await box.engine.runCycle('startup');

    expect(box.provider.claimCalls).toEqual(['free-2']);
    expect(box.repos.claims.history(10).filter((a) => a.status === 'succeeded')).toHaveLength(1);
  });

  it('refuses to claim an offer that is already owned', async () => {
    box.configStore.update({ claiming: { mode: 'auto' } });
    box.provider.offers = [makeOffer({ storeOfferId: 'owned-1' })];
    box.provider.owned.add('owned-1');

    const summary = await box.engine.runCycle('manual');

    expect(summary.alreadyOwned).toBe(1);
    expect(box.provider.claimCalls).toEqual([]);
    expect(box.repos.offers.list({})[0]?.status).toBe('already_owned');
    expect(eventsOfType(box.events, 'GAME_ALREADY_OWNED')).toHaveLength(1);
  });

  it('records a rejected claim as failed and never as claimed', async () => {
    box.configStore.update({ claiming: { mode: 'auto' } });
    box.provider.offers = [makeOffer({ storeOfferId: 'bad-1' })];
    box.provider.claimResults.set('bad-1', 'fail');

    const summary = await box.engine.runCycle('manual');

    expect(summary.failed).toBe(1);
    expect(summary.claimed).toBe(0);
    expect(box.repos.offers.list({})[0]?.status).toBe('failed');
    const attempt = box.repos.claims.history(10)[0];
    expect(attempt?.status).toBe('failed');
    expect(attempt?.errorCode).toBe('CLAIM_REJECTED');
    expect(eventsOfType(box.events, 'CLAIM_FAILED')).toHaveLength(1);
  });

  it('survives a network interruption without marking the offer claimed', async () => {
    box.configStore.update({ claiming: { mode: 'auto' } });
    box.provider.offers = [makeOffer({ storeOfferId: 'net-1' })];
    box.provider.claimResults.set('net-1', 'network');

    const summary = await box.engine.runCycle('manual');

    expect(summary.failed).toBe(1);
    expect(box.repos.offers.list({})[0]?.status).toBe('failed');
    expect(box.repos.claims.history(10)[0]?.errorCode).toBe('NETWORK');
    // the in-flight row must not be left behind
    expect(box.repos.claims.countInflight()).toBe(0);
  });

  it('treats an unverified claim as a failure', async () => {
    box.configStore.update({ claiming: { mode: 'auto', verificationAttempts: 2, verificationDelaySeconds: 0 } });
    box.provider.offers = [makeOffer({ storeOfferId: 'unverified-1' })];
    box.provider.claimResults.set('unverified-1', 'unverified');

    const summary = await box.engine.runCycle('manual');

    expect(summary.failed).toBe(1);
    expect(summary.claimed).toBe(0);
    expect(box.repos.offers.list({})[0]?.status).toBe('failed');
    const attempt = box.repos.claims.history(10)[0];
    expect(attempt?.errorCode).toBe('CLAIM_UNVERIFIED');
    expect(attempt?.verified).toBe(false);
  });

  it('converts an ALREADY_OWNED answer from the store into ownership', async () => {
    box.configStore.update({ claiming: { mode: 'auto' } });
    box.provider.offers = [makeOffer({ storeOfferId: 'owned-2' })];
    box.provider.claimResults.set('owned-2', 'already_owned');

    const summary = await box.engine.runCycle('manual');

    expect(summary.alreadyOwned).toBe(1);
    expect(box.repos.offers.list({})[0]?.status).toBe('already_owned');
  });

  it('never claims an expired offer', async () => {
    box.configStore.update({ claiming: { mode: 'auto' } });
    box.provider.offers = [makeOffer({ storeOfferId: 'expired-1', startAt: '2026-11-01T00:00:00.000Z', endAt: '2026-11-02T00:00:00.000Z' })];

    const summary = await box.engine.runCycle('manual');

    expect(summary.claimed).toBe(0);
    expect(box.provider.claimCalls).toEqual([]);
    expect(box.repos.offers.list({})[0]?.status).toBe('expired');
  });

  it('skips an offer that has not started yet', async () => {
    box.configStore.update({ claiming: { mode: 'auto' } });
    box.provider.offers = [makeOffer({ storeOfferId: 'future-1', startAt: '2026-12-01T00:00:00.000Z', endAt: '2026-12-08T00:00:00.000Z' })];

    const summary = await box.engine.runCycle('manual');

    expect(box.provider.claimCalls).toEqual([]);
    expect(summary.skipped).toBe(1);
  });

  it('honours the per-cycle claim cap', async () => {
    box.configStore.update({ claiming: { mode: 'auto', maxClaimsPerCycle: 2 } });
    box.provider.offers = [1, 2, 3, 4].map((n) => makeOffer({ storeOfferId: `cap-${n}` }));

    const summary = await box.engine.runCycle('manual');

    expect(box.provider.claimCalls).toHaveLength(2);
    expect(summary.claimed).toBe(2);
  });

  it('does nothing in dry-run mode', async () => {
    box.configStore.update({ claiming: { mode: 'auto', dryRun: true } });
    box.provider.offers = [makeOffer({ storeOfferId: 'dry-1' })];

    const summary = await box.engine.runCycle('manual');

    expect(box.provider.claimCalls).toEqual([]);
    expect(summary.discovered).toBe(1);
    expect(summary.claimed).toBe(0);
  });
});

describe('approval workflow', () => {
  beforeEach(() => {
    box.configStore.update({ claiming: { mode: 'approval', approvalExpiryHours: 24 } });
    box.provider.offers = [makeOffer({ storeOfferId: 'approve-1', title: 'Approval Game' })];
  });

  it('creates exactly one approval request and does not claim', async () => {
    const summary = await box.engine.runCycle('manual');

    expect(summary.pendingApproval).toBe(1);
    expect(box.provider.claimCalls).toEqual([]);
    const pending = box.repos.approvals.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.shortCode).toMatch(/^[a-z0-9]{8}$/);
    const event = eventsOfType(box.events, 'APPROVAL_REQUIRED')[0];
    expect(event?.payload.offer.title).toBe('Approval Game');
    expect(event?.payload.token.length).toBeGreaterThan(20);

    // A second cycle must not create a duplicate request.
    await box.engine.runCycle('scheduled');
    expect(box.repos.approvals.pending()).toHaveLength(1);
    expect(eventsOfType(box.events, 'APPROVAL_REQUIRED')).toHaveLength(1);
  });

  it('claims after an explicit approval', async () => {
    await box.engine.runCycle('manual');
    const approval = box.repos.approvals.pending()[0]!;

    const result = await box.engine.handleApprovalDecision({ approvalId: approval.id, decision: 'claim', decidedBy: 'test' });

    expect(result.ok).toBe(true);
    expect(result.decision).toBe('accepted');
    expect(box.provider.claimCalls).toEqual(['approve-1']);
    expect(box.repos.approvals.get(approval.id)?.status).toBe('accepted');
  });

  it('skips after an explicit rejection', async () => {
    await box.engine.runCycle('manual');
    const approval = box.repos.approvals.pending()[0]!;

    const result = await box.engine.handleApprovalDecision({ approvalId: approval.id, decision: 'skip', decidedBy: 'test' });

    expect(result.ok).toBe(true);
    expect(result.decision).toBe('rejected');
    expect(box.provider.claimCalls).toEqual([]);
    expect(box.repos.offers.list({})[0]?.status).toBe('skipped');
    expect(eventsOfType(box.events, 'APPROVAL_REJECTED')).toHaveLength(1);
  });

  it('accepts a decision by short code (iMessage style)', async () => {
    await box.engine.runCycle('manual');
    const approval = box.repos.approvals.pending()[0]!;

    const result = await box.engine.handleApprovalDecision({ shortCode: approval.shortCode, decision: 'claim', decidedBy: 'imessage:+32470000000' });

    expect(result.ok).toBe(true);
    expect(box.provider.claimCalls).toEqual(['approve-1']);
  });

  it('rejects a replayed decision', async () => {
    await box.engine.runCycle('manual');
    const approval = box.repos.approvals.pending()[0]!;
    await box.engine.handleApprovalDecision({ approvalId: approval.id, decision: 'skip', decidedBy: 'test' });

    const second = await box.engine.handleApprovalDecision({ approvalId: approval.id, decision: 'claim', decidedBy: 'test' });
    expect(second.ok).toBe(false);
    expect(second.decision).toBe('already_decided');
    expect(box.provider.claimCalls).toEqual([]);
  });

  it('expires an unanswered approval and skips the offer', async () => {
    await box.engine.runCycle('manual');
    box.clock.advance(25 * 3_600_000);

    const expired = await box.engine.expireApprovals();
    const approval = box.repos.approvals.history(5)[0]!;

    expect(expired).toBe(1);
    expect(approval.status).toBe('expired');
    expect(box.repos.offers.list({})[0]?.status).toBe('skipped');
    expect(box.provider.claimCalls).toEqual([]);
    expect(eventsOfType(box.events, 'APPROVAL_EXPIRED')).toHaveLength(1);
  });

  it('keeps the offer pending when the expiry action says so', async () => {
    box.configStore.update({ claiming: { approvalExpiryAction: 'keep_pending' } });
    await box.engine.runCycle('manual');
    box.clock.advance(25 * 3_600_000);

    await box.engine.expireApprovals();

    expect(box.repos.approvals.history(5)[0]?.status).toBe('expired');
    expect(box.repos.offers.list({})[0]?.status).toBe('pending_approval');
    expect(box.provider.claimCalls).toEqual([]);
  });
});

describe('hybrid rules', () => {
  it('claims base games automatically and asks about add-ons', async () => {
    box.configStore.update({
      claiming: {
        mode: 'hybrid',
        rules: [{ id: 'base-games', enabled: true, field: 'kind', op: 'is', value: 'game', action: 'claim', note: 'base games are automatic' }],
      },
    });
    box.provider.offers = [makeOffer({ storeOfferId: 'hybrid-game', kind: 'game' }), makeOffer({ storeOfferId: 'hybrid-dlc', kind: 'dlc', title: 'DLC' })];

    const summary = await box.engine.runCycle('manual');

    expect(box.provider.claimCalls).toEqual(['hybrid-game']);
    expect(summary.claimed).toBe(1);
    expect(summary.pendingApproval).toBe(1);
  });

  it('honours a publisher rule with a skip action', async () => {
    box.configStore.update({
      claiming: {
        mode: 'hybrid',
        rules: [{ id: 'skip-pub', enabled: true, field: 'publisher', op: 'contains', value: 'annoying', action: 'skip' }],
      },
    });
    box.provider.offers = [makeOffer({ storeOfferId: 'skip-1', publisher: 'Annoying Studio' })];

    const summary = await box.engine.runCycle('manual');

    expect(box.provider.claimCalls).toEqual([]);
    expect(summary.skipped).toBe(1);
    expect(box.repos.offers.list({})[0]?.status).toBe('skipped');
  });

  it('uses the first matching rule', async () => {
    box.configStore.update({
      claiming: {
        mode: 'hybrid',
        rules: [
          { id: 'r1', enabled: true, field: 'title', op: 'contains', value: 'special', action: 'skip' },
          { id: 'r2', enabled: true, field: 'kind', op: 'is', value: 'game', action: 'claim' },
        ],
      },
    });
    box.provider.offers = [makeOffer({ storeOfferId: 'first-rule', title: 'A Special Game' })];

    await box.engine.runCycle('manual');

    expect(box.provider.claimCalls).toEqual([]);
  });
});

describe('authentication and recovery', () => {
  it('reports an expired session but still records discovered offers', async () => {
    box.configStore.update({ claiming: { mode: 'auto' } });
    box.provider.authenticated = false;
    box.provider.offers = [makeOffer({ storeOfferId: 'noauth-1' })];

    const summary = await box.engine.runCycle('manual');

    expect(summary.authRequired).toBe(true);
    expect(summary.discovered).toBe(1);
    expect(summary.claimed).toBe(0);
    expect(box.provider.claimCalls).toEqual([]);
    expect(eventsOfType(box.events, 'AUTHENTICATION_EXPIRED')).toHaveLength(1);
  });

  it('never switches approval mode to automatic after an error', async () => {
    box.configStore.update({ claiming: { mode: 'approval' } });
    box.provider.offers = [makeOffer({ storeOfferId: 'stay-approval' })];
    box.provider.discoverError = new AppError('NETWORK', 'flaky network');

    await box.engine.runCycle('manual');
    box.provider.discoverError = null;
    await box.engine.runCycle('manual');

    expect(box.provider.claimCalls).toEqual([]);
    expect(box.repos.approvals.pending()).toHaveLength(1);
    expect(box.configStore.load().claiming.mode).toBe('approval');
  });

  it('abandons attempts left in progress by a crashed process', async () => {
    box.configStore.update({ claiming: { mode: 'auto' } });
    const { offer } = box.repos.offers.upsert(makeOffer({ storeOfferId: 'crash-1' }), box.clock.now().toISOString());
    box.repos.claims.beginAttempt({ offerId: offer.id, initiator: 'test', cycleId: null, now: box.clock.now().toISOString() });
    expect(box.repos.claims.countInflight()).toBe(1);

    await box.engine.runCycle('startup');

    const attempts = box.repos.claims.history(5);
    expect(attempts.some((a) => a.status === 'abandoned')).toBe(true);
    expect(box.repos.claims.countInflight()).toBe(0);
  });

  it('refuses a second concurrent claim for the same offer', async () => {
    box.configStore.update({ claiming: { mode: 'auto' } });
    const { offer } = box.repos.offers.upsert(makeOffer({ storeOfferId: 'concurrent-1' }), box.clock.now().toISOString());
    let release: (() => void) | null = null;
    box.provider.onClaim = async (o) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      box.provider.owned.add(o.storeOfferId);
      return { httpStatus: 200, ok: true, entitlementNames: [], raw: {} };
    };

    const first = box.engine.claimOffer(offer.id, 'test');
    await new Promise((r) => setTimeout(r, 20));
    const second = await box.engine.claimOffer(offer.id, 'test');
    if (release) (release as () => void)();
    const result = await first;

    expect(result.status).toBe('claimed');
    expect(second.status).toBe('failed');
    if (second.status === 'failed') expect(second.errorCode).toBe('CLAIM_IN_PROGRESS');
    expect(box.provider.claimCalls).toHaveLength(1);
  });
});
