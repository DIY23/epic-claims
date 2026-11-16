import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { makeSandbox, makeOffer, type Sandbox } from './helpers.js';
import { parseApprovalCommand, appleDateToIso, MessagesDbReader, NullReader, type IncomingMessage } from '../src/notify/imessage/reader.js';
import { decodeAttributedBody } from '../src/notify/imessage/typedstream.js';
import { IMessageCommandService, normaliseHandle } from '../src/notify/imessage/commands.js';
import { IMessageNotificationAdapter } from '../src/notify/adapters/imessage.js';
import type { IMessageTransport, SendResult } from '../src/notify/imessage/transports.js';
import { makeEvent } from '../src/shared/events.js';

let box: Sandbox;

beforeEach(() => {
  box = makeSandbox();
});

afterEach(() => {
  box.cleanup();
});

describe('approval commands', () => {
  it('parses CLAIM and SKIP case-insensitively', () => {
    expect(parseApprovalCommand('CLAIM 9f2c1b34')).toEqual({ kind: 'claim', code: '9f2c1b34', raw: 'CLAIM 9f2c1b34' });
    expect(parseApprovalCommand('skip 9F2C1B34')?.kind).toBe('skip');
    expect(parseApprovalCommand('  claim   9f2c1b34  ')?.code).toBe('9f2c1b34');
  });

  it('ignores prose, quotes and partial commands', () => {
    expect(parseApprovalCommand('can you claim it?')).toBeNull();
    expect(parseApprovalCommand('CLAIM')).toBeNull();
    expect(parseApprovalCommand('CLAIM abc')).toBeNull();
    expect(parseApprovalCommand('OK CLAIM 9f2c1b34')).toBeNull();
    expect(parseApprovalCommand('🎮 CLAIM 9f2c1b34')).toBeNull();
  });

  it('normalises handles for comparison', () => {
    expect(normaliseHandle('+32 (470) 00-00-00')).toBe('+32470000000');
    expect(normaliseHandle('Someone@Example.COM')).toBe('someone@example.com');
  });
});

describe('messages database decoding', () => {
  it('converts Apple nanosecond timestamps', () => {
    expect(appleDateToIso(814848602116619008)).toBe('2026-10-28T02:50:02.116Z');
    expect(appleDateToIso(null)).toBe('1970-01-01T00:00:00.000Z');
  });

  it('decodes a length-prefixed attributedBody blob', () => {
    const text = 'CLAIM 9f2c1b';
    const prefix = Buffer.from('040b73747265616d747970656481e80384014084848414', 'hex');
    const klass = Buffer.from('4e5341747472696275746564537472696e6700', 'hex'); // NSAttributedString\0
    const marker = Buffer.from([0x84, 0x84, 0x84]);
    const nsstring = Buffer.from('4e53537472696e6701', 'hex'); // NSString\x01
    const payload = Buffer.from([0x2b, text.length, ...Buffer.from(text, 'utf8')]);
    const blob = Buffer.concat([prefix, klass, marker, nsstring, payload]);
    expect(decodeAttributedBody(blob)).toBe(text);
  });

  it('decodes the two-byte length form', () => {
    const text = 'x'.repeat(200);
    const blob = Buffer.concat([
      Buffer.from('04 0B streamtyped', 'utf8'),
      Buffer.from('NSString', 'utf8'),
      Buffer.from([0x2b, 0x81, 200, 0]),
      Buffer.from(text, 'utf8'),
    ]);
    expect(decodeAttributedBody(blob)).toBe(text);
  });

  it('returns null for junk', () => {
    expect(decodeAttributedBody(null)).toBeNull();
    expect(decodeAttributedBody(Buffer.alloc(2))).toBeNull();
  });

  it('reports a missing chat.db instead of throwing', async () => {
    const reader = new MessagesDbReader('/nonexistent/chat.db');
    const ready = await reader.ready();
    expect(ready.ready).toBe(false);
    expect(ready.detail).toContain('not found');
  });

  it('the null reader is inert', async () => {
    const reader = new NullReader();
    expect(await reader.since(0)).toEqual([]);
    expect(await reader.maxRowid()).toBe(0);
    expect((await reader.ready()).ready).toBe(false);
  });
});

