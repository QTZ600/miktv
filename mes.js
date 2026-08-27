'use strict';

const { getDb } = require('./kv');
const XLSX = require('xlsx');

// ---- helpers ----

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function jsonResp(obj, status = 200) {
  return { status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

function htmlResp(body, status = 200) {
  return { status, headers: { 'Content-Type': 'text/html; charset=utf-8' }, body };
}

function fmtTime(ts) {
  const d = new Date(ts);
  const pad = n => String(n).padStart(2, '0');
  const offset = 8 * 3600000;
  const local = new Date(d.getTime() + offset);
  return local.getUTCFullYear() + '-' + pad(local.getUTCMonth() + 1) + '-' + pad(local.getUTCDate()) +
    ' ' + pad(local.getUTCHours()) + ':' + pad(local.getUTCMinutes()) + ':' + pad(local.getUTCSeconds());
}

function fmtDate(ts) {
  return fmtTime(ts).slice(0, 10);
}

function todayStr() {
  return fmtDate(Date.now());
}

// ---- constants ----

const MES_STATIONS = [
  { key: 'incoming_stock', label: '来料入库', order: 1 },
  { key: 'outgoing_stock', label: '物料出库', order: 2 },
  { key: 'iqc', label: '来料检验(IQC)', order: 3 },
  { key: 'smt', label: 'SMT', order: 4 },
  { key: 'dip', label: 'DIP', order: 5 },
  { key: 'assembly', label: '组装', order: 6 },
  { key: 'testing', label: '测试数据', order: 7 },
];

const STATION_MAP = Object.fromEntries(MES_STATIONS.map(s => [s.key, s]));
const STATION_KEYS = MES_STATIONS.map(s => s.key);
const STATION_LABEL_MAP = Object.fromEntries(MES_STATIONS.map(s => [s.key, s.label]));

// ---- init tables ----

function ensureTables() {
  const db = getDb();
  db.exec(`CREATE TABLE IF NOT EXISTS mes_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    serial_number TEXT NOT NULL,
    station TEXT NOT NULL,
    operator TEXT NOT NULL,
    result TEXT NOT NULL DEFAULT 'pass',
    remark TEXT,
    is_override INTEGER NOT NULL DEFAULT 0,
    sequence_warning INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_mes_sn ON mes_records(serial_number)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_mes_station_date ON mes_records(station, created_at)`);
}

let _tablesReady = false;
function ready() {
  if (!_tablesReady) { ensureTables(); _tablesReady = true; }
}

// ---- DB helpers ----

function getSerialRecords(sn) {
  ready();
  return getDb().prepare(
    'SELECT station, result, operator, remark, created_at, is_override, sequence_warning FROM mes_records WHERE serial_number = ? ORDER BY created_at ASC'
  ).all(sn);
}

function checkDuplicate(sn, station) {
  ready();
  return getDb().prepare(
    'SELECT id, operator, result, created_at FROM mes_records WHERE serial_number = ? AND station = ? ORDER BY created_at DESC LIMIT 1'
  ).get(sn, station);
}

function detectSequenceWarning(sn, station) {
  const idx = STATION_KEYS.indexOf(station);
  if (idx <= 0) return false;
  const records = getSerialRecords(sn);
  const done = new Set(records.map(r => r.station));
  for (let i = 0; i < idx; i++) {
    if (!done.has(STATION_KEYS[i])) return true;
  }
  return false;
}

function insertRecord(sn, station, operator, result, remark, isOverride, seqWarning) {
  ready();
  return getDb().prepare(
    'INSERT INTO mes_records (serial_number, station, operator, result, remark, is_override, sequence_warning, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(sn, station, operator, result, remark || null, isOverride ? 1 : 0, seqWarning ? 1 : 0, Date.now());
}

// ---- layout ----

function mesNav(active, sess) {
  const visibleStations = (sess.role === 'factory' && sess.mes_station)
    ? MES_STATIONS.filter(s => s.key === sess.mes_station)
    : MES_STATIONS;
  const links = visibleStations.map(s =>
    `<a href="/mes/station/${s.key}" class="px-3 py-1.5 rounded text-xs font-medium whitespace-nowrap ${active === s.key ? 'bg-green-600 text-white' : 'text-slate-600 hover:bg-slate-100'}">${escapeHtml(s.label)}</a>`
  ).join('\n    ');

  return `
  <nav class="flex gap-1 mb-4 border-b pb-3 flex-wrap items-center">
    <span class="text-xs text-slate-400 mr-1">工站:</span>
    ${links}
    <span class="border-l mx-2 h-5 inline-block"></span>
    <span class="text-xs text-slate-400 mr-1">查询:</span>
    <a href="/mes/tracking" class="px-3 py-1.5 rounded text-xs font-medium whitespace-nowrap ${active === 'tracking' ? 'bg-blue-600 text-white' : 'text-slate-600 hover:bg-slate-100'}">序列号追踪</a>
    <a href="/mes/daily-report" class="px-3 py-1.5 rounded text-xs font-medium whitespace-nowrap ${active === 'daily-report' ? 'bg-blue-600 text-white' : 'text-slate-600 hover:bg-slate-100'}">工站日报</a>
    <a href="/mes/exceptions" class="px-3 py-1.5 rounded text-xs font-medium whitespace-nowrap ${active === 'exceptions' ? 'bg-blue-600 text-white' : 'text-slate-600 hover:bg-slate-100'}">异常记录</a>
  </nav>`;
}

function mesLayout(title, active, sess, content, ADMIN_NAV) {
  const uname = escapeHtml(sess.username);
  const isAdmin = sess.role === 'admin' || sess.role === 'super_admin';
  const navHtml = (isAdmin && ADMIN_NAV) ? ADMIN_NAV('mes', sess.role, uname) : '';
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">

<title>${escapeHtml(title)} - 制造执行系统</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<script src="https://cdn.tailwindcss.com"></script>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif;background:#f8fafc}
.mes-pulse{animation:pulse 0.3s ease-out}@keyframes pulse{0%{transform:scale(1)}50%{transform:scale(1.02)}100%{transform:scale(1)}}</style>
</head><body class="min-h-screen">
${navHtml}
<div class="max-w-7xl mx-auto p-4" style="${isAdmin ? 'margin-left:220px;padding-top:80px;' : ''}">
  ${isAdmin ? "" : mesNav(active, sess)}
  ${content}
</div>
</body>
</html>`;
}

// ====================
//   PAGE: Station (扫码录入)
// ====================

function stationPage(stationKey, sess, ADMIN_NAV) {
  const station = STATION_MAP[stationKey];
  if (!station) return null;
  const content = `
  <section class="bg-white rounded shadow p-6">
    <h2 class="text-lg font-medium mb-4">扫码录入 - ${escapeHtml(station.label)}</h2>
    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
      <div>
        <input id="sn-input" type="text" class="border-2 border-blue-400 rounded-lg p-3 text-lg w-full" placeholder="扫描或输入序列号..." autofocus>
        <div id="msg" class="hidden mb-3"></div>
        <div class="flex items-center gap-3 mt-2">
          <label class="text-sm text-slate-600">操作结果:</label>
          <label class="inline-flex items-center gap-1 cursor-pointer"><input type="radio" name="result" value="pass" checked class="accent-green-600"> <span class="text-sm">通过</span></label>
          <label class="inline-flex items-center gap-1 cursor-pointer"><input type="radio" name="result" value="fail" class="accent-red-600"> <span class="text-sm">失败</span></label>
          <label class="inline-flex items-center gap-1 cursor-pointer"><input type="radio" name="result" value="exception" class="accent-yellow-600"> <span class="text-sm">异常</span></label>
        </div>
        <div id="remark-row" class="mt-2 hidden">
          <input id="remark-input" type="text" class="w-full border rounded p-2 text-sm" placeholder="异常/失败描述（可选）">
        </div>
        <div id="scan-feedback" class="mt-3 hidden"></div>
      </div>
      <div>
        <div id="status-panel" class="bg-slate-50 rounded-lg p-4 min-h-[140px]">
          <p class="text-slate-400 text-sm">扫码后显示产品当前工站状态</p>
        </div>
      </div>
    </div>
  </section>

  <section class="bg-white rounded shadow p-4">
    <h2 class="font-medium mb-3">最近录入记录 <span id="recent-count" class="text-xs text-slate-400"></span></h2>
    <div id="recent-list" class="text-sm text-slate-400">暂无记录</div>
  </section>

  <div id="dup-modal" class="fixed inset-0 bg-black/50 hidden z-50 flex items-center justify-center">
    <div class="bg-white rounded-lg p-6 max-w-md mx-4 shadow-xl">
      <h3 class="text-lg font-medium text-yellow-600 mb-2">重复录入提醒</h3>
      <p id="dup-msg" class="text-sm text-slate-600 mb-4"></p>
      <div class="flex gap-3 justify-end">
        <button id="dup-cancel" class="px-4 py-2 border rounded text-sm hover:bg-slate-50">取消</button>
        <button id="dup-confirm" class="px-4 py-2 bg-yellow-500 text-white rounded text-sm hover:bg-yellow-600">确认覆盖</button>
      </div>
    </div>
  </div>

  <div id="seq-modal" class="fixed inset-0 bg-black/50 hidden z-50 flex items-center justify-center">
    <div class="bg-white rounded-lg p-6 max-w-md mx-4 shadow-xl">
      <h3 class="text-lg font-medium text-orange-600 mb-2">工序跳站提醒</h3>
      <p id="seq-msg" class="text-sm text-slate-600 mb-4"></p>
      <div class="flex gap-3 justify-end">
        <button id="seq-cancel" class="px-4 py-2 border rounded text-sm hover:bg-slate-50">取消</button>
        <button id="seq-continue" class="px-4 py-2 bg-orange-500 text-white rounded text-sm hover:bg-orange-600">继续录入</button>
      </div>
    </div>
  </div>

<script>
const STATION = ${JSON.stringify(stationKey)};
const STATION_LABEL = ${JSON.stringify(station.label)};
const ALL_STATIONS = ${JSON.stringify(MES_STATIONS)};
const snInput = document.getElementById('sn-input');
const statusPanel = document.getElementById('status-panel');
const recentList = document.getElementById('recent-list');
const scanFeedback = document.getElementById('scan-feedback');
let pendingSn = null, pendingOverride = false, pendingSeqWarn = false;
let recentRecords = [];

function showMsg(text, ok) {
  const el = document.getElementById('msg');
  el.className = 'mb-3 px-4 py-2 rounded text-sm ' + (ok ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800');
  el.textContent = text; el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 3000);
}

function showFeedback(text, color) {
  scanFeedback.className = 'mt-3 px-3 py-2 rounded text-sm font-medium mes-pulse ' + color;
  scanFeedback.textContent = text;
  scanFeedback.classList.remove('hidden');
  setTimeout(() => scanFeedback.classList.add('hidden'), 2500);
}

function getResult() { return document.querySelector('input[name="result"]:checked').value; }
function getRemark() { return document.getElementById('remark-input').value.trim(); }

document.querySelectorAll('input[name="result"]').forEach(r => {
  r.addEventListener('change', () => {
    document.getElementById('remark-row').classList.toggle('hidden', getResult() === 'pass');
  });
});

function rl(r) { return r === 'pass' ? '通过' : r === 'fail' ? '失败' : '异常'; }
function rc(r) { return r === 'pass' ? 'text-green-600' : r === 'fail' ? 'text-red-600' : 'text-yellow-600'; }
function dc(r) { return r === 'pass' ? 'bg-green-500' : r === 'fail' ? 'bg-red-500' : 'bg-yellow-500'; }

function renderStatus(records) {
  if (!records || !records.length) {
    statusPanel.innerHTML = '<p class="text-blue-500 text-sm font-medium">新产品 — 首次进入工站流程</p>';
    return;
  }
  const byStation = {};
  records.forEach(r => { byStation[r.station] = r; });
  const rows = ALL_STATIONS.map(s => {
    const r = byStation[s.key];
    if (!r) return '<div class="flex items-center gap-2 py-0.5"><span class="w-2 h-2 rounded-full bg-slate-200"></span><span class="text-xs text-slate-300">' + s.label + '</span></div>';
    const t = new Date(r.created_at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});
    return '<div class="flex items-center gap-2 py-0.5"><span class="w-2 h-2 rounded-full ' + dc(r.result) + '"></span><span class="text-xs font-medium">' + s.label + '</span><span class="text-xs ' + rc(r.result) + '">' + rl(r.result) + '</span><span class="text-xs text-slate-400">' + t + '</span></div>';
  }).join('');
  statusPanel.innerHTML = '<div class="space-y-0.5">' + rows + '</div>';
}

function addRecent(sn, result) {
  recentRecords.unshift({ sn, result, ts: Date.now() });
  if (recentRecords.length > 30) recentRecords.pop();
  document.getElementById('recent-count').textContent = '(' + recentRecords.length + ')';
  const rows = recentRecords.map(r => {
    const t = new Date(r.ts).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});
    return '<tr class="border-b"><td class="p-1.5 font-mono">' + r.sn + '</td><td class="p-1.5 ' + rc(r.result) + '">' + rl(r.result) + '</td><td class="p-1.5 text-slate-400">' + t + '</td></tr>';
  }).join('');
  recentList.innerHTML = '<table class="min-w-full"><thead><tr class="text-left text-xs text-slate-400"><th class="p-1.5">序列号</th><th class="p-1.5">结果</th><th class="p-1.5">时间</th></tr></thead><tbody>' + rows + '</tbody></table>';
}

async function fetchStatus(sn) {
  try {
    const r = await fetch('/api/mes/serial-status?sn=' + encodeURIComponent(sn));
    const d = await r.json();
    if (d.ok) renderStatus(d.records);
  } catch {}
}

async function submitScan(sn, override, seqWarn) {
  const result = getResult();
  const remark = getRemark();
  try {
    const r = await fetch('/api/mes/scan', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ serial_number: sn, station: STATION, result, remark, override: !!override, accept_seq_warning: !!seqWarn })
    });
    const d = await r.json();
    if (d.ok) {
      showFeedback('\\u2714 ' + sn + ' 录入成功', 'bg-green-100 text-green-800');
      addRecent(sn, result);
      fetchStatus(sn);
      document.querySelector('input[name="result"][value="pass"]').checked = true;
      document.getElementById('remark-input').value = '';
      document.getElementById('remark-row').classList.add('hidden');
    } else if (d.duplicate) {
      pendingSn = sn; pendingOverride = true; pendingSeqWarn = seqWarn;
      document.getElementById('dup-msg').textContent = '序列号 ' + sn + ' 在「' + STATION_LABEL + '」已有记录（操作员: ' + d.existing.operator + '，结果: ' + rl(d.existing.result) + '）。确认覆盖录入？';
      document.getElementById('dup-modal').classList.remove('hidden');
    } else if (d.sequence_warning) {
      pendingSn = sn; pendingSeqWarn = true; pendingOverride = override;
      const missing = d.missing_stations || [];
      document.getElementById('seq-msg').textContent = '序列号 ' + sn + ' 跳工序：前序工站' + (missing.length ? '「' + missing.join('、') + '」' : '') + '尚未完成。是否继续录入？';
      document.getElementById('seq-modal').classList.remove('hidden');
    } else {
      showMsg('录入失败: ' + (d.msg || '未知错误'), false);
    }
  } catch (e) {
    showMsg('网络错误: ' + e.message, false);
  }
  snInput.value = '';
  snInput.focus();
}

snInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    e.preventDefault();
    const sn = snInput.value.trim();
    if (!sn) return;
    pendingSn = sn; pendingOverride = false; pendingSeqWarn = false;
    submitScan(sn, false, false);
  }
});

document.getElementById('dup-cancel').onclick = () => { document.getElementById('dup-modal').classList.add('hidden'); snInput.focus(); };
document.getElementById('dup-confirm').onclick = () => { document.getElementById('dup-modal').classList.add('hidden'); if (pendingSn) submitScan(pendingSn, true, pendingSeqWarn); };
document.getElementById('seq-cancel').onclick = () => { document.getElementById('seq-modal').classList.add('hidden'); snInput.focus(); };
document.getElementById('seq-continue').onclick = () => { document.getElementById('seq-modal').classList.add('hidden'); if (pendingSn) submitScan(pendingSn, pendingOverride, true); };

snInput.focus();
</script>`;

  return mesLayout(station.label, stationKey, sess, content, ADMIN_NAV);
}

// ====================
//   PAGE: Tracking
// ====================

function trackingPage(sess, ADMIN_NAV) {
  const isFactoryBound = sess.role === 'factory' && sess.mes_station;
  const content = `
  <section class="bg-white rounded shadow p-6">
    <h2 class="text-lg font-medium mb-4">序列号追踪${isFactoryBound ? ' <span class="text-sm text-slate-400">(仅显示我的录入记录)</span>' : ''}</h2>
    <div class="flex gap-3 mb-4">
      <input id="track-sn" type="text" class="border-2 border-blue-400 rounded-lg p-3 text-lg flex-1" placeholder="输入或扫描序列号..." autofocus>
      <button id="track-btn" class="bg-blue-600 text-white px-6 py-2 rounded-lg text-sm font-medium hover:bg-blue-700">查询</button>
    </div>
    <div id="track-result"></div>
  </section>
