'use strict';

const { getDb } = require('./kv');
const nodePath = require('path');
const fs = require('fs');
const crypto = require('crypto');

const VER_FIRMWARE_DIR = nodePath.join(__dirname, 'uploads', 'version-firmware');
const VER_FILES_DIR = nodePath.join(__dirname, 'uploads', 'version-files');
if (!fs.existsSync(VER_FIRMWARE_DIR)) fs.mkdirSync(VER_FIRMWARE_DIR, { recursive: true });
if (!fs.existsSync(VER_FILES_DIR)) fs.mkdirSync(VER_FILES_DIR, { recursive: true });

// ---- helpers ----

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function jsonResp(obj, status = 200) {
  return { status, headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(obj) };
}

function htmlResp(body, status = 200) {
  return { status, headers: { 'Content-Type': 'text/html; charset=utf-8' }, body };
}

function isDevRole(role) {
  return role === 'dev' || role === 'super_admin';
}

function parseMultipart(body, boundary) {
  const parts = [];
  const boundaryBuf = Buffer.from('--' + boundary);
  const endBuf = Buffer.from('--' + boundary + '--');
  let start = 0;
  while (start < body.length) {
    const bStart = body.indexOf(boundaryBuf, start);
    if (bStart < 0) break;
    const afterBoundary = bStart + boundaryBuf.length;
    if (body.slice(bStart, bStart + endBuf.length).equals(endBuf)) break;
    const headerEnd = body.indexOf('\r\n\r\n', afterBoundary);
    if (headerEnd < 0) break;
    const headerStr = body.slice(afterBoundary, headerEnd).toString('utf8');
    const nextBoundary = body.indexOf(boundaryBuf, headerEnd + 4);
    const partEnd = nextBoundary >= 0 ? nextBoundary - 2 : body.length;
    const partBody = body.slice(headerEnd + 4, partEnd);
    const nameMatch = headerStr.match(/name="([^"]+)"/);
    const filenameMatch = headerStr.match(/filename="([^"]+)"/);
    const ctMatch = headerStr.match(/Content-Type:\s*(.+)/i);
    parts.push({
      name: nameMatch ? nameMatch[1] : '',
      filename: filenameMatch ? filenameMatch[1] : null,
      contentType: ctMatch ? ctMatch[1].trim() : null,
      data: partBody,
    });
    start = nextBoundary >= 0 ? nextBoundary : body.length;
  }
  return parts;
}

// ---- DB init ----

