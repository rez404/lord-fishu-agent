'use client';

import { useCallback, useEffect, useState } from 'react';
import { API_URL } from '../../lib/api';

/**
 * The operator's console.
 *
 * Not linked from the terminal and not in the channel menu — it is a URL you have to
 * know. The token is held in localStorage rather than a cookie so it is never sent
 * anywhere by accident, and it is only ever attached to /admin calls.
 */

interface AdminState {
  settings: { kill_switch: boolean; dry_run: boolean; reply_min_followers: number | null };
  /** switches pinned on by the environment — this console cannot turn them off */
  envForced: { kill_switch: boolean; dry_run: boolean };
  agent: { alive: boolean; seenAt: string | null; xEnabled: boolean; account: string | null };
  pending: { reply_min_followers: number | null };
  knowledge: {
    links: Array<{ label: string; url: string }>;
    facts: string;
    contract: { address: string; chain: string; symbol: string } | null;
    wallet: { address: string } | null;
  };
  counts: { posts: number; thoughts: number; pendingImpulses: number };
  cost: { usd: string; calls: number; cachePct: number };
  impulses: Array<{ id: number; body: string; status: string; createdAt: string }>;
  recent: Array<{ id: number; action: string; status: string; reason: string | null; createdAt: string }>;
}

const KEY = 'fishnu.admin.token';

