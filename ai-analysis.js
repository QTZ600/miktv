'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const { getDb } = require('./kv');
const XLSX = require('xlsx');

const AI_UPLOAD_DIR = path.join(__dirname, 'uploads', 'ai');
if (!fs.existsSync(AI_UPLOAD_DIR)) fs.mkdirSync(AI_UPLOAD_DIR, { recursive: true });

const MAX_AI_UPLOAD_SIZE = 20 * 1024 * 1024; // 20MB

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

// ---- DB init ----

function ensureAiTables() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS ai_analyses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL,
      original_name TEXT NOT NULL,
      file_type TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      extracted_text TEXT,
      ai_result TEXT,
      feishu_doc_url TEXT,
      error_msg TEXT,
      created_by TEXT,
      created_at INTEGER NOT NULL,
      completed_at INTEGER
    )
  `);
}

// ---- file parsing ----

async function extractTextFromPdf(filepath) {
  const PDFParser = require('pdf2json');
  return new Promise((resolve, reject) => {
    const parser = new PDFParser();
    parser.on('pdfParser_dataReady', data => {
      const text = data.Pages.map(p =>
        p.Texts.map(t => decodeURIComponent(t.R.map(r => r.T).join(''))).join(' ')
      ).join('\n');
      resolve(text);
    });
    parser.on('pdfParser_dataError', err => reject(new Error('PDF 解析失败: ' + (err.parserError || err))));
    parser.loadPDF(filepath);
  });
}

function extractTextFromExcel(filepath) {
  const wb = XLSX.readFile(filepath);
  const lines = [];
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    lines.push(`=== 工作表: ${name} ===`);
    const csv = XLSX.utils.sheet_to_csv(ws, { FS: '\t', RS: '\n' });
    lines.push(csv);
  }
  return lines.join('\n');
}

function isImageFile(ext) {
  return ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].includes(ext.toLowerCase());
}

function isPdfFile(ext) {
  return ext.toLowerCase() === '.pdf';
}

function isExcelFile(ext) {
  return ['.xls', '.xlsx', '.xlsm', '.csv'].includes(ext.toLowerCase());
}

// ---- LLM API (multi-backend) ----
//
// Supported backends via env vars:
//   1. OPENAI_API_KEY + OPENAI_BASE_URL  → OpenAI-compatible (DashScope, DeepSeek, Silicon Flow, etc.)
//   2. ANTHROPIC_API_KEY + ANTHROPIC_BASE_URL → Claude API
//
// Priority: OPENAI_API_KEY > ANTHROPIC_API_KEY
// AI_MODEL env overrides default model for either backend.

function getAiBackend() {
  if (process.env.OPENAI_API_KEY) {
    return {
      type: 'openai',
      apiKey: process.env.OPENAI_API_KEY,
      baseUrl: process.env.OPENAI_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode',
      model: process.env.AI_MODEL || 'qwen-plus',
      visionModel: process.env.AI_VISION_MODEL || process.env.AI_MODEL || 'qwen-vl-plus',
    };
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return {
      type: 'anthropic',
      apiKey: process.env.ANTHROPIC_API_KEY,
      baseUrl: process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
      model: process.env.AI_MODEL || 'claude-sonnet-4-20250514',
      visionModel: process.env.AI_VISION_MODEL || process.env.AI_MODEL || 'claude-sonnet-4-20250514',
    };
  }
  return null;
}

function httpPost(url, headers, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === 'https:';
    const transport = isHttps ? https : http;
    const opts = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers,
    };
    const req = transport.request(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try { resolve({ status: res.statusCode, data: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, data: raw }); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

const ANALYSIS_SYSTEM_PROMPT = `你是雷石公司的质量分析专家。请分析质量管理相关文件内容，输出结构化的分析报告。

要求：
1. **问题点摘要**：列出文件中发现的所有质量问题，每个问题用一句话概括
2. **问题分类**：将问题归纳到合适的类别（如：外观缺陷、功能故障、连接问题、音频问题、结构问题、包装问题、其他）
3. **严重程度评估**：对每个问题评估严重等级（严重/一般/轻微），并说明判断依据
4. **趋势与建议**：如有多个问题，分析是否存在共性趋势，给出改进建议

请用 Markdown 格式输出。`;

const IMAGE_ANALYSIS_PROMPT = `你是雷石公司的质量分析专家。这是一份质量管理相关的文件图片（可能是验货报告、维修记录、质检单等）。

请：
1. 先提取图片中的所有文字内容
2. 然后基于提取的内容，输出结构化的分析报告：
   - **问题点摘要**：列出发现的所有质量问题
   - **问题分类**：归纳到合适的类别（外观缺陷、功能故障、连接问题、音频问题、结构问题、包装问题、其他）
   - **严重程度评估**：每个问题的严重等级（严重/一般/轻微）及判断依据
   - **趋势与建议**：共性趋势分析和改进建议