function ensureVersionTables() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS product_versions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id    INTEGER NOT NULL,
      hw_version    TEXT NOT NULL,
      sw_version    TEXT NOT NULL,
      release_date  TEXT NOT NULL,
      changelog     TEXT NOT NULL,
      firmware_path TEXT,
      firmware_name TEXT,
      created_at    TEXT DEFAULT (datetime('now')),
      UNIQUE(product_id, sw_version)
    );

    CREATE TABLE IF NOT EXISTS product_version_files (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      version_id  INTEGER NOT NULL REFERENCES product_versions(id) ON DELETE CASCADE,
      label       TEXT NOT NULL,
      file_path   TEXT NOT NULL,
      file_name   TEXT NOT NULL,
      created_at  TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS product_version_download_logs (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      username        TEXT NOT NULL,
      ip              TEXT NOT NULL,
      product_name    TEXT NOT NULL,
      sw_version      TEXT NOT NULL,
      file_name       TEXT NOT NULL,
      file_type       TEXT NOT NULL,
      downloaded_at   TEXT DEFAULT (datetime('now'))
    );
  `);
}

// ---- PRESET_LABELS for file attachments ----

const PRESET_LABELS = ['CMF', '包装盒', '会员卡', '说明书', '发射端固件', '接收端固件'];

// ---- Unified admin header ----

function getAdminHeaderHtml(uname) {
  return `<div style="position:fixed;top:0;left:0;right:0;z-index:200;background:#fff;border-bottom:1px solid #e5e7eb;">
  <div style="max-width:80rem;margin:0 auto;display:flex;justify-content:space-between;align-items:center;padding:0 24px;height:48px;">
    <span style="font-size:16px;font-weight:700;color:#111;">雷石质量管理系统</span>
    <div style="display:flex;align-items:center;gap:16px;font-size:14px;color:#6b7280;">
      <span>${uname || ''}</span>
      <a href="/logout" style="color:#2563eb;text-decoration:none;">退出</a>
    </div>
  </div>
</div>`;
}

// ---- Dev header (standalone layout) ----

function getDevHeaderHtml(sess) {
  const username = escapeHtml(sess.display_name || sess.username || '');
  return `<div style="position:fixed;top:0;left:0;right:0;z-index:200;background:#fff;border-bottom:1px solid #e5e7eb;">
  <div style="max-width:80rem;margin:0 auto;display:flex;justify-content:space-between;align-items:center;padding:0 24px;height:48px;">
    <span style="font-size:16px;font-weight:700;color:#111;">雷石质量管理系统</span>
    <div style="font-size:14px;color:#6b7280;">
      账号：<strong style="color:#111;">${username}</strong> &nbsp;|&nbsp; <a href="/logout" style="color:#2563eb;text-decoration:none;">退出</a>
    </div>
  </div>
</div>`;
}

// ---- Page layout wrapper ----

function pageShell(title, navHtml, bodyHtml) {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>${escapeHtml(title)} - 雷石质量管理系统</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<script src="https://cdn.tailwindcss.com"></script>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif;background:#f5f5f7}
select{box-sizing:border-box!important;font-family:inherit;font-size:1em;padding:.5rem!important;width:100%!important}
input[type="text"],input[type="number"],input[type="date"],input[type="file"],textarea{box-sizing:border-box!important;width:100%!important;padding:.5rem!important}
.btn-primary{display:inline-block;background:#111;color:#fff;padding:8px 20px;border-radius:8px;font-size:14px;font-weight:500;text-decoration:none;border:none;cursor:pointer}
.btn-primary:hover{background:#333}
.btn-secondary{display:inline-block;background:#f3f4f6;color:#374151;padding:8px 20px;border-radius:8px;font-size:14px;font-weight:500;text-decoration:none;border:none;cursor:pointer}
.input-field{display:block;width:100%;padding:10px 14px;border:1px solid #d1d5db;border-radius:10px;font-size:14px;outline:none;transition:border-color .2s}
.input-field:focus{border-color:#2563eb;box-shadow:0 0 0 3px rgba(37,99,235,.1)}
.version-card{background:#fff;border-radius:20px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);transition:box-shadow 0.25s,transform 0.25s;cursor:default}
.version-card:hover{box-shadow:0 8px 32px rgba(0,0,0,0.13);transform:translateY(-2px)}
.version-card .card-image{width:100%;height:200px;background:#ffffff;display:flex;align-items:center;justify-content:center;overflow:hidden;padding:16px;border-bottom:1px solid #f0f0f0}
.version-card .card-image img{max-width:100%;max-height:100%;object-fit:contain;object-position:center}
.version-card .card-header{padding:20px;border-bottom:1px solid #f0f0f0;cursor:pointer;user-select:none}
.version-card .card-header:hover{background:#fff}
.version-card .card-header h3{margin:0;font-size:17px;font-weight:600;color:#1d1d1f}
.version-card .card-meta{margin-top:8px;font-size:13px;color:#6e6e73;display:flex;gap:16px;flex-wrap:wrap}
.version-card .card-meta span{display:flex;align-items:center;gap:4px}
.version-card .card-firmware{margin-top:6px}
.version-card .card-firmware a{color:#0071e3;font-size:13px;text-decoration:none}
.version-card .card-firmware a:hover{text-decoration:underline}
.version-card .card-detail{padding:16px 20px;background:#fff;border-top:1px solid #f0f0f0;display:none}
.version-card .card-detail.show{display:block}
.version-card .card-detail-content{margin-bottom:12px}
.version-card .card-detail-label{font-size:12px;font-weight:500;color:#6e6e73;text-transform:uppercase;margin-bottom:8px;letter-spacing:0.5px}
.version-card .file-list{margin-bottom:12px}
.version-card .file-item{display:flex;align-items:center;gap:8px;font-size:13px;margin-bottom:8px}
.version-card .file-item .badge{background:#fff;padding:2px 8px;border-radius:6px;font-size:11px;color:#6e6e73;border:1px solid #e5e7eb}
.version-card .file-item a{color:#0071e3;text-decoration:none}
.version-card .file-item a:hover{text-decoration:underline}
.version-card .file-upload{display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap}
.version-card .card-badges{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:8px;}
.version-card .badge{font-size:11px;font-weight:500;padding:2px 8px;border-radius:20px;display:inline-block;}
.version-card .badge-cat{background:#e8edff;color:#4338ca;}
.version-grid{display:grid;grid-template-columns:repeat(1,1fr);gap:20px}
@media(min-width:640px){.version-grid{grid-template-columns:repeat(2,1fr)!important}}
@media(min-width:1024px){.version-grid{grid-template-columns:repeat(3,1fr)!important}}
</style>
</head><body class="min-h-screen" style="background:#f5f5f7">
${navHtml}
${bodyHtml}
</body></html>`;
}

// ---- Product Versions List Page ----

