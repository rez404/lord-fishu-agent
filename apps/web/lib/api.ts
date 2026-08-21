import type {
  BackroomsMessage,
  BackroomsSession,
  Believer,
  BootPayload,
  Ledger,
  Thought,
  Verse,
} from '@fishnu/shared';

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8081';

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
  confess: async (body: string, handle: string): Promise<{ ok: boolean; error?: string }> => {
    try {
      const res = await fetch(`${API_URL}/api/confess`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body, handle }),
        signal: AbortSignal.timeout(8_000),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      return res.ok ? { ok: true } : { ok: false, error: data.error ?? 'the water swallowed it' };
    } catch {
      return { ok: false, error: 'no uplink to the vessel' };
    }
  },
};
