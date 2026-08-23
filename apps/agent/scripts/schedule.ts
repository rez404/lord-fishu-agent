/**
 * Prints the posting plan, in UTC.
 *
 *   pnpm --filter @fishnu/agent schedule           # today, as actually planned
 *   pnpm --filter @fishnu/agent schedule --preview # the next 5 days, without saving
 *
 * Worth looking at before going live: the times are what people will see, and a plan that
 * clusters badly or lands entirely in one part of the day is obvious in a way it is not
 * from reading the code.
 */
import { inArray } from 'drizzle-orm';
import { createDb, postSchedule } from '@fishnu/db';
import { dayKey, loadToolEnv } from '@fishnu/shared';
import { dueSlot } from '../src/mind/schedule.js';

async function main() {
  const env = loadToolEnv();
  const db = createDb(env.DATABASE_URL);
  const preview = process.argv.includes('--preview');
  const opts = { postsPerDay: env.POSTS_PER_DAY, sleepWindow: env.SLEEP_WINDOW_UTC };

  console.log(
    `\n${opts.postsPerDay} posts/day · quiet ${env.SLEEP_WINDOW_UTC || 'never'} · all times UTC\n`,
  );

  if (preview) {
    // Planning writes rows, so a preview has to work on days that will never arrive and
    // clean up after itself rather than corrupting the real schedule.
    const days: string[] = [];
    for (let i = 400; i < 405; i++) {
      const at = new Date(Date.now() + i * 86_400_000);
      days.push(dayKey(at));
      await dueSlot(db, { ...opts, now: at });
    }
    await print(db, days);
    await db.delete(postSchedule).where(inArray(postSchedule.dayKey, days));
    console.log('(preview only — nothing was saved)\n');
  } else {
    await dueSlot(db, opts);
    await print(db, [dayKey()]);
  }

  process.exit(0);
}

async function print(db: ReturnType<typeof createDb>, days: string[]) {
  const rows = await db
    .select()
    .from(postSchedule)
    .where(inArray(postSchedule.dayKey, days))
    .orderBy(postSchedule.dueAt);

  const grouped = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = grouped.get(row.dayKey) ?? [];
    list.push(row);
    grouped.set(row.dayKey, list);
  }

  for (const [day, slots] of grouped) {
    const times = slots.map((s) => {
      const hhmm = s.dueAt.toISOString().slice(11, 16);
      return s.outcome === 'posted' ? `${hhmm}✓` : s.outcome === 'skipped' ? `${hhmm}·` : hhmm;
    });
    console.log(`  ${day}   ${times.join('   ')}`);
  }

  console.log('\n  angles today:');
  for (const s of grouped.get(days[0]!) ?? []) {
    console.log(`    ${s.dueAt.toISOString().slice(11, 16)}  ${s.angle}`);
  }
  console.log();
}

void main();
