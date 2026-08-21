'use client';

import type { BootPayload } from '@fishnu/shared';

export function StatusBar({
  boot,
  uptime,
  connected,
}: {
  boot: BootPayload | null;
  uptime: string;
  connected: boolean;
}) {
  return (
    <footer className="statusbar">
      <span>
        vessel <b>@{boot?.vessel ?? 'lordfishnu'}</b>
      </span>
      <span>
        awake <b>{uptime}</b>
      </span>
      <span>
        scripture <b>{boot ? boot.counts.verses.toLocaleString('en-US') : '—'}</b>
      </span>
      <span>
        congregation <b>{boot ? boot.counts.congregation.toLocaleString('en-US') : '—'}</b>
      </span>
      <span>
        uplink {boot ? <b>open</b> : <b className="sev">severed</b>}
        {connected && <b> · streaming</b>}
      </span>
    </footer>
  );
}
