import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Database } from '../src/db/database.js';
import { createRepositories, type Repositories } from '../src/db/repositories.js';
import { ConfigStore } from '../src/config/store.js';
import { FakeClock } from '../src/shared/clock.js';
import { Logger, memorySink, type LogRecord } from '../src/shared/logger.js';
import { EventBus, type AppEvent } from '../src/shared/events.js';
import { ClaimEngine, type ClaimEngineDeps } from '../src/claim/claimEngine.js';
import { InMemoryKeychain } from '../src/auth/keychain.js';
import { defaultConfig } from '../src/config/defaults.js';
import type { Config } from '../src/config/schema.js';
import type { ClaimResponse, OwnershipCheck, Offer, StoreProvider, AuthStatus } from '../src/providers/provider.js';
import type { Repos } from './types.js';

export type { Repos };

export interface Sandbox {
  dir: string;
  dataDir: string;
  logsDir: string;
  db: Database;
  repos: Repositories;
  configStore: ConfigStore;
  clock: FakeClock;
  logger: Logger;
  records: LogRecord[];
  bus: EventBus;
  events: AppEvent[];
  engine: ClaimEngine;
  keychain: InMemoryKeychain;
  provider: MockProvider;
  cleanup: () => void;
}

export function makeTempDir(prefix = 'epic-claims-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** A configurable provider double. Every interaction is recorded. */
export class MockProvider implements StoreProvider {
  readonly id = 'epic' as const;
  readonly displayName = 'Epic Games Store (mock)';

  offers: Offer[] = [];
  owned = new Set<string>();
  claimResults = new Map<string, 'ok' | 'fail' | 'unverified' | 'already_owned' | 'network'>();
  authenticated = true;
  authError: Error | null = null;
  discoverError: Error | null = null;
  claimCalls: string[] = [];
  ownershipCalls = 0;
  onClaim?: (offer: Offer) => Promise<ClaimResponse>;

  async ensureAuthenticated(): Promise<void> {
    if (this.authError) throw this.authError;
    if (!this.authenticated) {
      const { AppError } = await import('../src/shared/errors.js');
      throw new AppError('AUTH_REQUIRED', 'not signed in');
    }
  }

  async authStatus(): Promise<AuthStatus> {
    return { authenticated: this.authenticated, accountName: this.authenticated ? 'tester' : null, accountId: 'acc-1', expiresAt: null, detail: 'mock' };
  }

  async discoverOffers(): Promise<Offer[]> {
    if (this.discoverError) throw this.discoverError;
    return this.offers;
  }

  async isOwned(offer: Offer): Promise<OwnershipCheck> {
    this.ownershipCalls++;
    const owned = this.owned.has(offer.storeOfferId);
    return { owned, entitlementName: owned ? `ent-${offer.storeOfferId}` : null, source: 'entitlements' };
  }

  async claim(offer: Offer): Promise<ClaimResponse> {
    this.claimCalls.push(offer.storeOfferId);
    if (this.onClaim) return this.onClaim(offer);
    const mode = this.claimResults.get(offer.storeOfferId) ?? 'ok';
    const { AppError } = await import('../src/shared/errors.js');
    switch (mode) {
      case 'fail':
        throw new AppError('CLAIM_REJECTED', 'Epic refused the claim', { epicCode: 'errors.com.epicgames.ecommerce.unavailable' });
      case 'network':
        throw new AppError('NETWORK', 'socket hang up', {}, true);
      case 'unverified':
        return { httpStatus: 200, ok: true, entitlementNames: [], raw: {} };
      case 'already_owned':
        throw new AppError('ALREADY_OWNED', 'already owned');
      default:
        this.owned.add(offer.storeOfferId);
        return { httpStatus: 200, ok: true, entitlementNames: [`ent-${offer.storeOfferId}`], raw: {} };
    }
  }
}

export function makeOffer(overrides: Partial<Offer> = {}): Offer {
  const now = Date.now();
  return {
    store: 'epic',
    storeOfferId: overrides.storeOfferId ?? `offer-${Math.random().toString(36).slice(2, 8)}`,
    title: 'Test Game',
    description: 'A test promotion',
    publisher: 'Test Studio',
    kind: 'game',
    namespace: 'ns-1',
    offerId: 'offerid-1',
    catalogItemId: 'cat-1',
    productSlug: null,
    pageSlug: 'test-game',
    url: 'https://store.epicgames.com/en-US/p/test-game',
    imageUrl: null,
    originalPrice: 19.99,
    discountPrice: 0,
    currency: 'EUR',
    startAt: new Date(now - 86_400_000).toISOString(),
    endAt: new Date(now + 3 * 86_400_000).toISOString(),
    ...overrides,
  };
}

export function makeSandbox(opts: { config?: Partial<Config> | Record<string, unknown> } = {}): Sandbox {
  const dir = makeTempDir();
  const dataDir = path.join(dir, 'data');
  const logsDir = path.join(dir, 'logs');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });

  const configStore = new ConfigStore({ filePath: path.join(dataDir, 'config.json') });
  // Tests model a configured installation, so the first-run gate is off by
  // default; the dedicated first-run tests turn it back on explicitly.
  configStore.save(mergeDeep(defaultConfig(), mergeDeep({ claiming: { firstRun: 'normal' } }, opts.config ?? {})));

  const clock = new FakeClock('2026-11-16T12:00:00.000Z');
  const records: LogRecord[] = [];
  const logger = new Logger('test', 'debug');
  logger.addSink(memorySink(records));

  const db = new Database({ file: path.join(dataDir, 'epic-claims.db') });
  db.migrate();
  const repos = createRepositories(db);

  const bus = new EventBus();
  const events: AppEvent[] = [];
  bus.subscribe((e) => {
    events.push(e);
  });

  const provider = new MockProvider();
  const keychain = new InMemoryKeychain();

  const deps: ClaimEngineDeps = {
    provider,
    repos,
    bus,
    clock,
    logger,
    getConfig: () => configStore.load(),
  };
  const engine = new ClaimEngine(deps);

  return {
    dir,
    dataDir,
    logsDir,
    db,
    repos,
    configStore,
    clock,
    logger,
    records,
    bus,
    events,
    engine,
    keychain,
    provider,
    cleanup: () => {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function mergeDeep<T>(base: T, patch: unknown): T {
  if (Array.isArray(patch)) return patch as unknown as T;
  if (typeof patch !== 'object' || patch === null) return patch as T;
  if (typeof base !== 'object' || base === null) return patch as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    out[k] = mergeDeep((base as Record<string, unknown>)[k], v);
  }
  return out as T;
}

export function eventsOfType<T extends AppEvent['type']>(events: AppEvent[], type: T): Array<Extract<AppEvent, { type: T }>> {
  return events.filter((e): e is Extract<AppEvent, { type: T }> => e.type === type);
}