function productVersionsPage(sess, ADMIN_NAV) {
  const db = getDb();
  const products = db.prepare('SELECT * FROM products WHERE status = ? ORDER BY sort_order, id').all('active');

  const isDevUser = sess.role === 'dev';

  const cards = products.map(p => {
    const category = p.category || "其他";
    const latestVersion = db.prepare('SELECT hw_version, sw_version FROM product_versions WHERE product_id = ? ORDER BY release_date DESC, id DESC LIMIT 1').get(p.id);

    const versionLine = latestVersion
      ? `硬件版本：${escapeHtml(latestVersion.hw_version)} / 软件版本：${escapeHtml(latestVersion.sw_version)}`
      : '暂无版本';

    const btnHref = isDevUser ? `/dev/product-versions/${p.id}` : `/admin/product-versions/${p.id}`;
    const btnText = isDevUser ? '历史版本' : '管理版本';

    const imgHtml = p.image_path
      ? `<img src="${p.image_path.replace(/"/g,'&quot;')}" alt="${p.model_name.replace(/"/g,'&quot;')}" style="max-width:100%;max-height:100%;object-fit:contain;object-position:center;">`
      : '<div style="color:#cbd5e1;font-size:2rem;display:flex;align-items:center;justify-content:center;width:100%;height:100%;">📷</div>';

    return `<div class="version-hub-card" data-category="${escapeHtml(category)}" style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);transition:box-shadow 0.25s,transform 0.25s;">
      <div style="width:100%;height:200px;background:#ffffff;display:flex;align-items:center;justify-content:center;overflow:hidden;padding:16px;border-bottom:1px solid #f0f0f0;">
        ${imgHtml}
      </div>
      <div style="padding:20px 20px 14px;">
        <h3 style="margin:0 0 6px;font-size:16px;font-weight:600;color:#111827;">${escapeHtml(p.model_name)}</h3>
        <div style="font-size:13px;color:#6b7280;margin-bottom:10px;">型号：${escapeHtml(p.model_code || p.model_name)}</div>
        <div style="font-size:13px;color:#374151;">${versionLine}</div>
      </div>
      <div style="padding:12px 20px 14px;border-top:1px solid #f0f0f0;">
        <a href="${btnHref}" style="color:#2563eb;font-size:13px;text-decoration:none;font-weight:500;">${btnText} →</a>
      </div>
    </div>`;
  }).join('');

  const headerHtml = isDevUser ? getDevHeaderHtml(sess) : getAdminHeaderHtml(sess.display_name || sess.username);
  const logsLink = isDevUser ? '' : '<div class="flex items-center justify-end mb-8"><a href="/admin/product-versions/download-logs" class="text-blue-600 hover:underline text-sm">下载日志 →</a></div>';

  const categoryTabs = products.length === 0 ? '' : `
    <div style="display:flex;gap:8px;margin-bottom:24px;flex-wrap:wrap;">
      <button class="category-tab active" data-cat="全部" style="background:#111;color:#fff;padding:8px 16px;border-radius:6px;border:none;cursor:pointer;font-size:14px;font-weight:500;transition:background 0.2s;">全部</button>
      <button class="category-tab" data-cat="机顶盒" style="background:#f3f4f6;color:#374151;padding:8px 16px;border-radius:6px;border:none;cursor:pointer;font-size:14px;font-weight:500;transition:background 0.2s;">机顶盒</button>
      <button class="category-tab" data-cat="麦克风" style="background:#f3f4f6;color:#374151;padding:8px 16px;border-radius:6px;border:none;cursor:pointer;font-size:14px;font-weight:500;transition:background 0.2s;">麦克风</button>
      <button class="category-tab" data-cat="音箱" style="background:#f3f4f6;color:#374151;padding:8px 16px;border-radius:6px;border:none;cursor:pointer;font-size:14px;font-weight:500;transition:background 0.2s;">音箱</button>
    </div>
  `;

  const body = `${headerHtml}
<div style="padding-top:72px;" class="max-w-7xl mx-auto px-6 py-10">
    ${logsLink}
    ${categoryTabs}
    ${products.length === 0 ? '<div class="text-center py-24 text-gray-400"><p>暂无产品，请先在「产品」页面添加产品</p></div>' : `
    <div style="display:grid;grid-template-columns:repeat(1,1fr);gap:20px;" class="version-hub-grid">
      ${cards}
    </div>`}
  </div>
  <style>
  @keyframes slideUp{from{transform:translateY(40px);opacity:0;}to{transform:translateY(0);opacity:1;}}
  .version-hub-card{animation:slideUp 1.0s cubic-bezier(0.25, 0.46, 0.45, 0.94) forwards;}
  .version-hub-card:hover{box-shadow:0 8px 32px rgba(0,0,0,0.13);transform:translateY(-2px);}
  .category-tab.active{background:#111!important;color:#fff!important;}
  .category-tab:hover{opacity:0.8;}
  .version-hub-card.hidden{display:none;}
  @media(min-width:640px){.version-hub-grid{grid-template-columns:repeat(2,1fr)!important;}}
  @media(min-width:1024px){.version-hub-grid{grid-template-columns:repeat(3,1fr)!important;}}
  @media(min-width:1280px){.version-hub-grid{grid-template-columns:repeat(4,1fr)!important;}}
  </style>
  <script>
  function applyCardAnimations(){document.querySelectorAll('.version-hub-card').forEach(function(card,idx){if(!card.classList.contains('hidden')){card.style.animationDelay=(idx*120)+'ms';}});}
  applyCardAnimations();
  document.querySelectorAll('.category-tab').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var selectedCat = this.dataset.cat;
      document.querySelectorAll('.category-tab').forEach(function(b) { b.classList.remove('active'); });
      btn.classList.add('active');

      document.querySelectorAll('.version-hub-card').forEach(function(card) {
        var cardCat = card.dataset.category;
        if (selectedCat === '全部' || cardCat === selectedCat) {
          card.classList.remove('hidden');
          card.style.animation='none';
          setTimeout(function(){card.style.animation='';applyCardAnimations();},10);
        } else {
          card.classList.add('hidden');
        }
      });
    });
  });
  </script>`;

  return isDevUser
    ? pageShell('产品版本管理', '', body)
    : pageShell('产品版本管理', ADMIN_NAV('product-versions', sess.role), body);
}

function getCategory(modelCode) {
  if (!modelCode) return '其他';
  const m = String(modelCode).toUpperCase();
  if (m.startsWith('K')) return '机顶盒';
  if (m.startsWith('S')) return '服务器';
  if (m.startsWith('M')) return '麦克风';
  if (m.startsWith('A')) return '音箱';
  return '其他';
}

// ---- Product Version Detail Page (admin/super_admin only) ----

