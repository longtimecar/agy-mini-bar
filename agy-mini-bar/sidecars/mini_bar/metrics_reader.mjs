import { DatabaseSync } from 'node:sqlite';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

/**
 * Resolve candidate Antigravity conversation directories from sidecar data dir or home.
 */
export function resolveConversationDirs(dataDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR) {
  if (dataDir) {
    const root = resolve(dataDir);
    for (let dir = root; dir !== dirname(dir); dir = dirname(dir)) {
      if (basename(dir) === 'sidecar_data') {
        return [join(dirname(dir), 'conversations')];
      }
    }
    return [join(root, 'conversations')];
  }
  return ['antigravity', 'antigravity-ide', 'antigravity-cli'].map(product =>
    join(homedir(), '.gemini', product, 'conversations'));
}

export function resolveConversationDb(convId, dirs = resolveConversationDirs()) {
  if (!convId || typeof convId !== 'string' || !/^[0-9a-zA-Z_-]+$/.test(convId)) {
    return null;
  }
  for (const dir of dirs) {
    const dbPath = join(dir, `${convId}.db`);
    if (statSync(dbPath, { throwIfNoEntry: false })?.isFile()) {
      return dbPath;
    }
  }
  return null;
}

export function findLatestConversationDb(dirs = resolveConversationDirs()) {
  let latest = null;
  let newest = -Infinity;
  for (const dir of dirs) {
    if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) continue;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.db')) continue;
      const dbPath = join(dir, file);
      const st = statSync(dbPath, { throwIfNoEntry: false });
      if (st?.isFile() && st.mtimeMs > newest) {
        newest = st.mtimeMs;
        latest = dbPath;
      }
    }
  }
  return latest;
}

function readVarint(buf, offset) {
  let val = 0n;
  let shift = 0n;
  let i = offset;
  while (i < buf.length && i - offset < 10) {
    const b = buf[i++];
    if (i - offset === 10 && b > 1) throw new RangeError('Invalid 64-bit protobuf varint');
    val |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) return [Number(val), i];
    shift += 7n;
  }
  throw new RangeError('Truncated protobuf varint');
}

export function parsePbMap(buf) {
  const fields = new Map();
  let i = 0;
  while (i < buf.length) {
    try {
      const [tag, nextI] = readVarint(buf, i);
      i = nextI;
      const fn = tag >>> 3;
      const wt = tag & 7;
      if (fn === 0) break;
      if (!fields.has(fn)) fields.set(fn, []);
      if (wt === 0) {
        const [val, nI] = readVarint(buf, i);
        i = nI;
        fields.get(fn).push(val);
      } else if (wt === 2) {
        const [len, nI] = readVarint(buf, i);
        i = nI;
        if (len < 0 || i + len > buf.length) break;
        fields.get(fn).push(buf.subarray(i, i + len));
        i += len;
      } else if (wt === 5) {
        if (i + 4 > buf.length) break;
        fields.get(fn).push(buf.subarray(i, i + 4));
        i += 4;
      } else if (wt === 1) {
        if (i + 8 > buf.length) break;
        fields.get(fn).push(buf.subarray(i, i + 8));
        i += 8;
      } else {
        break;
      }
    } catch {
      break;
    }
  }
  return fields;
}

function readDurationSec(map, field) {
  if (!map.has(field)) return null;
  const f = parsePbMap(map.get(field)[0]);
  return (f.get(1)?.[0] || 0) + (f.get(2)?.[0] || 0) / 1e9;
}

