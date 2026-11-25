import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findLatestConversationDb, readMetricsFromDb } from '../agy-mini-bar/sidecars/mini_bar/metrics_reader.mjs';

function encodeVarint(n) {
  let v = BigInt(n);
  const out = [];
  while (v >= 0x80n) {
    out.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  out.push(Number(v));
  return Buffer.from(out);
}

function pbField(fn, wt, val) {
  const tag = encodeVarint((fn << 3) | wt);
  if (wt === 0) return Buffer.concat([tag, encodeVarint(val)]);
  if (wt === 2) return Buffer.concat([tag, encodeVarint(val.length), val]);
  throw new Error(`Unsupported wire type ${wt}`);
}

function makeDuration(sec) {
  const s = Math.floor(sec);
  const ns = Math.round((sec - s) * 1e9);
  return Buffer.concat([pbField(1, 0, s), pbField(2, 0, ns)]);
}

function makeGenRow({ uncachedIn, cachedIn, thinkTokens, outTokens, maxCtx, ttft, streaming, lastStep }) {
  const totalOut = thinkTokens + outTokens;
  const usage = Buffer.concat([
    pbField(2, 0, uncachedIn),
    pbField(3, 0, totalOut),
    pbField(5, 0, cachedIn),
    pbField(9, 0, thinkTokens),
    pbField(10, 0, outTokens),
  ]);
  const m10 = pbField(4, 0, maxCtx);
  const m9 = pbField(10, 2, m10);
  const kv = Buffer.concat([
    pbField(1, 2, Buffer.from('last_step_index')),
    pbField(2, 2, Buffer.from(String(lastStep))),
  ]);
  const m1 = Buffer.concat([
    pbField(4, 2, usage),
    pbField(9, 2, m9),
    pbField(11, 2, makeDuration(ttft)),
    pbField(12, 2, makeDuration(streaming)),
    pbField(20, 2, kv),
  ]);
  return Buffer.concat([pbField(1, 2, m1), pbField(2, 0, lastStep)]);
}

test('readMetricsFromDb parses synthetic protobuf and aggregates totals & context breakdown', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-mini-bar-test-'));
  const dbPath = join(dir, 'sample.db');
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB);');
    db.exec('CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);');

    db.prepare('INSERT INTO steps VALUES (1, 14, 3, NULL)').run();
    db.prepare('INSERT INTO steps VALUES (2, 15, 3, NULL)').run();
    db.prepare('INSERT INTO steps VALUES (3, 14, 3, NULL)').run();
    db.prepare('INSERT INTO steps VALUES (4, 15, 3, NULL)').run();
    db.prepare('INSERT INTO steps VALUES (5, 16, 3, NULL)').run();

    const row1 = makeGenRow({ uncachedIn: 2000, cachedIn: 8000, thinkTokens: 300, outTokens: 200, maxCtx: 512000, ttft: 1.0, streaming: 1.0, lastStep: 2 });
    const row2 = makeGenRow({ uncachedIn: 1000, cachedIn: 19000, thinkTokens: 400, outTokens: 600, maxCtx: 512000, ttft: 1.5, streaming: 2.5, lastStep: 4 });
    db.prepare('INSERT INTO gen_metadata VALUES (0, ?)').run(row1);
    db.prepare('INSERT INTO gen_metadata VALUES (1, ?)').run(row2);
  } finally {
    db.close();
  }

  try {
    const res = readMetricsFromDb(dbPath);
    assert.equal(res.turnsCount, 2);
    assert.equal(res.stepsCount, 5);
    assert.equal(res.requestCount, 2);

    assert.equal(res.context.used, 20000);
    assert.equal(res.context.max, 512000);
    assert.equal(res.context.pct, 4);
    assert.equal(res.context.cacheHitPct, 95);
    assert.equal(res.context.turn0, 10000);
    assert.equal(res.context.think, 300);
    assert.equal(res.context.write, 200);
    assert.equal(res.context.read, 9500);
    assert.equal(res.context.turn0 + res.context.read + res.context.think + res.context.write, res.context.used);

    // Total across both requests: (10000 + 500) + (20000 + 1000) = 31500
    assert.equal(res.sessionTotal.total, 31500);
    assert.equal(res.sessionTotal.input, 30000);
    assert.equal(res.sessionTotal.cached, 27000);
    assert.equal(res.sessionTotal.thinking, 700);
    assert.equal(res.sessionTotal.output, 800);

    assert.ok(res.speed);
    assert.equal(res.speed.output, 1000);
    assert.equal(res.speed.duration, 4);
    assert.equal(res.speed.tps, 250);
    assert.equal(res.speed.streamTps, 400);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readMetricsFromDb smoke test against local conversation DB if present', () => {
  const realDb = process.env.AGY_TEST_DB || findLatestConversationDb();
  if (!realDb || !existsSync(realDb)) return;

  const res = readMetricsFromDb(realDb);
  assert.ok(res.turnsCount >= 0);
  assert.ok(res.stepsCount >= res.turnsCount);
  assert.ok(res.context.max >= 0);
  assert.ok(res.context.used >= 0);
  assert.equal(res.context.turn0 + res.context.read + res.context.think + res.context.write, res.context.used);
  assert.ok(res.sessionTotal.total >= res.context.used);
  assert.ok(Number.isFinite(res.context.pct) && res.context.pct >= 0);
  assert.ok(Number.isFinite(res.context.cacheHitPct) && res.context.cacheHitPct >= 0 && res.context.cacheHitPct <= 100);
});