function productVersionDetailPage(sess, productId, ADMIN_NAV) {
  const db = getDb();
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
  if (!product) return null;

  const versions = db.prepare('SELECT * FROM product_versions WHERE product_id = ? ORDER BY release_date DESC, id DESC').all(productId);

  const versionCards = versions.map(v => {
    const firmwareLink = v.firmware_path
      ? `<a href="/api/product-versions/${productId}/versions/${v.id}/download">${escapeHtml(v.firmware_name || '下载')}</a>`
      : '<span style="color:#6e6e73;">—</span>';
    const imgHtml = product.image_path
      ? `<img src="${product.image_path.replace(/"/g,'&quot;')}" alt="${product.model_name.replace(/"/g,'&quot;')}" style="max-width:100%;max-height:100%;object-fit:contain;object-position:center;">`
      : '<div style="color:#cbd5e1;font-size:2rem;display:flex;align-items:center;justify-content:center;width:100%;height:100%;">📷</div>';
    
    return `<div class="version-card" data-vid="${v.id}">
      <div class="card-image">${imgHtml}</div>
      <div class="card-header" onclick="toggleDetail(this)">
        <h3>${escapeHtml(v.sw_version)}</h3>
        <div class="card-meta">
          <span>硬件: <strong style="font-weight:600;color:#1d1d1f">${escapeHtml(v.hw_version)}</strong></span>
          <span>发布: <strong style="font-weight:600;color:#1d1d1f">${escapeHtml(v.release_date)}</strong></span>
          <span>固件: ${firmwareLink}</span>
        </div>
        <div style="margin-top:10px;color:#6e6e73;font-size:13px;line-height:1.5">${escapeHtml(v.changelog).replace(/\n/g, '<br>')}</div>
      </div>
      <div class="card-detail" id="detail-${v.id}">
        <div class="card-detail-content">
          <div class="card-detail-label">附件</div>
          <div id="filelist-${v.id}" class="file-list"><p style="font-size:13px;color:#6e6e73;">加载中…</p></div>
          <div class="file-upload">
            <select id="label-${v.id}" class="input-field text-xs" style="width:140px!important;padding:6px 10px!important">
              <option value="">选择标签…</option>
              ${PRESET_LABELS.map(l => `<option value="${escapeHtml(l)}">${escapeHtml(l)}</option>`).join('')}
              <option value="__custom__">自定义…</option>
            </select>
            <input id="customlabel-${v.id}" placeholder="自定义标签" class="input-field text-xs hidden" style="width:120px!important;padding:6px 10px!important">
            <input type="file" id="file-${v.id}" class="text-xs" style="width:auto!important">
            <button onclick="uploadFile(${productId},${v.id})" class="btn-primary text-xs py-1.5 px-3">上传</button>
          </div>
        </div>
      </div>
    </div>`;
  }).join('');

  const headerHtml = getAdminHeaderHtml(sess.display_name || sess.username);
  const body = `${headerHtml}
<div style="padding-top:72px;" class="max-w-7xl mx-auto px-6 py-10">
    <div class="flex items-center gap-3 mb-8">
      <a href="/admin/product-versions" class="text-blue-600 hover:underline text-sm">← 返回</a>
      <h2 style="font-size:20px;font-weight:700;color:#111;margin:0;">
        ${escapeHtml(product.model_name)} <span class="text-gray-400 font-normal text-lg">(${escapeHtml(product.model_code || '')})</span>
      </h2>
    </div>
    <div class="flex items-center justify-between mb-6">
      <h3 style="font-size:16px;font-weight:600;color:#1d1d1f;margin:0">版本列表</h3>
      <a href="/admin/product-versions/${productId}/versions/new" class="btn-primary">+ 新增版本</a>
    </div>
    ${versions.length === 0 ? '<p class="text-gray-400 text-center py-16">还没有版本记录</p>' : `
    <div class="version-grid">${versionCards}</div>`}
  </div>
  <script>
  function toggleDetail(headerEl) {
    const card = headerEl.parentElement;
    const detailEl = card.querySelector('.card-detail');
    const vid = card.dataset.vid;
    detailEl.classList.toggle('show');
    if (detailEl.classList.contains('show')) {
      loadFiles(${productId}, vid);
    }
  }

  document.querySelectorAll('select[id^="label-"]').forEach(function(sel) {
    sel.addEventListener('change', function() {
      var vid = sel.id.replace('label-', '');
      var custom = document.getElementById('customlabel-' + vid);
      if (sel.value === '__custom__') { custom.classList.remove('hidden'); }
      else { custom.classList.add('hidden'); }
    });
  });

  function loadFiles(productId, vid) {
    fetch('/api/product-versions/' + productId + '/versions/' + vid + '/files')
      .then(function(r) { return r.json(); })
      .then(function(d) {
        var container = document.getElementById('filelist-' + vid);
        if (!d.ok || !d.files.length) {
          container.innerHTML = '<p style="font-size:13px;color:#6e6e73;">暂无附件</p>';
          return;
        }
        container.innerHTML = d.files.map(function(f) {
          return '<div class="file-item">' +
            '<span class="badge">' + f.label + '</span>' +
            '<a href="/api/product-versions/' + productId + '/versions/' + vid + '/files/' + f.id + '/download">' + f.file_name + '</a>' +
          '</div>';
        }).join('');
      });
  }

  function uploadFile(productId, vid) {
    var sel = document.getElementById('label-' + vid);
    var label = sel.value === '__custom__' ? document.getElementById('customlabel-' + vid).value.trim() : sel.value;
    var fileInput = document.getElementById('file-' + vid);
    if (!label || !fileInput.files[0]) { alert('请选择标签和文件'); return; }
    var fd = new FormData();
    fd.append('label', label);
    fd.append('file', fileInput.files[0]);
    fetch('/api/product-versions/' + productId + '/versions/' + vid + '/files', { method: 'POST', body: fd })
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (d.ok) {
          loadFiles(productId, vid);
          sel.value = '';
          document.getElementById('customlabel-' + vid).value = '';
          document.getElementById('customlabel-' + vid).classList.add('hidden');
          fileInput.value = '';
        } else { alert(d.msg || '上传失败'); }
      });
  }
  </script>`;

  return pageShell('版本管理 - ' + product.model_name, ADMIN_NAV('product-versions', sess.role), body);
}

// ---- Dev Product History Page (dev role only, read-only) ----