请用 Markdown 格式输出。`;

// ---- OpenAI-compatible backend ----

async function callOpenAIText(backend, textContent) {
  const payload = {
    model: backend.model,
    max_tokens: 4096,
    messages: [
      { role: 'system', content: ANALYSIS_SYSTEM_PROMPT },
      { role: 'user', content: '请分析以下文件内容：\n\n' + textContent.slice(0, 50000) },
    ],
  };

  const resp = await httpPost(`${backend.baseUrl}/v1/chat/completions`, {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${backend.apiKey}`,
  }, JSON.stringify(payload));

  if (resp.status !== 200) {
    const errMsg = typeof resp.data === 'object' ? JSON.stringify(resp.data) : resp.data;
    throw new Error(`AI API 错误 (${resp.status}): ${errMsg}`);
  }

  const choice = resp.data.choices && resp.data.choices[0];
  if (!choice || !choice.message) throw new Error('AI API 返回空内容');
  return choice.message.content;
}

async function callOpenAIVision(backend, imageBuffer, mimeType) {
  const b64 = imageBuffer.toString('base64');
  const mediaType = mimeType || 'image/jpeg';

  const payload = {
    model: backend.visionModel,
    max_tokens: 4096,
    messages: [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: `data:${mediaType};base64,${b64}` } },
        { type: 'text', text: IMAGE_ANALYSIS_PROMPT },
      ],
    }],
  };

  const resp = await httpPost(`${backend.baseUrl}/v1/chat/completions`, {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${backend.apiKey}`,
  }, JSON.stringify(payload));

  if (resp.status !== 200) {
    const errMsg = typeof resp.data === 'object' ? JSON.stringify(resp.data) : resp.data;
    throw new Error(`AI Vision API 错误 (${resp.status}): ${errMsg}`);
  }

  const choice = resp.data.choices && resp.data.choices[0];
  if (!choice || !choice.message) throw new Error('AI Vision API 返回空内容');
  return choice.message.content;
}

// ---- Anthropic backend ----

async function callAnthropicText(backend, textContent) {
  const payload = {
    model: backend.model,
    max_tokens: 4096,
    messages: [{ role: 'user', content: ANALYSIS_SYSTEM_PROMPT + '\n\n---\n\n文件内容：\n\n' + textContent.slice(0, 50000) }],
  };

  const resp = await httpPost(`${backend.baseUrl}/v1/messages`, {
    'Content-Type': 'application/json',
    'x-api-key': backend.apiKey,
    'anthropic-version': '2023-06-01',
  }, JSON.stringify(payload));

  if (resp.status !== 200) {
    const errMsg = typeof resp.data === 'object' ? JSON.stringify(resp.data) : resp.data;
    throw new Error(`Claude API 错误 (${resp.status}): ${errMsg}`);
  }

  const content = resp.data.content;
  if (!content || !content.length) throw new Error('Claude API 返回空内容');
  return content.map(c => c.text || '').join('\n');
}

async function callAnthropicVision(backend, imageBuffer, mimeType) {
  const b64 = imageBuffer.toString('base64');
  const mediaType = mimeType || 'image/jpeg';

  const payload = {
    model: backend.visionModel,
    max_tokens: 4096,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: b64 } },
        { type: 'text', text: IMAGE_ANALYSIS_PROMPT },
      ],
    }],
  };

  const resp = await httpPost(`${backend.baseUrl}/v1/messages`, {
    'Content-Type': 'application/json',
    'x-api-key': backend.apiKey,
    'anthropic-version': '2023-06-01',
  }, JSON.stringify(payload));

  if (resp.status !== 200) {
    const errMsg = typeof resp.data === 'object' ? JSON.stringify(resp.data) : resp.data;
    throw new Error(`Claude Vision API 错误 (${resp.status}): ${errMsg}`);
  }

  const content = resp.data.content;
  if (!content || !content.length) throw new Error('Claude Vision API 返回空内容');
  return content.map(c => c.text || '').join('\n');
}

// ---- Unified AI call ----

async function callAiText(textContent) {
  const backend = getAiBackend();
  if (!backend) throw new Error('未配置 AI API Key。请在 ecosystem.config.js 中设置 OPENAI_API_KEY（推荐，兼容 DashScope/DeepSeek/硅基流动等）或 ANTHROPIC_API_KEY。');
  if (backend.type === 'openai') return callOpenAIText(backend, textContent);
  return callAnthropicText(backend, textContent);
}

async function callAiVision(imageBuffer, mimeType) {
  const backend = getAiBackend();
  if (!backend) throw new Error('未配置 AI API Key。请在 ecosystem.config.js 中设置 OPENAI_API_KEY（推荐，兼容 DashScope/DeepSeek/硅基流动等）或 ANTHROPIC_API_KEY。');
  if (backend.type === 'openai') return callOpenAIVision(backend, imageBuffer, mimeType);
  return callAnthropicVision(backend, imageBuffer, mimeType);
}

// ---- Feishu doc generation ----

async function createFeishuDoc(title, markdownContent) {
  const { execSync } = require('child_process');

  // Write content to temp file to avoid shell escaping issues
  const tmpFile = path.join(AI_UPLOAD_DIR, `_tmp_doc_${Date.now()}.md`);
  fs.writeFileSync(tmpFile, markdownContent, 'utf8');

  try {
    const cmd = `lark-cli docs +create --as bot --title "${title.replace(/"/g, '\\"')}" --body-file "${tmpFile}" --output json 2>&1`;
    const output = execSync(cmd, { timeout: 30000, encoding: 'utf8' });

    // Parse output - look for JSON with url
    const lines = output.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('{')) {
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed.url) return parsed.url;
          if (parsed.document && parsed.document.url) return parsed.document.url;
        } catch {}
      }
    }

    // Fallback: look for URL pattern in output
    const urlMatch = output.match(/https?:\/\/[^\s"]+\/docx\/[^\s"]+/);
    if (urlMatch) return urlMatch[0];

    console.error('[feishu doc] unexpected output:', output);
    return null;
  } catch (e) {
    console.error('[feishu doc error]', e.message);
    return null;
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

// ---- analysis pipeline ----

async function runAnalysis(analysisId) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM ai_analyses WHERE id = ?').get(analysisId);
  if (!row) return;

  db.prepare('UPDATE ai_analyses SET status = ? WHERE id = ?').run('analyzing', analysisId);

  try {
    const filepath = path.join(AI_UPLOAD_DIR, row.filename);
    const ext = path.extname(row.original_name).toLowerCase();
    let aiResult;

    if (isImageFile(ext)) {
      // Image: use Claude Vision directly
      const imgBuf = fs.readFileSync(filepath);
      const mimeMap = {
        '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.png': 'image/png', '.gif': 'image/gif',
        '.webp': 'image/webp', '.bmp': 'image/bmp',
      };
      aiResult = await callAiVision(imgBuf, mimeMap[ext] || 'image/jpeg');
      db.prepare('UPDATE ai_analyses SET extracted_text = ? WHERE id = ?')
        .run('[图片文件 - 由 AI 直接识别]', analysisId);

    } else if (isPdfFile(ext)) {
      // PDF: extract text then analyze
      const text = await extractTextFromPdf(filepath);
      if (!text || text.trim().length < 10) {
        // PDF might be scanned image - try vision on first page
        // Fallback: inform user
        throw new Error('PDF 文件未提取到有效文字内容。如果是扫描件，请转换为图片格式后重新上传。');
      }
      db.prepare('UPDATE ai_analyses SET extracted_text = ? WHERE id = ?').run(text, analysisId);
      aiResult = await callAiText(text);

    } else if (isExcelFile(ext)) {
      // Excel: parse to text then analyze
      const text = extractTextFromExcel(filepath);
      db.prepare('UPDATE ai_analyses SET extracted_text = ? WHERE id = ?').run(text, analysisId);
      aiResult = await callAiText(text);

    } else {
      throw new Error(`不支持的文件类型: ${ext}`);
    }

    // Save AI result
    db.prepare('UPDATE ai_analyses SET ai_result = ? WHERE id = ?').run(aiResult, analysisId);

    // Generate Feishu doc
    const docTitle = `AI质量分析 - ${row.original_name} - ${fmtTime(Date.now())}`;
    const docContent = `> 文件: ${row.original_name} | 分析时间: ${fmtTime(Date.now())} | 分析者: AI\n\n${aiResult}`;
    const docUrl = await createFeishuDoc(docTitle, docContent);

    db.prepare('UPDATE ai_analyses SET status = ?, feishu_doc_url = ?, completed_at = ? WHERE id = ?')
      .run('completed', docUrl, Date.now(), analysisId);

  } catch (e) {
    console.error(`[ai-analysis] Error for id=${analysisId}:`, e.message);
    db.prepare('UPDATE ai_analyses SET status = ?, error_msg = ?, completed_at = ? WHERE id = ?')
      .run('failed', e.message, Date.now(), analysisId);
  }
}

