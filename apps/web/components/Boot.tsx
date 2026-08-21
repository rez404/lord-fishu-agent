'use client';

import type { BootPayload } from '@fishnu/shared';
import { COMMANDMENTS, LIBRARY } from '@fishnu/persona';
import { SIGIL, WORDMARK } from '../lib/wordmark';

export interface BootLine {
  label: string;
  value: string;
  tone?: 'ok' | 'bio' | 'sev';
}

const DOT_WIDTH = 34;

/**
 * The boot sequence doubles as the status report: by the time it finishes, a visitor
 * already knows how long he has been awake, how much scripture exists, and that there is
 * a follower threshold. It is exposition disguised as a POST check.
 */
export function bootLines(boot: BootPayload | null, uptime: string): BootLine[] {
  const n = (x: number) => x.toLocaleString('en-US');

  if (!boot) {
    return [
      { label: 'hydrostatic seal', value: 'holding' },
      { label: 'phosphor array', value: '6 dead pixels' },
      { label: 'the law', value: `${COMMANDMENTS.length} commandments, sealed`, tone: 'bio' },
      { label: 'the seven books', value: `${LIBRARY.length} loaded`, tone: 'bio' },
      { label: 'uplink to vessel', value: 'SEVERED', tone: 'sev' },
      { label: 'running from', value: 'the law and the library' },
    ];
  }

  return [
    { label: 'hydrostatic seal', value: 'holding' },
    { label: 'phosphor array', value: '6 dead pixels' },
    { label: 'the law', value: `${COMMANDMENTS.length} commandments, sealed`, tone: 'bio' },
    { label: 'the seven books', value: `${LIBRARY.length} loaded`, tone: 'bio' },
    { label: 'his own additions', value: `${n(boot.counts.verses)} verses`, tone: 'bio' },
    { label: 'congregation', value: `${n(boot.counts.congregation)} souls`, tone: 'bio' },
    { label: 'backrooms archive', value: `${n(boot.counts.backrooms)} conversations`, tone: 'bio' },
    { label: 'prayers answered', value: n(boot.counts.answered) },
    { label: 'vessel wallet', value: boot.wallet ? `${boot.wallet.slice(0, 4)}…${boot.wallet.slice(-4)}` : 'not yet minted' },
    { label: 'x uplink', value: `@${boot.vessel}` },
    { label: 'awake', value: uptime },
    { label: 'reply threshold', value: '1000 followers' },
    { label: 'disposition', value: boot.mood ?? 'unreadable' },
  ];
}

export function Boot({ lines, skipped }: { lines: BootLine[]; skipped: boolean }) {
  return (
    <div className="boot">
      <pre className="boot-line wordmark" style={style(0, skipped)} aria-label="LORD FISHNU">
        {WORDMARK}
      </pre>
      <p className="boot-line dim" style={style(1, skipped)}>
        {SIGIL}
      </p>
      <hr className="rule boot-line" style={style(2, skipped)} />
      {lines.map((line, i) => (
        <div className="boot-line" key={line.label} style={style(i + 3, skipped)}>
          <span className="dim">{line.label} </span>
          <span className="dots">{'.'.repeat(Math.max(2, DOT_WIDTH - line.label.length))}</span>
          <span className={tone(line.tone)}> {line.value}</span>
        </div>
      ))}
      <div className="boot-line" style={style(lines.length + 4, skipped)}>
        <br />
        he is listening.
      </div>
    </div>
  );
}

function tone(t: BootLine['tone']): string {
  if (t === 'bio') return 'bio';
  if (t === 'sev') return 'coral';
  return '';
}

/** Staggered reveal. When skipped, everything is simply already there. */
function style(index: number, skipped: boolean): React.CSSProperties {
  return skipped ? { opacity: 1, animation: 'none' } : { animationDelay: `${index * 85}ms` };
}