function devProductHistoryPage(sess, productId) {
  const db = getDb();
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
  if (!product) return null;

  const versions = db.prepare('SELECT * FROM product_versions WHERE product_id = ? ORDER BY release_date DESC, id DESC').all(productId);

  const versionCards = versions.map(v => {
    const files = db.prepare('SELECT id, label, file_name FROM product_version_files WHERE version_id = ? ORDER BY created_at ASC').all(v.id);

    const firmwareHtml = v.firmware_path
      ? `<div style="display:flex;align-items:center;gap:8px;font-size:13px;margin-bottom:8px;">
          <span style="background:#e8f4fd;padding:2px 8px;border-radius:6px;font-size:11px;color:#1d6fa5;border:1px solid #bde0f7;white-space:nowrap;">固件</span>
          <a href="/api/product-versions/${productId}/versions/${v.id}/download" style="color:#2563eb;text-decoration:none;">${escapeHtml(v.firmware_name || '下载固件')}</a>
        </div>`
      : '';

    const filesHtml = files.map(f =>
      `<div style="display:flex;align-items:center;gap:8px;font-size:13px;margin-bottom:8px;">
        <span style="background:#f3f4f6;padding:2px 8px;border-radius:6px;font-size:11px;color:#6b7280;border:1px solid #e5e7eb;white-space:nowrap;">${escapeHtml(f.label)}</span>
        <a href="/api/product-versions/${productId}/versions/${v.id}/files/${f.id}/download" style="color:#2563eb;text-decoration:none;">${escapeHtml(f.file_name)}</a>
      </div>`
    ).join('');

    const hasAttachments = v.firmware_path || files.length > 0;

    const imgHtml = product.image_path
      ? `<img src="${product.image_path.replace(/"/g,'&quot;')}" alt="${product.model_name.replace(/"/g,'&quot;')}" style="max-width:100%;max-height:100%;object-fit:contain;object-position:center;">`
      : '<div style="color:#cbd5e1;font-size:2rem;display:flex;align-items:center;justify-content:center;width:100%;height:100%;">📷</div>';

    return `<div style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.08);margin-bottom:16px;">
      <div style="width:100%;height:200px;background:#ffffff;display:flex;align-items:center;justify-content:center;overflow:hidden;padding:16px;">${imgHtml}</div>
      <div style="padding:20px;">
      <div style="margin-bottom:12px;">
        <div style="font-size:16px;font-weight:600;color:#111;margin-bottom:4px;">软件版本：${escapeHtml(v.sw_version)}</div>
        <div style="font-size:13px;color:#6b7280;">硬件版本：${escapeHtml(v.hw_version)} &nbsp;·&nbsp; 发布日期：${escapeHtml(v.release_date)}</div>
      </div>
      ${v.changelog ? `<div style="font-size:13px;color:#374151;line-height:1.6;margin-bottom:14px;padding:10px 12px;background:#f9fafb;border-radius:8px;border-left:3px solid #d1d5db;">${escapeHtml(v.changelog).replace(/\n/g, '<br>')}</div>` : ''}
      <div>
        <div style="font-size:12px;font-weight:500;color:#9ca3af;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;">附件下载</div>
        ${hasAttachments ? firmwareHtml + filesHtml : '<span style="font-size:13px;color:#9ca3af;">暂无附件</span>'}
      </div>
    </div>`;
  }).join('');

  const headerHtml = getDevHeaderHtml(sess);
  const body = `${headerHtml}
<div style="padding-top:72px;" class="max-w-4xl mx-auto px-6 py-8">
  <div style="display:flex;align-items:center;gap:12px;margin-bottom:24px;">
    <a href="/admin/product-versions" style="color:#2563eb;font-size:13px;text-decoration:none;padding:5px 14px;border:1px solid #d1d5db;border-radius:8px;font-weight:500;">← 返回</a>
    <div>
      <h2 style="font-size:20px;font-weight:700;color:#111;margin:0;">${escapeHtml(product.model_name)}</h2>
      <div style="font-size:13px;color:#6b7280;margin-top:2px;">型号：${escapeHtml(product.model_code || '')}</div>
    </div>
  </div>
  ${versions.length === 0
    ? '<div style="text-align:center;color:#9ca3af;padding:60px 0;">暂无版本记录</div>'
    : `<div style="margin-bottom:16px;font-size:14px;font-weight:500;color:#6b7280;">历史版本（共 ${versions.length} 个）</div>${versionCards}`}
</div>`;

  return pageShell('历史版本 - ' + product.model_name, '', body);
}

// ---- New Version Page ----