<script>
const ALL_STATIONS = ${JSON.stringify(MES_STATIONS)};
const stationMap = {};
ALL_STATIONS.forEach(s => { stationMap[s.key] = s.label; });
function rl(r) { return r === 'pass' ? '通过' : r === 'fail' ? '失败' : '异常'; }
function rc(r) { return r === 'pass' ? 'text-green-600' : r === 'fail' ? 'text-red-600' : 'text-yellow-600'; }
function dc(r) { return r === 'pass' ? 'bg-green-500' : r === 'fail' ? 'bg-red-500' : 'bg-yellow-500'; }

async function doTrack() {
  const sn = document.getElementById('track-sn').value.trim();
  if (!sn) return;
  const el = document.getElementById('track-result');
  el.innerHTML = '<p class="text-slate-400 text-sm">查询中...</p>';
  try {
    const r = await fetch('/api/mes/serial-status?sn=' + encodeURIComponent(sn));
    const d = await r.json();
    if (!d.ok) { el.innerHTML = '<p class="text-red-500">查询失败</p>'; return; }
    if (!d.records || !d.records.length) { el.innerHTML = '<p class="text-slate-400">未找到该序列号的任何工站记录</p>'; return; }

    const timeline = d.records.map((r, i) => {
      const t = new Date(r.created_at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});
      const flags = [];
      if (r.is_override) flags.push('<span class="text-xs bg-yellow-100 text-yellow-700 px-1.5 py-0.5 rounded">覆盖录入</span>');
      if (r.sequence_warning) flags.push('<span class="text-xs bg-orange-100 text-orange-700 px-1.5 py-0.5 rounded">跳工序</span>');
      const isLast = i === d.records.length - 1;
      return '<div class="flex gap-4"><div class="flex flex-col items-center"><div class="w-3 h-3 rounded-full ' + dc(r.result) + ' mt-1.5 ring-2 ring-white"></div>' + (isLast ? '' : '<div class="w-0.5 flex-1 bg-slate-200"></div>') + '</div><div class="pb-5"><div class="font-medium text-sm">' + (stationMap[r.station] || r.station) + '</div><div class="text-xs text-slate-500 mt-0.5">' + t + ' &middot; 操作员: ' + r.operator + '</div><div class="text-sm mt-1 ' + rc(r.result) + '">' + rl(r.result) + (r.remark ? ' <span class="text-slate-500">&mdash; ' + r.remark + '</span>' : '') + '</div>' + (flags.length ? '<div class="mt-1 flex gap-1">' + flags.join('') + '</div>' : '') + '</div></div>';
    }).join('');

    const completed = new Set(d.records.map(r => r.station));
    const pending = ALL_STATIONS.filter(s => !completed.has(s.key));
    const pendingHtml = pending.length ? '<div class="mt-4 pt-4 border-t"><p class="text-xs text-slate-400 mb-2">未经过的工站:</p><div class="flex gap-2 flex-wrap">' + pending.map(s => '<span class="text-xs bg-slate-100 text-slate-500 px-2 py-1 rounded">' + s.label + '</span>').join('') + '</div></div>' : '';

    el.innerHTML = '<div class="mt-2"><h3 class="text-sm font-medium text-slate-500 mb-3">序列号: <span class="font-mono text-slate-800">' + sn + '</span> &mdash; 已经过 ' + d.records.length + ' 个工站</h3>' + timeline + pendingHtml + '</div>';
  } catch (e) { el.innerHTML = '<p class="text-red-500">网络错误</p>'; }
}