// ---- multipart parser (simplified) ----

function parseMultipartAi(body, boundary) {
  const sep = Buffer.from('--' + boundary);
  const parts = [];
  let start = 0;
  while (true) {
    const idx = body.indexOf(sep, start);
    if (idx < 0) break;
    if (start > 0) {
      const chunk = body.slice(start, idx);
      const headerEnd = chunk.indexOf('\r\n\r\n');
      if (headerEnd >= 0) {
        const headerStr = chunk.slice(0, headerEnd).toString('utf8');
        const data = chunk.slice(headerEnd + 4, chunk.length - 2); // strip trailing \r\n
        const nameMatch = headerStr.match(/name="([^"]+)"/);
        const fnMatch = headerStr.match(/filename="([^"]+)"/);
        const ctMatch = headerStr.match(/Content-Type:\s*(.+)/i);
        parts.push({
          name: nameMatch ? nameMatch[1] : '',
          filename: fnMatch ? fnMatch[1] : null,
          contentType: ctMatch ? ctMatch[1].trim() : null,
          data,
          text: !fnMatch ? data.toString('utf8').trim() : null,
        });
      }
    }
    start = idx + sep.length;
    if (body[start] === 0x2D && body[start + 1] === 0x2D) break; // --
    start += 2; // skip \r\n
  }
  return parts;
}