function newVersionPage(sess, productId, ADMIN_NAV) {
  const db = getDb();
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
  if (!product) return null;

  const headerHtml = getAdminHeaderHtml(sess.display_name || sess.username);
  const body = `${headerHtml}
<div style="padding-top:72px;" class="max-w-2xl mx-auto px-6 py-10">
    <div class="flex items-center gap-3 mb-8">
      <a href="/admin/product-versions/${productId}" class="text-blue-600 hover:underline text-sm">← 返回</a>
      <h2 style="font-size:20px;font-weight:700;color:#111;margin:0;">新增版本 — ${escapeHtml(product.model_name)}</h2>
    </div>
    <form id="vform" class="space-y-5">
      <div class="grid grid-cols-2 gap-4">
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1.5">硬件版本号 *</label>
          <input name="hw_version" required class="input-field" placeholder="例：V1.0">
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1.5">软件版本号 *</label>
          <input name="sw_version" required class="input-field" placeholder="例：1.2.3">
        </div>
      </div>
      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1.5">发布日期 *</label>
        <input name="release_date" type="date" required class="input-field">
      </div>
      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1.5">变更说明 *</label>
        <textarea name="changelog" required rows="5" class="input-field resize-none" placeholder="描述本版本的更新内容、修复的问题等"></textarea>
      </div>
      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1.5">固件文件（可选）</label>
        <input name="firmware" type="file" class="input-field" style="padding:8px!important">
      </div>

      <div>
        <div class="flex items-center justify-between mb-3">
          <label class="block text-sm font-medium text-gray-700">附件（可选）</label>
          <button type="button" onclick="addFileRow()" class="text-blue-600 text-sm hover:underline">+ 添加附件</button>
        </div>
        <div id="file-rows" class="space-y-3"></div>
      </div>

      <p id="vform-error" class="text-red-500 text-sm hidden"></p>
      <div class="flex gap-3 pt-2">
        <button type="submit" id="vform-btn" class="btn-primary">保存版本</button>
        <a href="/admin/product-versions/${productId}" class="btn-secondary">取消</a>
      </div>
    </form>
  </div>
  <script>
  var fileRowIdx = 0;
  var PRESET_LABELS = ${JSON.stringify(PRESET_LABELS)};

  function addFileRow() {
    fileRowIdx++;
    var id = fileRowIdx;
    var container = document.getElementById('file-rows');
    var div = document.createElement('div');
    div.className = 'flex items-start gap-3 bg-gray-50 rounded-xl p-3';
    div.id = 'frow-' + id;
    div.innerHTML = '<div class="flex-1 space-y-2">' +
      '<div class="flex gap-2">' +
        '<select id="flabel-'+id+'" class="input-field text-sm" style="flex:1">' +
          '<option value="">选择标签…</option>' +
          PRESET_LABELS.map(function(l){ return '<option value="'+l+'">'+l+'</option>'; }).join('') +
          '<option value="__custom__">自定义…</option>' +
        '</select>' +
        '<input id="fcustom-'+id+'" placeholder="自定义标签" class="input-field text-sm hidden" style="flex:1">' +
      '</div>' +
      '<input type="file" id="ffile-'+id+'" class="input-field text-sm" style="padding:6px!important">' +
    '</div>' +
    '<button type="button" onclick="removeFileRow('+id+')" class="text-red-400 hover:text-red-600 text-lg mt-1 px-1" title="删除">×</button>';
    container.appendChild(div);
    document.getElementById('flabel-'+id).addEventListener('change', function() {
      var custom = document.getElementById('fcustom-'+id);
      if (this.value === '__custom__') custom.classList.remove('hidden');
      else custom.classList.add('hidden');
    });
  }

  function removeFileRow(id) {
    var el = document.getElementById('frow-' + id);
    if (el) el.remove();
  }

  document.getElementById('vform').addEventListener('submit', async function(e) {
    e.preventDefault();
    var btn = document.getElementById('vform-btn');
    var errEl = document.getElementById('vform-error');
    btn.disabled = true;
    btn.textContent = '保存中…';
    errEl.classList.add('hidden');

    var fd = new FormData(this);
    try {
      var res = await fetch('/api/product-versions/${productId}/versions', { method: 'POST', body: fd });
      var data = await res.json();
      if (!data.ok) { throw new Error(data.msg || '创建失败'); }
      var versionId = data.id;

      // Upload file attachments
      var rows = document.querySelectorAll('[id^="frow-"]');
      for (var i = 0; i < rows.length; i++) {
        var rowId = rows[i].id.replace('frow-', '');
        var sel = document.getElementById('flabel-' + rowId);
        var label = sel.value === '__custom__' ? document.getElementById('fcustom-' + rowId).value.trim() : sel.value;
        var fileInput = document.getElementById('ffile-' + rowId);
        if (label && fileInput.files[0]) {
          var ffd = new FormData();
          ffd.append('label', label);
          ffd.append('file', fileInput.files[0]);
          await fetch('/api/product-versions/${productId}/versions/' + versionId + '/files', { method: 'POST', body: ffd });
        }
      }

      window.location.href = '/admin/product-versions/${productId}';
    } catch(err) {
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
      btn.disabled = false;
      btn.textContent = '保存版本';
    }
  });
  </script>`;

  return pageShell('新增版本 - ' + product.model_name, ADMIN_NAV('product-versions', sess.role), body);
}

// ---- Download Logs Page ----

function downloadLogsPage(sess, query, ADMIN_NAV) {
  const db = getDb();
  const page = parseInt(query.page || '1', 10) || 1;
  const pageSize = 50;
  const offset = (page - 1) * pageSize;

  const total = db.prepare('SELECT COUNT(*) as c FROM product_version_download_logs').get().c;
  const logs = db.prepare('SELECT * FROM product_version_download_logs ORDER BY downloaded_at DESC LIMIT ? OFFSET ?').all(pageSize, offset);
  const totalPages = Math.ceil(total / pageSize);

  const rows = logs.map(l => `<tr class="hover:bg-gray-50">
    <td class="px-6 py-3 text-sm">${escapeHtml(l.downloaded_at)}</td>
    <td class="px-6 py-3 text-sm">${escapeHtml(l.username)}</td>
    <td class="px-6 py-3 text-sm">${escapeHtml(l.product_name)}</td>
    <td class="px-6 py-3 text-sm">${escapeHtml(l.sw_version)}</td>
    <td class="px-6 py-3 text-sm">${escapeHtml(l.file_name)}</td>
    <td class="px-6 py-3 text-sm">${escapeHtml(l.file_type)}</td>
    <td class="px-6 py-3 text-sm text-gray-400">${escapeHtml(l.ip)}</td>
  </tr>`).join('');

  const pager = totalPages > 1 ? `<div class="flex items-center justify-center gap-2 mt-6">${
    Array.from({ length: totalPages }, (_, i) => i + 1).map(p =>
      `<a href="/admin/product-versions/download-logs?page=${p}" class="px-3 py-1 rounded text-sm ${p === page ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}">${p}</a>`
    ).join('')
  }</div>` : '';

  const headerHtml = getAdminHeaderHtml(sess.display_name || sess.username);
  const body = `${headerHtml}
<div style="padding-top:72px;" class="max-w-6xl mx-auto px-6 py-10">
    <div class="flex items-center gap-3 mb-8">
      <a href="/admin/product-versions" class="text-blue-600 hover:underline text-sm">← 返回</a>
      <h2 style="font-size:20px;font-weight:700;color:#111;margin:0;">下载日志</h2>
      <span class="text-sm text-gray-400 ml-2">(共 ${total} 条)</span>
    </div>
    ${logs.length === 0 ? '<p class="text-gray-400 text-center py-16">暂无下载记录</p>' : `
    <div class="bg-white rounded-2xl border border-gray-200 overflow-hidden">
      <table class="w-full text-sm">
        <thead class="bg-gray-50 text-gray-500 text-xs uppercase tracking-wide">
          <tr>
            <th class="px-6 py-3 text-left">时间</th>
            <th class="px-6 py-3 text-left">用户</th>
            <th class="px-6 py-3 text-left">产品</th>
            <th class="px-6 py-3 text-left">版本</th>
            <th class="px-6 py-3 text-left">文件</th>
            <th class="px-6 py-3 text-left">类型</th>
            <th class="px-6 py-3 text-left">IP</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-gray-200">${rows}</tbody>
      </table>
    </div>
    ${pager}`}
  </div>`;

  return pageShell('下载日志', ADMIN_NAV('product-versions', sess.role), body);
}

