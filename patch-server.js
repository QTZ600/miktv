#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');

const SERVER_PATH = '/opt/quality-board/server.js';
let code = fs.readFileSync(SERVER_PATH, 'utf8');

// Backup
const backupName = `server.js.bak.${new Date().toISOString().replace(/[:-]/g,'').slice(0,15)}`;
fs.writeFileSync(path.join('/opt/quality-board', backupName), code);
console.log('Backup:', backupName);

let changed = false;

// 1. Add require for ai-analysis (after mes.js require)
if (!code.includes('ai-analysis')) {
  code = code.replace(
    "const { handleMes } = require('./mes');",
    "const { handleMes } = require('./mes');\nconst { handleAiAnalysis, ensureAiTables } = require('./ai-analysis');"
  );
  changed = true;
  console.log('✓ Added ai-analysis require');
}

// 2. Add AI routes before the 404 catch-all
if (!code.includes('handleAiAnalysis')) {
  const aiRouteBlock = `
  // ---- AI Analysis routes ----
  if (pathname.startsWith('/ai') || pathname.startsWith('/api/ai')) {
    if (!sess) {
      if (pathname.startsWith('/api')) return json({ ok: false, msg: '未登录' }, 401);
      return htmlRedirect('/login');
    }
    const aiResult = handleAiAnalysis(method, pathname, query, sess, body, headers);
    if (aiResult) return aiResult;
  }

`;
  // Insert before the final 404 return
  const marker = "  return { status: 404, headers: { 'Content-Type': 'text/plain' }, body: 'Not Found' };";
  if (code.includes(marker)) {
    code = code.replace(marker, aiRouteBlock + marker);
    changed = true;
    console.log('✓ Added AI routes');
  } else {
    console.error('✗ Could not find 404 marker in server.js');
  }
}

// 3. Add "AI 分析" tab to ADMIN_NAV (before 账号 link)
if (!code.includes('AI 分析')) {
  // The admin nav link pattern
  const adminLinkStart = `<a href="/admin" style="flex:1;text-align:center;padding:10px 8px;font-size:14px;font-weight:500;text-decoration:none;white-space:nowrap;\${active==='users'`;
  const aiTab = `<a href="/ai" style="flex:1;text-align:center;padding:10px 8px;font-size:14px;font-weight:500;text-decoration:none;white-space:nowrap;\${active==='ai'?'color:#111;border-bottom:2px solid #111;':'color:#9ca3af;border-bottom:2px solid transparent;'}">AI 分析</a>\n  `;

  if (code.includes(adminLinkStart)) {
    code = code.replace(adminLinkStart, aiTab + adminLinkStart);
    changed = true;
    console.log('✓ Added AI nav tab to ADMIN_NAV');
  } else {
    console.error('✗ Could not find admin nav link pattern');
  }
}

// 4. Add ensureAiTables() call in server startup
if (!code.includes('ensureAiTables()')) {
  const listenMarker = "server.listen(PORT, '0.0.0.0', async () => {";
  if (code.includes(listenMarker)) {
    code = code.replace(
      listenMarker,
      listenMarker + "\n  ensureAiTables();"
    );
    changed = true;
    console.log('✓ Added ensureAiTables() to startup');
  }
}

if (changed) {
  fs.writeFileSync(SERVER_PATH, code);
  console.log('Server.js patched successfully');
} else {
  console.log('No changes needed');
}