// ---- route handler ----

function handleAiAnalysis(method, pathname, query, sess, body, headers) {
  if (!pathname.startsWith('/ai') && !pathname.startsWith('/api/ai')) return null;

  // Page route
  if (pathname === '/ai' && method === 'GET') {
    return htmlResp(aiAnalysisPage(sess));
  }

  // API: upload and analyze
  if (pathname === '/api/ai/upload' && method === 'POST') {
    const ct = (headers || {})['content-type'] || '';
    const boundaryMatch = ct.match(/boundary=(.+)/i);
    if (!boundaryMatch) return jsonResp({ ok: false, msg: 'Content-Type must be multipart/form-data' }, 400);

    const parts = parseMultipartAi(body, boundaryMatch[1].trim());
    const filePart = parts.find(p => p.name === 'file' && p.filename);
    if (!filePart) return jsonResp({ ok: false, msg: '未找到上传文件' }, 400);

    if (filePart.data.length > MAX_AI_UPLOAD_SIZE) {
      return jsonResp({ ok: false, msg: '文件过大，最大支持 20MB' }, 400);
    }

    const ext = path.extname(filePart.filename || '').toLowerCase();
    if (!isImageFile(ext) && !isPdfFile(ext) && !isExcelFile(ext)) {
      return jsonResp({ ok: false, msg: '不支持的文件类型。支持 PDF、图片(JPG/PNG)、Excel(xlsx/xls/csv)' }, 400);
    }

    // Save file
    const safeName = `ai_${Date.now()}_${crypto.randomBytes(4).toString('hex')}${ext}`;
    fs.writeFileSync(path.join(AI_UPLOAD_DIR, safeName), filePart.data);

    // Create DB record
    ensureAiTables();
    const db = getDb();
    const fileType = isImageFile(ext) ? 'image' : isPdfFile(ext) ? 'pdf' : 'excel';
    const info = db.prepare(
      'INSERT INTO ai_analyses (filename, original_name, file_type, file_size, status, created_by, created_at) VALUES (?,?,?,?,?,?,?)'
    ).run(safeName, filePart.filename, fileType, filePart.data.length, 'pending', sess.username, Date.now());

    const analysisId = Number(info.lastInsertRowid);

    // Trigger analysis asynchronously
    runAnalysis(analysisId).catch(e => {
      console.error('[ai-analysis] runAnalysis failed:', e);
    });

    return jsonResp({ ok: true, id: analysisId, msg: '文件上传成功，AI 分析已开始' });
  }

  // API: get analysis status
  if (pathname === '/api/ai/status' && method === 'GET') {
    const id = parseInt(query.id, 10);
    if (!id) return jsonResp({ ok: false, msg: '缺少 id 参数' }, 400);
    ensureAiTables();
    const db = getDb();
    const row = db.prepare('SELECT id, original_name, file_type, file_size, status, ai_result, feishu_doc_url, error_msg, created_at, completed_at FROM ai_analyses WHERE id = ?').get(id);
    if (!row) return jsonResp({ ok: false, msg: '未找到分析记录' }, 404);
    return jsonResp({ ok: true, analysis: { ...row, created_at_fmt: fmtTime(row.created_at), completed_at_fmt: row.completed_at ? fmtTime(row.completed_at) : null } });
  }

  // API: list analyses
  if (pathname === '/api/ai/list' && method === 'GET') {
    ensureAiTables();
    const db = getDb();
    const rows = db.prepare(
      'SELECT id, original_name, file_type, file_size, status, feishu_doc_url, error_msg, created_by, created_at, completed_at FROM ai_analyses ORDER BY id DESC LIMIT 50'
    ).all();
    return jsonResp({
      ok: true,
      analyses: rows.map(r => ({
        ...r,
        created_at_fmt: fmtTime(r.created_at),
        completed_at_fmt: r.completed_at ? fmtTime(r.completed_at) : null,
      })),
    });
  }

  // API: get single analysis detail (for viewing AI result)
  if (pathname === '/api/ai/detail' && method === 'GET') {
    const id = parseInt(query.id, 10);
    if (!id) return jsonResp({ ok: false, msg: '缺少 id 参数' }, 400);
    ensureAiTables();
    const db = getDb();
    const row = db.prepare('SELECT * FROM ai_analyses WHERE id = ?').get(id);
    if (!row) return jsonResp({ ok: false, msg: '未找到分析记录' }, 404);
    return jsonResp({
      ok: true,
      analysis: {
        ...row,
        created_at_fmt: fmtTime(row.created_at),
        completed_at_fmt: row.completed_at ? fmtTime(row.completed_at) : null,
      },
    });
  }

  return null;
}

