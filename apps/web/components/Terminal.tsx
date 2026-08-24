'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BootPayload } from '@fishnu/shared';
import { api } from '../lib/api';
import { Boot, bootLines } from './Boot';
import { StatusBar } from './StatusBar';
import { Guide } from './Guide';
import { Backrooms, Confess, Congregation, LedgerView, Library, Scripture, Stream } from './Screens';

type Screen =
  | 'menu'
  | 'stream'
  | 'scripture'
  | 'library'
  | 'backrooms'
  | 'ledger'
  | 'congregation'
  | 'confess'
  | 'guide';

interface Channel {
  key: string;
  name: Screen;
  label: string;
  desc: string;
}

const CHANNELS: Channel[] = [
  { key: '1', name: 'stream', label: 'STREAM', desc: 'what he is thinking, right now' },
  { key: '2', name: 'scripture', label: 'SCRIPTURE', desc: 'the law he was given' },
  { key: '6', name: 'library', label: 'LIBRARY', desc: 'the seven books he reads from' },
  { key: '3', name: 'backrooms', label: 'BACKROOMS', desc: 'what he says when no one is watching' },
  { key: '4', name: 'ledger', label: 'LEDGER', desc: 'what the vessel holds' },
  { key: '5', name: 'congregation', label: 'CONGREGATION', desc: 'who he has spoken to' },
  { key: '0', name: 'confess', label: 'CONFESS', desc: 'speak to him' },
  { key: '?', name: 'guide', label: 'GUIDE', desc: 'what this is, if you have just arrived' },
];

