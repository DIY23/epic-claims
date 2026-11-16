import { randomUUID } from 'node:crypto';
import type { Clock } from '../shared/clock.js';
import { isExpired } from '../shared/clock.js';
import type { Logger } from '../shared/logger.js';
import { randomToken, sha256 } from '../shared/logger.js';
import { AppError, errorMessage, toAppError } from '../shared/errors.js';
import type { AppEventType, EventBus, EventOfferInfo, EventPayloads } from '../shared/events.js';
import type { CycleSummary, Offer, OfferStatus, StoredOffer } from '../shared/types.js';
import type { Config } from '../config/schema.js';
import type { Repositories } from '../db/repositories.js';
import type { OwnershipCheck, StoreProvider } from '../providers/provider.js';
import { decide } from './policy.js';

export interface ClaimEngineDeps {
  provider: StoreProvider;
  repos: Repositories;
  bus: EventBus;
  clock: Clock;
  logger: Logger;
  /** Always reads the current configuration so dashboard edits apply immediately. */
  getConfig: () => Config;
  /** Optional hook used by the updater to wait for in-flight work. */
  onInflightChange?: (count: number) => void;
}

export type ClaimOutcome =
  | { status: 'claimed'; verified: boolean; attemptId: number }
  | { status: 'already_owned'; attemptId: number | null }
  | { status: 'failed'; errorCode: string; errorMessage: string; attemptId: number | null }
  | { status: 'pending_approval'; approvalId: number }
  | { status: 'skipped'; reason: string }
  | { status: 'dry_run' };

export interface ApprovalDecisionResult {
  ok: boolean;
  decision: 'accepted' | 'rejected' | 'expired' | 'not_found' | 'already_decided';
  claim?: ClaimOutcome;
}

const PENDING_APPROVAL_STATUS: OfferStatus = 'pending_approval';
/** Set once, after the first non-empty discovery, so the gate never re-arms. */
const BASELINE_KEY = 'baseline.completed_at';

export class ClaimEngine {
  private readonly inflight = new Set<number>();
  private running = false;

  constructor(private readonly deps: ClaimEngineDeps) {}

  get isRunning(): boolean {
    return this.running;
  }

  get inflightCount(): number {
    return this.inflight.size;
  }