document.getElementById('track-sn').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); doTrack(); } });
document.getElementById('track-btn').addEventListener('click', doTrack);
document.getElementById('track-sn').focus();
</script>`;

  return mesLayout('序列号追踪', 'tracking', sess, content, ADMIN_NAV);
}

// ====================
//   PAGE: Daily Report
// ====================

function dailyReportPage(sess, ADMIN_NAV) {
  const isFactoryBound = sess.role === 'factory' && sess.mes_station;
  const stationOpts = MES_STATIONS.map(s => `<option value="${s.key}">${escapeHtml(s.label)}</option>`).join('');
  const today = todayStr();
  const boundLabel = isFactoryBound ? escapeHtml(STATION_LABEL_MAP[sess.mes_station] || sess.mes_station) : '';

  const content = `
  <section class="bg-white rounded shadow p-6">
    <h2 class="text-lg font-medium mb-4">工站日报${isFactoryBound ? ' <span class="text-sm text-slate-400">(仅显示我的数据)</span>' : ''}</h2>
    <div class="flex gap-3 mb-4 flex-wrap">
      ${isFactoryBound ? `<span class="border rounded p-2 text-sm bg-slate-50 text-slate-600">${boundLabel}</span>` : `<select id="rpt-station" class="border rounded p-2 text-sm">
        <option value="">全部工站</option>
        ${stationOpts}
      </select>`}
      <input id="rpt-date" type="date" value="${today}" class="border rounded p-2 text-sm">
      <button id="rpt-btn" class="bg-blue-600 text-white px-4 py-2 rounded text-sm hover:bg-blue-700">查询</button>
    </div>
    <div id="rpt-result"></div>
  </section>
