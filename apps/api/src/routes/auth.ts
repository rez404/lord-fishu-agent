import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type Redis from 'ioredis';

/**
 * "Connect X" — verifying who someone is before their words carry their name.
 *
 * The confession box used to take a handle as free text, which meant anyone could sign as
 * anyone. A public reply addressed to a person who never wrote in is not a small problem:
 * it is the agent putting words in a stranger's mouth, at scale, in front of an audience.
 *
 * OAuth 2.0 with PKCE, and deliberately nothing more. We ask for the narrowest scope that
 * establishes identity, use the token once to read the account name, and throw it away —
 * we never store it and never act on anyone's behalf. What survives is a signed cookie
 * saying "this browser proved it is @someone", valid for a day.
 */

const SESSION_COOKIE = 'fishnu_visitor';
const SESSION_TTL_SECONDS = 24 * 60 * 60;
const PKCE_TTL_SECONDS = 10 * 60;
const SCOPES = 'users.read tweet.read';

export interface Visitor {
  id: string;
  username: string;
}

export interface AuthConfig {
  clientId: string | null;
  clientSecret: string | null;
  callbackUrl: string | null;
  siteUrl: string;
  sessionSecret: string | null;
  redis: Redis | null;
}

export function readVisitor(cookieHeader: string | undefined, secret: string | null): Visitor | null {
  if (!secret || !cookieHeader) return null;
  const raw = cookieHeader
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1);
  if (!raw) return null;
  return verifySession(decodeURIComponent(raw), secret);
}

export async function registerAuthRoutes(app: FastifyInstance, config: AuthConfig) {
  const enabled = Boolean(config.clientId && config.clientSecret && config.callbackUrl && config.sessionSecret && config.redis);

  app.get('/auth/x/status', async (req) => {
    const visitor = readVisitor(req.headers.cookie, config.sessionSecret);
    return { enabled, visitor };
  });

  app.get('/auth/x/start', async (_req, reply) => {
    if (!enabled) return reply.code(503).send({ error: 'connecting is not configured' });

    // PKCE: the verifier never leaves this server, so an intercepted code is useless.
    const verifier = randomBytes(48).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const state = randomBytes(24).toString('base64url');

    await config.redis!.setex(`fishnu:pkce:${state}`, PKCE_TTL_SECONDS, verifier);

    const url = new URL('https://twitter.com/i/oauth2/authorize');
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', config.clientId!);
    url.searchParams.set('redirect_uri', config.callbackUrl!);
    url.searchParams.set('scope', SCOPES);
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');

    return reply.redirect(url.toString());
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    '/auth/x/callback',
    async (req, reply) => {
      const back = (status: string) => reply.redirect(`${config.siteUrl}/#confess?x=${status}`);

      if (!enabled) return back('unconfigured');
      if (req.query.error || !req.query.code || !req.query.state) return back('denied');

      // Single use: consuming the verifier here means a replayed callback finds nothing.
      const key = `fishnu:pkce:${req.query.state}`;
      const verifier = await config.redis!.get(key);
      await config.redis!.del(key);
      if (!verifier) return back('expired');

      try {
        const token = await exchange(config, req.query.code, verifier);
        const me = await fetchMe(token);
        // The access token has done its only job. It is not stored anywhere.
        const cookie = signSession({ id: me.id, username: me.username }, config.sessionSecret!);

        reply.header(
          'set-cookie',
          `${SESSION_COOKIE}=${encodeURIComponent(cookie)}; Path=/; Max-Age=${SESSION_TTL_SECONDS}; ` +
            `HttpOnly; Secure; SameSite=None`,
        );
        return back('connected');
      } catch (err) {
        app.log.error({ err }, 'x oauth callback failed');
        return back('failed');
      }
    },
  );

  app.post('/auth/x/logout', async (_req, reply) => {
    reply.header('set-cookie', `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=None`);
    return { ok: true };
  });
}

async function exchange(config: AuthConfig, code: string, verifier: string): Promise<string> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.callbackUrl!,
    code_verifier: verifier,
    client_id: config.clientId!,
  });

  const res = await fetch('https://api.twitter.com/2/oauth2/token', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      // Confidential client: X requires basic auth as well as client_id in the body.
      authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`,
    },
    body,
  });

  if (!res.ok) throw new Error(`token exchange failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) throw new Error('no access token in response');
  return json.access_token;
}

async function fetchMe(token: string): Promise<{ id: string; username: string }> {
  const res = await fetch('https://api.twitter.com/2/users/me', {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`users/me failed: ${res.status}`);
  const json = (await res.json()) as { data?: { id: string; username: string } };
  if (!json.data) throw new Error('no user in response');
  return json.data;
}

function signSession(visitor: Visitor, secret: string): string {
  const payload = Buffer.from(
    JSON.stringify({ ...visitor, exp: Date.now() + SESSION_TTL_SECONDS * 1000 }),
  ).toString('base64url');
  const sig = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifySession(value: string, secret: string): Visitor | null {
  const [payload, sig] = value.split('.');
  if (!payload || !sig) return null;

  const expected = createHmac('sha256', secret).update(payload).digest('base64url');
  // Constant time, and length-checked first so the comparison never throws on a short forgery.
  if (sig.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;

  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Visitor & { exp: number };
    if (!parsed.exp || parsed.exp < Date.now()) return null;
    return { id: parsed.id, username: parsed.username };
  } catch {
    return null;
  }
}