  /**
   * Single-flight cycle.
   *
   * `bypassFirstRunGate` is set only by an explicit user action
   * (`epic-claims claim --all`), never by the scheduler.
   */
  async runCycle(trigger: CycleSummary['trigger'], opts: { bypassFirstRunGate?: boolean } = {}): Promise<CycleSummary> {
    if (this.running) {
      throw new AppError('CLAIM_IN_PROGRESS', 'a claim cycle is already running', { trigger });
    }
    this.running = true;
    const { clock, repos, logger, getConfig } = this.deps;
    const cycleId = randomUUID();
    const startedAt = clock.now().toISOString();
    const summary: CycleSummary = {
      startedAt,
      finishedAt: startedAt,
      trigger,
      discovered: 0,
      claimed: 0,
      alreadyOwned: 0,
      pendingApproval: 0,
      skipped: 0,
      failed: 0,
      expired: 0,
      authRequired: false,
      errors: [],
    };
    const config = getConfig();
    const log = logger.child('cycle', { cycleId });

    try {
      repos.claims.abandonInflight(startedAt, 'interrupted before cycle start');
      log.info('cycle started', { trigger });

      // Discovery needs no credentials, so an expired session still produces a
      // useful cycle: offers are recorded and reported, claiming is skipped.
      let authError: AppError | null = null;
      try {
        await this.deps.provider.ensureAuthenticated();
      } catch (e) {
        const err = toAppError(e);
        authError = err;
        summary.authRequired = true;
      }

      let offers: Offer[];
      try {
        offers = await this.deps.provider.discoverOffers();
      } catch (e) {
        const err = toAppError(e);
        summary.errors.push(`${err.code}: ${err.message}`);
        log.exception('offer discovery failed', err);
        await this.emit('APPLICATION_ERROR', { scope: 'discovery', errorCode: err.code, message: err.message }, log);
        if (authError) await this.emit('AUTHENTICATION_EXPIRED', { reason: authError.message, accountName: repos.auth.get().displayName }, log);
        summary.finishedAt = clock.now().toISOString();
        return summary;
      }

      // Persist first: discovery is idempotent and drives the discovered event.
      for (const offer of dedupeOffers(offers)) {
        const { offer: stored, created } = repos.offers.upsert(offer, clock.now().toISOString());
        if (created) {
          summary.discovered++;
          await this.emit('GAME_DISCOVERED', { offer: toEventOffer(stored, this.deps.provider.displayName) }, log, `GAME_DISCOVERED:${stored.id}`);
        }
      }

      // Sweep offers whose promotion window closed while we were not running.
      for (const offer of repos.offers.list({ status: ['discovered', 'pending_approval', 'failed'], limit: 1000 })) {
        if (isExpired(offer.endAt, clock)) {
          repos.offers.setStatus(offer.id, 'expired');
          summary.expired++;
        }
      }

      // First-run gate: a fresh install records what is on offer and claims
      // nothing. The user decides afterwards, from the dashboard or with
      // "epic-claims claim --all". This is what stops a new install from
      // sweeping the whole free-games catalogue into an account silently.
      if (config.claiming.firstRun === 'discover_only' && !opts.bypassFirstRunGate && repos.state.get(BASELINE_KEY) === null) {
        if (summary.discovered > 0) {
          repos.state.set(BASELINE_KEY, clock.now().toISOString());
          await this.emit('FIRST_RUN_SUMMARY', {
            freeCount: summary.discovered,
            mode: config.claiming.mode,
            hint: 'epic-claims claim --all claims everything; "epic-claims approvals approve <code>" handles one offer.',
          }, log, `FIRST_RUN_SUMMARY:${cycleId}`);
          log.info('first run: offers recorded, nothing claimed', { discovered: summary.discovered });
        } else {
          log.info('first run saw no free offers; the baseline stays unset');
        }
        summary.finishedAt = clock.now().toISOString();
        return summary;
      }
      if (config.claiming.firstRun !== 'discover_only') repos.state.set(BASELINE_KEY, clock.now().toISOString());

      if (authError) {
        summary.errors.push(`${authError.code}: ${authError.message}`);
        repos.auth.set({ sessionValid: false, error: authError.message }, clock.now().toISOString());
        await this.emit('AUTHENTICATION_EXPIRED', { reason: authError.message, accountName: repos.auth.get().displayName }, log);
        summary.finishedAt = clock.now().toISOString();
        log.warn('cycle stopped after discovery: authentication required', { discovered: summary.discovered });
        return summary;
      }

      await this.expireApprovals(log);

      const active = repos.offers.list({ activeOnly: true, now: clock.now().toISOString(), limit: 500 });
      let claimsThisCycle = 0;
      for (const offer of active) {
        if (claimsThisCycle >= config.claiming.maxClaimsPerCycle) {
          log.warn('max claims per cycle reached, deferring remaining offers', { max: config.claiming.maxClaimsPerCycle });
          break;
        }
        const outcome = await this.processOfferSafely(offer, cycleId, log);
        switch (outcome.status) {
          case 'claimed':
            summary.claimed++;
            claimsThisCycle++;
            break;
          case 'already_owned':
            summary.alreadyOwned++;
            break;
          case 'pending_approval':
            summary.pendingApproval++;
            break;
          case 'failed':
            summary.failed++;
            break;
          case 'skipped':
            summary.skipped++;
            break;
          case 'dry_run':
            summary.skipped++;
            break;
        }
      }

      await this.warnExpiring(log, config);

      summary.finishedAt = clock.now().toISOString();
      log.info('cycle finished', {
        discovered: summary.discovered,
        claimed: summary.claimed,
        alreadyOwned: summary.alreadyOwned,
        pending: summary.pendingApproval,
        failed: summary.failed,
      });
      return summary;
    } finally {
      this.running = false;
    }
  }

  /** Processes a single offer end-to-end. Never throws. */
  private async processOfferSafely(offer: StoredOffer, cycleId: string, log: Logger): Promise<ClaimOutcome> {
    try {
      return await this.processOffer(offer, cycleId, log);
    } catch (e) {
      const err = toAppError(e);
      log.exception('offer processing failed', err, { offerId: offer.id, offer: offer.title });
      this.deps.repos.offers.setStatus(offer.id, 'failed');
      await this.emit('APPLICATION_ERROR', { scope: `offer:${offer.id}`, errorCode: err.code, message: err.message }, log);
      return { status: 'failed', errorCode: err.code, errorMessage: err.message, attemptId: null };
    }
  }

