import type {
  BackroomsMessage,
  BackroomsSession,
  Believer,
  BootPayload,
  Ledger,
  Thought,
  Verse,
} from '@fishnu/shared';

/**
 * `??` alone is not enough: an env var that is present but empty — which is what an
 * unfilled line in .env.local or a blank Vercel variable produces — is a string, not
 * undefined, so it would slip past the default and every request would go to a relative
 * path against the Vercel domain. That fails as a 404 on a page that otherwise looks
 * fine, which is the worst way for this to break.
 */
const configured = process.env.NEXT_PUBLIC_API_URL?.trim();
export const API_URL = configured && configured.length > 0 ? configured : 'http://localhost:8081';

/**
 * The site is deployed to Vercel independently of the agent box, so it has to survive
 * the backend being unreachable — during a redeploy, or before the agent exists at all.
 * Every call returns null rather than throwing, and the terminal reports the severed
 * uplink in character instead of showing an error page.
 */
async function get<T>(path: string, init?: RequestInit): Promise<T | null> {
  try {
    const res = await fetch(`${API_URL}${path}`, {
      ...init,
      // The visitor session is a cookie on the API's origin, so it only travels when
      // credentials are included explicitly on a cross-origin request.
      credentials: 'include',
      signal: AbortSignal.timeout(8_000),
      cache: 'no-store',
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export const api = {
  boot: () => get<BootPayload>('/api/boot'),
  thoughts: (limit = 60) => get<{ thoughts: Thought[] }>(`/api/thoughts?limit=${limit}`),
  scripture: (limit = 50) => get<{ verses: Verse[] }>(`/api/scripture?limit=${limit}`),
  backrooms: () => get<{ sessions: BackroomsSession[] }>('/api/backrooms'),
  transcript: (slug: string) =>
    get<{ session: BackroomsSession; messages: BackroomsMessage[] }>(`/api/backrooms/${slug}`),
  ledger: () => get<Ledger>('/api/ledger'),
  congregation: () => get<{ people: Believer[] }>('/api/congregation'),
  /** Who the browser has proved it is, if anyone. */
  whoami: () => get<{ enabled: boolean; visitor: { id: string; username: string } | null }>('/auth/x/status'),
  connectUrl: () => `${API_URL}/auth/x/start`,
  disconnect: () =>
    fetch(`${API_URL}/auth/x/logout`, { method: 'POST', credentials: 'include' }).catch(() => {}),

  /** How many are waiting, so the page can be honest about the odds. */
  confessQueue: () => get<{ waiting: number; answered: number }>('/api/confess'),

  confess: async (body: string): Promise<{ ok: boolean; error?: string }> => {
    try {
      const res = await fetch(`${API_URL}/api/confess`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ body }),
        signal: AbortSignal.timeout(8_000),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      return res.ok ? { ok: true } : { ok: false, error: data.error ?? 'the water swallowed it' };
    } catch {
      return { ok: false, error: 'no uplink to the vessel' };
    }
  },
};
