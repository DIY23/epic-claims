import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ApiClientError,
  clearToken,
  get,
  getToken,
  post,
  put,
  setToken,
  type Config,
  type HistoryResponse,
  type MatrixEvent,
  type OfferRow,
  type StatusResponse,
  type Template,
} from './api.js';
import './styles.css';

type Tab = 'overview' | 'games' | 'approvals' | 'notifications' | 'history' | 'settings' | 'updates';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'games', label: 'Games' },
  { id: 'approvals', label: 'Approvals' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'history', label: 'History' },
  { id: 'settings', label: 'Settings' },
  { id: 'updates', label: 'Updates' },
];

function fmt(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString();
}

function Pill({ tone, children }: { tone?: 'ok' | 'warn' | 'err'; children: React.ReactNode }): React.ReactElement {
  return <span className={`pill${tone ? ` ${tone}` : ''}`}>{children}</span>;
}

function statusTone(status: string): 'ok' | 'warn' | 'err' | undefined {
  if (['claimed', 'succeeded', 'delivered', 'success', 'active', 'accepted'].includes(status)) return 'ok';
  if (['pending_approval', 'pending', 'skipped', 'expired', 'running'].includes(status)) return 'warn';
  if (['failed', 'abandoned', 'rolled_back'].includes(status)) return 'err';
  return undefined;
}

function useToast(): { show: (message: string, error?: boolean) => void; node: React.ReactNode } {
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(null), 5000);
    return () => clearTimeout(timer);
  }, [message]);
  const show = useCallback((text: string, isError = false) => {
    setMessage(text);
    setError(isError);
  }, []);
  const node = message ? <div className={`toast${error ? ' err' : ''}`}>{message}</div> : null;
  return { show, node };
}

function Login({ onDone }: { onDone: () => void }): React.ReactElement {
  const [token, setValue] = useState('');
  return (
    <div className="login">
      <h1>Epic Claims</h1>
      <p className="sub">Paste the local API token. Get it with <span className="mono">epic-claims config token</span>.</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (token.trim()) {
            setToken(token.trim());
            onDone();
          }
        }}
      >
        <label className="field">
          <span>API token</span>
          <input type="password" value={token} onChange={(e) => setValue(e.target.value)} autoFocus placeholder="paste token" />
        </label>
        <button className="action primary" type="submit">
          Open dashboard
        </button>
      </form>
    </div>
  );
}