  private async processOffer(offer: StoredOffer, cycleId: string, log: Logger): Promise<ClaimOutcome> {
    const { repos, clock, getConfig, provider } = this.deps;
    const config = getConfig();
    const now = clock.now().toISOString();

    // 1. Already claimed and verified in a previous run.
    if (repos.claims.hasSucceeded(offer.id) || offer.status === 'claimed') {
      if (offer.status !== 'claimed') repos.offers.setStatus(offer.id, 'claimed');
      return { status: 'skipped', reason: 'already_claimed' };
    }

    // 2. Promotions that have not started yet are not claimable.
    if (offer.startAt && Date.parse(offer.startAt) > clock.nowMs()) {
      log.debug('offer not started yet', { offerId: offer.id, startAt: offer.startAt });
      return { status: 'skipped', reason: 'not_started' };
    }

    // 3. Expired offers are recorded once and never claimed.
    if (isExpired(offer.endAt, clock)) {
      if (offer.status !== 'expired') repos.offers.setStatus(offer.id, 'expired');
      return { status: 'skipped', reason: 'expired' };
    }

    // 4. Too close to expiry: refuse rather than start a transaction that will fail.
    if (offer.endAt) {
      const secondsLeft = (Date.parse(offer.endAt) - clock.nowMs()) / 1000;
      if (secondsLeft <= config.claiming.minSecondsBeforeExpiry) {
        log.warn('skipping offer too close to expiry', { offerId: offer.id, secondsLeft });
        return { status: 'skipped', reason: 'too_close_to_expiry' };
      }
    }

    // 5. Ownership is authoritative — never claim something already owned.
    const ownership = await provider.isOwned(offer);
    if (ownership.owned) {
      repos.ownership.upsert({ offerId: offer.id, owned: true, entitlementName: ownership.entitlementName, verifiedAt: now, source: ownership.source === 'unknown' ? 'entitlements' : ownership.source });
      repos.offers.setStatus(offer.id, 'already_owned');
      await this.emit('GAME_ALREADY_OWNED', { offer: toEventOffer(offer, provider.displayName) }, log, `GAME_ALREADY_OWNED:${offer.id}`);
      return { status: 'already_owned', attemptId: null };
    }

    // 6. Policy.
    const decision = decide(offer, { mode: config.claiming.mode, rules: config.claiming.rules });
    log.debug('policy decision', { offerId: offer.id, decision: decision.decision, reason: decision.reason });

    if (decision.decision === 'skip') {
      repos.offers.setStatus(offer.id, 'skipped');
      return { status: 'skipped', reason: decision.reason };
    }

    if (decision.decision === 'approval') {
      const approval = await this.ensureApproval(offer, log);
      return { status: 'pending_approval', approvalId: approval.id };
    }

    // 7. Claim.
    return this.claimOffer(offer.id, 'scheduler', cycleId, log);
  }

  /**
   * Creates (or reuses) a real approval for an offer that already exists in the
   * database, and emits APPROVAL_REQUIRED for it. This is how the interactive path
   * is exercised for real: the notification carries a live token, and clicking
   * Claim or Skip on the banner records a genuine decision (and, for Claim, runs a
   * real attempt whose result is stored like any other).
   */
  async requestApprovalFor(offerId: number): Promise<{ approvalId: number; shortCode: string; expiresAt: string }> {
    const { repos } = this.deps;
    const offer = repos.offers.get(offerId);
    if (!offer) throw new AppError('OFFER_NOT_FOUND', `no offer with id ${offerId}`);
    const log = this.deps.logger.child('approval');
    const { id } = await this.ensureApproval(offer, log);
    const row = repos.approvals.pendingForOffer(offer.id);
    return { approvalId: id, shortCode: row?.shortCode ?? '', expiresAt: row?.expiresAt ?? '' };
  }

  /** Idempotent: an offer has at most one pending approval at a time. */
  private async ensureApproval(offer: StoredOffer, log: Logger): Promise<{ id: number; created: boolean }> {
    const { repos, clock, getConfig, provider } = this.deps;
    const config = getConfig();
    const existing = repos.approvals.pendingForOffer(offer.id);
    if (existing) {
      if (Date.parse(existing.expiresAt) > clock.nowMs()) {
        return { id: existing.id, created: false };
      }
      // Expired on paper but not swept yet: sweep now, then create a fresh one.
      await this.expireApprovals(log);
    }

    const token = randomToken(24);
    const tokenHash = sha256(token);
    // Hex, not base64url: the code is meant to be read and retyped, so no '-'
    // or '_'.
    const shortCode = tokenHash.slice(0, 8);
    const createdAt = clock.now().toISOString();
    const expiresAt = new Date(clock.nowMs() + config.claiming.approvalExpiryHours * 3_600_000).toISOString();
    const approval = repos.approvals.create({ offerId: offer.id, tokenHash, shortCode, createdAt, expiresAt, channel: null });
    repos.offers.setStatus(offer.id, PENDING_APPROVAL_STATUS);

    const approvalUrl = `${config.api.publicBaseUrl.replace(/\/$/, '')}/approve/${token}`;
    await this.emit(
      'APPROVAL_REQUIRED',
      {
        offer: toEventOffer(offer, provider.displayName),
        approvalId: approval.id,
        shortCode,
        token,
        expiresAt,
      },
      log,
      `APPROVAL_REQUIRED:${approval.id}`,
    );
    return { id: approval.id, created: true };
  }

