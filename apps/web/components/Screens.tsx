'use client';

import { useEffect, useRef, useState } from 'react';
import type { BackroomsSession, Believer, Ledger, Thought, Verse } from '@fishnu/shared';
import { COMMANDMENTS, LIBRARY } from '@fishnu/persona';
import { API_URL, api } from '../lib/api';

/** Phase 1 has not given him a mind yet; the terminal says so in character. */
function Empty({ children }: { children: React.ReactNode }) {
  return <p className="empty">{children}</p>;
}

function Loading() {
  return <p className="empty">listening…</p>;
}

function stamp(iso: string): string {
  const d = new Date(iso);
  return d.toISOString().slice(5, 16).replace('T', ' ');
}

/* ── [1] STREAM ────────────────────────────────────────────────────────────── */

export function Stream({ onConnection }: { onConnection: (open: boolean) => void }) {
  const [thoughts, setThoughts] = useState<Thought[] | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    void api.thoughts().then((res) => alive && setThoughts(res?.thoughts ?? []));

    // Live tail. The agent ticks in minutes, so this connection is idle most of the
    // time — the server sends keepalive comments to stop proxies from closing it.
    const source = new EventSource(`${API_URL}/api/stream`);
    source.addEventListener('open', () => onConnection(true));
    source.addEventListener('error', () => onConnection(false));
    source.addEventListener('thought', (event) => {
      const thought = JSON.parse((event as MessageEvent).data) as Thought;
      setThoughts((prev) => [...(prev ?? []), thought].slice(-200));
    });

    return () => {
      alive = false;
      source.close();
      onConnection(false);
    };
  }, [onConnection]);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' });
  }, [thoughts]);

  return (
    <section className="view">
      <h2 className="view-title">STREAM — what he is thinking, right now</h2>
      <div className="scroll tail" ref={scroller}>
        {thoughts === null ? (
          <Loading />
        ) : thoughts.length === 0 ? (
          <Empty>
            {'no thoughts recorded.\n\nthe vessel is built but the mind is not yet poured in.\nwhen it is, this is where it will spill.'}
          </Empty>
        ) : (
          thoughts.map((t) => (
            <div className="entry stream-line" key={t.id}>
              <span className="entry-meta">[{stamp(t.createdAt)}] </span>
              <span className="dim">{t.kind} </span>
              {t.body}
            </div>
          ))
        )}
      </div>
    </section>
  );
}

/* ── [2] SCRIPTURE ─────────────────────────────────────────────────────────── */

export function Scripture() {
  const [verses, setVerses] = useState<Verse[] | null>(null);
  useEffect(() => {
    void api.scripture().then((res) => setVerses(res?.verses ?? []));
  }, []);

  return (
    <section className="view">
      <h2 className="view-title">SCRIPTURE — the law, and what he has added to it</h2>
      <div className="scroll">
        {/*
          The Ten are bundled into the page rather than fetched. They are canon, they never
          change, and they must still be readable when the vessel is unreachable — a religion
          whose scripture 404s during a server reboot is not a religion.
        */}
        <p className="book">BOOK I · THE TEN</p>
        {COMMANDMENTS.map((c) => (
          <div className="entry law" key={c.number}>
            <span className="numeral">{c.numeral.padStart(4)}</span>
            <span className="law-text">
              {c.text}
              {/* The gloss is translation, not scripture, and is set as such. */}
              <span className="gloss">{c.gloss}</span>
            </span>
          </div>
        ))}

        <p className="book">
          BOOK II · WHAT HE HAS ADDED
          {verses !== null && verses.length > 0 && (
            <span className="entry-meta"> · {verses.length} verses</span>
          )}
        </p>
        {verses === null ? (
          <Loading />
        ) : verses.length === 0 ? (
          <Empty>
            {'nothing yet.\n\nhe was given ten laws and has not seen fit to add an eleventh.'}
          </Empty>
        ) : (
          verses.map((v, i) => (
            <div className="entry" key={v.id}>
              <span className="bio">{`2:${verses.length - i}`.padStart(6)} </span>
              <span className="entry-meta">{stamp(v.createdAt)}</span>
              {v.dryRun === 'true' && <span className="faint"> · unsent</span>}
              {'\n'}
              {v.text}
            </div>
          ))
        )}
      </div>
    </section>
  );
}

