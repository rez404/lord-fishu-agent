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
  knowledge: { links: Array<{ label: string; url: string }>; facts: string };
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
  const [knowledgeLoaded, setKnowledgeLoaded] = useState(false);

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
    setKnowledgeLoaded(true);
  }, [state, knowledgeLoaded]);

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

              <p className="book">WHAT HE KNOWS</p>
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
                        body: JSON.stringify({
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
                        }),
                      }),
                    )
                  }
                >
                  <span className="menu-key">↵</span>
                  <span className="menu-name">TEACH</span>
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