function Overview({ status, reload }: { status: StatusResponse; reload: () => void }): React.ReactElement {
  const { show } = useToast();
  const [busy, setBusy] = useState(false);
  const runCheck = async (): Promise<void> => {
    setBusy(true);
    try {
      const res = await post<{ summary: { claimed: number; pendingApproval: number; failed: number; discovered: number } }>('/api/check');
      show(`Cycle done — discovered ${res.summary.discovered}, claimed ${res.summary.claimed}, pending ${res.summary.pendingApproval}, failed ${res.summary.failed}`);
      reload();
    } catch (e) {
      show((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section>
      <h1>Overview</h1>
      <p className="sub">
        v{status.version} · up {Math.round(status.uptimeSec / 60)} min · mode <strong>{status.mode}</strong>
        {status.dryRun ? ' (dry run)' : ''}
      </p>
      {!status.store.auth.authenticated && (
        <div className="notice warn">
          Epic session not active: {status.store.auth.detail} — run <span className="mono">epic-claims auth login</span> on the Mac.
        </div>
      )}
      {(status.counts.discovered ?? 0) > 0 && (
        <div className="notice">
          <strong>{status.counts.discovered} offer(s) found and nothing claimed yet.</strong> The first scan never claims automatically — pick games
          on the Games tab, or claim everything eligible now.{' '}
          <button
            className="action"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const res = await post<{ summary: { claimed: number; pendingApproval: number; failed: number } }>('/api/claim-all');
                show(`Claimed ${res.summary.claimed} · pending ${res.summary.pendingApproval} · failed ${res.summary.failed}`);
                reload();
              } catch (e) {
                show((e as Error).message, true);
              } finally {
                setBusy(false);
              }
            }}
          >
            Claim all eligible
          </button>
        </div>
      )}
      {status.scheduler.lastError && <div className="notice err">Last cycle error: {status.scheduler.lastError}</div>}
      <div className="cards">
        <div className="card">
          <div className="label">Epic account</div>
          <div className="value">{status.store.auth.authenticated ? status.store.auth.accountName ?? 'connected' : 'signed out'}</div>
        </div>
        <div className="card">
          <div className="label">Awaiting approval</div>
          <div className="value">{status.approvalsPending}</div>
        </div>
        <div className="card">
          <div className="label">Next check</div>
          <div className="value">{fmt(status.scheduler.nextCheckAt)}</div>
        </div>
        <div className="card">
          <div className="label">Last check</div>
          <div className="value">{fmt(status.scheduler.lastCheckAt)}</div>
        </div>
        <div className="card">
          <div className="label">Service</div>
          <div className="value">{status.service ? (status.service.loaded ? 'launchd loaded' : 'not loaded') : '—'}</div>
        </div>
        <div className="card">
          <div className="label">Updates</div>
          <div className="value">{status.updates.lastAvailableVersion ? `v${status.updates.lastAvailableVersion} available` : 'up to date'}</div>
        </div>
      </div>

      <h2>Offers by status</h2>
      <div className="row">
        {Object.entries(status.counts).length === 0 && <span className="muted">No offers recorded yet.</span>}
        {Object.entries(status.counts).map(([key, value]) => (
          <span key={key} className="pill">
            {key}: {value}
          </span>
        ))}
      </div>

      <h2>Channels</h2>
      <table>
        <thead>
          <tr>
            <th>Adapter</th>
            <th>State</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>
          {status.notifications.map((a) => (
            <tr key={a.id}>
              <td>{a.id}</td>
              <td>{a.enabled ? <Pill tone={a.configured ? 'ok' : 'warn'}>{a.configured ? 'ready' : 'not ready'}</Pill> : <Pill>disabled</Pill>}</td>
              <td className="muted">{a.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Recent errors</h2>
      {status.errors.length === 0 ? (
        <p className="muted">None.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Scope</th>
              <th>Message</th>
            </tr>
          </thead>
          <tbody>
            {status.errors.map((e, i) => (
              <tr key={`${e.ts}-${i}`}>
                <td className="muted">{fmt(e.ts)}</td>
                <td>{e.scope}</td>
                <td>{e.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="row" style={{ marginTop: 20 }}>
        <button className="action primary" onClick={() => void runCheck()} disabled={busy}>
          {busy ? 'Checking…' : 'Run a check now'}
        </button>
        <button className="action" onClick={reload}>
          Refresh
        </button>
      </div>
    </section>
  );
}

function Games({ reload }: { reload: () => void }): React.ReactElement {
  const { show } = useToast();
  const [offers, setOffers] = useState<OfferRow[]>([]);
  const [busy, setBusy] = useState<number | null>(null);

  const load = useCallback(async () => {
    setOffers(await get<OfferRow[]>('/api/offers'));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (id: number, kind: 'claim' | 'skip'): Promise<void> => {
    setBusy(id);
    try {
      await post(`/api/offers/${id}/${kind}`);
      show(kind === 'claim' ? 'Claim finished — check History for verification' : 'Offer skipped');
      await load();
      reload();
    } catch (e) {
      show((e as Error).message, true);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section>
      <h1>Games</h1>
      <p className="sub">Every promotion seen so far, with its claim and ownership state.</p>
      {offers.length === 0 ? (
        <p className="muted">No offers recorded yet. Run a check from the Overview tab.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Game</th>
              <th>Type</th>
              <th>Status</th>
              <th>Owned</th>
              <th>Ends</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {offers.map((o) => (
              <tr key={o.id}>
                <td>
                  <div>{o.url ? <a href={o.url} target="_blank" rel="noreferrer">{o.title}</a> : o.title}</div>
                  <div className="muted" style={{ fontSize: 12 }}>
                    {o.publisher || 'unknown publisher'}
                  </div>
                </td>
                <td>{o.kind}</td>
                <td>
                  <Pill tone={statusTone(o.status)}>{o.status}</Pill>
                  {o.pendingApproval && <div className="muted mono" style={{ fontSize: 11 }}>code {o.pendingApproval.shortCode}</div>}
                  {o.lastAttempt?.errorCode && <div className="muted" style={{ fontSize: 11 }}>{o.lastAttempt.errorCode}</div>}
                </td>
                <td>{o.owned ? <Pill tone="ok">owned</Pill> : <span className="muted">no</span>}</td>
                <td className="muted">{fmt(o.endAt)}</td>
                <td>
                  <div className="row">
                    <button className="action" disabled={busy === o.id || o.status === 'claimed'} onClick={() => void act(o.id, 'claim')}>
                      {o.status === 'claimed' ? 'Claimed' : 'Claim'}
                    </button>
                    <button className="action" disabled={busy === o.id || o.status === 'skipped'} onClick={() => void act(o.id, 'skip')}>
                      Skip
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

interface ApprovalRow {
  id: number;
  shortCode: string;
  expiresAt: string;
  createdAt: string;
  offer: { id: number; title: string; endAt: string | null; url: string | null } | null;
}

function Approvals({ reload }: { reload: () => void }): React.ReactElement {
  const { show } = useToast();
  const [rows, setRows] = useState<ApprovalRow[]>([]);
  const load = useCallback(async () => setRows(await get<ApprovalRow[]>('/api/approvals')), []);
  useEffect(() => {
    void load();
  }, [load]);

  const decide = async (id: number, decision: 'claim' | 'skip'): Promise<void> => {
    try {
      await post(`/api/approvals/${id}/decide`, { decision });
      show(decision === 'claim' ? 'Approved — claiming now' : 'Skipped');
      await load();
      reload();
    } catch (e) {
      show((e as Error).message, true);
    }
  };

  return (
    <section>
      <h1>Approvals</h1>
      <p className="sub">Offers waiting for your decision. You can also answer from the macOS notification or by iMessage command.</p>
      {rows.length === 0 ? (
        <p className="muted">Nothing is waiting.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Game</th>
              <th>Code</th>
              <th>Requested</th>
              <th>Expires</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a.id}>
                <td>{a.offer?.url ? <a href={a.offer.url} target="_blank" rel="noreferrer">{a.offer.title}</a> : a.offer?.title ?? '—'}</td>
                <td className="mono">{a.shortCode}</td>
                <td className="muted">{fmt(a.createdAt)}</td>
                <td className="muted">{fmt(a.expiresAt)}</td>
                <td>
                  <div className="row">
                    <button className="action primary" onClick={() => void decide(a.id, 'claim')}>
                      Claim
                    </button>
                    <button className="action" onClick={() => void decide(a.id, 'skip')}>
                      Skip
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function Notifications(): React.ReactElement {
  const { show } = useToast();
  const [matrix, setMatrix] = useState<{ adapters: Array<{ id: string; enabled: boolean; configured: boolean; detail: string }>; events: MatrixEvent[] } | null>(null);
  const [config, setConfig] = useState<Config | null>(null);
  const [editing, setEditing] = useState<{ event: string; adapter: 'macos' } | null>(null);
  const [draft, setDraft] = useState<Template | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [m, c] = await Promise.all([get<typeof matrix>('/api/notifications/matrix'), get<Config>('/api/config')]);
    setMatrix(m);
    setConfig(c);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = async (event: string, adapter: 'macos', enabled: boolean): Promise<void> => {
    try {
      await put('/api/notifications/toggles', { events: { [event]: { [adapter]: enabled } } });
      await load();
    } catch (e) {
      show((e as Error).message, true);
    }
  };

  const saveTemplate = async (): Promise<void> => {
    if (!editing || !draft) return;
    try {
      await put('/api/notifications/templates', { adapter: editing.adapter, event: editing.event, template: draft });
      show('Template saved');
      setEditing(null);
      setDraft(null);
      setPreview(null);
      await load();
    } catch (e) {
      show((e as Error).message, true);
    }
  };

  const runPreview = async (): Promise<void> => {
    if (!editing || !draft) return;
    try {
      const res = await post<{ rendered?: { subject: string | null; subtitle: string | null; body: string } }>('/api/notifications/preview', {
        adapter: editing.adapter,
        event: editing.event,
        template: draft,
      });
      setPreview(
        res.rendered
          ? [res.rendered.subject, res.rendered.subtitle, res.rendered.body].filter(Boolean).join('\n')
          : 'Preview not available',
      );
    } catch (e) {
      setPreview(`Preview failed: ${(e as Error).message}`);
    }
  };

  const sendTest = async (adapter: string): Promise<void> => {
    try {
      const res = await post<{ report: { status: string; errorMessage?: string } }>('/api/notifications/test', { adapter, event: 'APPROVAL_REQUIRED' });
      show(res.report.status === 'delivered' ? `Test sent via ${adapter}` : `Test failed: ${res.report.errorMessage ?? res.report.status}`, res.report.status !== 'delivered');
    } catch (e) {
      show((e as Error).message, true);
    }
  };

  if (!matrix || !config) return <p className="muted">Loading…</p>;

  return (
    <section>
      <h1>Notifications</h1>
      <p className="sub">Every event has its own switch and its own editable template. Native macOS notifications carry Claim / Skip buttons.</p>

      <h2>Channels</h2>
      <table>
        <thead>
          <tr>
            <th>Adapter</th>
            <th>Enabled</th>
            <th>State</th>
            <th>Detail</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {matrix.adapters.map((a) => (
            <tr key={a.id}>
              <td>{a.id}</td>
              <td>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={config.notifications.adapters.macos.enabled}
                    onChange={async (e) => {
                      try {
                        await put('/api/config', { notifications: { adapters: { macos: { enabled: e.target.checked } } } });
                        await load();
                      } catch (err) {
                        show((err as Error).message, true);
                      }
                    }}
                  />
                </label>
              </td>
              <td>{a.configured ? <Pill tone="ok">ready</Pill> : <Pill tone="warn">not ready</Pill>}</td>
              <td className="muted">{a.detail}</td>
              <td>
                <button className="action" onClick={() => void sendTest(a.id)}>
                  Send test
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Event matrix</h2>
      <table>
        <thead>
          <tr>
            <th>Event</th>
            <th>macOS</th>
            <th>Templates</th>
          </tr>
        </thead>
        <tbody>
          {matrix.events.map((e) => (
            <tr key={e.event}>
              <td>{e.label}</td>
              <td>
                <input type="checkbox" checked={e.toggles.macos} onChange={(ev) => void toggle(e.event, 'macos', ev.target.checked)} />
              </td>
              <td>
                <button
                  className="action"
                  onClick={() => {
                    setEditing({ event: e.event, adapter: 'macos' });
                    setDraft(e.templates.macos ? { ...e.templates.macos } : { body: '{game_name}' });
                    setPreview(null);
                  }}
                >
                  Edit
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {editing && draft && (
        <>
          <h2>
            Template · {editing.adapter} · {editing.event}
          </h2>
          <div className="grid2">
            <div>
              {editing.adapter === 'macos' && (
                <>
                  <label className="field">
                    <span>Title</span>
                    <input type="text" value={draft.title ?? ''} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
                  </label>
                  <label className="field">
                    <span>Subtitle</span>
                    <input type="text" value={draft.subtitle ?? ''} onChange={(e) => setDraft({ ...draft, subtitle: e.target.value })} />
                  </label>
                </>
              )}
              <label className="field">
                <span>Body</span>
                <textarea value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
              </label>
              <label className="field">
                <span>Claim button / command</span>
                <input type="text" value={draft.approveLabel ?? ''} onChange={(e) => setDraft({ ...draft, approveLabel: e.target.value })} />
              </label>
              <label className="field">
                <span>Skip button / command</span>
                <input type="text" value={draft.skipLabel ?? ''} onChange={(e) => setDraft({ ...draft, skipLabel: e.target.value })} />
              </label>
              <div className="row">
                <button className="action primary" onClick={() => void saveTemplate()}>
                  Save
                </button>
                <button className="action" onClick={() => void runPreview()}>
                  Preview
                </button>
                <button
                  className="action"
                  onClick={() => {
                    setEditing(null);
                    setDraft(null);
                    setPreview(null);
                  }}
                >
                  Cancel
                </button>
              </div>
              <p className="muted" style={{ marginTop: 12 }}>
                Variables:{' '}
                {matrix.events
                  .find((e) => e.event === editing.event)
                  ?.variables.map((v) => (
                    <span key={v} className="tag">
                      {'{' + v + '}'}
                    </span>
                  ))}
              </p>
            </div>
            <div>
              <div className="label muted" style={{ marginBottom: 6 }}>
                Preview
              </div>
              <div className="preview">{preview ?? 'Press Preview to render this template with example data.'}</div>
            </div>
          </div>
        </>
      )}
    </section>
  );
}

function History(): React.ReactElement {
  const [data, setData] = useState<HistoryResponse | null>(null);
  useEffect(() => {
    void get<HistoryResponse>('/api/history?limit=60').then(setData);
  }, []);
  if (!data) return <p className="muted">Loading…</p>;
  return (
    <section>
      <h1>History</h1>
      <p className="sub">Auditable record of every claim attempt, approval, notification and update.</p>

      <h2>Claim attempts</h2>
      {data.claims.length === 0 ? (
        <p className="muted">No claims yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Game</th>
              <th>Result</th>
              <th>Verified</th>
              <th>Error</th>
              <th>By</th>
            </tr>
          </thead>
          <tbody>
            {data.claims.map((c) => (
              <tr key={c.id}>
                <td className="muted">{fmt(c.startedAt)}</td>
                <td>{c.title ?? `#${c.offerId}`}</td>
                <td>
                  <Pill tone={statusTone(c.status)}>{c.status}</Pill>
                </td>
                <td>{c.verified ? 'yes' : 'no'}</td>
                <td className="muted">{c.errorCode ? `${c.errorCode}: ${c.errorMessage ?? ''}` : '—'}</td>
                <td className="muted">{c.initiator}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Approvals</h2>
      {data.approvals.length === 0 ? (
        <p className="muted">No approval requests yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Game</th>
              <th>Status</th>
              <th>Decided by</th>
              <th>Expires</th>
            </tr>
          </thead>
          <tbody>
            {data.approvals.map((a) => (
              <tr key={a.id}>
                <td className="muted">{fmt(a.createdAt)}</td>
                <td>{a.title ?? '—'}</td>
                <td>
                  <Pill tone={statusTone(a.status)}>{a.status}</Pill>
                </td>
                <td className="muted">{a.decidedBy ?? '—'}</td>
                <td className="muted">{fmt(a.expiresAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Notifications</h2>
      {data.notifications.length === 0 ? (
        <p className="muted">Nothing delivered yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Event</th>
              <th>Channel</th>
              <th>Status</th>
              <th>Error</th>
            </tr>
          </thead>
          <tbody>
            {data.notifications.map((n) => (
              <tr key={n.id}>
                <td className="muted">{fmt(n.createdAt)}</td>
                <td>{n.event}</td>
                <td>{n.adapter}</td>
                <td>
                  <Pill tone={statusTone(n.status)}>{n.status}</Pill>
                </td>
                <td className="muted">{n.errorCode ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Log</h2>
      <table>
        <thead>
          <tr>
            <th>When</th>
            <th>Level</th>
            <th>Scope</th>
            <th>Message</th>
          </tr>
        </thead>
        <tbody>
          {data.logs.slice(0, 40).map((l, i) => (
            <tr key={`${l.ts}-${i}`}>
              <td className="muted">{fmt(l.ts)}</td>
              <td>{l.level}</td>
              <td>{l.scope}</td>
              <td>{l.message}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function Settings({ config, reload }: { config: Config; reload: () => void }): React.ReactElement {
  const { show } = useToast();
  const [draft, setDraft] = useState<Config>(config);
  useEffect(() => setDraft(config), [config]);

  const save = async (patch: Partial<Config>): Promise<void> => {
    try {
      await put('/api/config', patch);
      show('Saved');
      reload();
    } catch (e) {
      show((e as Error).message, true);
    }
  };

  const addRule = async (): Promise<void> => {
    const rule = { id: `rule-${Date.now().toString(36)}`, enabled: true, field: 'kind' as const, op: 'is' as const, value: 'game', action: 'claim' as const };
    await save({ claiming: { ...draft.claiming, rules: [...draft.claiming.rules, rule] } });
  };

  const updateRule = async (id: string, patch: Record<string, unknown>): Promise<void> => {
    const rules = draft.claiming.rules.map((r) => (r.id === id ? { ...r, ...patch } : r));
    await save({ claiming: { ...draft.claiming, rules } });
  };

  const removeRule = async (id: string): Promise<void> => {
    await save({ claiming: { ...draft.claiming, rules: draft.claiming.rules.filter((r) => r.id !== id) } });
  };

  return (
    <section>
      <h1>Settings</h1>
      <p className="sub">Everything here is stored in the data directory and survives updates.</p>

      <h2>Claiming</h2>
      <div className="grid2">
        <label className="field">
          <span>Mode</span>
          <select value={draft.claiming.mode} onChange={(e) => void save({ claiming: { ...draft.claiming, mode: e.target.value as Config['claiming']['mode'] } })}>
            <option value="auto">Automatic — claim everything eligible</option>
            <option value="approval">Approval — ask me every time</option>
            <option value="hybrid">Hybrid — rules decide</option>
          </select>
        </label>
        <label className="field">
          <span>Dry run (discover only, never redeem)</span>
          <input type="checkbox" checked={draft.claiming.dryRun} onChange={(e) => void save({ claiming: { ...draft.claiming, dryRun: e.target.checked } })} />
        </label>
        <label className="field">
          <span>Approval expires after (hours)</span>
          <input
            type="number"
            min={0.25}
            step={0.25}
            defaultValue={draft.claiming.approvalExpiryHours}
            onBlur={(e) => void save({ claiming: { ...draft.claiming, approvalExpiryHours: Number(e.target.value) } })}
          />
        </label>
        <label className="field">
          <span>When an approval expires</span>
          <select
            value={draft.claiming.approvalExpiryAction}
            onChange={(e) => void save({ claiming: { ...draft.claiming, approvalExpiryAction: e.target.value as 'skip' | 'keep_pending' } })}
          >
            <option value="skip">Skip the offer</option>
            <option value="keep_pending">Keep it pending</option>
          </select>
        </label>
        <label className="field">
          <span>Minutes after the store publishes (11:00 America/New_York)</span>
          <input
            type="number"
            min={0}
            step={5}
            defaultValue={draft.scheduling.scanOffsetMinutes}
            onBlur={(e) => void save({ scheduling: { ...draft.scheduling, scanOffsetMinutes: Number(e.target.value) } })}
          />
        </label>
        <label className="field">
          <span>Warn about expiring offers (hours before)</span>
          <input
            type="number"
            min={0}
            step={1}
            defaultValue={draft.scheduling.expiringWarningHours}
            onBlur={(e) => void save({ scheduling: { ...draft.scheduling, expiringWarningHours: Number(e.target.value) } })}
          />
        </label>
      </div>

      <h2>Hybrid rules</h2>
      <p className="sub">First matching rule wins. With mode = hybrid, anything unmatched asks for approval.</p>
      <table>
        <thead>
          <tr>
            <th>On</th>
            <th>Field</th>
            <th>Operator</th>
            <th>Value</th>
            <th>Action</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {draft.claiming.rules.map((r) => (
            <tr key={r.id}>
              <td>
                <input type="checkbox" checked={r.enabled} onChange={(e) => void updateRule(r.id, { enabled: e.target.checked })} />
              </td>
              <td>
                <select value={r.field} onChange={(e) => void updateRule(r.id, { field: e.target.value })}>
                  {['kind', 'publisher', 'title', 'price', 'discount_percent'].map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </select>
              </td>
              <td>
                <select value={r.op} onChange={(e) => void updateRule(r.id, { op: e.target.value })}>
                  {['is', 'is_not', 'contains', 'not_contains', 'matches', 'gte', 'lte'].map((op) => (
                    <option key={op} value={op}>
                      {op}
                    </option>
                  ))}
                </select>
              </td>
              <td>
                <input type="text" defaultValue={r.value} onBlur={(e) => void updateRule(r.id, { value: e.target.value })} />
              </td>
              <td>
                <select value={r.action} onChange={(e) => void updateRule(r.id, { action: e.target.value })}>
                  <option value="claim">claim</option>
                  <option value="approval">approval</option>
                  <option value="skip">skip</option>
                </select>
              </td>
              <td>
                <button className="action" onClick={() => void removeRule(r.id)}>
                  Remove
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row" style={{ marginTop: 12 }}>
        <button className="action" onClick={() => void addRule()}>
          Add rule
        </button>
      </div>

      <h2>Updates</h2>
      <div className="grid2">
        <label className="field">
          <span>Preference</span>
          <select value={draft.updates.preference} onChange={(e) => void save({ updates: { ...draft.updates, preference: e.target.value as Config['updates']['preference'] } })}>
            <option value="manual">Manual only</option>
            <option value="notify">Notify when available</option>
            <option value="auto">Install stable updates automatically</option>
          </select>
        </label>
        <label className="field">
          <span>Channel</span>
          <select value={draft.updates.channel} onChange={(e) => void save({ updates: { ...draft.updates, channel: e.target.value as 'stable' | 'beta' } })}>
            <option value="stable">Stable</option>
            <option value="beta">Beta (prereleases)</option>
          </select>
        </label>
      </div>

      <h2>Store</h2>
      <div className="grid2">
        <label className="field">
          <span>Country (pricing region)</span>
          <input type="text" defaultValue={draft.epic.country} maxLength={2} onBlur={(e) => void save({ epic: { ...draft.epic, country: e.target.value.toUpperCase() } })} />
        </label>
        <label className="field">
          <span>Locale</span>
          <input type="text" defaultValue={draft.epic.locale} onBlur={(e) => void save({ epic: { ...draft.epic, locale: e.target.value } })} />
        </label>
      </div>
      <p className="muted">
        Local API: {config.api.host}:{config.api.port} · config and database live in the data directory and are never touched by updates.
      </p>
    </section>
  );
}

function Updates({ reload }: { reload: () => void }): React.ReactElement {
  const { show } = useToast();
  const [data, setData] = useState<{
    installed: { installedVersion: string; lastCheckAt: string | null; lastAvailableVersion: string | null; lastInstallAt: string | null };
    preference: string;
    channel: string;
    history: Array<{ id: number; fromVersion: string | null; toVersion: string; status: string; rolledBack: boolean; startedAt: string }>;
  } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => setData(await get('/api/updates')), []);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section>
      <h1>Updates</h1>
      <p className="sub">Updates replace the application files only. Configuration, credentials, database and history are untouched.</p>
      {data && (
        <>
          <div className="cards">
            <div className="card">
              <div className="label">Installed</div>
              <div className="value">v{data.installed.installedVersion}</div>
            </div>
            <div className="card">
              <div className="label">Available</div>
              <div className="value">{data.installed.lastAvailableVersion ? `v${data.installed.lastAvailableVersion}` : '—'}</div>
            </div>
            <div className="card">
              <div className="label">Last check</div>
              <div className="value">{fmt(data.installed.lastCheckAt)}</div>
            </div>
            <div className="card">
              <div className="label">Last install</div>
              <div className="value">{fmt(data.installed.lastInstallAt)}</div>
            </div>
          </div>
          <div className="row" style={{ marginTop: 16 }}>
            <button
              className="action primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const res = await post<{ updateAvailable: boolean; latestVersion: string | null }>('/api/updates/check');
                  show(res.updateAvailable ? `Update available: v${res.latestVersion}. Install it with "epic-claims update".` : 'Already up to date');
                  await load();
                  reload();
                } catch (e) {
                  show((e as Error).message, true);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? 'Checking…' : 'Check for updates'}
            </button>
            <span className="muted">
              Preference: {data.preference} · channel: {data.channel} — install from the CLI: <span className="mono">epic-claims update</span>
            </span>
          </div>
          <h2>History</h2>
          {data.history.length === 0 ? (
            <p className="muted">No updates installed yet.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>From</th>
                  <th>To</th>
                  <th>Status</th>
                  <th>Rolled back</th>
                </tr>
              </thead>
              <tbody>
                {data.history.map((h) => (
                  <tr key={h.id}>
                    <td className="muted">{fmt(h.startedAt)}</td>
                    <td>{h.fromVersion ?? '—'}</td>
                    <td>{h.toVersion}</td>
                    <td>
                      <Pill tone={statusTone(h.status)}>{h.status}</Pill>
                    </td>
                    <td>{h.rolledBack ? 'yes' : 'no'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </section>
  );
}

function App(): React.ReactElement {
  const [authed, setAuthed] = useState<boolean>(getToken() !== null);
  const [tab, setTab] = useState<Tab>('overview');
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [config, setConfig] = useState<Config | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    setError(null);
    void get<StatusResponse>('/api/status')
      .then(setStatus)
      .catch((e: unknown) => {
        if (e instanceof ApiClientError && e.status === 401) setAuthed(false);
        setError((e as Error).message);
      });
    void get<Config>('/api/config').then(setConfig).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!authed) return;
    reload();
    const timer = setInterval(reload, 15_000);
    return () => clearInterval(timer);
  }, [authed, reload]);

  const content = useMemo(() => {
    if (!status || !config) return <p className="muted">Loading…</p>;
    switch (tab) {
      case 'overview':
        return <Overview status={status} reload={reload} />;
      case 'games':
        return <Games reload={reload} />;
      case 'approvals':
        return <Approvals reload={reload} />;
      case 'notifications':
        return <Notifications />;
      case 'history':
        return <History />;
      case 'settings':
        return <Settings config={config} reload={reload} />;
      case 'updates':
        return <Updates reload={reload} />;
      default:
        return null;
    }
  }, [tab, status, config, reload]);

  if (!authed) return <Login onDone={() => setAuthed(true)} />;

  return (
    <div className="layout">
      <nav>
        <div className="brand">
          Epic Claims<small>{status ? `v${status.version}` : ''}</small>
        </div>
        {TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
        <button
          style={{ marginTop: 18, color: '#8b93a7' }}
          onClick={() => {
            clearToken();
            setAuthed(false);
          }}
        >
          Sign out
        </button>
      </nav>
      <main>
        {error && <div className="notice err">{error}</div>}
        {content}
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