<script>
const ALL_STATIONS = ${JSON.stringify(MES_STATIONS)};
const stationMap = {};
ALL_STATIONS.forEach(s => { stationMap[s.key] = s.label; });

async function loadReport() {
  const stationEl = document.getElementById('rpt-station');
  const station = stationEl ? stationEl.value : '';
  const date = document.getElementById('rpt-date').value;
  const p = new URLSearchParams({ date });
  if (station) p.set('station', station);
  const el = document.getElementById('rpt-result');
  try {
    const r = await fetch('/api/mes/daily-report?' + p);
    const d = await r.json();
    if (!d.ok) { el.innerHTML = '<p class="text-red-500">查询失败</p>'; return; }
    if (!d.data || !d.data.length) { el.innerHTML = '<p class="text-slate-400">该日期无记录</p>'; return; }

    let totalAll = 0, passAll = 0, failAll = 0, excAll = 0;
    const rows = d.data.map(r => {
      const total = r.pass_count + r.fail_count + r.exception_count;
      totalAll += total; passAll += r.pass_count; failAll += r.fail_count; excAll += r.exception_count;
      const rate = total > 0 ? (r.pass_count / total * 100).toFixed(1) : '-';
      return '<tr class="border-b hover:bg-slate-50"><td class="p-2 font-medium">' + (stationMap[r.station] || r.station) + '</td><td class="p-2">' + total + '</td><td class="p-2 text-green-600">' + r.pass_count + '</td><td class="p-2 text-red-600">' + r.fail_count + '</td><td class="p-2 text-yellow-600">' + r.exception_count + '</td><td class="p-2">' + rate + '%</td></tr>';
    }).join('');
    const rateAll = totalAll > 0 ? (passAll / totalAll * 100).toFixed(1) : '-';
    const footer = '<tr class="bg-slate-50 font-medium"><td class="p-2">合计</td><td class="p-2">' + totalAll + '</td><td class="p-2 text-green-600">' + passAll + '</td><td class="p-2 text-red-600">' + failAll + '</td><td class="p-2 text-yellow-600">' + excAll + '</td><td class="p-2">' + rateAll + '%</td></tr>';

    el.innerHTML = '<table class="min-w-full text-sm"><thead><tr class="bg-slate-100 text-left"><th class="p-2">工站</th><th class="p-2">总数</th><th class="p-2">通过</th><th class="p-2">失败</th><th class="p-2">异常</th><th class="p-2">通过率</th></tr></thead><tbody>' + rows + footer + '</tbody></table>';
  } catch (e) { el.innerHTML = '<p class="text-red-500">网络错误</p>'; }
}