// ---- API handlers ----

function apiCreateVersion(productId, body, headers, sess) {
  const ct = headers['content-type'] || '';
  const bm = ct.match(/boundary=(.+)/i);
  if (!bm) return jsonResp({ ok: false, msg: '需要 multipart/form-data' }, 400);

  const parts = parseMultipart(body, bm[1].trim());
  const fields = {};
  let firmwareData = null;
  let firmwareFilename = null;
  for (const p of parts) {
    if (p.filename) {
      if (p.name === 'firmware') {
        firmwareData = p.data;
        firmwareFilename = p.filename;
      }
    } else {
      fields[p.name] = p.data.toString('utf8');
    }
  }

  const { hw_version, sw_version, release_date, changelog } = fields;
  if (!hw_version || !sw_version || !release_date || !changelog) {
    return jsonResp({ ok: false, msg: '缺少必填字段' }, 400);
  }

  let firmwarePath = null;
  let firmwareName = null;
  if (firmwareData && firmwareData.length > 0) {
    const ext = nodePath.extname(firmwareFilename || '').toLowerCase() || '.bin';
    const uuid = crypto.randomUUID();
    firmwareName = firmwareFilename;
    const filename = uuid + ext;
    fs.writeFileSync(nodePath.join(VER_FIRMWARE_DIR, filename), firmwareData);
    firmwarePath = filename;
  }

  const db = getDb();
  const existing = db.prepare('SELECT id FROM products WHERE id = ?').get(productId);
  if (!existing) return jsonResp({ ok: false, msg: '产品不存在' }, 404);

  try {
    const result = db.prepare(
      'INSERT INTO product_versions (product_id, hw_version, sw_version, release_date, changelog, firmware_path, firmware_name) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(productId, hw_version, sw_version, release_date, changelog, firmwarePath, firmwareName);
    return jsonResp({ ok: true, id: result.lastInsertRowid }, 201);
  } catch (e) {
    if (e.message && e.message.includes('UNIQUE')) {
      return jsonResp({ ok: false, msg: '该软件版本号已存在' }, 409);
    }
    return jsonResp({ ok: false, msg: '创建失败: ' + e.message }, 500);
  }
}

function apiUploadFile(productId, versionId, body, headers, sess) {
  const ct = headers['content-type'] || '';
  const bm = ct.match(/boundary=(.+)/i);
  if (!bm) return jsonResp({ ok: false, msg: '需要 multipart/form-data' }, 400);

  const parts = parseMultipart(body, bm[1].trim());
  let label = '';
  let fileData = null;
  let fileName = null;
  for (const p of parts) {
    if (p.name === 'label' && !p.filename) label = p.data.toString('utf8');
    if (p.name === 'file' && p.filename) {
      fileData = p.data;
      fileName = p.filename;
    }
  }

  if (!label || !fileData || fileData.length === 0) {
    return jsonResp({ ok: false, msg: '缺少标签或文件' }, 400);
  }

  const db = getDb();
  const version = db.prepare('SELECT id FROM product_versions WHERE id = ? AND product_id = ?').get(versionId, productId);
  if (!version) return jsonResp({ ok: false, msg: '版本不存在' }, 404);

  const ext = nodePath.extname(fileName || '').toLowerCase() || '.bin';
  const uuid = crypto.randomUUID();
  const filename = uuid + ext;
  fs.writeFileSync(nodePath.join(VER_FILES_DIR, filename), fileData);

  const result = db.prepare(
    'INSERT INTO product_version_files (version_id, label, file_path, file_name) VALUES (?, ?, ?, ?)'
  ).run(versionId, label, filename, fileName);

  return jsonResp({ ok: true, id: result.lastInsertRowid }, 201);
}

function apiListFiles(productId, versionId) {
  const db = getDb();
  const files = db.prepare('SELECT id, label, file_name, created_at FROM product_version_files WHERE version_id = ? ORDER BY created_at ASC').all(versionId);
  return jsonResp({ ok: true, files });
}

function apiDownloadFirmware(productId, versionId, sess, headers) {
  const db = getDb();
  const version = db.prepare('SELECT * FROM product_versions WHERE id = ? AND product_id = ?').get(versionId, productId);
  if (!version || !version.firmware_path) return jsonResp({ ok: false, msg: 'Not found' }, 404);

  const filePath = nodePath.join(VER_FIRMWARE_DIR, version.firmware_path);
  if (!fs.existsSync(filePath)) return jsonResp({ ok: false, msg: 'File not found on disk' }, 404);

  const product = db.prepare('SELECT model_name FROM products WHERE id = ?').get(productId);
  const filename = version.firmware_name || nodePath.basename(filePath);
  const ip = (headers['x-forwarded-for'] || '').split(',')[0].trim() || headers['x-real-ip'] || 'unknown';

  db.prepare(
    'INSERT INTO product_version_download_logs (username, ip, product_name, sw_version, file_name, file_type) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(sess.username, ip, product ? product.model_name : '', version.sw_version, filename, 'firmware');

  const buffer = fs.readFileSync(filePath);
  return {
    status: 200,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(filename)}"`,
      'Content-Length': String(buffer.length),
    },
    body: buffer,
  };
}

