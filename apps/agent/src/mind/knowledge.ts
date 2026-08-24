import { eq } from 'drizzle-orm';
import type { Db } from '@fishnu/db';
import { settings } from '@fishnu/db';

export interface Contract {
  /** exactly as it must be reproduced — never shortened, never retyped */
  address: string;
  /** 'solana' | 'ethereum' | whatever the operator calls it */
  chain: string;
  /** what the thing is, e.g. 'FISHNU' */
  symbol: string;
}

export interface Knowledge {
  links: Array<{ label: string; url: string }>;
  facts: string;
  contract: Contract | null;
}

export const EMPTY_KNOWLEDGE: Knowledge = { links: [], facts: '', contract: null };

/**
 * Base58 (no 0/O/I/l) at Solana's length, or an EVM address.
 *
 * Used both to validate what the operator saves and to find anything address-shaped in a
 * draft — a model that produces a contract address on its own has produced a wrong one.
 */
export const ADDRESS_PATTERN = /\b(?:[1-9A-HJ-NP-Za-km-z]{32,44}|0x[a-fA-F0-9]{40})\b/g;

export function isAddress(value: string): boolean {
  ADDRESS_PATTERN.lastIndex = 0;
  const match = ADDRESS_PATTERN.exec(value.trim());
  return match !== null && match[0] === value.trim();
}

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

  const contract = value.contract as Partial<Contract> | null | undefined;

  return {
    links: Array.isArray(value.links)
      ? value.links.filter((l) => l && typeof l.label === 'string' && typeof l.url === 'string')
      : [],
    facts: typeof value.facts === 'string' ? value.facts : '',
    // Re-validated on read, not only on write: a row edited by hand in psql reaches his
    // mouth exactly like one saved through the console.
    contract:
      contract && typeof contract.address === 'string' && isAddress(contract.address)
        ? {
            address: contract.address.trim(),
            chain: typeof contract.chain === 'string' ? contract.chain : '',
            symbol: typeof contract.symbol === 'string' ? contract.symbol : '',
          }
        : null,
  };
}
