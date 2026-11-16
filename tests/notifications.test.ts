import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { makeSandbox, makeOffer, eventsOfType, type Sandbox } from './helpers.js';
import { NotificationManager, buildRenderContext, dedupeKeyFor, renderForAdapter } from '../src/notify/manager.js';
import type { AdapterContext, AdapterStatus, DeliveryResult, NotificationAdapter, RenderedNotification } from '../src/notify/adapter.js';
import type { AppEvent, AppEventType } from '../src/shared/events.js';
import { makeEvent } from '../src/shared/events.js';
import type { TemplateFields } from '../src/notify/template-vars.js';
import { extractVariables, renderTemplate, validateTemplate, EVENT_VARIABLES } from '../src/notify/template-vars.js';
import { IMessageNotificationAdapter } from '../src/notify/adapters/imessage.js';
import { MacOSNotificationAdapter } from '../src/notify/adapters/macos.js';
import type { Config } from '../src/config/schema.js';

class FakeAdapter implements NotificationAdapter {
  readonly displayName: string;
  deliveries: Array<{ event: AppEventType; body: string; rendered: RenderedNotification }> = [];
  failWith: string | null = null;
  constructor(
    readonly id: string,
    private readonly caps: { interactive?: boolean } = {},
  ) {
    this.displayName = id;
  }
  isEnabled(config: Config, event: AppEventType): boolean {
    const adapter = (config.notifications.adapters as unknown as Record<string, { enabled?: boolean }>)[this.id];
    if (adapter && adapter.enabled === false) return false;
    const t = (config.notifications.events as unknown as Record<string, Record<string, { enabled: boolean }>>)[event];
    return (t?.[this.id] as { enabled: boolean } | undefined)?.enabled === true;
  }
  isConfigured(): boolean {
    return true;
  }
  render(event: AppEvent, template: TemplateFields, ctx: AdapterContext): RenderedNotification {
    const r = renderForAdapter(this.id, event, template, ctx.approvalBaseUrl);
    r.actions = this.caps.interactive && r.data.approvalUrl ? [{ id: 'claim', title: 'Claim' }, { id: 'skip', title: 'Skip' }] : [];
    return r;
  }
  async deliver(message: RenderedNotification, event: AppEvent): Promise<DeliveryResult> {
    if (this.failWith) return { ok: false, errorCode: 'DELIVERY_FAILED', errorMessage: this.failWith, attempts: 1 };
    this.deliveries.push({ event: event.type, body: message.body, rendered: message });
    return { ok: true, attempts: 1 };
  }
  async status(): Promise<AdapterStatus> {
    return { id: this.id, enabled: true, configured: true, detail: 'fake', capabilities: { interactive: true, richText: false } };
  }
  async test(event: AppEvent, template: TemplateFields, ctx: AdapterContext): Promise<DeliveryResult> {
    return this.deliver(this.render(event, template, ctx), event);
  }
}

let box: Sandbox;
let macos: FakeAdapter;
let manager: NotificationManager;

function discoverEvent(title = 'Game One'): AppEvent {
  return makeEvent(
    'GAME_DISCOVERED',
    {
      offer: { id: 1, storeOfferId: 'o1', title, publisher: 'Pub', kind: 'game', url: null, imageUrl: null, startAt: null, endAt: null, storeName: 'Epic Games Store' },
    },
    box.clock.now().toISOString(),
  );
}

beforeEach(() => {
  box = makeSandbox();
  macos = new FakeAdapter('macos', { interactive: true });
  manager = new NotificationManager({
    adapters: [macos],
    repos: box.repos,
    clock: box.clock,
    logger: box.logger,
    getConfig: () => box.configStore.load(),
  });
});

afterEach(() => {
  box.cleanup();
});