class FakeReader {
  readonly kind = 'fake';
  rows: IncomingMessage[] = [];
  async since(rowid: number): Promise<IncomingMessage[]> {
    return this.rows.filter((r) => r.rowid > rowid);
  }
  async maxRowid(): Promise<number> {
    return this.rows.length > 0 ? Math.max(...this.rows.map((r) => r.rowid)) : 0;
  }
  async ready(): Promise<{ ready: boolean; detail: string }> {
    return { ready: true, detail: 'fake' };
  }
}

class FakeTransport implements IMessageTransport {
  readonly id = 'fake';
  readonly displayName = 'fake';
  sent: string[] = [];
  async send(_recipient: string, text: string): Promise<SendResult> {
    this.sent.push(text);
    return { ok: true };
  }
  async readiness(): Promise<{ ready: boolean; detail: string }> {
    return { ready: true, detail: 'fake' };
  }
}

function message(rowid: number, text: string, handle = '+32470000000'): IncomingMessage {
  return { rowid, guid: `g-${rowid}`, text, handle, service: 'iMessage', receivedAt: box.clock.now().toISOString(), isFromMe: false };
}

describe('inbound command service', () => {
  beforeEach(() => {
    box.configStore.update({
      notifications: {
        adapters: {
          imessage: { enabled: true, recipient: '+32470000000', commandSender: '+32470000000' },
        },
      },
    });
  });

  it('baselines on first run and never replays history', async () => {
    const reader = new FakeReader();
    reader.rows = [message(1, 'CLAIM aaaa1111'), message(2, 'SKIP aaaa1111')];
    const transport = new FakeTransport();
    const service = new IMessageCommandService({
      reader,
      repos: box.repos,
      clock: box.clock,
      logger: box.logger,
      getConfig: () => box.configStore.load(),
      decide: async () => ({ ok: true, decision: 'accepted' }),
      getTransport: () => transport,
    });

    const first = await service.poll();
    expect(first.commands).toBe(0);
    expect(box.repos.state.getNumber('imessage.last_rowid')).toBe(2);

    reader.rows.push(message(3, 'CLAIM bbbb2222'));
    const second = await service.poll();
    expect(second.commands).toBe(1);
    expect(second.applied).toBe(1);
    expect(transport.sent).toHaveLength(1);
  });

  it('ignores commands from an unknown sender', async () => {
    const reader = new FakeReader();
    reader.rows = [message(1, 'seed')];
    let decisions = 0;
    const service = new IMessageCommandService({
      reader,
      repos: box.repos,
      clock: box.clock,
      logger: box.logger,
      getConfig: () => box.configStore.load(),
      decide: async () => {
        decisions++;
        return { ok: true, decision: 'accepted' };
      },
      getTransport: () => null,
    });
    await service.poll();

    reader.rows.push(message(2, 'CLAIM aaaa1111', '+15550000000'));
    const result = await service.poll();
    expect(result.rejected).toBe(1);
    expect(decisions).toBe(0);
  });

  it('applies a real decision end to end through the claim engine', async () => {
    box.configStore.update({ claiming: { mode: 'approval' } });
    box.provider.offers = [makeOffer({ storeOfferId: 'im-1' })];
    await box.engine.runCycle('manual');
    const approval = box.repos.approvals.pending()[0]!;

    const reader = new FakeReader();
    reader.rows = [message(1, 'seed')];
    const service = new IMessageCommandService({
      reader,
      repos: box.repos,
      clock: box.clock,
      logger: box.logger,
      getConfig: () => box.configStore.load(),
      decide: (input) => box.engine.handleApprovalDecision({ shortCode: input.shortCode, decision: input.decision, decidedBy: input.decidedBy }),
      getTransport: () => null,
    });
    await service.poll();

    reader.rows.push(message(2, `CLAIM ${approval.shortCode}`));
    const result = await service.poll();

    expect(result.applied).toBe(1);
    expect(box.provider.claimCalls).toEqual(['im-1']);
    expect(box.repos.claims.history(5)[0]?.status).toBe('succeeded');
  });

  it('replies that an unknown code was not applied', async () => {
    const reader = new FakeReader();
    reader.rows = [message(1, 'seed')];
    const transport = new FakeTransport();
    const service = new IMessageCommandService({
      reader,
      repos: box.repos,
      clock: box.clock,
      logger: box.logger,
      getConfig: () => box.configStore.load(),
      decide: async () => ({ ok: false, decision: 'not_found' }),
      getTransport: () => transport,
    });
    await service.poll();
    reader.rows.push(message(2, 'CLAIM deadbeef'));
    const result = await service.poll();
    expect(result.rejected).toBe(1);
    expect(transport.sent[0]).toContain('Not applied');
  });

  it('does nothing when the adapter is disabled', async () => {
    box.configStore.update({ notifications: { adapters: { imessage: { enabled: false } } } });
    const reader = new FakeReader();
    reader.rows = [message(1, 'CLAIM aaaa1111')];
    const service = new IMessageCommandService({
      reader,
      repos: box.repos,
      clock: box.clock,
      logger: box.logger,
      getConfig: () => box.configStore.load(),
      decide: async () => ({ ok: true, decision: 'accepted' }),
      getTransport: () => null,
    });
    const result = await service.poll();
    expect(result.commands).toBe(0);
  });
});