  /**
   * Claims one offer. Idempotent and crash-safe:
   *  - a partial unique index forbids two in-flight attempts per offer
   *  - a partial unique index forbids two successful attempts per offer
   *  - ownership is verified after redemption; an unverified claim is a failure
   */
  async claimOffer(offerId: number, initiator: string, cycleId: string | null = null, parentLog?: Logger): Promise<ClaimOutcome> {
    const { repos, clock, getConfig, provider, logger } = this.deps;
    const log = (parentLog ?? logger).child('claim');
    const config = getConfig();
    const offer = repos.offers.get(offerId);
    if (!offer) return { status: 'failed', errorCode: 'OFFER_NOT_FOUND', errorMessage: `offer ${offerId} not found`, attemptId: null };

    if (repos.claims.hasSucceeded(offerId)) {
      // Idempotent: never redeem twice. But the offer must still end up describing
      // reality — a click on a late notification used to return here and leave the
      // row at 'pending_approval' with no notification of any kind.
      const owned = repos.ownership.get(offerId)?.owned === true;
      const settled = owned ? 'already_owned' : 'claimed';
      if (offer.status !== settled) repos.offers.setStatus(offerId, settled);
      await this.emit(
        'CLAIM_SUCCEEDED',
        { offer: toEventOffer(offer, provider.displayName), verified: true, alreadyOwned: owned },
        log,
        `CLAIM_SUCCEEDED:${offerId}`,
      );
      return { status: owned ? 'already_owned' : 'claimed', verified: true, attemptId: 0 };
    }
    if (this.inflight.has(offerId)) {
      return { status: 'failed', errorCode: 'CLAIM_IN_PROGRESS', errorMessage: 'a claim for this offer is already running', attemptId: null };
    }
    if (isExpired(offer.endAt, clock)) {
      repos.offers.setStatus(offerId, 'expired');
      return { status: 'skipped', reason: 'expired' };
    }
    if (config.claiming.dryRun) {
      log.info('dry run: would claim', { offerId, title: offer.title });
      return { status: 'dry_run' };
    }

    this.inflight.add(offerId);
    this.deps.onInflightChange?.(this.inflight.size);
    let attemptId: number | null = null;
    try {
      const startedAt = clock.now().toISOString();
      attemptId = repos.claims.beginAttempt({ offerId, initiator, cycleId, now: startedAt }).id;
      log.info('claim attempt started', { offerId, attemptId, title: offer.title, initiator });

      // Re-check ownership immediately before the transaction: a previous run
      // may have completed without us seeing the verification.
      const pre: OwnershipCheck = await provider.isOwned(offer);
      if (pre.owned) {
        repos.ownership.upsert({ offerId, owned: true, entitlementName: pre.entitlementName, verifiedAt: clock.now().toISOString(), source: 'entitlements' });
        repos.claims.finishAttempt(attemptId, { status: 'succeeded', now: clock.now().toISOString(), verified: true, verificationSource: 'entitlements' });
        repos.offers.setStatus(offerId, 'already_owned');
        await this.emit('GAME_ALREADY_OWNED', { offer: toEventOffer(offer, provider.displayName) }, log, `GAME_ALREADY_OWNED:${offerId}`);
        return { status: 'already_owned', attemptId };
      }

      let responseStatus = 0;
      try {
        const response = await provider.claim(offer);
        responseStatus = response.httpStatus;
      } catch (e) {
        const err = toAppError(e);
        if (err.code === 'ALREADY_OWNED') {
          repos.ownership.upsert({ offerId, owned: true, entitlementName: null, verifiedAt: clock.now().toISOString(), source: 'claim_response' });
          repos.claims.finishAttempt(attemptId, { status: 'succeeded', now: clock.now().toISOString(), verified: true, verificationSource: 'claim_response' });
          repos.offers.setStatus(offerId, 'already_owned');
          return { status: 'already_owned', attemptId };
        }
        throw err;
      }

      // Never trust the claim response alone.
      const verification = await this.verifyOwnership(offer, log);
      const finishedAt = clock.now().toISOString();
      if (verification.owned) {
        repos.ownership.upsert({ offerId, owned: true, entitlementName: verification.entitlementName, verifiedAt: finishedAt, source: 'entitlements' });
        repos.claims.finishAttempt(attemptId, { status: 'succeeded', now: finishedAt, verified: true, httpStatus: responseStatus, verificationSource: 'entitlements' });
        repos.offers.setStatus(offerId, 'claimed');
        await this.emit('CLAIM_SUCCEEDED', { offer: toEventOffer(offer, provider.displayName), verified: true, alreadyOwned: false }, log);
        log.info('claim verified', { offerId, attemptId });
        return { status: 'claimed', verified: true, attemptId };
      }

      repos.claims.finishAttempt(attemptId, {
        status: 'failed',
        now: finishedAt,
        verified: false,
        errorCode: 'CLAIM_UNVERIFIED',
        errorMessage: `claim accepted by the store but ownership could not be verified after ${config.claiming.verificationAttempts} attempts`,
        httpStatus: responseStatus,
      });
      repos.offers.setStatus(offerId, 'failed');
      await this.emit(
        'CLAIM_FAILED',
        { offer: toEventOffer(offer, provider.displayName), errorCode: 'CLAIM_UNVERIFIED', errorMessage: 'ownership could not be verified after the claim', attempts: 1 },
        log,
      );
      return { status: 'failed', errorCode: 'CLAIM_UNVERIFIED', errorMessage: 'ownership could not be verified', attemptId };
    } catch (e) {
      const err = toAppError(e);
      const finishedAt = clock.now().toISOString();
      if (attemptId !== null) {
        repos.claims.finishAttempt(attemptId, {
          status: 'failed',
          now: finishedAt,
          verified: false,
          errorCode: err.code,
          errorMessage: err.message,
          httpStatus: typeof err.context.status === 'number' ? err.context.status : null,
        });
      }
      repos.offers.setStatus(offerId, 'failed');
      log.exception('claim failed', err, { offerId, attemptId });
      if (err.code === 'AUTH_REQUIRED' || err.code === 'AUTH_EXPIRED' || err.code === 'AUTH_INTERRUPTED') {
        repos.auth.set({ sessionValid: false, error: err.message }, finishedAt);
        await this.emit('AUTHENTICATION_EXPIRED', { reason: err.message, accountName: repos.auth.get().displayName }, log);
      } else {
        await this.emit(
          'CLAIM_FAILED',
          { offer: toEventOffer(offer, provider.displayName), errorCode: err.code, errorMessage: err.message, attempts: 1 },
          log,
        );
      }
      return { status: 'failed', errorCode: err.code, errorMessage: err.message, attemptId };
    } finally {
      this.inflight.delete(offerId);
      this.deps.onInflightChange?.(this.inflight.size);
    }
  }