describe('notification routing', () => {
  it('delivers through the registered channel', async () => {
    const reports = await manager.dispatch(discoverEvent());
    expect(reports.map((r) => r.adapter)).toEqual(['macos']);
    expect(macos.deliveries).toHaveLength(1);
  });

  it('sends nothing when the only channel is disabled', async () => {
    box.configStore.update({ notifications: { adapters: { macos: { enabled: false } } } });
    const reports = await manager.dispatch(discoverEvent());
    expect(reports.every((r) => r.status !== 'delivered')).toBe(true);
    expect(macos.deliveries).toHaveLength(0);
  });

  it('respects a per-event, per-adapter switch', async () => {
    await manager.dispatch(discoverEvent());
    box.configStore.update({ notifications: { events: { GAME_DISCOVERED: { macos: { enabled: false } } } } });

    const event = makeEvent('OFFER_EXPIRING', { offer: { id: 2, storeOfferId: 'o2', title: 'Expiring', publisher: '', kind: 'game', url: null, imageUrl: null, startAt: null, endAt: null, storeName: 'Epic' }, hoursLeft: 4 }, box.clock.now().toISOString());
    await manager.dispatch(event);
    // OFFER_EXPIRING is off by default for macOS
    expect(macos.deliveries.find((d) => d.event === 'OFFER_EXPIRING')).toBeUndefined();
  });

  it('keeps working when a channel throws', async () => {
    const failing = new FakeAdapter('macos');
    failing.failWith = 'Notification Center unavailable';
    const m = new NotificationManager({ adapters: [failing], repos: box.repos, clock: box.clock, logger: box.logger, getConfig: () => box.configStore.load() });
    const reports = await m.dispatch(discoverEvent());
    expect(reports[0]?.status).toBe('failed');
    expect(reports[0]?.errorMessage).toContain('unavailable');
  });

  it('never throws out of dispatch, even with a broken adapter', async () => {
    const broken: NotificationAdapter = {
      id: 'broken',
      displayName: 'broken',
      isEnabled: () => true,
      isConfigured: () => true,
      render: () => {
        throw new Error('render exploded');
      },
      deliver: async () => ({ ok: true, attempts: 1 }),
      status: async () => ({ id: 'broken', enabled: true, configured: true, detail: '', capabilities: { interactive: false, richText: false } }),
      test: async () => ({ ok: true, attempts: 1 }),
    };
    const m = new NotificationManager({ adapters: [broken, macos], repos: box.repos, clock: box.clock, logger: box.logger, getConfig: () => box.configStore.load() });
    const reports = await m.dispatch(discoverEvent());
    expect(reports.find((r) => r.adapter === 'broken')?.status).toBe('failed');
    expect(reports.find((r) => r.adapter === 'macos')?.status).toBe('delivered');
  });

  it('suppresses duplicate notifications for the same fact', async () => {
    const event = discoverEvent();
    await manager.dispatch(event);
    const second = await manager.dispatch(event);
    expect(second.every((r) => r.status === 'duplicate')).toBe(true);
    expect(macos.deliveries).toHaveLength(1);
  });

  it('does not deduplicate distinct approvals', async () => {
    const one = makeEvent(
      'APPROVAL_REQUIRED',
      { offer: { id: 3, storeOfferId: 'o3', title: 'A', publisher: '', kind: 'game', url: null, imageUrl: null, startAt: null, endAt: null, storeName: 'Epic' }, approvalId: 10, shortCode: 'aaaa1111', token: 'tok-a', expiresAt: '2026-11-20T00:00:00.000Z' },
      box.clock.now().toISOString(),
    );
    const two = makeEvent(
      'APPROVAL_REQUIRED',
      { offer: { id: 4, storeOfferId: 'o4', title: 'B', publisher: '', kind: 'game', url: null, imageUrl: null, startAt: null, endAt: null, storeName: 'Epic' }, approvalId: 11, shortCode: 'bbbb2222', token: 'tok-b', expiresAt: '2026-11-20T00:00:00.000Z' },
      box.clock.now().toISOString(),
    );
    await manager.dispatch(one);
    await manager.dispatch(two);
    expect(macos.deliveries.filter((d) => d.event === 'APPROVAL_REQUIRED')).toHaveLength(2);
  });

  it('records delivery history', async () => {
    await manager.dispatch(discoverEvent());
    const rows = box.repos.notifications.recent(10);
    expect(rows.filter((r) => r.status === 'delivered')).toHaveLength(1);
  });

  it('sends a test through the requested adapter', async () => {
    const report = await manager.test(discoverEvent(), 'macos');
    expect(report.status).toBe('delivered');
    expect(macos.deliveries).toHaveLength(1);
  });

  it('reports an unknown adapter instead of throwing', async () => {
    const report = await manager.test(discoverEvent(), 'telegram');
    expect(report.status).toBe('failed');
    expect(report.errorCode).toBe('UNKNOWN_ADAPTER');
  });

  it('honours the global off switch', async () => {
    box.configStore.update({ notifications: { enabled: false } });
    const reports = await manager.dispatch(discoverEvent());
    expect(reports).toHaveLength(1);
    expect(reports[0]?.status).toBe('skipped');
    expect(macos.deliveries).toHaveLength(0);
  });
});

