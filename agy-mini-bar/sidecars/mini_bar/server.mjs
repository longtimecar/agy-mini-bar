import { execFile } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMetricsReader, resolveConversationDirs } from './metrics_reader.mjs';
import { createQuotaClient } from './quota_client.mjs';
import { startBarInjector } from './bar_injector.mjs';

function installProcessGuards(onStop) {
  const isEpipe = err => err?.code === 'EPIPE';
  for (const stream of [process.stdout, process.stderr]) {
    stream?.on?.('error', err => { if (!isEpipe(err)) throw err; });
  }
  const handleFatal = err => {
    if (isEpipe(err)) return;
    try { console.error('[agy-mini-bar] fatal:', err); } catch {}
    process.exit(1);
  };
  process.on('uncaughtException', handleFatal);
  process.on('unhandledRejection', handleFatal);
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.once(sig, () => void onStop(sig));
  }
}

function runAgentApiAsync(args, projectId) {
  const env = { ...process.env };
  if (projectId) env.ANTIGRAVITY_PROJECT_ID = projectId;
  const exe = env.ANTIGRAVITY_AGENTAPI_EXE;
  const file = exe || 'agentapi';
  const execArgs = exe ? ['agentapi', ...args] : args;
  return new Promise((resolvePromise, reject) => {
    execFile(file, execArgs, { encoding: 'utf-8', env, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      try {
        const out = String(stdout ?? '').trim();
        resolvePromise(out ? JSON.parse(out) : {});
      } catch (e) {
        reject(e);
      }
    });
  });
}

function installAsyncHostRoutes(app) {
  app.api('/_sidecar/send-message', (data = {}) => {
    const args = ['send-message'];
    if (data.title) args.push('--title', data.title);
    args.push(data.conversationId, data.message);
    return runAgentApiAsync(args, data.projectId);
  }, 'POST');
  app.api('/_sidecar/new-conversation', (data = {}) =>
    runAgentApiAsync(['new-conversation', '--model', data.model || 'flash', data.message], data.projectId), 'POST');
  app.api('/_sidecar/get-conversation-metadata', (data = {}) =>
    runAgentApiAsync(['get-conversation-metadata', data.conversationId]), 'POST');
}

const STATUS_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>极简 Token 底栏</title>
  <style>
    :root { color-scheme: light dark; }
    body {
      margin: 0; padding: 16px;
      font-family: "Segoe UI", "Microsoft YaHei UI", system-ui, sans-serif;
      font-size: 13px; line-height: 1.6;
      color: var(--foreground, #27272a);
      background: var(--background, transparent);
    }
    .card {
      border: 1px solid color-mix(in srgb, var(--foreground, #71717a) 15%, transparent);
      border-radius: 12px; padding: 14px 16px; margin-bottom: 12px;
      background: color-mix(in srgb, var(--card, #ffffff) 70%, transparent);
    }
    h1 { font-size: 15px; margin: 0 0 8px; }
    .row { display: flex; justify-content: space-between; padding: 3px 0; }
    .muted { opacity: 0.68; font-size: 12px; }
    .ok { color: #10b981; font-weight: 600; }
    .warn { color: #f59e0b; font-weight: 600; }
  </style>
</head>
<body>
  <div class="card">
    <h1>极简 Token 底栏（agy-mini-bar）</h1>
    <div class="row"><span>运行状态</span><span id="cdp" class="ok">检查中...</span></div>
    <div class="row"><span>当前会话</span><span id="conv" class="muted">--</span></div>
    <div class="row"><span>累计总消耗</span><span id="tot">--</span></div>
    <div class="row"><span>上下文占用</span><span id="ctx">--</span></div>
    <div class="row"><span>最近速度</span><span id="spd">--</span></div>
  </div>
  <div class="card muted">
    <div>• 指标已直接显示在聊天输入框正下方，悬停可看详情、点击可钉住浮窗。</div>
    <div>• 点击底栏最右侧的 <strong>中 / EN</strong> 可切换纯简体中文与英文显示。</div>
    <div>• 若底栏未出现，请确认从带 <code>--remote-debugging-port=0</code> 的快捷方式启动 Antigravity。</div>
  </div>
  <script>
    const fmt = n => n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n || 0);
    async function poll() {
      try {
        const res = await fetch('/api/status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        const d = await res.json();
        const st = d.cdp?.status || 'unknown';
        const cdpEl = document.getElementById('cdp');
        cdpEl.textContent = st === 'ok' ? '底栏已挂载' : '等待调试端口 (' + st + ')';
        cdpEl.className = st === 'ok' ? 'ok' : 'warn';
        document.getElementById('conv').textContent = d.conversationId || '新对话';
        document.getElementById('tot').textContent = d.metrics ? fmt(d.metrics.sessionTotal.total) + ' tok (缓存 ' + d.metrics.context.cacheHitPct + '%)' : '--';
        document.getElementById('ctx').textContent = d.metrics ? d.metrics.context.pct + '% (' + fmt(d.metrics.context.used) + ' / ' + fmt(d.metrics.context.max) + ')' : '--';
        document.getElementById('spd').textContent = d.metrics?.speed ? d.metrics.speed.tps.toFixed(1) + ' tok/s' : '--';
      } catch {}
    }
    poll();
    setInterval(poll, 2000);
  </script>
</body>
</html>`;

const conversationDirs = resolveConversationDirs();
const readConversation = createMetricsReader(conversationDirs);
const fetchQuota = createQuotaClient();

async function buildPayload(convId) {
  const [metrics, quota] = await Promise.all([
    Promise.resolve(convId ? readConversation(convId) : null),
    fetchQuota(),
  ]);
  if (!metrics) return { quota };
  return { ...metrics, quota };
}

let injector = null;
let stopping = false;

async function shutdown() {
  if (stopping) return;
  stopping = true;
  try {
    await injector?.stop();
  } finally {
    process.exit(0);
  }
}

installProcessGuards(shutdown);

const productRoots = conversationDirs.map(dir => dirname(dir));
injector = startBarInjector(buildPayload, {
  productRoots,
  onSuperseded: () => void shutdown(),
});

if (process.env.ANTIGRAVITY_SIDECAR_WEB_PORT && process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN?.trim()) {
  const { SidecarApp } = await import('sidecar_sdk');
  const app = new SidecarApp();
  app.page('/', () => STATUS_HTML);
  app.api('/api/status', async data => {
    const convId = data?.conversationId || app.config.conversationId || '';
    return {
      conversationId: convId,
      cdp: injector.getStatus(),
      metrics: convId ? readConversation(convId) : null,
    };
  }, 'POST');
  const ready = app.run();
  installAsyncHostRoutes(app);
  await ready;
}
