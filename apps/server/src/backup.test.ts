import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'supops-bak-')), 'test.db');
process.env.SUPOPS_MASTER_KEY = randomBytes(32).toString('base64');
process.env.LLM_BASE_URL = 'http://127.0.0.1:9/';

const Database = (await import('better-sqlite3')).default;
const { db } = await import('./context.ts');
const { projects, DEFAULT_RISK_POLICY } = await import('@supops/db');
const { backupNow, listBackups } = await import('./backup.ts');

test('a backup is a complete, readable copy; only the newest are kept', async () => {
  db.insert(projects).values({ slug: 'bak', name: 'Backed up', riskPolicy: DEFAULT_RISK_POLICY, createdAt: new Date() }).run();
  const dir = mkdtempSync(join(tmpdir(), 'supops-bak-out-'));
  const s = { dir, everyHours: 24, keep: 2 };
  const first = await backupNow(s);
  await backupNow(s);
  await backupNow(s);
  const kept = listBackups(dir);
  assert.equal(kept.length, 2, 'the oldest is pruned');
  assert.ok(!kept.some((b) => join(dir, b.file) === first.file));
  const copy = new Database(join(dir, kept[0]!.file), { readonly: true });
  assert.equal((copy.prepare("select name from projects where slug = 'bak'").get() as { name: string }).name, 'Backed up');
  copy.close();
});
