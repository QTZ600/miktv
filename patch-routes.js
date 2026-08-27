#!/usr/bin/env node
'use strict';
const fs = require('fs');
const SERVER_PATH = '/opt/quality-board/server.js';
let code = fs.readFileSync(SERVER_PATH, 'utf8');

// Add AI routes before the 404 catch-all
const marker = "  return { status: 404, headers: { 'Content-Type': 'text/plain' }, body: 'Not Found' };";
const aiRouteBlock = `  // ---- AI Analysis routes ----
  if (pathname.startsWith('/ai') || pathname.startsWith('/api/ai')) {
    if (!sess) {
      if (pathname.startsWith('/api')) return json({ ok: false, msg: '未登录' }, 401);
      return htmlRedirect('/login');
    }
    const aiResult = handleAiAnalysis(method, pathname, query, sess, body, headers);
    if (aiResult) return aiResult;
  }

`;

if (!code.includes('aiResult = handleAiAnalysis')) {
  if (code.includes(marker)) {
    code = code.replace(marker, aiRouteBlock + marker);
    fs.writeFileSync(SERVER_PATH, code);
    console.log('✓ Added AI routes before 404');
  } else {
    console.error('✗ Could not find 404 marker');
  }
} else {
  console.log('AI routes already present');
}