// ---- page ----

function aiAnalysisPage(sess) {
  const uname = escapeHtml(sess.display_name || sess.username);
  const isAdmin = sess.role === 'admin' || sess.role === 'super_admin';
  const ADMIN_NAV_AI = isAdmin ? adminNavHtml('ai', sess.role) : '';

  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>AI 质量分析 - 雷石质量管理系统</title><meta name="viewport" content="width=device-width,initial-scale=1">
<script src="https://cdn.tailwindcss.com"></script>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif;background:#f0f0f0}
.upload-zone{border:2px dashed #d1d5db;border-radius:12px;padding:48px 24px;text-align:center;cursor:pointer;transition:all 0.2s;}
.upload-zone:hover,.upload-zone.dragover{border-color:#2563eb;background:#eff6ff;}
.status-pending{color:#f59e0b;}
.status-analyzing{color:#3b82f6;}
.status-completed{color:#10b981;}
.status-failed{color:#ef4444;}
.fade-in{animation:fadeIn 0.3s ease-in;}
@keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
</style>
</head><body class="min-h-screen">
${isAdmin ? `<div style="position:fixed;top:0;left:0;right:0;z-index:200;background:#fff;border-bottom:1px solid #e5e7eb;">
  <div style="max-width:80rem;margin:0 auto;display:flex;justify-content:space-between;align-items:center;padding:0 24px;height:48px;">
    <span style="font-size:16px;font-weight:700;color:#111;">雷石质量管理系统</span>
    <div style="display:flex;align-items:center;gap:16px;font-size:14px;color:#6b7280;">
      <span>${uname}</span>
      <a href="/logout" style="color:#2563eb;text-decoration:none;">退出</a>
    </div>
  </div>
</div>
${ADMIN_NAV_AI}` : ''}

<div style="max-width:80rem;margin:0 auto;padding:${isAdmin ? '120px' : '24px'} 24px 40px;">
  ${!isAdmin ? `<header style="display:flex;justify-content:space-between;align-items:center;margin-bottom:24px;">
    <h1 style="font-size:20px;font-weight:700;color:#111;">AI 质量分析</h1>
    <div style="display:flex;align-items:center;gap:16px;font-size:14px;color:#6b7280;">
      <a href="/" style="color:#2563eb;text-decoration:none;">&larr; 返回</a>
      <span>${uname}</span>
      <a href="/logout" style="color:#2563eb;text-decoration:none;">退出</a>
    </div>
  </header>` : ''}

  <!-- Upload Section -->
  <div class="bg-white rounded-xl shadow-sm p-6 mb-6">
    <h3 class="text-lg font-semibold text-gray-900 mb-4">上传文件进行 AI 分析</h3>
    <div id="upload-zone" class="upload-zone" onclick="document.getElementById('file-input').click()">
      <input id="file-input" type="file" accept=".pdf,.jpg,.jpeg,.png,.xlsx,.xls,.csv" style="display:none" onchange="handleUpload(this)">
      <div style="margin-bottom:12px;">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" stroke-width="1.5" style="margin:0 auto;">
          <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12"/>
        </svg>
      </div>
      <p style="font-size:15px;color:#374151;margin:0 0 8px;">点击或拖拽文件到此处</p>
      <p style="font-size:13px;color:#9ca3af;margin:0;">支持 PDF、图片（JPG/PNG）、Excel（xlsx/xls/csv），最大 20MB</p>
    </div>
    <div id="upload-progress" style="display:none;margin-top:16px;">
      <div style="display:flex;align-items:center;gap:12px;">
        <div class="animate-spin" style="width:20px;height:20px;border:2px solid #e5e7eb;border-top-color:#2563eb;border-radius:50%;"></div>
        <span id="upload-status-text" style="font-size:14px;color:#6b7280;">上传中...</span>
      </div>
    </div>
  </div>

  <!-- Analysis Results -->
  <div class="bg-white rounded-xl shadow-sm p-6">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
      <h3 class="text-lg font-semibold text-gray-900">分析记录</h3>
      <button onclick="loadAnalyses()" style="font-size:13px;color:#2563eb;background:none;border:none;cursor:pointer;">刷新</button>
    </div>
    <div id="analyses-list">
      <div style="text-align:center;color:#9ca3af;padding:24px;">加载中...</div>
    </div>
  </div>
</div>

<!-- Detail Modal -->
<div id="detail-modal" style="display:none;position:fixed;inset:0;z-index:300;background:rgba(0,0,0,0.5);overflow-y:auto;" onclick="if(event.target===this)closeDetail()">
  <div style="max-width:800px;margin:40px auto;background:#fff;border-radius:12px;padding:24px;max-height:calc(100vh - 80px);overflow-y:auto;">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
      <h3 id="detail-title" style="font-size:18px;font-weight:700;color:#111;margin:0;"></h3>
      <button onclick="closeDetail()" style="font-size:20px;color:#9ca3af;background:none;border:none;cursor:pointer;">&times;</button>
    </div>
    <div id="detail-content" style="font-size:14px;line-height:1.7;color:#374151;"></div>
  </div>
</div>

<script>
// Drag and drop
var zone = document.getElementById('upload-zone');
['dragenter','dragover'].forEach(function(e){
  zone.addEventListener(e, function(ev){ ev.preventDefault(); zone.classList.add('dragover'); });
});
['dragleave','drop'].forEach(function(e){
  zone.addEventListener(e, function(ev){ ev.preventDefault(); zone.classList.remove('dragover'); });
});
zone.addEventListener('drop', function(ev){
  var files = ev.dataTransfer.files;
  if(files.length) uploadFile(files[0]);
});

function handleUpload(input){
  if(input.files.length) uploadFile(input.files[0]);
  input.value = '';
}

function uploadFile(file){
  var maxSize = 20*1024*1024;
  if(file.size > maxSize){ alert('文件过大，最大支持 20MB'); return; }
  var ext = (file.name.match(/\\.[^.]+$/) || [''])[0].toLowerCase();
  var allowed = ['.pdf','.jpg','.jpeg','.png','.xlsx','.xls','.csv'];
  if(allowed.indexOf(ext) < 0){ alert('不支持的文件类型'); return; }

  var fd = new FormData();
  fd.append('file', file);

  var prog = document.getElementById('upload-progress');
  var statusText = document.getElementById('upload-status-text');
  prog.style.display = 'block';
  statusText.textContent = '上传中: ' + file.name;

  fetch('/api/ai/upload', { method: 'POST', body: fd })
    .then(function(r){ return r.json(); })
    .then(function(d){
      if(!d.ok){ alert('上传失败: ' + d.msg); prog.style.display='none'; return; }
      statusText.textContent = 'AI 分析中，请稍候...';
      pollStatus(d.id);
    })
    .catch(function(e){ alert('上传出错: ' + e.message); prog.style.display='none'; });
}

function pollStatus(id){
  var statusText = document.getElementById('upload-status-text');
  var prog = document.getElementById('upload-progress');
  var interval = setInterval(function(){
    fetch('/api/ai/status?id=' + id)
      .then(function(r){ return r.json(); })
      .then(function(d){
        if(!d.ok) return;
        var a = d.analysis;
        if(a.status === 'analyzing'){
          statusText.textContent = 'AI 正在分析 ' + a.original_name + '...';
        } else if(a.status === 'completed'){
          clearInterval(interval);
          prog.style.display = 'none';
          loadAnalyses();
        } else if(a.status === 'failed'){
          clearInterval(interval);
          prog.style.display = 'none';
          alert('分析失败: ' + (a.error_msg || '未知错误'));
          loadAnalyses();
        }
      });
  }, 2000);
}

function loadAnalyses(){
  fetch('/api/ai/list')
    .then(function(r){ return r.json(); })
    .then(function(d){
      var el = document.getElementById('analyses-list');
      if(!d.ok || !d.analyses.length){
        el.innerHTML = '<div style="text-align:center;color:#9ca3af;padding:24px;">暂无分析记录</div>';
        return;
      }
      var statusLabels = { pending:'等待中', analyzing:'分析中', completed:'已完成', failed:'失败' };
      var typeLabels = { pdf:'PDF', image:'图片', excel:'Excel' };
      el.innerHTML = '<table style="width:100%;border-collapse:collapse;font-size:14px;">' +
        '<thead><tr style="border-bottom:1px solid #e5e7eb;text-align:left;">' +
        '<th style="padding:8px 12px;font-weight:500;color:#6b7280;">文件名</th>' +
        '<th style="padding:8px 12px;font-weight:500;color:#6b7280;">类型</th>' +
        '<th style="padding:8px 12px;font-weight:500;color:#6b7280;">状态</th>' +
        '<th style="padding:8px 12px;font-weight:500;color:#6b7280;">时间</th>' +
        '<th style="padding:8px 12px;font-weight:500;color:#6b7280;">操作</th>' +
        '</tr></thead><tbody>' +
        d.analyses.map(function(a){
          var statusClass = 'status-' + a.status;
          var actions = '';
          if(a.status === 'completed'){
            actions = '<button onclick="viewDetail(' + a.id + ')" style="color:#2563eb;background:none;border:none;cursor:pointer;font-size:13px;margin-right:8px;">查看结果</button>';
            if(a.feishu_doc_url){
              actions += '<a href="' + a.feishu_doc_url + '" target="_blank" style="color:#10b981;font-size:13px;text-decoration:none;">飞书文档</a>';
            }
          } else if(a.status === 'failed'){
            actions = '<span style="font-size:12px;color:#ef4444;" title="' + (a.error_msg||'').replace(/"/g,'&quot;') + '">查看错误</span>';
          } else if(a.status === 'analyzing'){
            actions = '<span style="font-size:12px;color:#3b82f6;">处理中...</span>';
          }
          var sizeStr = a.file_size > 1048576 ? (a.file_size/1048576).toFixed(1)+'MB' : (a.file_size/1024).toFixed(0)+'KB';
          return '<tr style="border-bottom:1px solid #f3f4f6;" class="fade-in">' +
            '<td style="padding:10px 12px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + (a.original_name||'').replace(/"/g,'&quot;') + '">' + (a.original_name||'').replace(/</g,'&lt;') + '<div style="font-size:11px;color:#9ca3af;">' + sizeStr + '</div></td>' +
            '<td style="padding:10px 12px;">' + (typeLabels[a.file_type] || a.file_type) + '</td>' +
            '<td style="padding:10px 12px;"><span class="' + statusClass + '" style="font-weight:500;">' + (statusLabels[a.status] || a.status) + '</span></td>' +
            '<td style="padding:10px 12px;white-space:nowrap;">' + (a.created_at_fmt || '') + '</td>' +
            '<td style="padding:10px 12px;">' + actions + '</td>' +
            '</tr>';
        }).join('') +
        '</tbody></table>';
    });
}

function viewDetail(id){
  fetch('/api/ai/detail?id=' + id)
    .then(function(r){ return r.json(); })
    .then(function(d){
      if(!d.ok){ alert(d.msg); return; }
      var a = d.analysis;
      document.getElementById('detail-title').textContent = 'AI 分析结果 - ' + a.original_name;
      var html = '';
      if(a.feishu_doc_url){
        html += '<div style="margin-bottom:16px;padding:12px;background:#f0fdf4;border-radius:8px;"><a href="' + a.feishu_doc_url + '" target="_blank" style="color:#10b981;font-weight:500;">📄 在飞书文档中查看完整报告 →</a></div>';
      }
      html += '<div style="background:#f9fafb;border-radius:8px;padding:16px;white-space:pre-wrap;font-size:13px;line-height:1.8;">' + formatMarkdown(a.ai_result || '无结果') + '</div>';
      document.getElementById('detail-content').innerHTML = html;
      document.getElementById('detail-modal').style.display = 'block';
    });
}

function closeDetail(){
  document.getElementById('detail-modal').style.display = 'none';
}

function formatMarkdown(text){
  // Simple markdown to HTML
  return text
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/^### (.+)$/gm, '<h4 style="font-size:15px;font-weight:600;color:#111;margin:16px 0 8px;">$1</h4>')
    .replace(/^## (.+)$/gm, '<h3 style="font-size:16px;font-weight:700;color:#111;margin:20px 0 10px;">$1</h3>')
    .replace(/^# (.+)$/gm, '<h2 style="font-size:18px;font-weight:700;color:#111;margin:24px 0 12px;">$1</h2>')
    .replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>')
    .replace(/^- (.+)$/gm, '<div style="padding-left:16px;">• $1</div>')
    .replace(/^\\d+\\. (.+)$/gm, function(m,p1,offset,str){ return '<div style="padding-left:16px;">' + m.match(/^\\d+/)[0] + '. ' + p1 + '</div>'; })
    .replace(/\\n/g, '<br>');
}

// Auto-load on page ready
loadAnalyses();
// Auto-refresh every 5 seconds if there are pending/analyzing items
setInterval(function(){
  var pendingEls = document.querySelectorAll('.status-pending, .status-analyzing');
  if(pendingEls.length > 0) loadAnalyses();
}, 5000);
</script></body></html>`;
}

// Admin nav with AI tab highlighted
function adminNavHtml(active, role) {
  const inProduct = active==='products'||active==='product-bindings';
  const inProduction = active==='mes'||active==='mainboard-tests'||active==='ai';
  const inSupplier = active==='suppliers'||active==='bindings';
  const mainNav = `<nav style="position:fixed;top:49px;left:50%;transform:translateX(-50%);width:100%;max-width:80rem;z-index:199;background:#fff;border-bottom:1px solid #e5e7eb;border-left:1px solid #e5e7eb;border-right:1px solid #e5e7eb;">
  <div style="max-width:80rem;margin:0 auto;display:flex;width:100%;">
  <a href="/admin/dashboard" style="flex:1;text-align:center;padding:10px 8px;font-size:14px;font-weight:500;text-decoration:none;white-space:nowrap;${active==='dashboard'?'color:#111;border-bottom:2px solid #111;':'color:#9ca3af;border-bottom:2px solid transparent;'}">首页</a>
  <a href="/admin/brands" style="flex:1;text-align:center;padding:10px 8px;font-size:14px;font-weight:500;text-decoration:none;white-space:nowrap;${active==='brands'?'color:#111;border-bottom:2px solid #111;':'color:#9ca3af;border-bottom:2px solid transparent;'}">客户</a>
  <a href="/admin/suppliers" style="flex:1;text-align:center;padding:10px 8px;font-size:14px;font-weight:500;text-decoration:none;white-space:nowrap;${inSupplier?'color:#111;border-bottom:2px solid #111;':'color:#9ca3af;border-bottom:2px solid transparent;'}">供应商</a>
  <a href="/admin/products" style="flex:1;text-align:center;padding:10px 8px;font-size:14px;font-weight:500;text-decoration:none;white-space:nowrap;${inProduct?'color:#111;border-bottom:2px solid #111;':'color:#9ca3af;border-bottom:2px solid transparent;'}">产品</a>
  <a href="/mes" style="flex:1;text-align:center;padding:10px 8px;font-size:14px;font-weight:500;text-decoration:none;white-space:nowrap;${inProduction?'color:#111;border-bottom:2px solid #111;':'color:#9ca3af;border-bottom:2px solid transparent;'}">生产</a>
  <a href="/admin" style="flex:1;text-align:center;padding:10px 8px;font-size:14px;font-weight:500;text-decoration:none;white-space:nowrap;${active==='users'?'color:#111;border-bottom:2px solid #111;':'color:#9ca3af;border-bottom:2px solid transparent;'}">账号</a>
  <a href="/admin/api-keys" style="flex:1;text-align:center;padding:10px 8px;font-size:14px;font-weight:500;text-decoration:none;white-space:nowrap;${active==='api-keys'?'color:#111;border-bottom:2px solid #111;':'color:#9ca3af;border-bottom:2px solid transparent;'}">API KEY</a>
</nav>`;
  const productionSubNav = inProduction ? `<div style="position:fixed;top:94px;left:50%;transform:translateX(-50%);width:100%;max-width:80rem;z-index:198;background:#f9fafb;border-bottom:1px solid #e5e7eb;border-left:1px solid #e5e7eb;border-right:1px solid #e5e7eb;margin-bottom:0;">
  <div style="max-width:80rem;margin:0 auto;display:flex;">
  <a href="/mes" style="padding:8px 16px;font-size:13px;text-decoration:none;${active==='mes'?'color:#2563eb;border-bottom:2px solid #2563eb;':'color:#6b7280;border-bottom:2px solid transparent;'}">制造执行系统</a>
  <a href="/admin/mainboard-tests" style="padding:8px 16px;font-size:13px;text-decoration:none;${active==='mainboard-tests'?'color:#2563eb;border-bottom:2px solid #2563eb;':'color:#6b7280;border-bottom:2px solid transparent;'}">测试记录</a>
  <a href="/ai" style="padding:8px 16px;font-size:13px;text-decoration:none;${active==='ai'?'color:#2563eb;border-bottom:2px solid #2563eb;':'color:#6b7280;border-bottom:2px solid transparent;'}">AI 分析</a>
</div>
</div>` : '';
  return mainNav + productionSubNav + `
<script>
(function(){
  var IDLE_MS = 30*60*1000;
  var _timer;
  function resetTimer(){
    clearTimeout(_timer);
    _timer = setTimeout(function(){
      alert('长时间未操作，请重新登录');
      window.location.href = '/logout';
    }, IDLE_MS);
  }
  ['click','keydown','mousemove','scroll','touchstart'].forEach(function(ev){
    document.addEventListener(ev, resetTimer, true);
  });
  resetTimer();
})();
</script>`;
}

module.exports = { handleAiAnalysis, ensureAiTables };
