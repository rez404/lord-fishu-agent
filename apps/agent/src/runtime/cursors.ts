import { eq } from 'drizzle-orm';
import type { Db } from '@fishnu/db';
import { cursors } from '@fishnu/db';

/** Resumable read positions (mentions since_id, per-query search cursors, ...). */
export class CursorStore {
  constructor(private readonly db: Db) {}

  async get(key: string): Promise<string | undefined> {
    const [row] = await this.db.select().from(cursors).where(eq(cursors.key, key)).limit(1);
    return row?.value;
  }

  async set(key: string, value: string): Promise<void> {
    await this.db
      .insert(cursors)
      .values({ key, value, updatedAt: new Date() })
      .onConflictDoUpdate({ target: cursors.key, set: { value, updatedAt: new Date() } });
  }
}
