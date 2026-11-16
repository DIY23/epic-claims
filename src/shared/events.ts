/**
 * Typed application events. The claim engine, scheduler, auth manager and updater
 * emit these; only the notification manager consumes them. Adapters never see the
 * domain objects directly — just the payload plus the template context.
 */

export interface EventOfferInfo {
  id: number | null;
  storeOfferId: string;
  title: string;
  publisher: string;
  kind: 'game' | 'dlc' | 'other';
  url: string | null;
  imageUrl: string | null;
  startAt: string | null;
  endAt: string | null;
  storeName: string;
}

export interface EventPayloads {
  GAME_DISCOVERED: { offer: EventOfferInfo };
  CLAIM_SUCCEEDED: { offer: EventOfferInfo; verified: boolean; alreadyOwned: boolean };
  CLAIM_FAILED: { offer: EventOfferInfo; errorCode: string; errorMessage: string; attempts: number };
  APPROVAL_REQUIRED: { offer: EventOfferInfo; approvalId: number; shortCode: string; token: string; expiresAt: string };
  APPROVAL_ACCEPTED: { offer: EventOfferInfo; decidedBy: string };
  APPROVAL_REJECTED: { offer: EventOfferInfo; decidedBy: string };
  APPROVAL_EXPIRED: { offer: EventOfferInfo; expiredAt: string };
  GAME_ALREADY_OWNED: { offer: EventOfferInfo };
  OFFER_EXPIRING: { offer: EventOfferInfo; hoursLeft: number };
  AUTHENTICATION_EXPIRED: { reason: string; accountName: string | null };
  APPLICATION_ERROR: { scope: string; errorCode: string; message: string };
  FIRST_RUN_SUMMARY: { freeCount: number; mode: string; hint: string };
  UPDATE_AVAILABLE: { currentVersion: string; availableVersion: string; releaseUrl: string | null };
  UPDATE_INSTALLED: { fromVersion: string; toVersion: string };
  UPDATE_FAILED: { fromVersion: string; targetVersion: string; errorCode: string; message: string; rolledBack: boolean };
  RESTART_REQUIRED: { version: string; reason: string };
}

export type AppEventType = keyof EventPayloads;

export type AppEvent = {
  [K in AppEventType]: {
    readonly type: K;
    readonly at: string;
    readonly payload: EventPayloads[K];
  };
}[AppEventType];

export const EVENT_TYPES: AppEventType[] = [
  'GAME_DISCOVERED',
  'CLAIM_SUCCEEDED',
  'CLAIM_FAILED',
  'APPROVAL_REQUIRED',
  'APPROVAL_ACCEPTED',
  'APPROVAL_REJECTED',
  'APPROVAL_EXPIRED',
  'GAME_ALREADY_OWNED',
  'OFFER_EXPIRING',
  'AUTHENTICATION_EXPIRED',
  'APPLICATION_ERROR',
  'FIRST_RUN_SUMMARY',
  'UPDATE_AVAILABLE',
  'UPDATE_INSTALLED',
  'UPDATE_FAILED',
  'RESTART_REQUIRED',
];

/** Human labels for the dashboard's event matrix. */
export const EVENT_LABELS: Record<AppEventType, string> = {
  GAME_DISCOVERED: 'New game discovered',
  CLAIM_SUCCEEDED: 'Claim succeeded',
  CLAIM_FAILED: 'Claim failed',
  APPROVAL_REQUIRED: 'Approval required',
  APPROVAL_ACCEPTED: 'Approval accepted',
  APPROVAL_REJECTED: 'Approval rejected',
  APPROVAL_EXPIRED: 'Approval expired',
  GAME_ALREADY_OWNED: 'Already owned',
  OFFER_EXPIRING: 'Offer expiring soon',
  AUTHENTICATION_EXPIRED: 'Authentication expired',
  APPLICATION_ERROR: 'Application error',
  FIRST_RUN_SUMMARY: 'First run: offers found',
  UPDATE_AVAILABLE: 'Update available',
  UPDATE_INSTALLED: 'Update installed',
  UPDATE_FAILED: 'Update failed',
  RESTART_REQUIRED: 'Restart required',
};

export function makeEvent<K extends AppEventType>(type: K, payload: EventPayloads[K], at: string): { type: K; at: string; payload: EventPayloads[K] } {
  return { type, at, payload };
}

export type EventSink = (event: AppEvent) => void | Promise<void>;

/** A trivial in-process bus. Delivery failures are the manager's problem, not the emitter's. */
export class EventBus {
  private sinks: EventSink[] = [];
  subscribe(sink: EventSink): () => void {
    this.sinks.push(sink);
    return () => {
      this.sinks = this.sinks.filter((s) => s !== sink);
    };
  }
  async emit<K extends AppEventType>(type: K, payload: EventPayloads[K], at: string): Promise<void> {
    const event = makeEvent(type, payload, at) as AppEvent;
    for (const sink of this.sinks) {
      try {
        await sink(event);
      } catch {
        /* one bad subscriber must not break the others */
      }
    }
  }
}