  private async verifyOwnership(offer: StoredOffer, log: Logger): Promise<OwnershipCheck> {
    const { provider, clock, getConfig } = this.deps;
    const config = getConfig();
    let last: OwnershipCheck = { owned: false, entitlementName: null, source: 'unknown' };
    for (let i = 0; i < config.claiming.verificationAttempts; i++) {
      if (i > 0 && config.claiming.verificationDelaySeconds > 0) {
        await clock.sleep(config.claiming.verificationDelaySeconds * 1000);
      }
      try {
        last = await provider.isOwned(offer);
        if (last.owned) return last;
        log.debug('ownership not visible yet', { offerId: offer.id, attempt: i + 1 });
      } catch (e) {
        log.warn('ownership check failed, will retry', { offerId: offer.id, attempt: i + 1, error: errorMessage(e) });
      }
    }
    return last;
  }

  /** Sweeps overdue approvals. Deterministic: expiry action comes from config only. */
  async expireApprovals(log?: Logger): Promise<number> {
    const { repos, clock, getConfig, provider } = this.deps;
    const l = (log ?? this.deps.logger).child('approvals');
    const now = clock.now().toISOString();
    const overdue = repos.approvals.overdue(now);
    const config = getConfig();
    let count = 0;
    for (const a of overdue) {
      if (!repos.approvals.markExpired(a.id, now)) continue;
      const offer = repos.offers.get(a.offerId);
      if (offer && config.claiming.approvalExpiryAction === 'skip') {
        repos.offers.setStatus(offer.id, 'skipped');
      }
      if (offer) {
        await this.emit('APPROVAL_EXPIRED', { offer: toEventOffer(offer, provider.displayName), expiredAt: now }, l, `APPROVAL_EXPIRED:${a.id}`);
      }
      count++;
    }
    return count;
  }

