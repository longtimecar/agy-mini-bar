import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

const INTERVAL_MS = 1000;
const INSTANCE_TS = Date.now();

export function getPortFilePath(env = process.env) {
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Antigravity', 'DevToolsActivePort');
  }
  if (process.platform === 'win32') {
    return join(env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Antigravity', 'DevToolsActivePort');
  }
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'Antigravity', 'DevToolsActivePort');
}

function resolveVerifiedOrigin(productRoots = [], env = process.env) {
  const address = env.ANTIGRAVITY_LS_ADDRESS;
  const match = /^(127\.0\.0\.1|localhost):([1-9]\d{0,4})$/.exec(address || '');
  if (!match) return null;
  for (const root of productRoots) {
    try {
      const hub = JSON.parse(readFileSync(join(root, 'daemon', `hub_${match[2]}.json`), 'utf8'));
      if (hub?.httpPort === Number(match[2]) && Number.isInteger(hub.httpsPort) && hub.httpsPort > 0 && hub.httpsPort <= 65535) {
        return new URL(`https://127.0.0.1:${hub.httpsPort}`).origin;
      }
    } catch {
      // Ignore missing hub file and check next root
    }
  }
  return null;
}

/**
 * In-page runtime injected into the Antigravity renderer via CDP.
 * Must stay completely self-contained (all helpers inside mountMiniBar).
 */
