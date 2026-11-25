const QUOTA_TTL_MS = 10_000;

function formatGroupTitle(raw) {
  const s = String(raw || '').trim();
  if (s === 'Gemini Models') return 'Gemini';
  if (s.toLowerCase().startsWith('claude')) return 'Claude & GPT';
  return s || 'Model';
}

export function normalizeQuotaGroups(groups = []) {
  if (!Array.isArray(groups)) return [];
  const order = { '5h': 0, weekly: 1 };
  return groups.map(g => {
    const rawName = String(g.displayName || '').trim().toLowerCase();
    const title = formatGroupTitle(g.displayName);
    const descMatch = String(g.description || '').match(/models within this group:\s*([^\n.]+)/i);
    const modelsInGroup = descMatch ? descMatch[1].toLowerCase() : '';
    const buckets = [...(g.buckets || [])]
      .filter(b => Number.isFinite(b.remainingFraction))
      .sort((a, b) => (order[a.window] ?? 2) - (order[b.window] ?? 2))
      .map(b => ({
        window: b.window === '5h' ? '5h' : b.window === 'weekly' ? 'weekly' : String(b.window || ''),
        pctLeft: Math.max(0, Math.min(100, Math.round(b.remainingFraction * 100))),
        resetTime: b.resetTime || null,
      }));
    return { title, rawName, modelsInGroup, buckets };
  });
}

/**
 * Create a cached client for Antigravity's local language server quota endpoint.
 */
export function createQuotaClient(env = process.env) {
  let cached = { groups: [] };
  let lastFetchMs = 0;
  let inflight = null;

  async function loadQuota() {
    const lsAddr = env.ANTIGRAVITY_LS_ADDRESS;
    const csrf = env.ANTIGRAVITY_CSRF_TOKEN;
    if (!lsAddr || !csrf) return cached;

    try {
      const res = await fetch(`http://${lsAddr}/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-codeium-csrf-token': csrf },
        body: '{}',
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) return cached;
      const data = await res.json();
      const rawGroups = data?.response?.groups ?? data?.groups;
      if (Array.isArray(rawGroups)) {
        cached = { groups: normalizeQuotaGroups(rawGroups) };
        lastFetchMs = Date.now();
      }
      return cached;
    } catch {
      return cached;
    }
  }

  return async function fetchQuota() {
    const now = Date.now();
    if (now - lastFetchMs < QUOTA_TTL_MS && cached.groups.length > 0) {
      return cached;
    }
    if (inflight) return inflight;
    inflight = loadQuota();
    try {
      return await inflight;
    } finally {
      inflight = null;
    }
  };
}
