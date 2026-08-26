export const API_BASE = '';

async function request(path, opts = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text || res.statusText}`);
  }
  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json') ? res.json() : res.text();
}

export function getMedia(params = {}) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') q.set(k, v);
  const qs = q.toString();
  return request(`/api/media${qs ? `?${qs}` : ''}`);
}

export function getMediaById(id) {
  return request(`/api/media/${id}`);
}

export function getMediaStreamUrl(id, token = '') {
  const qs = token ? `?token=${encodeURIComponent(token)}` : '';
  return `${API_BASE}/api/media/${id}/stream${qs}`;
}

export function getSubtitles(id) {
  return request(`/api/media/${id}/subtitles`);
}

export function getSubtitleUrl(id, name, token = '') {
  const qs = token ? `?token=${encodeURIComponent(token)}` : '';
  return `${API_BASE}/api/media/${id}/subtitle/${encodeURIComponent(name)}${qs}`;
}

export function markPlayed(id) {
  return request(`/api/media/${id}/play`, { method: 'POST' });
}

export function triggerScan() {
  return request('/api/scan', { method: 'POST' });
}

export function getStats() {
  return request('/api/stats');
}

export function formatSize(bytes) {
  if (!bytes) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

export function formatDate(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  return d.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