function apiDownloadFile(productId, versionId, fileId, sess, headers) {
  const db = getDb();
  const file = db.prepare(
    `SELECT vf.* FROM product_version_files vf
     JOIN product_versions v ON v.id = vf.version_id
     WHERE vf.id = ? AND v.id = ? AND v.product_id = ?`
  ).get(fileId, versionId, productId);

  if (!file) return jsonResp({ ok: false, msg: 'Not found' }, 404);

  const filePath = nodePath.join(VER_FILES_DIR, file.file_path);
  if (!fs.existsSync(filePath)) return jsonResp({ ok: false, msg: 'File not found on disk' }, 404);

  const product = db.prepare('SELECT model_name FROM products WHERE id = ?').get(productId);
  const version = db.prepare('SELECT sw_version FROM product_versions WHERE id = ?').get(versionId);
  const ip = (headers['x-forwarded-for'] || '').split(',')[0].trim() || headers['x-real-ip'] || 'unknown';

  db.prepare(
    'INSERT INTO product_version_download_logs (username, ip, product_name, sw_version, file_name, file_type) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(sess.username, ip, product ? product.model_name : '', version ? version.sw_version : '', file.file_name, 'attachment');

  const buffer = fs.readFileSync(filePath);
  return {
    status: 200,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(file.file_name)}"`,
      'Content-Length': String(buffer.length),
    },
    body: buffer,
  };
}

// ---- Main handler ----

function handleVersionHub(method, pathname, query, sess, body, headers, ADMIN_NAV) {
  if (!sess) return null;
  if (!isDevRole(sess.role)) return null;

  // Pages
  if (pathname === '/admin/product-versions' && method === 'GET') {
    return htmlResp(productVersionsPage(sess, ADMIN_NAV));
  }

  if (pathname === '/admin/product-versions/download-logs' && method === 'GET') {
    return htmlResp(downloadLogsPage(sess, query, ADMIN_NAV));
  }

  // /admin/product-versions/:id — admin/super_admin only management page
  const detailMatch = pathname.match(/^\/admin\/product-versions\/(\d+)$/);
  if (detailMatch && method === 'GET') {
    // dev role redirects to read-only history page
    if (sess.role === 'dev') {
      return { status: 302, headers: { Location: `/dev/product-versions/${detailMatch[1]}` }, body: '' };
    }
    const page = productVersionDetailPage(sess, parseInt(detailMatch[1], 10), ADMIN_NAV);
    if (!page) return jsonResp({ ok: false, msg: '产品不存在' }, 404);
    return htmlResp(page);
  }

  // /dev/product-versions/:id — dev role read-only history page
  const devDetailMatch = pathname.match(/^\/dev\/product-versions\/(\d+)$/);
  if (devDetailMatch && method === 'GET') {
    const page = devProductHistoryPage(sess, parseInt(devDetailMatch[1], 10));
    if (!page) return jsonResp({ ok: false, msg: '产品不存在' }, 404);
    return htmlResp(page);
  }

  // /admin/product-versions/:id/versions/new
  const newMatch = pathname.match(/^\/admin\/product-versions\/(\d+)\/versions\/new$/);
  if (newMatch && method === 'GET') {
    if (sess.role === 'dev') return null; // dev cannot create versions
    const page = newVersionPage(sess, parseInt(newMatch[1], 10), ADMIN_NAV);
    if (!page) return jsonResp({ ok: false, msg: '产品不存在' }, 404);
    return htmlResp(page);
  }

  // API: create version
  const createMatch = pathname.match(/^\/api\/product-versions\/(\d+)\/versions$/);
  if (createMatch && method === 'POST') {
    return apiCreateVersion(parseInt(createMatch[1], 10), body, headers, sess);
  }

  // API: list files for a version
  const listFilesMatch = pathname.match(/^\/api\/product-versions\/(\d+)\/versions\/(\d+)\/files$/);
  if (listFilesMatch && method === 'GET') {
    return apiListFiles(parseInt(listFilesMatch[1], 10), parseInt(listFilesMatch[2], 10));
  }

  // API: upload file to a version
  if (listFilesMatch && method === 'POST') {
    return apiUploadFile(parseInt(listFilesMatch[1], 10), parseInt(listFilesMatch[2], 10), body, headers, sess);
  }

  // API: download firmware
  const dlFirmwareMatch = pathname.match(/^\/api\/product-versions\/(\d+)\/versions\/(\d+)\/download$/);
  if (dlFirmwareMatch && method === 'GET') {
    return apiDownloadFirmware(parseInt(dlFirmwareMatch[1], 10), parseInt(dlFirmwareMatch[2], 10), sess, headers);
  }

  // API: download file attachment
  const dlFileMatch = pathname.match(/^\/api\/product-versions\/(\d+)\/versions\/(\d+)\/files\/(\d+)\/download$/);
  if (dlFileMatch && method === 'GET') {
    return apiDownloadFile(parseInt(dlFileMatch[1], 10), parseInt(dlFileMatch[2], 10), parseInt(dlFileMatch[3], 10), sess, headers);
  }

  return null;
}

module.exports = { handleVersionHub, ensureVersionTables };