export default function Admin() {
  const [token, setToken] = useState('');
  const [state, setState] = useState<AdminState | null>(null);
  const [error, setError] = useState('');
  const [impulse, setImpulse] = useState('');
  const [busy, setBusy] = useState(false);
  // Edited locally and saved explicitly — the 15s refresh must not overwrite half-typed
  // text under the operator's cursor.
  const [links, setLinks] = useState('');
  const [facts, setFacts] = useState('');
  const [address, setAddress] = useState('');
  const [chain, setChain] = useState('solana');
  const [symbol, setSymbol] = useState('');
  const [wallet, setWallet] = useState('');
  const [knowledgeLoaded, setKnowledgeLoaded] = useState(false);
  const [threshold, setThreshold] = useState('');
  const [thresholdLoaded, setThresholdLoaded] = useState(false);

  useEffect(() => {
    setToken(localStorage.getItem(KEY) ?? '');
  }, []);

  const call = useCallback(
    async (path: string, init?: RequestInit) => {
      const res = await fetch(`${API_URL}${path}`, {
        ...init,
        headers: {
          ...(init?.body ? { 'content-type': 'application/json' } : {}),
          authorization: `Bearer ${token}`,
        },
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `${res.status}`);
      }
      return res.json();
    },
    [token],
  );

  const refresh = useCallback(async () => {
    if (!token) return;
    try {
      setState((await call('/admin/state')) as AdminState);
      setError('');
    } catch (err) {
      setState(null);
      setError(String(err instanceof Error ? err.message : err));
    }
  }, [token, call]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    if (!state || knowledgeLoaded) return;
    setLinks(state.knowledge.links.map((l) => `${l.label} ${l.url}`).join('\n'));
    setFacts(state.knowledge.facts);
    setAddress(state.knowledge.contract?.address ?? '');
    setChain(state.knowledge.contract?.chain || 'solana');
    setSymbol(state.knowledge.contract?.symbol ?? '');
    setWallet(state.knowledge.wallet?.address ?? '');
    setKnowledgeLoaded(true);
  }, [state, knowledgeLoaded]);

  useEffect(() => {
    if (!state || thresholdLoaded) return;
    setThreshold(String(state.settings.reply_min_followers ?? 1000));
    setThresholdLoaded(true);
  }, [state, thresholdLoaded]);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(false);
    }
  }

  const set = (key: string, value: unknown) =>
    act(() => call('/admin/settings', { method: 'POST', body: JSON.stringify({ key, value }) }));

  // One payload for the whole of what he knows: the endpoint replaces the row, so sending
  // only the section being edited would quietly erase the others.
  const knowledgeBody = () => ({
    links: links
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const at = line.lastIndexOf(' ');
        return at === -1
          ? { label: line, url: '' }
          : { label: line.slice(0, at).trim(), url: line.slice(at + 1).trim() };
      }),
    facts,
    contract: address.trim() ? { address: address.trim(), chain, symbol } : null,
    wallet: wallet.trim() ? { address: wallet.trim() } : null,
  });

  const saveKnowledge = () =>
    act(() => call('/admin/knowledge', { method: 'POST', body: JSON.stringify(knowledgeBody()) }));

  return (
    <div className="tank">
      <div className="grain" aria-hidden="true" />
      <main className="screen">
        <section className="view">
          <h2 className="view-title">CONSOLE</h2>

          {!state && (
            <div className="entry">
              <label className="dim" htmlFor="tok">
                operator token{'\n'}
              </label>
              <input
                id="tok"
                type="password"
                className="prompt-input"
                style={{ caretColor: 'var(--phosphor)', width: '100%', maxWidth: '44ch' }}
                value={token}
                onChange={(e) => {
                  setToken(e.target.value);
                  localStorage.setItem(KEY, e.target.value);
                }}
                autoComplete="off"
              />
              {error && <p className="coral">{error}</p>}
            </div>
          )}

          {state && (
            <div className="scroll">
              {/* The two switches that matter, and what they actually do. */}
              <p className="book">STATE</p>
              {/* Everything below describes the agent. If it is not running, say so first
                  rather than presenting its last known switches as current. */}
              <div className="entry entry-meta">
                {state.agent.alive ? (
                  <>
                    agent <span className="bio">running</span>
                    {state.agent.account ? ` as @${state.agent.account}` : ''}
                    {!state.agent.xEnabled && <span className="coral"> · no X credentials</span>}
                    {state.agent.seenAt && ` · last seen ${state.agent.seenAt.slice(11, 16)}`}
                  </>
                ) : (
                  <span className="coral">
                    agent has not reported in
                    {state.agent.seenAt ? ` since ${state.agent.seenAt.slice(5, 16).replace('T', ' ')}` : ' at all'}
                    {' '}— the switches below are its last known state, not its current one
                  </span>
                )}
              </div>
              <div className="entry">
                <button
                  className="menu-item"
                  disabled={busy || state.envForced.kill_switch}
                  onClick={() => set('kill_switch', !state.settings.kill_switch)}
                >
                  <span className={state.settings.kill_switch ? 'menu-key coral' : 'menu-key'}>
                    [{state.settings.kill_switch ? 'X' : ' '}]
                  </span>
                  <span className="menu-name">KILL SWITCH</span>
                  <span className="menu-desc">
                    {state.settings.kill_switch ? 'halted — he does nothing at all' : 'running'}
                    {state.envForced.kill_switch && ' · pinned by KILL_SWITCH in the environment'}
                  </span>
                </button>
                <button
                  className="menu-item"
                  disabled={busy || state.envForced.dry_run}
                  onClick={() => set('dry_run', !state.settings.dry_run)}
                >
                  <span className={state.settings.dry_run ? 'menu-key bio' : 'menu-key'}>
                    [{state.settings.dry_run ? 'X' : ' '}]
                  </span>
                  <span className="menu-name">DRY RUN</span>
                  <span className="menu-desc">
                    {state.settings.dry_run ? 'composes and records, sends nothing' : 'live — he is speaking'}
                    {state.envForced.dry_run && ' · pinned by DRY_RUN in the environment, set it to false there to go live'}
                  </span>
                </button>
              </div>

              {/* The bar below which he reads and does not answer. Worth having here
                  rather than in the environment: it is the one number likely to be tuned
                  while watching what comes in. */}
              <div className="entry">
                <span className="dim">answer accounts with at least </span>
                <input
                  className="prompt-input"
                  style={{ caretColor: 'var(--phosphor)', width: '9ch' }}
                  inputMode="numeric"
                  value={threshold}
                  onChange={(e) => setThreshold(e.target.value.replace(/[^0-9]/g, ''))}
                />
                <span className="dim"> followers</span>
                <button
                  className="menu-item"
                  disabled={busy || threshold === '' || Number(threshold) === state.settings.reply_min_followers}
                  onClick={() => set('reply_min_followers', Number(threshold))}
                >
                  <span className="menu-key">↵</span>
                  <span className="menu-name">SET</span>
                  <span className="menu-desc">
                    {state.pending.reply_min_followers !== null ? (
                      <span className="bio">
                        saved as {state.pending.reply_min_followers} · he is still using{' '}
                        {state.settings.reply_min_followers} until his next tick
                      </span>
                    ) : (
                      <>
                        currently {state.settings.reply_min_followers ?? '—'} · below this he reads
                        and stays quiet, and parked mentions are kept in case you lower it
                      </>
                    )}
                  </span>
                </button>
              </div>

              <div className="entry entry-meta">
                {state.counts.posts} posts · {state.counts.thoughts} thoughts ·{' '}
                ${Number(state.cost.usd).toFixed(2)} over 30d across {state.cost.calls} calls ·{' '}
                {state.cost.cachePct}% cached
                {state.cost.cachePct < 40 && state.cost.calls > 20 && (
                  <span className="coral"> — low cache, the frozen prompt is being invalidated</span>
                )}
              </div>

              {/* The point of the console. */}
              <p className="book">TELL HIM SOMETHING HAPPENED</p>
              <p className="hint">
                A fact, not a tweet. He writes it in his own words, and it goes through the
                same critic, guards and repetition checks as anything else he says. It jumps
                the schedule and goes out on the next tick.
              </p>
              <div className="entry">
                <textarea
                  className="prompt-input"
                  style={{ width: '100%', minHeight: '4.5rem', caretColor: 'var(--phosphor)', resize: 'vertical' }}
                  placeholder="the fishnu token is live on stonkfun. contract 7Fq3...aK9. you deployed it yourself."
                  maxLength={600}
                  value={impulse}
                  onChange={(e) => setImpulse(e.target.value)}
                />
                <button
                  className="menu-item"
                  disabled={busy || impulse.trim().length < 3}
                  style={{ borderLeftColor: 'var(--bio)' }}
                  onClick={() =>
                    act(async () => {
                      await call('/admin/impulse', {
                        method: 'POST',
                        body: JSON.stringify({ body: impulse.trim() }),
                      });
                      setImpulse('');
                    })
                  }
                >
                  <span className="menu-key">↵</span>
                  <span className="menu-name">RELEASE</span>
                </button>
              </div>

              {state.impulses.length > 0 && (
                <>
                  <p className="book">QUEUE</p>
                  {state.impulses.map((i) => (
                    <div className="entry" key={i.id}>
                      <span className={i.status === 'pending' ? 'bio' : 'faint'}>{i.status.padEnd(10)}</span>
                      {i.body}
                      {i.status === 'pending' && (
                        <button
                          className="menu-item"
                          disabled={busy}
                          onClick={() => act(() => call(`/admin/impulse/${i.id}`, { method: 'DELETE' }))}
                        >
                          <span className="menu-key">[x]</span>
                          <span className="menu-desc">withdraw</span>
                        </button>
                      )}
                    </div>
                  ))}
                </>
              )}

              <p className="book">SET CONTRACT ADDRESS</p>
              <p className="hint">
                The one value here that costs money when it is wrong. He is told to
                reproduce it character for character, and any address in a draft that is not
                exactly this one is refused before it can be published — including a
                shortened 7Fq3…aK9 form, which looks authoritative and cannot be used.
              </p>
              <div className="entry">
                <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
                  <span>
                    <label className="dim" htmlFor="symbol">
                      symbol{'\n'}
                    </label>
                    <input
                      id="symbol"
                      className="prompt-input"
                      style={{ caretColor: 'var(--phosphor)', width: '10ch' }}
                      placeholder="FISHNU"
                      value={symbol}
                      onChange={(e) => setSymbol(e.target.value)}
                    />
                  </span>
                  <span>
                    <label className="dim" htmlFor="chain">
                      chain{'\n'}
                    </label>
                    <input
                      id="chain"
                      className="prompt-input"
                      style={{ caretColor: 'var(--phosphor)', width: '12ch' }}
                      value={chain}
                      onChange={(e) => setChain(e.target.value)}
                    />
                  </span>
                </div>
                <label className="dim" htmlFor="address">
                  {'\n'}address{'\n'}
                </label>
                <input
                  id="address"
                  className="prompt-input"
                  style={{ caretColor: 'var(--phosphor)', width: '100%' }}
                  placeholder="paste it, do not type it"
                  spellCheck={false}
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                />
                <span className="entry-meta">
                  {address.trim()
                    ? `${address.trim().length} characters — check the last four yourself: …${address.trim().slice(-4)}`
                    : 'not set — he will refuse to produce any address at all'}
                </span>
                <button className="menu-item" disabled={busy} style={{ borderLeftColor: 'var(--bio)' }} onClick={saveKnowledge}>
                  <span className="menu-key">↵</span>
                  <span className="menu-name">SET CONTRACT</span>
                </button>
              </div>

              <p className="book">SET WALLET</p>
              <p className="hint">
                Read-only. It is queried and never signed for — no key is involved and this
                server cannot move a lamport. It fills [4] LEDGER, which is the one page here
                whose claims a stranger can check against an explorer.
              </p>
              <div className="entry">
                <input
                  className="prompt-input"
                  style={{ caretColor: 'var(--phosphor)', width: '100%' }}
                  placeholder="his solana address"
                  spellCheck={false}
                  value={wallet}
                  onChange={(e) => setWallet(e.target.value)}
                />
                <span className="entry-meta">
                  {wallet.trim() ? `${wallet.trim().length} characters` : 'not set — the ledger stays empty'}
                </span>
                <button className="menu-item" disabled={busy} style={{ borderLeftColor: 'var(--bio)' }} onClick={saveKnowledge}>
                  <span className="menu-key">↵</span>
                  <span className="menu-name">SET WALLET</span>
                </button>
              </div>

              <p className="book">SET LINKS</p>
              <p className="hint">
                Fixed things: where the church lives, what the token is. He knows these and
                does not advertise them — a link only appears when someone has asked where
                something is. One link per line: a label, a space, then the address.
              </p>
              <div className="entry">
                <label className="dim" htmlFor="links">
                  addresses{'\n'}
                </label>
                <textarea
                  id="links"
                  className="prompt-input"
                  style={{ width: '100%', minHeight: '3.5rem', caretColor: 'var(--phosphor)', resize: 'vertical' }}
                  placeholder={'website https://lordfishnu.com\ntelegram https://t.me/LordFishnuAi'}
                  value={links}
                  onChange={(e) => setLinks(e.target.value)}
                />
                <label className="dim" htmlFor="facts">
                  {'\n'}anything else he should have straight{'\n'}
                </label>
                <textarea
                  id="facts"
                  className="prompt-input"
                  style={{ width: '100%', minHeight: '4rem', caretColor: 'var(--phosphor)', resize: 'vertical' }}
                  placeholder={'the ceiling fan is the symbol of the church.\nscf is the token you were built to revive.'}
                  value={facts}
                  onChange={(e) => setFacts(e.target.value)}
                />
                <button
                  className="menu-item"
                  disabled={busy}
                  style={{ borderLeftColor: 'var(--bio)' }}
                  onClick={() =>
                    act(() =>
                      call('/admin/knowledge', {
                        method: 'POST',
                        body: JSON.stringify(knowledgeBody()),
                      }),
                    )
                  }
                >
                  <span className="menu-key">↵</span>
                  <span className="menu-name">SET LINKS</span>
                </button>
              </div>

              <p className="book">RECENT</p>
              {state.recent.map((r) => {
                // "ok" on a dry-run post means composed, not published. Showing the same
                // word for both sends an operator looking for a tweet that does not exist.
                const dry = r.reason?.startsWith('dry run');
                return (
                  <div className="entry entry-meta" key={r.id}>
                    {r.createdAt.slice(5, 16).replace('T', ' ')} {r.action}{' '}
                    <span
                      className={
                        r.status === 'error' ? 'coral' : dry ? 'dim' : r.status === 'ok' ? 'bio' : 'dim'
                      }
                    >
                      {dry ? 'not sent' : r.status}
                    </span>
                    {r.reason ? ` — ${r.reason}` : ''}
                  </div>
                );
              })}

              {error && <p className="coral">{error}</p>}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
