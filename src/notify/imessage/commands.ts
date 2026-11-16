import type { Clock } from '../../shared/clock.js';
import type { Logger } from '../../shared/logger.js';
import type { Config } from '../../config/schema.js';
import type { Repositories } from '../../db/repositories.js';
import type { ApprovalDecisionResult } from '../../claim/claimEngine.js';
import { parseApprovalCommand, type IncomingMessage, type MessageReader } from './reader.js';
import type { IMessageTransport } from './transports.js';

export interface CommandServiceDeps {
  reader: MessageReader;
  repos: Repositories;
  clock: Clock;
  logger: Logger;
  getConfig: () => Config;
  decide: (input: { shortCode: string; decision: 'claim' | 'skip'; decidedBy: string }) => Promise<ApprovalDecisionResult>;
  /** Optional transport for confirmations; when absent no reply is sent. */
  getTransport: () => IMessageTransport | null;
}

export interface PollResult {
  scanned: number;
  commands: number;
  applied: number;
  rejected: number;
  errors: string[];
}

const STATE_KEY = 'imessage.last_rowid';

/** Handles are compared loosely: digits-only for phone numbers, lowercase for emails. */
export function normaliseHandle(handle: string): string {
  const trimmed = handle.trim().toLowerCase();
  if (trimmed.includes('@')) return trimmed;
  return trimmed.replace(/[^0-9+]/g, '');
}

/**
 * Polls Messages.app for approval commands.
 *
 * This is deliberately not "iMessage polling of notification replies" (which is
 * not programmable): it reads ordinary inbound text messages and accepts only
 * an explicit `CLAIM <code>` / `SKIP <code>` from the configured sender. Every
 * command is a real user decision, recorded with who decided and when.
 */
export class IMessageCommandService {
  constructor(private readonly deps: CommandServiceDeps) {}

  async poll(): Promise<PollResult> {
    const result: PollResult = { scanned: 0, commands: 0, applied: 0, rejected: 0, errors: [] };
    const { reader, repos, getConfig, clock, logger } = this.deps;
    const config = getConfig();
    const cfg = config.notifications.adapters.imessage;
    if (!cfg.enabled) return result;

    let lastRowid = repos.state.getNumber(STATE_KEY);
    let messages: IncomingMessage[];
    try {
      if (lastRowid === null) {
        // First run: baseline at the newest message so history is never replayed.
        const newest = await reader.maxRowid();
        repos.state.set(STATE_KEY, String(newest), clock.now().toISOString());
        logger.child('imessage').info('inbound baseline established', { rowid: newest });
        return result;
      }
      messages = await reader.since(lastRowid, cfg.commandSender.trim() || cfg.recipient || null, 200);
    } catch (e) {
      result.errors.push((e as Error).message);
      logger.child('imessage').warn('could not read Messages database', { error: (e as Error).message });
      return result;
    }

    const allowed = normaliseHandle(cfg.commandSender.trim() || cfg.recipient);
    const log = logger.child('imessage');

    for (const msg of messages) {
      result.scanned++;
      if (msg.rowid > lastRowid) lastRowid = msg.rowid;
      if (msg.isFromMe) continue;
      const command = parseApprovalCommand(msg.text);
      if (!command) continue;

      if (!allowed || normaliseHandle(msg.handle) !== allowed) {
        result.rejected++;
        log.warn('ignoring approval command from an unexpected sender', { handle: msg.handle });
        continue;
      }

      result.commands++;
      try {
        const decision = await this.deps.decide({ shortCode: command.code, decision: command.kind, decidedBy: `imessage:${msg.handle}` });
        if (decision.ok) {
          result.applied++;
          log.info('approval applied from iMessage', { code: command.code, decision: command.kind });
          await this.reply(command.kind === 'claim' ? `✅ Claiming now (code ${command.code}).` : `👌 Skipped (code ${command.code}).`);
        } else {
          result.rejected++;
          const why =
            decision.decision === 'expired'
              ? 'that approval has expired'
              : decision.decision === 'not_found'
                ? 'no pending approval matches that code'
                : 'that approval was already decided';
          log.info('approval command not applied', { code: command.code, reason: decision.decision });
          await this.reply(`⚠️ Not applied: ${why}.`);
        }
      } catch (e) {
        result.errors.push((e as Error).message);
        log.exception('approval command failed', e, { code: command.code });
      }
    }

    if (lastRowid !== null) repos.state.set(STATE_KEY, String(lastRowid), clock.now().toISOString());
    return result;
  }

  private async reply(text: string): Promise<void> {
    const transport = this.deps.getTransport();
    const cfg = this.deps.getConfig().notifications.adapters.imessage;
    if (!transport || !cfg.recipient) return;
    try {
      await transport.send(cfg.recipient, text, cfg.sendTimeoutSeconds * 1000);
    } catch {
      /* a confirmation reply failing must never affect the decision */
    }
  }
}
