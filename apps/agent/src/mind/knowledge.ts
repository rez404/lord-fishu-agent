import { eq } from 'drizzle-orm';
import type { Db } from '@fishnu/db';
import { settings } from '@fishnu/db';

export interface Knowledge {
  links: Array<{ label: string; url: string }>;
  facts: string;
}

export const EMPTY_KNOWLEDGE: Knowledge = { links: [], facts: '' };

/**
 * The fixed things he knows: where the church lives, what the token is, anything the
 * operator wants him to have straight.
 *
 * Stored rather than compiled in, because it changes — a contract address arrives, a link
 * moves — and none of that should need a deployment.
 */
export async function loadKnowledge(db: Db): Promise<Knowledge> {
  const [row] = await db.select().from(settings).where(eq(settings.key, 'knowledge')).limit(1);
  const value = row?.value as Partial<Knowledge> | undefined;
  if (!value) return EMPTY_KNOWLEDGE;

  return {
    links: Array.isArray(value.links)
      ? value.links.filter((l) => l && typeof l.label === 'string' && typeof l.url === 'string')
      : [],
    facts: typeof value.facts === 'string' ? value.facts : '',
  };
}