describe('templates', () => {
  it('renders variables and leaves unknown ones untouched', () => {
    const out = renderTemplate('{game_name} until {offer_expiry} {unknown}', { game_name: 'X', offer_expiry: 'Y' }, ['game_name', 'offer_expiry']);
    expect(out).toBe('X until Y {unknown}');
  });

  it('strips control characters from values', () => {
    const out = renderTemplate('{game_name}', { game_name: 'bad\u0000name' }, ['game_name']);
    expect(out).toBe('bad name');
  });

  it('validates unknown variables and unbalanced braces', () => {
    expect(validateTemplate('GAME_DISCOVERED', { body: '{nope}' })).toHaveLength(1);
    expect(validateTemplate('GAME_DISCOVERED', { body: 'hello {' }).some((i) => /unbalanced/.test(i.message))).toBe(true);
    expect(validateTemplate('GAME_DISCOVERED', { body: 'hello {game_name}' })).toHaveLength(0);
    expect(validateTemplate('GAME_DISCOVERED', { body: '' }).some((i) => /must not be empty/.test(i.message))).toBe(true);
  });

  it('extracts variables from a template', () => {
    expect(extractVariables('{game_name} / {publisher} / {game_name}')).toEqual(['game_name', 'publisher']);
  });

  it('gives each event its own variable whitelist', () => {
    expect(EVENT_VARIABLES.APPROVAL_REQUIRED).toContain('approval_url');
    expect(EVENT_VARIABLES.GAME_DISCOVERED).not.toContain('approval_url');
  });

  it('builds a context for approval events including the approval URL', () => {
    const event = makeEvent(
      'APPROVAL_REQUIRED',
      { offer: { id: 1, storeOfferId: 'o', title: 'G', publisher: 'P', kind: 'game', url: null, imageUrl: null, startAt: null, endAt: null, storeName: 'Epic' }, approvalId: 5, shortCode: 'abcd1234', token: 'secret-token', expiresAt: '2026-11-19T00:00:00.000Z' },
      box.clock.now().toISOString(),
    );
    const rendered = renderForAdapter('imessage', event, { body: '{game_name} {approval_instruction}' }, 'http://127.0.0.1:8781');
    expect(rendered.data.approvalUrl).toBe('http://127.0.0.1:8781/approve/secret-token');
    expect(buildRenderContext(event).approval_code).toBe('abcd1234');
  });

  it('ships one template set and no other channel', () => {
    const config = box.configStore.load();
    expect(config.notifications.templates.macos.GAME_DISCOVERED.title).toBe('Epic Claims');
    expect(config.notifications.templates.macos.GAME_DISCOVERED.body).toContain('{game_name}');
    expect(Object.keys(config.notifications.adapters)).toEqual(['macos']);
    expect(Object.keys(config.notifications.templates)).toEqual(['macos']);
  });
});

describe('macOS adapter', () => {
  it('reports the helper as missing instead of pretending to be ready', async () => {
    const adapter = new MacOSNotificationAdapter({ helperCandidates: ['/nonexistent'], dataDir: box.dataDir });
    const status = await adapter.status({ config: box.configStore.load(), logger: box.logger, clock: box.clock, approvalBaseUrl: 'http://127.0.0.1:8781' });
    expect(status.capabilities.interactive).toBe(false);
    expect(status.detail).toContain('helper not found');
  });
});

describe('dedupe keys', () => {
  it('scopes discoveries and failures per offer', () => {
    const event = discoverEvent();
    expect(dedupeKeyFor(event, 'macos')).toBe('GAME_DISCOVERED|macos|1');
    const failure = makeEvent(
      'CLAIM_FAILED',
      { offer: { id: 7, storeOfferId: 'o7', title: 'F', publisher: '', kind: 'game', url: null, imageUrl: null, startAt: null, endAt: null, storeName: 'Epic' }, errorCode: 'NETWORK', errorMessage: 'x', attempts: 1 },
      box.clock.now().toISOString(),
    );
    expect(dedupeKeyFor(failure, 'imessage')).toBe('CLAIM_FAILED|imessage|7|NETWORK');
  });
});

describe('provider independence of the event layer', () => {
  it('dispatches offers from any provider through the same adapters', async () => {
    const offer = makeOffer({ store: 'epic', storeOfferId: 'other-store-1', title: 'From Another Store' });
    const { offer: stored } = box.repos.offers.upsert(offer, box.clock.now().toISOString());
    const event = makeEvent(
      'GAME_DISCOVERED',
      {
        offer: {
          id: stored.id,
          storeOfferId: stored.storeOfferId,
          title: stored.title,
          publisher: stored.publisher,
          kind: stored.kind,
          url: stored.url,
          imageUrl: stored.imageUrl,
          startAt: stored.startAt,
          endAt: stored.endAt,
          storeName: 'Some Other Store',
        },
      },
      box.clock.now().toISOString(),
    );
    await manager.dispatch(event);
    const delivered = macos.deliveries[0]?.rendered;
    expect([delivered?.subject, delivered?.subtitle, delivered?.body].join(' ')).toContain('From Another Store');
  });
});