describe('iMessage adapter', () => {
  it('defaults to the Photon gateway and needs a space id, not a phone number', () => {
    const adapter = new IMessageNotificationAdapter();
    expect(box.configStore.load().notifications.adapters.imessage.transport).toBe('photon');
    expect(adapter.isConfigured(box.configStore.load())).toBe(false); // no spaceId yet
    box.configStore.update({ notifications: { adapters: { imessage: { enabled: true, photon: { baseUrl: 'http://127.0.0.1:8789', spaceId: 'any;-;+32470000000' } } } } });
    expect(adapter.isConfigured(box.configStore.load())).toBe(true);
  });

  it('requires a recipient for the AppleScript transport', () => {
    const adapter = new IMessageNotificationAdapter();
    box.configStore.update({ notifications: { adapters: { imessage: { enabled: true, transport: 'applescript', recipient: '' } } } });
    expect(adapter.isConfigured(box.configStore.load())).toBe(false);
    box.configStore.update({ notifications: { adapters: { imessage: { recipient: '+32470000000' } } } });
    expect(adapter.isConfigured(box.configStore.load())).toBe(true);
  });

  it('reports delivery failures without throwing', async () => {
    box.configStore.update({
      notifications: { adapters: { imessage: { enabled: true, transport: 'applescript', recipient: '+32470000000' } } },
    });
    const failing: IMessageTransport = {
      id: 'failing',
      displayName: 'failing',
      send: async () => ({ ok: false, errorCode: 'NOTIFICATION_FAILED', errorMessage: 'Messages.app unavailable' }),
      readiness: async () => ({ ready: false, detail: 'down' }),
    };
    const adapter = new IMessageNotificationAdapter({ transport: failing });
    const ctx = { config: box.configStore.load(), logger: box.logger, clock: box.clock, approvalBaseUrl: 'http://127.0.0.1:8781' };
    const event = makeEvent(
      'CLAIM_FAILED',
      { offer: { id: 1, storeOfferId: 'o', title: 'G', publisher: '', kind: 'game', url: null, imageUrl: null, startAt: null, endAt: null, storeName: 'Epic' }, errorCode: 'NETWORK', errorMessage: 'down', attempts: 1 },
      box.clock.now().toISOString(),
    );
    const result = await adapter.deliver(adapter.render(event, { body: '{game_name} failed' }, ctx), event, ctx);
    expect(result.ok).toBe(false);
    expect(result.errorMessage).toContain('unavailable');
  });
});