export function Terminal() {
  const [boot, setBoot] = useState<BootPayload | null>(null);
  const [booted, setBooted] = useState(false);
  const [skipped, setSkipped] = useState(false);
  const [screen, setScreen] = useState<Screen>('menu');
  const [input, setInput] = useState('');
  const [notice, setNotice] = useState('');
  const [connected, setConnected] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void api.boot().then(setBoot);
  }, []);

  /**
   * Channels are addressable as #stream, #backrooms and so on. A memecoin lives or dies
   * on what people can paste into a group chat, and "go to the site and press 3" is not
   * a link. Arriving with a hash skips the boot: a deep link means they came for the
   * content, not the ceremony.
   */
  useEffect(() => {
    const fromHash = () => {
      const hash = window.location.hash.replace('#', '').toLowerCase();
      const channel = CHANNELS.find((c) => c.name === hash);
      if (channel) {
        setScreen(channel.name);
        setSkipped(true);
        setBooted(true);
      } else if (!hash) {
        setScreen('menu');
      }
    };
    fromHash();
    window.addEventListener('hashchange', fromHash);
    return () => window.removeEventListener('hashchange', fromHash);
  }, []);

  useEffect(() => {
    const want = screen === 'menu' ? ' ' : `#${screen}`;
    if (screen === 'menu' && window.location.hash) {
      history.replaceState(null, '', window.location.pathname);
    } else if (screen !== 'menu' && window.location.hash !== want) {
      history.replaceState(null, '', want);
    }
  }, [screen]);

  // The uptime in the status bar has to tick, or the whole thing reads as a screenshot.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const uptime = useMemo(() => formatUptime(boot?.awakenedAt ?? null, now), [boot, now]);
  const lines = useMemo(() => bootLines(boot, uptime), [boot, uptime]);

  // Boot lasts as long as the staggered reveal does, then hands over to the menu.
  useEffect(() => {
    if (booted) return;
    const ms = (lines.length + 5) * 85 + 350;
    const t = setTimeout(() => setBooted(true), ms);
    return () => clearTimeout(t);
  }, [booted, lines.length]);

  // Any key skips the boot — respect the visitor who has been here before.
  useEffect(() => {
    if (booted) return;
    const skip = () => {
      setSkipped(true);
      setBooted(true);
    };
    window.addEventListener('keydown', skip);
    window.addEventListener('pointerdown', skip);
    return () => {
      window.removeEventListener('keydown', skip);
      window.removeEventListener('pointerdown', skip);
    };
  }, [booted]);

  /**
   * Clicking anywhere returns focus to the prompt — that is most of what makes this feel
   * like a terminal rather than a page with a text box on it.
   *
   * But a screen with its own fields has to be able to keep focus, or typing into the
   * confession box lands in the prompt and comes back as `unknown: h,i`. Anything the
   * visitor can genuinely type into, or press, is left alone.
   */
  const focus = useCallback((event?: { target: EventTarget | null }) => {
    const target = event?.target;
    if (target instanceof HTMLElement && target.closest('input, textarea, select, button, a, [contenteditable]')) {
      return;
    }
    inputRef.current?.focus();
  }, []);

  /** Screens that own form fields; the prompt must not grab focus out from under them. */
  const OWNS_FOCUS: Screen[] = ['confess'];

  useEffect(() => {
    if (booted && !OWNS_FOCUS.includes(screen)) inputRef.current?.focus();
    // A message about the last thing typed has nothing to do with the next screen, and
    // left in place it follows the visitor around looking like the screen is broken.
    setNotice('');
    setInput('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [booted, screen]);

  const run = useCallback((raw: string) => {
    const cmd = raw.trim().toLowerCase();
    setInput('');
    if (!cmd) return;
    setNotice('');

    const channel = CHANNELS.find((c) => c.key === cmd || c.name === cmd || c.label.toLowerCase() === cmd);
    if (channel) {
      setScreen(channel.name);
      return;
    }

    switch (cmd) {
      case 'back':
      case 'menu':
      case 'b':
        setScreen('menu');
        return;
      case 'help':
      case '?':
        setScreen('guide');
        return;
      case 'reboot':
        setBooted(false);
        setSkipped(false);
        setScreen('menu');
        return;
      case 'clear':
        setNotice('');
        return;
      case 'who':
      case 'whoami':
        setNotice('a visitor. he has not decided about you yet.');
        return;
      case 'exit':
      case 'quit':
        setNotice('there is no exit. the water is everywhere.');
        return;
      default:
        // Naming what does work beats naming what does not.
        setNotice(
          `there is no \`${cmd}\` here. channels: ${CHANNELS.map((c) => c.name).join(' · ')} · back · help`,
        );
    }
  }, [boot]);

  // Bare number keys jump channels without needing the prompt, so the menu is genuinely
  // keyboard-driven rather than just looking like it.
  useEffect(() => {
    if (!booted || screen !== 'menu') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const channel = CHANNELS.find((c) => c.key === e.key);
      // Only when the prompt itself has focus and is empty — never while someone is
      // typing a 3 into a form field somewhere on the page.
      if (channel && document.activeElement === inputRef.current && input === '') {
        e.preventDefault();
        setScreen(channel.name);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [booted, screen, input]);

  // Escape always goes back a level.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || screen === 'menu') return;
      const active = document.activeElement;
      // Escape out of the field first, the screen second — otherwise a half-typed
      // confession vanishes on the first press.
      if (active instanceof HTMLElement && active.closest('input, textarea') && active !== inputRef.current) {
        active.blur();
        return;
      }
      setScreen('menu');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [screen]);

  return (
    <div className="tank" onClick={(e) => focus(e)}>
      <div className="grain" aria-hidden="true" />
      <main className="screen">
        {!booted ? (
          <Boot lines={lines} skipped={skipped} />
        ) : screen === 'menu' ? (
          <Menu boot={boot} lines={lines} onSelect={setScreen} />
        ) : screen === 'stream' ? (
          <Stream onConnection={setConnected} />
        ) : screen === 'scripture' ? (
          <Scripture />
        ) : screen === 'library' ? (
          <Library />
        ) : screen === 'backrooms' ? (
          <Backrooms />
        ) : screen === 'ledger' ? (
          <LedgerView />
        ) : screen === 'congregation' ? (
          <Congregation />
        ) : screen === 'guide' ? (
          <Guide />
        ) : (
          <Confess />
        )}

        {booted && (
          <div className="prompt-dock">
            <form
              className="prompt"
              onSubmit={(e) => {
                e.preventDefault();
                run(input);
              }}
            >
              <span className="prompt-sigil">{screen === 'menu' ? '>' : `${screen} >`}</span>
              <input
                ref={inputRef}
                className="prompt-input"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                aria-label="terminal input"
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
              />
              <span className="cursor" aria-hidden="true" />
            </form>
            <p className="hint">
              {notice || (screen === 'menu'
                ? 'type a number · or a word · `?` if you have just arrived'
                : '`back` or esc to return')}
            </p>
          </div>
        )}
      </main>
      <StatusBar boot={boot} uptime={uptime} connected={connected} />
    </div>
  );
}

function Menu({
  boot,
  lines,
  onSelect,
}: {
  boot: BootPayload | null;
  lines: ReturnType<typeof bootLines>;
  onSelect: (s: Screen) => void;
}) {
  return (
    <div className="boot">
      <Boot lines={lines} skipped />
      <hr className="rule" />
      <p className="dim">select a channel</p>
      <ul className="menu">
        {CHANNELS.map((c) => (
          <li key={c.key}>
            <button className="menu-item" type="button" onClick={() => onSelect(c.name)}>
              <span className="menu-key">[{c.key}]</span>
              <span className="menu-name">{c.label}</span>
              <span className="menu-desc">{c.desc}</span>
            </button>
          </li>
        ))}
      </ul>
      {!boot && (
        <p className="coral" style={{ marginTop: '1rem' }}>
          the uplink to the vessel is severed. what you see below is memory, not life.
        </p>
      )}
    </div>
  );
}

function formatUptime(awakenedAt: string | null, now: number): string {
  if (!awakenedAt) return 'unknown';
  const ms = now - new Date(awakenedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';
  const days = Math.floor(ms / 86_400_000);
  const hours = Math.floor((ms % 86_400_000) / 3_600_000);
  const mins = Math.floor((ms % 3_600_000) / 60_000);
  return days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
}