export function parseGenRow(idx, data) {
  if (!data || !Buffer.isBuffer(data)) data = Buffer.from(data || []);
  const top = parsePbMap(data);
  if (!top.has(1)) return null;

  const stepIndices = [];
  for (const val of top.get(2) || []) {
    if (typeof val === 'number') {
      stepIndices.push(val);
    } else {
      for (let off = 0; off < val.length;) {
        const [sIdx, next] = readVarint(val, off);
        stepIndices.push(sIdx);
        off = next;
      }
    }
  }

  const m1 = parsePbMap(top.get(1)[0]);
  const usage = m1.has(4) ? parsePbMap(m1.get(4)[0]) : new Map();

  const uncachedIn = usage.get(2)?.[0] || 0;
  const cachedIn = usage.get(5)?.[0] || 0;
  const contextTokens = uncachedIn + cachedIn;
  const thinkTokens = usage.get(9)?.[0] || 0;
  const outTokens = usage.get(10)?.[0] || 0;
  const totalOutput = usage.has(3) ? (usage.get(3)[0] || 0) : (thinkTokens + outTokens);

  const ttft = readDurationSec(m1, 11);
  const streaming = readDurationSec(m1, 12);
  const hasOutput = m1.has(4) && (usage.has(3) || (ttft !== null && streaming !== null));

  let maxContextTokens = 0;
  if (m1.has(9)) {
    const m9 = parsePbMap(m1.get(9)[0]);
    if (m9.has(10)) {
      const m10 = parsePbMap(m9.get(10)[0]);
      if (m10.has(4)) {
        maxContextTokens = m10.get(4)[0] || 0;
      }
    }
  }

  let lastStepIndex = -1;
  if (m1.has(20)) {
    for (const kvBuf of m1.get(20)) {
      const kv = parsePbMap(kvBuf);
      const key = kv.has(1) ? kv.get(1)[0].toString('utf8') : '';
      if (key === 'last_step_index' && kv.has(2)) {
        const n = Number(kv.get(2)[0].toString('utf8'));
        if (Number.isFinite(n)) lastStepIndex = n;
        break;
      }
    }
  }

  let hasError = false;
  const lastRetry = m1.get(17)?.at(-1);
  if (lastRetry) {
    const retryErr = parsePbMap(lastRetry).get(3)?.[0];
    if (Buffer.isBuffer(retryErr) && retryErr.length > 0) hasError = true;
  }

  return {
    idx,
    stepIndices,
    lastStepIndex,
    uncachedIn,
    cachedIn,
    contextTokens,
    thinkTokens,
    outTokens,
    totalOutput,
    maxContextTokens,
    ttft,
    streaming,
    hasOutput,
    hasError,
  };
}

/**
 * Read conversation metrics snapshot directly from local SQLite database.
 */