document.getElementById('rpt-btn').addEventListener('click', loadReport);
loadReport();
</script>`;

  return mesLayout('工站日报', 'daily-report', sess, content, ADMIN_NAV);
}

// ====================
//   PAGE: Exceptions
// ====================

function exceptionsPage(sess, ADMIN_NAV) {
  const isFactoryBound = sess.role === 'factory' && sess.mes_station;
  const stationOpts = MES_STATIONS.map(s => `<option value="${s.key}">${escapeHtml(s.label)}</option>`).join('');
  const today = todayStr();

  const content = `
  <section class="bg-white rounded shadow p-6">
    <h2 class="text-lg font-medium mb-4">异常记录汇总${isFactoryBound ? ' <span class="text-sm text-slate-400">(仅显示我的记录)</span>' : ''}</h2>
    <div class="flex gap-3 mb-4 flex-wrap items-end">
      <div><label class="block text-xs text-slate-500 mb-1">开始日期</label><input id="exc-from" type="date" value="${today}" class="border rounded p-2 text-sm"></div>
      <div><label class="block text-xs text-slate-500 mb-1">结束日期</label><input id="exc-to" type="date" value="${today}" class="border rounded p-2 text-sm"></div>
      <div><label class="block text-xs text-slate-500 mb-1">工站</label><select id="exc-station" class="border rounded p-2 text-sm"><option value="">全部</option>${stationOpts}</select></div>
      <div><label class="block text-xs text-slate-500 mb-1">结果</label><select id="exc-result" class="border rounded p-2 text-sm"><option value="">全部</option><option value="fail">失败</option><option value="exception">异常</option><option value="pass">通过</option></select></div>
      <button id="exc-btn" class="bg-blue-600 text-white px-4 py-2 rounded text-sm h-fit hover:bg-blue-700">查询</button>
      <button id="exc-export" class="bg-green-600 text-white px-4 py-2 rounded text-sm h-fit hover:bg-green-700">导出 Excel</button>
    </div>
    <div id="exc-el"></div>
  </section>
<script>
const ALL_STATIONS = ${JSON.stringify(MES_STATIONS)};
const stationMap = {};
ALL_STATIONS.forEach(s => { stationMap[s.key] = s.label; });
function rl(r) { return r === 'pass' ? '通过' : r === 'fail' ? '失败' : '异常'; }
function rc(r) { return r === 'pass' ? 'text-green-600' : r === 'fail' ? 'text-red-600' : 'text-yellow-600'; }

function getParams() {
  const p = new URLSearchParams();
  p.set('from', document.getElementById('exc-from').value);
  p.set('to', document.getElementById('exc-to').value);
  const s = document.getElementById('exc-station').value;
  const r = document.getElementById('exc-result').value;
  if (s) p.set('station', s);
  if (r) p.set('result', r);
  return p;
}