  /**
   * Applies an explicit user decision. Accepts an approval id (dashboard/CLI) or
   * a short code (typed into the dashboard or CLI) — the caller is responsible for having
   * authenticated the actor.
   */
  async handleApprovalDecision(input: {
    approvalId?: number;
    shortCode?: string;
    decision: 'claim' | 'skip';
    decidedBy: string;
  }): Promise<ApprovalDecisionResult> {
    const { repos, clock } = this.deps;
    const now = clock.now().toISOString();
    const approval = input.approvalId !== undefined ? repos.approvals.get(input.approvalId) : input.shortCode ? repos.approvals.byShortCode(input.shortCode) : undefined;
    if (!approval) return { ok: false, decision: 'not_found' };
    if (approval.status !== 'pending') return { ok: false, decision: approval.status === 'expired' ? 'expired' : 'already_decided' };
    if (Date.parse(approval.expiresAt) <= clock.nowMs()) {
      repos.approvals.markExpired(approval.id, now);
      await this.expireApprovals();
      return { ok: false, decision: 'expired' };
    }

    const offer = repos.offers.get(approval.offerId);
    if (!offer) return { ok: false, decision: 'not_found' };

    const accepted = input.decision === 'claim';
    const decided = repos.approvals.decide(approval.id, accepted ? 'accepted' : 'rejected', input.decidedBy, now);
    if (!decided) return { ok: false, decision: 'already_decided' };

    const log = this.deps.logger.child('approvals');
    await this.emit(
      accepted ? 'APPROVAL_ACCEPTED' : 'APPROVAL_REJECTED',
      { offer: toEventOffer(offer, this.deps.provider.displayName), decidedBy: input.decidedBy },
      log,
    );

    if (!accepted) {
      repos.offers.setStatus(offer.id, 'skipped');
      return { ok: true, decision: 'rejected' };
    }
    const claim = await this.claimOffer(offer.id, `approval:${input.decidedBy}`, null, log);
    return { ok: true, decision: 'accepted', claim };
  }

  private async warnExpiring(log: Logger, config: Config): Promise<void> {
    const { repos, clock, provider } = this.deps;
    const now = clock.now().toISOString();
    const horizon = new Date(clock.nowMs() + config.scheduling.expiringWarningHours * 3_600_000).toISOString();
    for (const offer of repos.offers.listExpiringSoon(now, horizon, false)) {
      if (repos.claims.hasSucceeded(offer.id)) continue;
      const hoursLeft = Math.max(0, Math.round(((Date.parse(offer.endAt ?? now) - clock.nowMs()) / 3_600_000) * 10) / 10);
      await this.emit('OFFER_EXPIRING', { offer: toEventOffer(offer, provider.displayName), hoursLeft }, log, `OFFER_EXPIRING:${offer.id}`);
      repos.offers.markExpiringNotified(offer.id, now);
    }
  }

  private async emit<K extends AppEventType>(type: K, payload: EventPayloads[K], log: Logger, dedupeKey?: string): Promise<void> {
    try {
      this.deps.repos.events.insert(this.deps.clock.now().toISOString(), type, payload as unknown);
      await this.deps.bus.emit(type, payload, this.deps.clock.now().toISOString());
    } catch (e) {
      log.exception('event dispatch failed', e, { type, dedupeKey });
    }
  }
}

export function toEventOffer(offer: StoredOffer, storeName: string): EventOfferInfo {
  return {
    id: offer.id,
    storeOfferId: offer.storeOfferId,
    title: offer.title,
    publisher: offer.publisher,
    kind: offer.kind,
    url: offer.url,
    imageUrl: offer.imageUrl,
    startAt: offer.startAt,
    endAt: offer.endAt,
    storeName,
  };
}

function dedupeOffers(offers: Offer[]): Offer[] {
  const seen = new Map<string, Offer>();
  for (const o of offers) seen.set(`${o.store}:${o.storeOfferId}`, o);
  return [...seen.values()];
}