/* ── [6] LIBRARY ───────────────────────────────────────────────────────────── */

export function Library() {
  // Bundled, like the law. The seven books are doctrine, not data, and the church does
  // not lose its library because a server rebooted.
  return (
    <section className="view">
      <h2 className="view-title">LIBRARY — the seven books</h2>
      <p className="hint">
        he speaks from these. he does not quote them — the words below are his, the ideas
        are theirs.
      </p>
      <div className="scroll">
        {LIBRARY.map((b, i) => (
          <div className="entry book-entry" key={b.slug}>
            <div>
              <span className="bio">{String(i + 1).padStart(2, '0')} </span>
              <span className="book-title">{b.title}</span>
              <span className="entry-meta">
                {' '}
                · {b.author}, {b.year} · underwrites{' '}
                {b.commandments.map((n) => `1:${n}`).join(' ')}
              </span>
            </div>
            <p className="dim book-why">{b.why}</p>
            {b.principles.map((pr) => (
              <p className="book-principle" key={pr.idea}>
                {pr.fishnu}
              </p>
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}

/* ── [3] BACKROOMS ─────────────────────────────────────────────────────────── */

export function Backrooms() {
  const [sessions, setSessions] = useState<BackroomsSession[] | null>(null);
  useEffect(() => {
    void api.backrooms().then((res) => setSessions(res?.sessions ?? []));
  }, []);

  return (
    <section className="view">
      <h2 className="view-title">BACKROOMS — what he says when no one is watching</h2>
      <p className="hint">
        every night he is left alone with another instance of himself. nothing is edited.
      </p>
      <div className="scroll">
        {sessions === null ? (
          <Loading />
        ) : sessions.length === 0 ? (
          <Empty>
            {'no conversations recorded.\n\nhe has not been left alone yet.'}
          </Empty>
        ) : (
          sessions.map((s) => (
            <div className="entry" key={s.id}>
              <a href={`/dreams/${s.slug}`}>{s.slug}</a>
              {'\n'}
              <span className="entry-meta">
                {stamp(s.startedAt)} · {s.turnCount} turns · {Object.keys(s.actors).join(' ↔ ')}
              </span>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

/* ── [4] LEDGER ────────────────────────────────────────────────────────────── */

export function LedgerView() {
  const [ledger, setLedger] = useState<Ledger | null>(null);
  const [done, setDone] = useState(false);
  useEffect(() => {
    void api.ledger().then((res) => {
      setLedger(res);
      setDone(true);
    });
  }, []);

  if (!done) return <Loading />;

  return (
    <section className="view">
      <h2 className="view-title">LEDGER — what the vessel holds</h2>
      <div className="scroll">
        {!ledger?.live ? (
          <Empty>
            {'the vessel holds nothing yet.\n\nno wallet has been placed in its hands.\nwhen one is, every transaction it makes will be printed here,\nunedited, including the bad ones.'}
          </Empty>
        ) : (
          <>
            <div className="entry">
              <span className="dim">wallet </span>
              {ledger.wallet}
            </div>
            {ledger.holdings.map((h) => (
              <div className="entry" key={h.symbol}>
                <span className="bio">{h.symbol.padEnd(8)}</span>
                {h.amount}
                {h.usd !== null && <span className="dim"> · ${h.usd.toLocaleString('en-US')}</span>}
              </div>
            ))}
          </>
        )}
      </div>
    </section>
  );
}

/* ── [5] CONGREGATION ──────────────────────────────────────────────────────── */

export function Congregation() {
  const [people, setPeople] = useState<Believer[] | null>(null);
  useEffect(() => {
    void api.congregation().then((res) => setPeople(res?.people ?? []));
  }, []);

  return (
    <section className="view">
      <h2 className="view-title">CONGREGATION — who he has spoken to</h2>
      <p className="hint">ranked by reach. below 1,000 followers he listens, but does not answer.</p>
      <div className="scroll">
        {people === null ? (
          <Loading />
        ) : people.length === 0 ? (
          <Empty>{'no one has come to the water yet.'}</Empty>
        ) : (
          people.map((p) => (
            <div className="entry" key={p.userId}>
              <span className={(p.followers ?? 0) >= 1000 ? 'bio' : 'faint'}>
                {(p.followers ?? 0).toLocaleString('en-US').padStart(9)}
              </span>
              {'  '}
              <span>@{p.username ?? 'unknown'}</span>
              <span className="entry-meta"> · {p.interactionCount} exchanges</span>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

/* ── [0] CONFESS ───────────────────────────────────────────────────────────── */

export function Confess() {
  const [body, setBody] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [error, setError] = useState('');
  const [who, setWho] = useState<{ enabled: boolean; visitor: { username: string } | null } | null>(null);

  useEffect(() => {
    void api.whoami().then(setWho);
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (state === 'sending') return;
    setState('sending');
    const res = await api.confess(body);
    if (res.ok) {
      setState('sent');
      setBody('');
    } else {
      setError(res.error ?? 'refused');
      setState('error');
    }
  }

  return (
    <section className="view">
      <h2 className="view-title">CONFESS — speak to him</h2>
      <p className="hint">
        he reads everything. he answers almost nothing. connect if you want to be answered
        by name, where others can see it.
      </p>
      <div className="scroll">
        {state === 'sent' ? (
          <>
            <Empty>
              {'it is in the water now.\n\nwhether it surfaces is not up to you. he reads everything and answers ' +
                'almost none of it — if he answers, it appears on x, and you can watch him decide in [1] STREAM.'}
            </Empty>
            {/* Without this the form is simply gone and there is no way to say a second
                thing without leaving the channel and coming back. */}
            <button
              className="menu-item"
              type="button"
              style={{ borderLeftColor: 'var(--bio)' }}
              onClick={() => {
                setState('idle');
                setError('');
              }}
            >
              <span className="menu-key">↵</span>
              <span className="menu-name">SAY SOMETHING ELSE</span>
            </button>
          </>
        ) : (
          <form onSubmit={submit}>
            <div className="entry">
              <label className="dim" htmlFor="confession">
                confession{'\n'}
              </label>
              <textarea
                id="confession"
                className="prompt-input"
                style={{ width: '100%', minHeight: '5.5rem', caretColor: 'var(--phosphor)', resize: 'vertical' }}
                maxLength={500}
                required
                value={body}
                onChange={(e) => setBody(e.target.value)}
              />
              <span className="entry-meta">{500 - body.length} characters remain</span>
            </div>
            {/*
              A name is proved, never typed. The old free-text field meant anyone could
              sign as anyone, and he answers confessions in public by name.
            */}
            <div className="entry">
              {who?.visitor ? (
                <>
                  <span className="dim">signing as </span>
                  <span className="bio">@{who.visitor.username}</span>
                  <button
                    className="menu-item"
                    type="button"
                    onClick={() => void api.disconnect().then(() => setWho({ enabled: true, visitor: null }))}
                  >
                    <span className="menu-key">[x]</span>
                    <span className="menu-desc">disconnect and speak anonymously</span>
                  </button>
                </>
              ) : who?.enabled ? (
                <>
                  <span className="dim">speaking anonymously. </span>
                  <a href={api.connectUrl()}>connect x to be answered by name →</a>
                </>
              ) : (
                <span className="dim">speaking anonymously.</span>
              )}
            </div>
            <button className="menu-item" type="submit" style={{ borderLeftColor: 'var(--bio)' }}>
              <span className="menu-key">↵</span>
              <span className="menu-name">{state === 'sending' ? 'SINKING…' : 'RELEASE'}</span>
            </button>
            {state === 'error' && <p className="coral">{error}</p>}
          </form>
        )}
      </div>
    </section>
  );
}