async function loadExc() {
  const el = document.getElementById('exc-el');
  try {
    const r = await fetch('/api/mes/exceptions?' + getParams());
    const d = await r.json();
    if (!d.ok) { el.innerHTML = '<p class="text-red-500">查询失败</p>'; return; }
    if (!d.records || !d.records.length) { el.innerHTML = '<p class="text-slate-400">无匹配记录</p>'; return; }

    const rows = d.records.map(r => {
      const t = new Date(r.created_at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});
      return '<tr class="border-b hover:bg-slate-50"><td class="p-2 font-mono text-xs">' + r.serial_number + '</td><td class="p-2">' + (stationMap[r.station] || r.station) + '</td><td class="p-2">' + r.operator + '</td><td class="p-2 ' + rc(r.result) + '">' + rl(r.result) + '</td><td class="p-2 text-slate-500">' + (r.remark || '-') + '</td><td class="p-2 text-slate-400 text-xs">' + t + '</td></tr>';
    }).join('');

    el.innerHTML = '<p class="text-xs text-slate-400 mb-2">共 ' + d.total + ' 条' + (d.total > 1000 ? '（仅显示前1000条）' : '') + '</p><div class="overflow-x-auto"><table class="min-w-full text-sm"><thead><tr class="bg-slate-100 text-left"><th class="p-2">序列号</th><th class="p-2">工站</th><th class="p-2">操作员</th><th class="p-2">结果</th><th class="p-2">备注</th><th class="p-2">时间</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
  } catch (e) { el.innerHTML = '<p class="text-red-500">网络错误</p>'; }
}