export function readMetricsFromDb(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  let turnsCount = 0;
  let stepsCount = 0;
  let rawRows = [];
  let cpRows = [];
  let lastStepEpochMs = 0;

  try {
    turnsCount = db.prepare('SELECT COUNT(*) AS c FROM steps WHERE step_type = 14').get()?.c || 0;
    stepsCount = db.prepare('SELECT COUNT(*) AS c FROM steps').get()?.c || 0;
    rawRows = db.prepare('SELECT idx, data FROM gen_metadata ORDER BY idx ASC').all();
    cpRows = db.prepare('SELECT idx FROM steps WHERE step_type = 23 ORDER BY idx DESC').all();

    const stepRow = db.prepare('SELECT metadata FROM steps ORDER BY idx DESC LIMIT 1').get();
    if (stepRow?.metadata) {
      const sm = parsePbMap(Buffer.from(stepRow.metadata));
      if (sm.has(1)) {
        const tsMap = parsePbMap(sm.get(1)[0]);
        if (tsMap.has(1)) lastStepEpochMs = Number(tsMap.get(1)[0]) * 1000;
      }
    }
  } finally {
    db.close();
  }

  if (!lastStepEpochMs) {
    const walPath = `${dbPath}-wal`;
    lastStepEpochMs = Math.max(
      statSync(dbPath, { throwIfNoEntry: false })?.mtimeMs || 0,
      existsSync(walPath) ? (statSync(walPath, { throwIfNoEntry: false })?.mtimeMs || 0) : 0,
    );
  }

  const parsed = [];
  const contextTurns = [];
  let maxContextTokens = 0;

  let sumInput = 0;
  let sumCached = 0;
  let sumUncached = 0;
  let sumThinking = 0;
  let sumReply = 0;
  let sumTotalOutput = 0;
  let requestCount = 0;

  for (const row of rawRows) {
    const item = parseGenRow(row.idx, row.data);
    if (!item) continue;
    parsed.push(item);

    if (item.maxContextTokens > 0) maxContextTokens = item.maxContextTokens;

    if (item.contextTokens > 0 || item.totalOutput > 0) {
      requestCount += 1;
      sumInput += item.contextTokens;
      sumCached += item.cachedIn;
      sumUncached += item.uncachedIn;
      sumThinking += item.thinkTokens;
      sumReply += item.outTokens;
      sumTotalOutput += item.totalOutput;
    }

    if (item.contextTokens > 0) {
      contextTurns.push(item);
    }
  }

  // Determine compaction epoch start for active context breakdown
  let epochStart = 0;
  if (contextTurns.length > 0) {
    for (const cp of cpRows) {
      const postIdx = contextTurns.findIndex(t => t.lastStepIndex >= cp.idx);
      if (postIdx >= 0) {
        epochStart = postIdx;
        break;
      }
    }
    for (let i = epochStart + 1; i < contextTurns.length; i++) {
      if (contextTurns[i].contextTokens < contextTurns[i - 1].contextTokens * 0.7) {
        epochStart = i;
      }
    }
  }

  const latestCtx = contextTurns[contextTurns.length - 1] || {
    uncachedIn: 0,
    cachedIn: 0,
    contextTokens: 0,
  };

  let rawOut = 0;
  let rawThink = 0;
  for (let i = epochStart; i < contextTurns.length - 1; i++) {
    rawOut += contextTurns[i].outTokens;
    rawThink += contextTurns[i].thinkTokens;
  }

  const used = latestCtx.contextTokens;
  const turn0 = Math.min(contextTurns[epochStart]?.contextTokens || 0, used);
  const availGen = Math.max(0, used - turn0);
  const genSum = rawOut + rawThink;
  const scale = genSum > availGen && genSum > 0 ? availGen / genSum : 1;
  const think = Math.round(rawThink * scale);
  const write = Math.round(rawOut * scale);
  const read = Math.max(0, used - turn0 - think - write);

  const pct = maxContextTokens > 0 ? Math.round((used / maxContextTokens) * 100) : 0;
  const cacheHitPct = used > 0 ? Math.round((latestCtx.cachedIn / used) * 100) : 0;

  // Latest completed generation speed
  let speed = null;
  for (let i = parsed.length - 1; i >= 0; i--) {
    const r = parsed[i];
    if (r.hasError || !r.hasOutput) continue;
    const ttft = r.ttft;
    const streaming = r.streaming;
    if (ttft === null || streaming === null) continue;
    const duration = ttft + streaming;
    if (duration <= 0 || r.totalOutput <= 0) continue;
    speed = {
      tps: r.totalOutput / duration,
      streamTps: streaming > 0 ? r.totalOutput / streaming : null,
      ttft,
      streaming,
      duration,
      output: r.totalOutput,
      thinking: r.thinkTokens,
      reply: r.outTokens,
    };
    break;
  }

  return {
    turnsCount,
    stepsCount,
    requestCount,
    lastStepEpochMs,
    sessionTotal: {
      total: sumInput + sumTotalOutput,
      input: sumInput,
      cached: sumCached,
      uncached: sumUncached,
      thinking: sumThinking,
      output: sumReply,
      totalOutput: sumTotalOutput,
    },
    context: {
      used,
      max: maxContextTokens,
      pct,
      cached: latestCtx.cachedIn,
      uncached: latestCtx.uncachedIn,
      cacheHitPct,
      turn0,
      read,
      think,
      write,
    },
    speed,
  };
}

/**
 * Create a lightweight mtime+size cached conversation metrics reader.
 */
export function createMetricsReader(dirs = resolveConversationDirs()) {
  const cache = new Map();

  return function readConversation(convId) {
    const dbPath = resolveConversationDb(convId, dirs);
    if (!dbPath) return null;

    const mainSt = statSync(dbPath, { throwIfNoEntry: false });
    if (!mainSt?.isFile()) return null;
    const walSt = statSync(`${dbPath}-wal`, { throwIfNoEntry: false });
    const sig = `${mainSt.mtimeMs}:${mainSt.size}:${walSt?.mtimeMs || 0}:${walSt?.size || 0}`;

    const hit = cache.get(dbPath);
    if (hit && hit.sig === sig) {
      return hit.data;
    }

    try {
      const data = readMetricsFromDb(dbPath);
      cache.set(dbPath, { sig, data });
      return data;
    } catch {
      return hit?.data || null;
    }
  };
}