function mountMiniBar(ownerTs, bundleHash) {
  if (globalThis.__agyMiniBar?.owner > ownerTs) return 'superseded';
  if (globalThis.__agyMiniBar?.owner === ownerTs && globalThis.__agyMiniBar?.hash === bundleHash) {
    return true;
  }
  globalThis.__agyMiniBar?.dispose?.();

  const I18N = {
    zh: {
      turnUnit: '轮',
      stepUnit: '步',
      totalLabel: '总计',
      cacheLabel: '缓存命中',
      fiveHoursShort: '5h',
      weeklyShort: '周',
      fiveHoursFull: '5 小时额度',
      weeklyFull: '每周额度',
      speedTitle: '最近请求速度',
      streamSpeed: '纯吐字速度',
      e2eSpeed: '端到端速度',
      ttft: '首字延迟',
      streaming: '流式生成',
      duration: '总耗时',
      speedVal: '输出速度',
      thisOutput: '本次输出',
      thinkLabel: '思考',
      replyLabel: '回复',
      totalTitle: '本会话累计消耗',
      cumInput: '累计输入',
      cumCached: '缓存读取',
      cumThinking: '累计思考',
      cumReply: '累计输出',
      reqCount: '请求次数',
      ctxTitle: '当前上下文窗口',
      usedOf: '已用',
      turn0: '首轮输入',
      read: '读取上下文',
      think: '思考',
      write: '回复输出',
      quotaTitle: '模型剩余额度',
      resetIn: '后重置',
      resetUnknown: '重置时间未知',
      activePool: '当前',
      langBtn: '中',
      langTip: '点击切换为 English',
    },
    en: {
      turnUnit: ' turns',
      stepUnit: ' steps',
      totalLabel: 'Total',
      cacheLabel: 'Cache',
      fiveHoursShort: '5h',
      weeklyShort: 'Wk',
      fiveHoursFull: '5-Hour Limit',
      weeklyFull: 'Weekly Limit',
      speedTitle: 'Latest Request Speed',
      streamSpeed: 'Stream Speed',
      e2eSpeed: 'End-to-End',
      ttft: 'TTFT',
      streaming: 'Streaming',
      duration: 'Duration',
      speedVal: 'Speed',
      thisOutput: 'Output',
      thinkLabel: 'Think',
      replyLabel: 'Reply',
      totalTitle: 'Session Cumulative Usage',
      cumInput: 'Total Input',
      cumCached: 'Cached Read',
      cumThinking: 'Total Think',
      cumReply: 'Total Reply',
      reqCount: 'Requests',
      ctxTitle: 'Active Context Window',
      usedOf: 'Used',
      turn0: 'Initial',
      read: 'Read',
      think: 'Think',
      write: 'Write',
      quotaTitle: 'Model Quotas',
      resetIn: 'left',
      resetUnknown: 'Reset unknown',
      activePool: 'Active',
      langBtn: 'EN',
      langTip: 'Switch to 简体中文',
    },
  };

  const state = {
    owner: ownerTs,
    hash: bundleHash,
    data: null,
    path: location.pathname,
    pinnedKey: null,
    hoverKey: null,
    hideTimer: null,
    lang: (() => {
      try {
        const saved = localStorage.getItem('agy_mini_bar_lang');
        return saved === 'en' ? 'en' : 'zh';
      } catch {
        return 'zh';
      }
    })(),
  };

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const fmtTok = n => {
    const v = Number(n || 0);
    if (!Number.isFinite(v) || v <= 0) return '0';
    if (v >= 1_000_000) return (v / 1_000_000).toFixed(v >= 10_000_000 ? 1 : 2).replace(/\.0+$/, '').replace(/(\.\d)0$/, '$1') + 'M';
    if (v >= 1_000) return (v / 1_000).toFixed(v >= 100_000 ? 0 : 1).replace(/\.0$/, '') + 'K';
    return String(Math.round(v));
  };

  const fmtSec = s => {
    if (!Number.isFinite(s) || s < 0) return '--';
    return s >= 10 ? `${s.toFixed(1)}s` : `${s.toFixed(2)}s`;
  };

  const fmtReset = (iso, lang) => {
    if (!iso) return '';
    const ms = new Date(iso).getTime() - Date.now();
    if (!Number.isFinite(ms)) return '';
    if (ms <= 0) return lang === 'zh' ? '即将重置' : 'soon';
    const totalMin = Math.ceil(ms / 60_000);
    const d = Math.floor(totalMin / 1440);
    const h = Math.floor((totalMin % 1440) / 60);
    const m = totalMin % 60;
    if (lang === 'zh') {
      if (d > 0) return h > 0 ? `${d}天${h}时` : `${d}天`;
      if (h > 0) return m > 0 ? `${h}时${m}分` : `${h}时`;
      return `${m}分`;
    }
    if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
    if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
    return `${m}m`;
  };

  const findComposerBox = () => {
    let best = null;
    let bestWidth = 0;
    for (const el of document.querySelectorAll('[id="antigravity.agentSidePanelInputBox"], .surface-composer')) {
      if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      const r = el.getBoundingClientRect();
      if (r.height <= 0 || Math.min(r.bottom, window.innerHeight) <= Math.max(r.top, 0)) continue;
      const w = Math.min(r.right, window.innerWidth) - Math.max(r.left, 0);
      if (w > bestWidth) {
        best = el;
        bestWidth = w;
      }
    }
    return best;
  };

  const readActiveModelName = box => {
    const scope = box || document;
    const btn = scope.querySelector('button[data-testid="model-selector-trigger"]')
      || document.querySelector('.agy-composer-footer button[data-testid="model-selector-trigger"]');
    return (btn?.textContent || '').trim();
  };

  const matchActivePool = (groups = [], modelName = '') => {
    if (!groups.length) return null;
    const q = modelName.toLowerCase();
    if (q) {
      const token = q.split(/[\s()]+/).find(part => part.length >= 4 && !['gemini', 'model', 'high', 'medium', 'low', 'xhigh'].includes(part));
      if (token) {
        const byModel = groups.find(g => g.modelsInGroup?.includes(token) || g.rawName?.includes(token));
        if (byModel) return byModel;
      }
      if (q.includes('claude') || q.includes('gpt')) {
        const cg = groups.find(g => g.rawName?.includes('claude') || g.rawName?.includes('gpt'));
        if (cg) return cg;
      }
      if (q.includes('gemini') || q.includes('orchestrator')) {
        const gm = groups.find(g => g.rawName?.includes('gemini') && !g.rawName?.includes('argon'));
        if (gm) return gm;
      }
    }
    return groups[0];
  };

  const quotaColor = pct => (pct <= 10 ? '#ef4444' : pct <= 25 ? '#f59e0b' : '#10b981');
  const ctxColor = pct => (pct >= 90 ? '#ef4444' : pct >= 75 ? '#f59e0b' : 'currentColor');

  let host = document.getElementById('agy-mini-bar-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'agy-mini-bar-host';
    host.style.cssText = 'display:block;width:100%;position:relative;z-index:20;';
  }
  const shadow = host.shadowRoot || host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      :host { all: initial; display: block; width: 100%; }
      * { box-sizing: border-box; }
      .mb-wrap {
        position: relative;
        width: 100%;
        padding: 5px 10px 1px;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 14px;
        flex-wrap: wrap;
        font-family: "Segoe UI", "Microsoft YaHei UI", system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
        font-size: 11.5px;
        line-height: 16px;
        font-variant-numeric: tabular-nums;
        color: color-mix(in srgb, var(--foreground, #52525b) 60%, transparent);
        user-select: none;
      }
      .mb-seg {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        padding: 2px 6px;
        border-radius: 6px;
        cursor: pointer;
        transition: color 0.15s ease, background-color 0.15s ease;
        white-space: nowrap;
      }
      .mb-seg:hover, .mb-seg[data-active="true"] {
        color: var(--foreground, #18181b);
        background: color-mix(in srgb, var(--foreground, #71717a) 8%, transparent);
      }
      .mb-seg svg { width: 13px; height: 13px; flex-shrink: 0; opacity: 0.85; }
      .mb-dot { opacity: 0.45; margin: 0 1px; }
      .mb-lang {
        border: none;
        background: transparent;
        color: inherit;
        font: inherit;
        font-size: 10.5px;
        padding: 1px 5px;
        border-radius: 5px;
        opacity: 0.42;
        cursor: pointer;
        transition: opacity 0.15s ease, background-color 0.15s ease;
      }
      .mb-lang:hover {
        opacity: 0.95;
        background: color-mix(in srgb, var(--foreground, #71717a) 10%, transparent);
      }
      .mb-pop {
        position: fixed;
        z-index: 999999;
        min-width: 228px;
        max-width: min(320px, calc(100vw - 24px));
        padding: 10px 12px;
        border-radius: 12px;
        border: 1px solid color-mix(in srgb, var(--foreground, #71717a) 12%, transparent);
        background: color-mix(in srgb, var(--card, #ffffff) 94%, transparent);
        backdrop-filter: blur(18px);
        -webkit-backdrop-filter: blur(18px);
        box-shadow: 0 12px 32px -8px rgba(0, 0, 0, 0.22), 0 2px 8px rgba(0, 0, 0, 0.08);
        color: var(--foreground, #18181b);
        font-family: "Segoe UI", "Microsoft YaHei UI", system-ui, -apple-system, sans-serif;
        font-size: 12px;
        line-height: 1.45;
        font-variant-numeric: tabular-nums;
      }
      .mb-pop[hidden] { display: none; }
      .mb-pop-title {
        font-weight: 600;
        font-size: 12px;
        margin-bottom: 8px;
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      .mb-pop-sub { font-weight: 400; font-size: 11px; opacity: 0.65; }
      .mb-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 2.5px 0;
        gap: 12px;
      }
      .mb-k { opacity: 0.72; display: inline-flex; align-items: center; gap: 6px; }
      .mb-v { font-weight: 500; }
      .mb-swatch { width: 7px; height: 7px; border-radius: 50%; display: inline-block; }
      .mb-bar-track {
        height: 5px;
        width: 100%;
        border-radius: 999px;
        background: color-mix(in srgb, var(--foreground, #71717a) 12%, transparent);
        overflow: hidden;
        display: flex;
        margin: 6px 0 8px;
      }
      .mb-bar-seg { height: 100%; transition: width 0.25s ease; }
      .mb-pool { padding: 6px 0; border-top: 1px solid color-mix(in srgb, var(--foreground, #71717a) 10%, transparent); }
      .mb-pool:first-of-type { border-top: none; padding-top: 0; }
      .mb-pool-head { display: flex; justify-content: space-between; align-items: center; font-weight: 600; margin-bottom: 4px; font-size: 11.5px; }
      .mb-badge { font-size: 10px; font-weight: 500; padding: 1px 6px; border-radius: 999px; background: color-mix(in srgb, #10b981 15%, transparent); color: #10b981; }
      .mb-qrow { display: grid; grid-template-columns: 68px 1fr auto; align-items: center; gap: 8px; font-size: 11px; margin: 3px 0; }
      .mb-qbar { height: 4px; border-radius: 999px; background: color-mix(in srgb, var(--foreground, #71717a) 12%, transparent); overflow: hidden; }
      .mb-qfill { height: 100%; border-radius: 999px; transition: width 0.25s ease; }
    </style>
    <div class="mb-wrap" data-el="wrap"></div>
    <div class="mb-pop" data-el="pop" hidden></div>
  `;

  const wrapEl = shadow.querySelector('[data-el="wrap"]');
  const popEl = shadow.querySelector('[data-el="pop"]');

  const svgSpeed = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M12 14l3.5-3.5"/><path d="M4.6 17A9 9 0 1 1 19.4 17"/></svg>';
  const svgDb = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85"><ellipse cx="12" cy="5.5" rx="8.5" ry="2.8"/><path d="M3.5 5.5v13c0 1.55 3.8 2.8 8.5 2.8s8.5-1.25 8.5-2.8v-13"/><path d="M3.5 12c0 1.55 3.8 2.8 8.5 2.8s8.5-1.25 8.5-2.8"/></svg>';
  const svgQuota = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L4.5 13.5h6.5L10 22l8.5-11.5H12L13 2z"/></svg>';

  const makeRing = (pct, color) => {
    const r = 6.2;
    const c = 2 * Math.PI * r;
    const clamped = Math.max(0, Math.min(100, pct));
    const off = c * (1 - clamped / 100);
    return `<svg viewBox="0 0 18 18" style="transform:rotate(-90deg)">
      <circle cx="9" cy="9" r="${r}" fill="none" stroke="currentColor" stroke-opacity="0.2" stroke-width="2.3"/>
      <circle cx="9" cy="9" r="${r}" fill="none" stroke="${color}" stroke-width="2.3" stroke-linecap="round" stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${off.toFixed(2)}"/>
    </svg>`;
  };

  function buildPopoverHtml(key) {
    const d = state.data;
    const t = I18N[state.lang];
    if (!d) return '';
    if (key === 'speed' && d.speed) {
      const sp = d.speed;
      const streamVal = sp.streamTps != null ? `${sp.streamTps.toFixed(1)} tok/s` : '--';
      return `
        <div class="mb-pop-title"><span>${t.speedTitle}</span><span class="mb-pop-sub">${streamVal}</span></div>
        <div class="mb-row"><span class="mb-k">${t.streamSpeed}</span><span class="mb-v">${streamVal}</span></div>
        <div class="mb-row"><span class="mb-k">${t.e2eSpeed}</span><span class="mb-v">${sp.tps.toFixed(1)} tok/s</span></div>
        <div class="mb-row"><span class="mb-k">${t.ttft}</span><span class="mb-v">${fmtSec(sp.ttft)}</span></div>
        <div class="mb-row"><span class="mb-k">${t.streaming}</span><span class="mb-v">${fmtSec(sp.streaming)}</span></div>
        <div class="mb-row"><span class="mb-k">${t.duration}</span><span class="mb-v">${fmtSec(sp.duration)}</span></div>
        <div class="mb-row"><span class="mb-k">${t.thisOutput}</span><span class="mb-v">${fmtTok(sp.output)} (${t.thinkLabel} ${fmtTok(sp.thinking)} / ${t.replyLabel} ${fmtTok(sp.reply)})</span></div>
      `;
    }
    if (key === 'total' && d.sessionTotal) {
      const st = d.sessionTotal;
      return `
        <div class="mb-pop-title"><span>${t.totalTitle}</span><span class="mb-pop-sub">${fmtTok(st.total)} tok</span></div>
        <div class="mb-row"><span class="mb-k">${t.cumInput}</span><span class="mb-v">${fmtTok(st.input)}</span></div>
        <div class="mb-row"><span class="mb-k">${t.cumCached}</span><span class="mb-v">${fmtTok(st.cached)} (${d.context?.cacheHitPct ?? 0}%)</span></div>
        <div class="mb-row"><span class="mb-k">${t.cumThinking}</span><span class="mb-v">${fmtTok(st.thinking)}</span></div>
        <div class="mb-row"><span class="mb-k">${t.cumReply}</span><span class="mb-v">${fmtTok(st.output)}</span></div>
        <div class="mb-row"><span class="mb-k">${t.reqCount}</span><span class="mb-v">${d.requestCount}</span></div>
      `;
    }
    if (key === 'ctx' && d.context) {
      const c = d.context;
      const denom = c.max > 0 ? c.max : Math.max(c.used, 1);
      const w = val => ((val / denom) * 100).toFixed(2) + '%';
      return `
        <div class="mb-pop-title"><span>${t.ctxTitle}</span><span class="mb-pop-sub">${c.pct}% · ${fmtTok(c.used)} / ${c.max > 0 ? fmtTok(c.max) : '--'}</span></div>
        <div class="mb-bar-track">
          <div class="mb-bar-seg" style="width:${w(c.turn0)};background:#d4940a"></div>
          <div class="mb-bar-seg" style="width:${w(c.read)};background:#3b82f6"></div>
          <div class="mb-bar-seg" style="width:${w(c.think)};background:#10b981"></div>
          <div class="mb-bar-seg" style="width:${w(c.write)};background:#ea580c"></div>
        </div>
        <div class="mb-row"><span class="mb-k"><i class="mb-swatch" style="background:#d4940a"></i>${t.turn0}</span><span class="mb-v">${fmtTok(c.turn0)}</span></div>
        <div class="mb-row"><span class="mb-k"><i class="mb-swatch" style="background:#3b82f6"></i>${t.read}</span><span class="mb-v">${fmtTok(c.read)}</span></div>
        <div class="mb-row"><span class="mb-k"><i class="mb-swatch" style="background:#10b981"></i>${t.think}</span><span class="mb-v">${fmtTok(c.think)}</span></div>
        <div class="mb-row"><span class="mb-k"><i class="mb-swatch" style="background:#ea580c"></i>${t.write}</span><span class="mb-v">${fmtTok(c.write)}</span></div>
      `;
    }
    if (key === 'quota' && d.quota?.groups?.length) {
      const box = findComposerBox();
      const activePool = matchActivePool(d.quota.groups, readActiveModelName(box));
      return d.quota.groups.map(g => {
        const isCurrent = activePool && g.rawName === activePool.rawName;
        const rows = g.buckets.map(b => {
          const label = b.window === '5h' ? t.fiveHoursFull : b.window === 'weekly' ? t.weeklyFull : esc(b.window);
          const reset = fmtReset(b.resetTime, state.lang);
          const resetTxt = reset ? `${reset}${state.lang === 'zh' ? t.resetIn : ' ' + t.resetIn}` : '';
          const col = quotaColor(b.pctLeft);
          return `
            <div class="mb-qrow">
              <span style="opacity:0.78">${label}</span>
              <div class="mb-qbar"><div class="mb-qfill" style="width:${b.pctLeft}%;background:${col}"></div></div>
              <span><strong style="color:${col}">${b.pctLeft}%</strong>${resetTxt ? ` <span style="opacity:0.6;font-size:10px">(${esc(resetTxt)})</span>` : ''}</span>
            </div>
          `;
        }).join('');
        return `
          <div class="mb-pool">
            <div class="mb-pool-head"><span>${esc(g.title)}</span>${isCurrent ? `<span class="mb-badge">${t.activePool}</span>` : ''}</div>
            ${rows}
          </div>
        `;
      }).join('');
    }
    return '';
  }

  function positionPopover(segEl) {
    const rect = segEl.getBoundingClientRect();
    const popRect = popEl.getBoundingClientRect();
    const left = Math.max(12, Math.min(window.innerWidth - popRect.width - 12, rect.left + rect.width / 2 - popRect.width / 2));
    const top = Math.max(12, rect.top - popRect.height - 8);
    popEl.style.left = `${Math.round(left)}px`;
    popEl.style.top = `${Math.round(top)}px`;
  }

  function refreshPopover() {
    const activeKey = state.pinnedKey || state.hoverKey;
    for (const seg of wrapEl.querySelectorAll('.mb-seg')) {
      seg.dataset.active = seg.dataset.key === activeKey ? 'true' : 'false';
    }
    if (!activeKey) {
      popEl.hidden = true;
      return;
    }
    const html = buildPopoverHtml(activeKey);
    if (!html) {
      popEl.hidden = true;
      return;
    }
    popEl.innerHTML = html;
    popEl.hidden = false;
    const segEl = wrapEl.querySelector(`.mb-seg[data-key="${activeKey}"]`);
    if (segEl) positionPopover(segEl);
  }

  function render() {
    const box = findComposerBox();
    if (!box) return false;
    if (host.previousElementSibling !== box) {
      box.after(host);
    }

    const d = state.data;
    const t = I18N[state.lang];
    const isConv = /\/c\/[0-9a-f-]{36}/.test(location.pathname);

    const parts = [];
    if (isConv && d) {
      const speedPart = d.speed ? `<span class="mb-dot">·</span><span>${d.speed.tps.toFixed(1)} tok/s</span>` : '';
      parts.push(`<div class="mb-seg" data-key="speed">${svgSpeed}<span>${d.turnsCount}${t.turnUnit} ${d.stepsCount}${t.stepUnit}</span>${speedPart}</div>`);

      const totalVal = fmtTok(d.sessionTotal?.total || 0);
      const cachePct = d.context?.cacheHitPct ?? 0;
      parts.push(`<div class="mb-seg" data-key="total">${svgDb}<span>${t.totalLabel} ${totalVal}</span><span class="mb-dot">·</span><span>${t.cacheLabel} ${cachePct}%</span></div>`);

      const ctxPct = d.context?.pct ?? 0;
      const ctxCol = ctxColor(ctxPct);
      parts.push(`<div class="mb-seg" data-key="ctx" style="${ctxPct >= 75 ? `color:${ctxCol}` : ''}">${makeRing(ctxPct, ctxCol === 'currentColor' ? 'currentColor' : ctxCol)}<span>${ctxPct}%</span></div>`);
    }

    const groups = d?.quota?.groups || [];
    if (groups.length > 0) {
      const activePool = matchActivePool(groups, readActiveModelName(box));
      if (activePool?.buckets?.length) {
        const b5 = activePool.buckets.find(b => b.window === '5h');
        const bw = activePool.buckets.find(b => b.window === 'weekly');
        const qItems = [];
        if (b5) qItems.push(`<span style="color:${b5.pctLeft <= 25 ? quotaColor(b5.pctLeft) : 'inherit'}">${t.fiveHoursShort} ${b5.pctLeft}%</span>`);
        if (bw) qItems.push(`<span style="color:${bw.pctLeft <= 25 ? quotaColor(bw.pctLeft) : 'inherit'}">${t.weeklyShort} ${bw.pctLeft}%</span>`);
        if (qItems.length) {
          parts.push(`<div class="mb-seg" data-key="quota">${svgQuota}${qItems.join('<span class="mb-dot">·</span>')}</div>`);
        }
      }
    }

    parts.push(`<button class="mb-lang" data-el="lang" title="${esc(t.langTip)}">${t.langBtn}</button>`);
    wrapEl.innerHTML = parts.join('');

    for (const seg of wrapEl.querySelectorAll('.mb-seg')) {
      seg.onmouseenter = () => {
        clearTimeout(state.hideTimer);
        state.hoverKey = seg.dataset.key;
        refreshPopover();
      };
      seg.onmouseleave = () => {
        clearTimeout(state.hideTimer);
        state.hideTimer = setTimeout(() => {
          state.hoverKey = null;
          refreshPopover();
        }, 120);
      };
      seg.onclick = e => {
        e.stopPropagation();
        state.pinnedKey = state.pinnedKey === seg.dataset.key ? null : seg.dataset.key;
        refreshPopover();
      };
    }

    const langBtn = wrapEl.querySelector('[data-el="lang"]');
    if (langBtn) {
      langBtn.onclick = e => {
        e.stopPropagation();
        state.lang = state.lang === 'zh' ? 'en' : 'zh';
        try { localStorage.setItem('agy_mini_bar_lang', state.lang); } catch {}
        render();
      };
    }

    refreshPopover();
    return true;
  }

  popEl.onmouseenter = () => clearTimeout(state.hideTimer);
  popEl.onmouseleave = () => {
    clearTimeout(state.hideTimer);
    state.hideTimer = setTimeout(() => {
      state.hoverKey = null;
      refreshPopover();
    }, 120);
  };

  const onOutsideClick = e => {
    if (!state.pinnedKey) return;
    if (e.composedPath?.().includes(host)) return;
    state.pinnedKey = null;
    refreshPopover();
  };
  const onEscape = e => {
    if (e.key === 'Escape' && (state.pinnedKey || state.hoverKey)) {
      state.pinnedKey = null;
      state.hoverKey = null;
      refreshPopover();
    }
  };
  document.addEventListener('click', onOutsideClick);
  document.addEventListener('keydown', onEscape);

  const observer = new MutationObserver(() => {
    if (!host.isConnected && findComposerBox()) render();
  });
  observer.observe(document.body, { childList: true, subtree: true });

  globalThis.__agyMiniBar = {
    owner: ownerTs,
    hash: bundleHash,
    readState(expectedOwner) {
      if (state.owner > expectedOwner) return 'superseded';
      return {
        owner: state.owner,
        hash: state.hash,
        path: location.pathname,
        hasBox: Boolean(findComposerBox()),
      };
    },
    apply(payload, path, expectedOwner) {
      if (state.owner > expectedOwner) return 'superseded';
      state.data = payload;
      state.path = path;
      return render();
    },
    dispose() {
      clearTimeout(state.hideTimer);
      observer.disconnect();
      document.removeEventListener('click', onOutsideClick);
      document.removeEventListener('keydown', onEscape);
      host.remove();
      if (globalThis.__agyMiniBar?.owner === ownerTs) {
        delete globalThis.__agyMiniBar;
      }
    },
  };

  render();
  return true;
}

export function buildBarBundle(owner = INSTANCE_TS) {
  const fnStr = mountMiniBar.toString();
  const hash = createHash('sha256').update(fnStr).digest('hex').slice(0, 16);
  const code = `(${fnStr})(${Number(owner)}, ${JSON.stringify(hash)})`;
  return { code, hash };
}

/**
 * Start background CDP injector that mounts the minimal bar below the active composer.
 */
export function startBarInjector(getPayload, options = {}) {
  const owner = options.instanceTs ?? INSTANCE_TS;
  const bundle = buildBarBundle(owner);
  const sockets = new Map();
  let cachedPages = [];
  let lastListAt = 0;
  let stopped = false;
  let busy = false;
  let status = 'starting';
  let lastStatusError = '';

  const retire = (entry, id) => {
    if (entry.closed) return;
    entry.closed = true;
    for (const cb of entry.pending.values()) cb(undefined);
    entry.pending.clear();
    try { entry.ws.close(); } catch {}
    if (sockets.get(id) === entry) sockets.delete(id);
  };

  const command = (entry, method, params) => new Promise(resolve => {
    if (entry.ws.readyState !== 1) return resolve(undefined);
    const id = entry.nextId++;
    const timer = setTimeout(() => { entry.pending.delete(id); resolve(undefined); }, 3000);
    entry.pending.set(id, msg => { clearTimeout(timer); resolve(msg?.result); });
    try { entry.ws.send(JSON.stringify({ id, method, params })); }
    catch { clearTimeout(timer); entry.pending.delete(id); resolve(undefined); }
  });

  const evaluate = async (entry, context, expression) => {
    if (!context || context !== entry.context) return undefined;
    const res = await command(entry, 'Runtime.evaluate', {
      uniqueContextId: context,
      expression,
      returnByValue: true,
    });
    return res?.result?.value;
  };

  const connect = async target => {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    const entry = { ws, pending: new Map(), nextId: 1, lastJson: '', lastPath: '', origin: new URL(target.url).origin };
    await new Promise((resolve, reject) => {
      const fail = msg => { clearTimeout(t); retire(entry, target.id); reject(new Error(msg)); };
      const t = setTimeout(() => fail('ws timeout'), 3000);
      ws.onopen = () => { clearTimeout(t); resolve(); };
      ws.onerror = () => fail('ws error');
    });
    if (stopped) { retire(entry, target.id); throw new Error('stopped'); }

    ws.onmessage = ev => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.method === 'Runtime.executionContextCreated') {
          const ctx = msg.params.context;
          if (ctx.auxData?.isDefault && ctx.auxData.frameId === entry.frameId) {
            entry.context = ctx.origin === entry.origin ? ctx.uniqueId : null;
            entry.lastJson = '';
          }
        } else if (
          msg.method === 'Runtime.executionContextsCleared' ||
          (msg.method === 'Runtime.executionContextDestroyed' && msg.params.executionContextUniqueId === entry.context)
        ) {
          entry.context = null;
        }
        const cb = entry.pending.get(msg.id);
        if (cb) { entry.pending.delete(msg.id); cb(msg); }
      } catch {}
    };
    ws.onerror = ws.onclose = () => retire(entry, target.id);
    sockets.set(target.id, entry);

    const tree = await command(entry, 'Page.getFrameTree', {});
    entry.frameId = tree?.frameTree?.frame?.id;
    if (!entry.frameId || !await command(entry, 'Runtime.enable', {})) {
      retire(entry, target.id);
      throw new Error('Runtime.enable failed');
    }
    return entry;
  };

  const listPages = async () => {
    const now = Date.now();
    if (lastListAt && now - lastListAt < 4000) return cachedPages;

    let port;
    try {
      port = readFileSync(options.portFile || getPortFilePath(), 'utf8').split(/\r?\n/)[0].trim();
    } catch {
      status = 'port-missing';
      return [];
    }
    if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
      status = 'port-invalid';
      return [];
    }

    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const targets = await res.json();
      const verifiedOrigin = resolveVerifiedOrigin(options.productRoots, options.env);
      const wsOrigin = new URL(`ws://127.0.0.1:${Number(port)}`).origin;

      cachedPages = targets.filter(t => {
        if (t?.type !== 'page' || typeof t.id !== 'string' || !t.id || !URL.canParse(t.url) || !URL.canParse(t.webSocketDebuggerUrl)) {
          return false;
        }
        const u = new URL(t.url);
        if (verifiedOrigin) {
          if (u.origin !== verifiedOrigin) return false;
        } else if (!['127.0.0.1', 'localhost'].includes(u.hostname)) {
          return false;
        }
        const wsUrl = new URL(t.webSocketDebuggerUrl);
        return wsUrl.origin === wsOrigin && wsUrl.pathname === `/devtools/page/${t.id}`;
      });

      lastListAt = now;
      status = cachedPages.length ? 'ok' : 'no-page';
      lastStatusError = '';

      const validIds = new Set(cachedPages.map(t => t.id));
      for (const [id, entry] of sockets) {
        if (!validIds.has(id)) retire(entry, id);
      }
      return cachedPages;
    } catch (err) {
      status = 'cdp-unreachable';
      lastStatusError = err.message;
      return [];
    }
  };

  const tick = async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      const pages = await listPages();
      for (const target of pages) {
        if (stopped) break;
        try {
          const entry = sockets.get(target.id) || await connect(target);
          if (!entry.context) continue;
          const run = expr => evaluate(entry, entry.context, expr);

          let pageState = await run(`globalThis.__agyMiniBar?.readState(${owner})??null`);
          if (pageState === 'superseded') {
            await stop();
            options.onSuperseded?.();
            return;
          }
          if (pageState?.owner !== owner || pageState?.hash !== bundle.hash) {
            const mounted = await run(bundle.code);
            if (mounted === 'superseded') {
              await stop();
              options.onSuperseded?.();
              return;
            }
            if (!mounted) continue;
            entry.lastJson = '';
            pageState = await run(`globalThis.__agyMiniBar?.readState(${owner})??null`);
          }
          if (!pageState?.hasBox) continue;

          const convMatch = String(pageState.path || '').match(/\/c\/([0-9a-f-]{36})/);
          const payload = await getPayload(convMatch ? convMatch[1] : '');
          const json = JSON.stringify(payload);
          if (entry.lastJson !== json || entry.lastPath !== pageState.path) {
            const ok = await run(`globalThis.__agyMiniBar?.apply(${json},${JSON.stringify(pageState.path)},${owner})??false`);
            if (ok === true) {
              entry.lastJson = json;
              entry.lastPath = pageState.path;
            }
          }
        } catch (err) {
          const entry = sockets.get(target.id);
          if (entry) retire(entry, target.id);
          lastStatusError = err.message;
        }
      }
    } finally {
      busy = false;
    }
  };

  const stop = async () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    await Promise.all([...sockets].map(async ([id, entry]) => {
      try {
        await evaluate(entry, entry.context, `globalThis.__agyMiniBar?.owner===${owner}&&globalThis.__agyMiniBar.dispose()`);
      } finally {
        retire(entry, id);
      }
    }));
  };

  const timer = setInterval(tick, INTERVAL_MS);
  void tick();

  return {
    tick,
    stop,
    getStatus: () => ({ status, error: lastStatusError, pages: cachedPages.length }),
  };
}