document.getElementById('exc-btn').addEventListener('click', loadExc);
document.getElementById('exc-export').addEventListener('click', () => {
  window.open('/api/mes/exceptions/export?' + getParams(), '_blank');
});
loadExc();
</script>`;

  return mesLayout('异常记录汇总', 'exceptions', sess, content, ADMIN_NAV);
}

// ====================
//   API handlers
// ====================

function apiScan(body, sess) {
  ready();
  const { serial_number, station, result, remark, override, accept_seq_warning } = body;
  if (!serial_number || !station) return jsonResp({ ok: false, msg: '缺少序列号或工站' }, 400);
  if (!STATION_MAP[station]) return jsonResp({ ok: false, msg: '无效工站' }, 400);
  if (!['pass', 'fail', 'exception'].includes(result)) return jsonResp({ ok: false, msg: '无效结果类型' }, 400);

  const sn = serial_number.trim();
  if (!sn) return jsonResp({ ok: false, msg: '序列号不能为空' }, 400);

  if (!accept_seq_warning) {
    const hasSeqWarn = detectSequenceWarning(sn, station);
    if (hasSeqWarn) {
      const idx = STATION_KEYS.indexOf(station);
      const records = getSerialRecords(sn);
      const done = new Set(records.map(r => r.station));
      const missing = [];
      for (let i = 0; i < idx; i++) {
        if (!done.has(STATION_KEYS[i])) missing.push(STATION_LABEL_MAP[STATION_KEYS[i]]);
      }
      return jsonResp({ ok: false, sequence_warning: true, missing_stations: missing, msg: '存在跳工序情况' });
    }
  }

  if (!override) {
    const dup = checkDuplicate(sn, station);
    if (dup) {
      return jsonResp({ ok: false, duplicate: true, existing: { operator: dup.operator, result: dup.result, created_at: dup.created_at }, msg: '已存在记录' });
    }
  }

  const seqWarning = detectSequenceWarning(sn, station);
  insertRecord(sn, station, sess.username, result, remark, !!override, seqWarning);
  return jsonResp({ ok: true });
}

function apiSerialStatus(query, sess) {
  ready();
  const sn = (query.sn || '').trim();
  if (!sn) return jsonResp({ ok: false, msg: '缺少序列号' }, 400);
  let records = getSerialRecords(sn);
  if (sess && sess.role === 'factory' && sess.mes_station) {
    const hasMyRecord = records.some(r => r.operator === sess.username);
    if (!hasMyRecord) return jsonResp({ ok: true, records: [] });
    records = records.filter(r => r.operator === sess.username);
  }
  return jsonResp({ ok: true, records });
}

function apiDailyReport(query, sess) {
  ready();
  const db = getDb();
  const date = query.date || todayStr();
  let station = query.station;

  const dayStart = new Date(date + 'T00:00:00+08:00').getTime();
  const dayEnd = dayStart + 86400000;

  const isFactoryBound = sess && sess.role === 'factory' && sess.mes_station;
  if (isFactoryBound) station = sess.mes_station;

  const conditions = ['created_at >= ?', 'created_at < ?'];
  const params = [dayStart, dayEnd];
  if (station) { conditions.push('station = ?'); params.push(station); }
  if (isFactoryBound) { conditions.push('operator = ?'); params.push(sess.username); }

  const where = 'WHERE ' + conditions.join(' AND ');
  const sql = `SELECT station, result, COUNT(*) as cnt FROM mes_records ${where} GROUP BY station, result`;

  const rows = db.prepare(sql).all(...params);
  const agg = {};
  for (const row of rows) {
    if (!agg[row.station]) agg[row.station] = { station: row.station, pass_count: 0, fail_count: 0, exception_count: 0 };
    if (row.result === 'pass') agg[row.station].pass_count = row.cnt;
    else if (row.result === 'fail') agg[row.station].fail_count = row.cnt;
    else agg[row.station].exception_count = row.cnt;
  }

  const data = STATION_KEYS.filter(k => agg[k]).map(k => agg[k]);
  return jsonResp({ ok: true, data });
}

function buildExceptionQuery(query, sess) {
  const conditions = [];
  const params = [];

  if (query.from) {
    conditions.push('created_at >= ?');
    params.push(new Date(query.from + 'T00:00:00+08:00').getTime());
  }
  if (query.to) {
    conditions.push('created_at < ?');
    params.push(new Date(query.to + 'T00:00:00+08:00').getTime() + 86400000);
  }
  if (query.station) {
    conditions.push('station = ?');
    params.push(query.station);
  }
  if (query.result) {
    conditions.push('result = ?');
    params.push(query.result);
  }
  if (sess && sess.role === 'factory' && sess.mes_station) {
    conditions.push('operator = ?');
    params.push(sess.username);
  }

  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
  return { where, params };
}

function apiExceptions(query, sess) {
  ready();
  const db = getDb();
  const { where, params } = buildExceptionQuery(query, sess);

  const countRow = db.prepare(`SELECT COUNT(*) as c FROM mes_records ${where}`).get(...params);
  const total = countRow ? countRow.c : 0;
  const records = db.prepare(`SELECT * FROM mes_records ${where} ORDER BY created_at DESC LIMIT 1000`).all(...params);

  return jsonResp({ ok: true, records, total });
}

function apiExceptionsExport(query, sess) {
  ready();
  const db = getDb();
  const { where, params } = buildExceptionQuery(query, sess);
  const records = db.prepare(`SELECT * FROM mes_records ${where} ORDER BY created_at DESC`).all(...params);

  const resultMap = { pass: '通过', fail: '失败', exception: '异常' };
  const data = records.map(r => ({
    '序列号': r.serial_number,
    '工站': STATION_LABEL_MAP[r.station] || r.station,
    '操作员': r.operator,
    '结果': resultMap[r.result] || r.result,
    '备注': r.remark || '',
    '覆盖录入': r.is_override ? '是' : '否',
    '跳工序': r.sequence_warning ? '是' : '否',
    '时间': fmtTime(r.created_at),
  }));

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(data);
  XLSX.utils.book_append_sheet(wb, ws, 'MES记录');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  const fname = 'mes-records-' + (query.from || 'all') + '-' + (query.to || 'all') + '.xlsx';
  return {
    status: 200,
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': 'attachment; filename="' + fname + '"',
    },
    body: buf,
  };
}

// ====================
//   Main handler
// ====================

function handleMes(method, pathname, query, sess, body, ADMIN_NAV) {
  const stationMatch = pathname.match(/^\/mes\/station\/([a-z_]+)$/);
  if (stationMatch && method === 'GET') {
    const page = stationPage(stationMatch[1], sess, ADMIN_NAV);
    if (page) return htmlResp(page);
    return htmlResp('<h1>404</h1><p>未知工站</p>', 404);
  }

  if (pathname === '/mes/tracking' && method === 'GET') return htmlResp(trackingPage(sess, ADMIN_NAV));
  if (pathname === '/mes/daily-report' && method === 'GET') return htmlResp(dailyReportPage(sess, ADMIN_NAV));
  if (pathname === '/mes/exceptions' && method === 'GET') return htmlResp(exceptionsPage(sess, ADMIN_NAV));

  if ((pathname === '/mes' || pathname === '/mes/') && method === 'GET') {
    return { status: 302, headers: { Location: '/mes/station/incoming_stock' }, body: '' };
  }

  if (pathname === '/api/mes/scan' && method === 'POST') {
    let parsed;
    try { parsed = typeof body === 'string' ? JSON.parse(body) : JSON.parse(body.toString('utf8')); }
    catch { return jsonResp({ ok: false, msg: '请求体必须为 JSON' }, 400); }
    return apiScan(parsed, sess);
  }
  if (pathname === '/api/mes/serial-status' && method === 'GET') return apiSerialStatus(query, sess);
  if (pathname === '/api/mes/daily-report' && method === 'GET') return apiDailyReport(query, sess);
  if (pathname === '/api/mes/exceptions' && method === 'GET') return apiExceptions(query, sess);
  if (pathname === '/api/mes/exceptions/export' && method === 'GET') return apiExceptionsExport(query, sess);

  return null;
}

module.exports = { handleMes, MES_STATIONS };
