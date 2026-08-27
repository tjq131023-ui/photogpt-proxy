const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const WebSocket = require('ws');

const app = express();
app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

const PORT = process.env.PORT || 8180;
const CDP_HTTP = process.env.CDP_HTTP || 'http://127.0.0.1:9222';
const ACCOUNTS_FILE = path.join(__dirname, 'photogpt_accounts.json');

// Ensure uploads dir exists
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// ----------------- Stats & Logs Store -----------------
const stats = {
  totalGenerations: 0,
  successfulGenerations: 0,
  failedGenerations: 0,
  startTime: Date.now()
};

const generationLogs = [];
function addLog(logItem) {
  generationLogs.unshift({
    id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    time: new Date().toLocaleTimeString(),
    ...logItem
  });
  if (generationLogs.length > 50) generationLogs.pop();
}

// ----------------- Account Pool Manager -----------------
function loadAccounts() {
  if (fs.existsSync(ACCOUNTS_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf-8'));
    } catch (e) {
      console.error('[AccountPool] Error parsing accounts file:', e);
    }
  }
  return [];
}

function saveAccounts(accounts) {
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2));
}

let accountIndex = 0;
let currentActiveToken = null;
let isSyncingCredits = false;

// Strictly select only accounts with active === true AND available_credits >= 6
function getNextAvailableAccount() {
  const accounts = loadAccounts();
  if (accounts.length === 0) return null;

  // Filter accounts strictly having >= 6 credits
  const eligible = accounts.filter(a => a.active && (a.available_credits === undefined || a.available_credits >= 6));
  if (eligible.length === 0) {
    console.warn('[AccountPool] ❌ 所有账号积分均已不足 6 积分，自动停止轮询！');
    return null;
  }

  const idx = accountIndex % eligible.length;
  accountIndex = (idx + 1) % eligible.length;
  return eligible[idx];
}

function updateAccountCredits(email, newCredits) {
  const accounts = loadAccounts();
  const acc = accounts.find(a => a.email === email);
  if (acc) {
    acc.available_credits = newCredits;
    acc.last_synced = new Date().toLocaleTimeString();
    saveAccounts(accounts);
    console.log(`[AccountPool] 💰 Updated credits for ${email}: ${newCredits}`);
  }
}

function normalizeAspectRatio(inputRatio, size) {
  if (inputRatio) {
    const r = String(inputRatio).trim();
    if (['16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3', '21:9'].includes(r)) return r;
    if (r.includes('16:9') || r === '16/9') return '16:9';
    if (r.includes('9:16') || r === '9/16') return '9:16';
    if (r.includes('1:1') || r === '1/1') return '1:1';
    if (r.includes('4:3') || r === '4/3') return '4:3';
    if (r.includes('3:4') || r === '3/4') return '3:4';
  }
  if (size) {
    if (size === '1024x576' || size === '1920x1080' || size === '1280x720') return '16:9';
    if (size === '576x1024' || size === '1080x1920' || size === '720x1280') return '9:16';
    if (size === '1024x1024' || size === '512x512') return '1:1';
    if (size === '1024x768') return '4:3';
    if (size === '768x1024') return '3:4';
  }
  return '16:9';
}

// ----------------- Helper Functions -----------------
async function downloadImageWithReferer(url) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'Referer': 'https://photogpt.io/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36'
      }
    };
    https.get(url, options, (res) => {
      if (res.statusCode !== 200) {
        return reject(new Error(`Failed to download image, status code: ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

// ----------------- Direct CDP WebSocket Helper -----------------
async function getPhotoGPTTab() {
  return new Promise((resolve, reject) => {
    http.get(`${CDP_HTTP}/json/list`, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const tabs = JSON.parse(data);
          let target = tabs.find(t => t.type === 'page' && t.url && t.url.includes('ai-models/gpt-image-2'));
          if (!target) {
            target = tabs.find(t => t.type === 'page' && t.url && t.url.includes('photogpt.io'));
          }
          if (!target) {
            target = tabs.find(t => t.type === 'page');
          }
          resolve(target);
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

// Script to read live credit from PhotoGPT DOM
const EXTRACT_CREDIT_SCRIPT = `
  (() => {
    const spans = Array.from(document.querySelectorAll('span'));
    const creditSpan = spans.find(s => s.innerText.trim() === 'Credit');
    if (creditSpan) {
      const row = creditSpan.closest('.w-full') || creditSpan.parentElement?.parentElement;
      if (row) {
        const num = row.innerText.replace(/[^0-9]/g, '');
        if (num) return parseInt(num);
      }
    }
    return null;
  })()
`;

// Sync real credits for all accounts in pool
async function syncAllAccountsRealCredits() {
  if (isSyncingCredits) return { success: false, message: 'Sync already in progress' };
  isSyncingCredits = true;
  console.log('\n[AccountPool] 🔄 Starting full sync of real live credits from PhotoGPT...');

  try {
    const tab = await getPhotoGPTTab();
    if (!tab || !tab.webSocketDebuggerUrl) {
      isSyncingCredits = false;
      return { success: false, message: 'No Chrome tab available' };
    }

    const accounts = loadAccounts();
    const ws = new WebSocket(tab.webSocketDebuggerUrl);

    await new Promise((resolve, reject) => {
      let msgId = 1;
      const sendCmd = (method, params = {}) => {
        return new Promise((resCmd, rejCmd) => {
          const id = msgId++;
          const payload = JSON.stringify({ id, method, params });
          const handler = (raw) => {
            try {
              const resp = JSON.parse(raw);
              if (resp.id === id) {
                ws.off('message', handler);
                if (resp.error) rejCmd(new Error(resp.error.message || 'CDP Error'));
                else resCmd(resp.result || {});
              }
            } catch (e) {}
          };
          ws.on('message', handler);
          ws.send(payload, (err) => { if (err) rejCmd(err); });
        });
      };

      ws.on('open', async () => {
        try {
          await sendCmd('Network.enable');

          for (const acc of accounts) {
            if (!acc.nc_token) continue;
            console.log(`[AccountPool] Checking real balance for: ${acc.email}...`);
            await sendCmd('Network.setCookie', {
              name: 'nc_token',
              value: acc.nc_token,
              domain: '.photogpt.io',
              path: '/'
            });
            await sendCmd('Page.navigate', { url: 'https://photogpt.io/ai-models/gpt-image-2' });
            
            // Poll for credit element
            let liveCredits = null;
            for (let i = 0; i < 8; i++) {
              await new Promise(r => setTimeout(r, 600));
              const res = await sendCmd('Runtime.evaluate', { expression: EXTRACT_CREDIT_SCRIPT, returnByValue: true });
              const val = res.result?.value;
              if (val !== undefined && val !== null) {
                liveCredits = val;
                break;
              }
            }

            if (liveCredits !== null) {
              acc.available_credits = liveCredits;
              acc.last_synced = new Date().toLocaleTimeString();
              console.log(`[AccountPool] ✅ ${acc.email} -> Real Live Credits: ${liveCredits}`);
            }
          }

          saveAccounts(accounts);
          ws.close();
          resolve();
        } catch (e) {
          try { ws.close(); } catch (err) {}
          reject(e);
        }
      });

      ws.on('error', (err) => reject(err));
    });

    isSyncingCredits = false;
    console.log('[AccountPool] 🎉 All accounts real credits synced successfully!\n');
    return { success: true, accounts: loadAccounts() };

  } catch (e) {
    isSyncingCredits = false;
    console.error('[AccountPool] Error syncing accounts real credits:', e.message);
    return { success: false, error: e.message };
  }
}

// Auto-sync on startup & every 10 minutes
setTimeout(syncAllAccountsRealCredits, 3000);
setInterval(syncAllAccountsRealCredits, 10 * 60 * 1000);

// ----------------- Core PhotoGPT Runner (Direct CDP Engine) -----------------
async function doPhotoGPTGenerate({ prompt, refImage, aspectRatio = '16:9' }) {
  const startTime = Date.now();
  stats.totalGenerations++;

  const account = getNextAvailableAccount();
  if (!account) {
    stats.failedGenerations++;
    const err = new Error('所有账号积分均已不足 6 积分（或未激活），已自动停止轮询！请在控制面板添加新账号或充值。');
    addLog({ prompt, status: 'FAILED', error: err.message, account: 'None', duration: 0 });
    throw err;
  }

  console.log(`\n[PhotoGPT Generator] ⚡ Selected Account: ${account.email} (Recorded Credits: ${account.available_credits})`);
  console.log(`[PhotoGPT Generator] 📝 Prompt: "${prompt.slice(0, 100)}..."`);

  const tab = await getPhotoGPTTab();
  if (!tab || !tab.webSocketDebuggerUrl) {
    stats.failedGenerations++;
    const err = new Error(`未检测到后台运行的 Chrome 标签页，请确保 Chrome 已启动（端口 9222）。`);
    addLog({ prompt, status: 'FAILED', error: err.message, account: account.email, duration: 0 });
    throw err;
  }

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(tab.webSocketDebuggerUrl);
    let msgId = 1;
    let isFinished = false;

    const cleanup = () => {
      isFinished = true;
      try { ws.close(); } catch (e) {}
    };

    const sendCmd = (method, params = {}) => {
      return new Promise((resCmd, rejCmd) => {
        const id = msgId++;
        const payload = JSON.stringify({ id, method, params });
        
        const handler = (raw) => {
          try {
            const resp = JSON.parse(raw);
            if (resp.id === id) {
              ws.off('message', handler);
              if (resp.error) rejCmd(new Error(resp.error.message || 'CDP Error'));
              else resCmd(resp.result || {});
            }
          } catch (e) {}
        };
        
        ws.on('message', handler);
        ws.send(payload, (err) => { if (err) rejCmd(err); });
      });
    };

    ws.on('error', (err) => {
      if (!isFinished) {
        cleanup();
        stats.failedGenerations++;
        addLog({ prompt, status: 'FAILED', error: err.message, account: account.email, duration: 0 });
        reject(err);
      }
    });

    ws.on('open', async () => {
      try {
        await sendCmd('Network.enable');

        // Switch cookie & navigate to gpt-image-2
        console.log(`[PhotoGPT Generator] 🔄 Switching session to ${account.email}...`);
        await sendCmd('Network.setCookie', {
          name: 'nc_token',
          value: account.nc_token,
          domain: '.photogpt.io',
          path: '/'
        });
        if (account.anonymous_user_id) {
          await sendCmd('Network.setCookie', {
            name: 'anonymous_user_id',
            value: account.anonymous_user_id,
            domain: '.photogpt.io',
            path: '/'
          });
        }
        currentActiveToken = account.nc_token;
        await sendCmd('Page.navigate', { url: 'https://photogpt.io/ai-models/gpt-image-2' });

        // Wait for page to mount and check real-time live credits
        let liveCredits = null;
        for (let i = 0; i < 10; i++) {
          await new Promise(r => setTimeout(r, 500));
          const credRes = await sendCmd('Runtime.evaluate', { expression: EXTRACT_CREDIT_SCRIPT, returnByValue: true });
          const val = credRes.result?.value;
          if (val !== undefined && val !== null) {
            liveCredits = val;
            break;
          }
        }

        if (liveCredits !== null) {
          console.log(`[PhotoGPT Generator] 📊 Real-time Live Balance from PhotoGPT: ${liveCredits} credits`);
          updateAccountCredits(account.email, liveCredits);

          // If real balance is insufficient (< 6), immediately auto-failover to next account!
          if (liveCredits < 6) {
            cleanup();
            console.warn(`[PhotoGPT Generator] ⚠️ Account ${account.email} has only ${liveCredits} credits (< 6). Automatically stopping rotation for this account and switching to next...`);
            return resolve(await doPhotoGPTGenerate({ prompt, refImage, aspectRatio }));
          }
        }

        // Listen for prediction/handle API response
        let projectId = null;
        let predictionError = null;
        const onNetworkResponse = async (raw) => {
          try {
            const ev = JSON.parse(raw);
            if (ev.method === 'Network.responseReceived') {
              const respUrl = ev.params?.response?.url || '';
              if (respUrl.includes('/api/v1/prediction/handle')) {
                const reqId = ev.params.requestId;
                const bodyRes = await sendCmd('Network.getResponseBody', { requestId: reqId });
                const bodyData = JSON.parse(bodyRes.body || '{}');
                console.log('[PhotoGPT Generator] 📥 Prediction Response Body:', JSON.stringify(bodyData));
                
                if (bodyData.code === 100024 || (bodyData.message && bodyData.message.includes('credits left'))) {
                  predictionError = bodyData.message || 'Only 2 credits left';
                  updateAccountCredits(account.email, 2);
                } else if (bodyData.code !== 100000 && bodyData.code !== undefined && bodyData.code !== 0) {
                  predictionError = bodyData.message || 'API error: ' + bodyData.code;
                } else {
                  projectId = bodyData.data?.project_id || bodyData.data?.id;
                }
              }
            }
          } catch (e) {}
        };
        ws.on('message', onNetworkResponse);

        // Set Aspect Ratio (16:9, 1:1, 9:16, etc.)
        const targetRatio = normalizeAspectRatio(aspectRatio);
        const setRatioScript = `
          (() => {
            const target = ${JSON.stringify(targetRatio)};
            const spans = Array.from(document.querySelectorAll('span'));
            const currentSpan = spans.find(s => ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'].includes((s.innerText || '').trim()));
            const currentVal = currentSpan ? currentSpan.innerText.trim() : null;

            if (currentVal === target) {
              return { changed: false, ratio: currentVal };
            }

            if (currentSpan) {
              const trigger = currentSpan.closest('[id*="popover-trigger"]') || currentSpan.parentElement;
              if (trigger) trigger.click();
            }

            const labels = Array.from(document.querySelectorAll('label'));
            const targetLabel = labels.find(l => (l.innerText || '').trim() === target);
            if (targetLabel) {
              targetLabel.click();
              document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
              return { changed: true, ratio: target };
            }

            return { changed: false, error: 'Target label not found' };
          })()
        `;
        const ratioRes = await sendCmd('Runtime.evaluate', { expression: setRatioScript, returnByValue: true });
        console.log(`[PhotoGPT Generator] 📐 Aspect Ratio setup (${targetRatio}):`, ratioRes.result?.value);
        await new Promise(r => setTimeout(r, 400));

        // Inject Prompt & Click Generate with Vue native prototype setter
        const escapedPrompt = JSON.stringify(prompt);
        const evalScript = `
          (() => {
            const ta = document.querySelector('textarea');
            if (!ta) return { success: false, error: 'No textarea found' };

            ta.focus();
            const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
            nativeSetter.call(ta, ${escapedPrompt});
            ta.dispatchEvent(new Event('input', { bubbles: true }));
            ta.dispatchEvent(new Event('change', { bubbles: true }));

            const btns = Array.from(document.querySelectorAll('button'));
            const genBtn = btns.find(b => {
              const t = (b.innerText || '').trim();
              return t === 'Generate' || t === '立即生成' || t.includes('Generate') || (t.includes('Credit') && t.includes('6'));
            });

            if (genBtn) {
              genBtn.click();
              return { success: true, text: genBtn.innerText, disabled: genBtn.disabled };
            }
            return { success: false, error: 'No generate button' };
          })()
        `;

        console.log('[PhotoGPT Generator] 🖱️ Injecting prompt and clicking Generate...');
        const clickRes = await sendCmd('Runtime.evaluate', { expression: evalScript, returnByValue: true });
        console.log('[PhotoGPT Generator] Click Result:', clickRes.result?.value);

        // Wait up to 15s for Project ID or Error
        const waitStart = Date.now();
        while (!projectId && !predictionError && Date.now() - waitStart < 15000) {
          await new Promise(r => setTimeout(r, 500));
        }

        ws.off('message', onNetworkResponse);

        if (predictionError) {
          cleanup();
          console.warn(`[PhotoGPT Generator] ⚠️ Account ${account.email} failed: "${predictionError}". Trying next available account...`);
          return resolve(await doPhotoGPTGenerate({ prompt, refImage, aspectRatio }));
        }

        if (!projectId) {
          throw new Error('未能在 15 秒内捕获到 PhotoGPT 提交任务 ID (project_id)');
        }

        console.log(`[PhotoGPT Generator] 🎉 Captured Project ID: ${projectId}! Polling status...`);

        // Poll status via Runtime.evaluate
        let resultImageUrl = null;
        for (let attempt = 1; attempt <= 45; attempt++) {
          await new Promise(r => setTimeout(r, 2000));

          const pollExpr = `fetch('/api/v1/prediction/get-status?project_id=${projectId}').then(r => r.json())`;
          const pollRes = await sendCmd('Runtime.evaluate', { expression: pollExpr, awaitPromise: true, returnByValue: true });
          const val = pollRes.result?.value;
          const taskStatus = val?.data?.status;
          const progress = val?.data?.progress;
          const firstResult = val?.data?.results?.[0];
          const imgUrl = firstResult?.result_content || val?.data?.result_content?.[0] || val?.data?.output_urls?.[0] || val?.data?.result_url;
          const isCompleted = taskStatus === 1 || taskStatus === '1' || taskStatus === 'COMPLETED' || taskStatus === 'SUCCESS';

          console.log(`[Poll #${attempt}] Status: ${taskStatus}, Progress: ${progress}% (Elapsed: ${Math.round((Date.now() - startTime)/1000)}s)`);

          if ((isCompleted && imgUrl) || imgUrl) {
            resultImageUrl = imgUrl;
            console.log(`\n🎉 [PhotoGPT Generator] SUCCESS! Generated image URL:\n${resultImageUrl}\n`);
            break;
          }

          if (taskStatus === 2 || taskStatus === '2' || taskStatus === 'FAILED' || firstResult?.error) {
            throw new Error(`PhotoGPT 任务返回失败: ${firstResult?.error || val?.data?.error || val?.data?.reason || 'Task failed'}`);
          }
        }

        if (!resultImageUrl) {
          throw new Error(`PhotoGPT 出图超时（已等待 90 秒）`);
        }

        const fullResolutionUrl = resultImageUrl.split('?')[0];
        const durationSec = Math.round((Date.now() - startTime) / 1000);

        // Fetch updated balance after generation
        try {
          const postCredRes = await sendCmd('Runtime.evaluate', { expression: EXTRACT_CREDIT_SCRIPT, returnByValue: true });
          const newLiveCredits = postCredRes.result?.value;
          if (newLiveCredits !== undefined && newLiveCredits !== null) {
            updateAccountCredits(account.email, newLiveCredits);
          } else if (account.available_credits !== undefined && account.available_credits >= 6) {
            updateAccountCredits(account.email, account.available_credits - 6);
          }
        } catch (e) {}

        stats.successfulGenerations++;
        addLog({
          prompt,
          status: 'SUCCESS',
          account: account.email,
          imageUrl: fullResolutionUrl,
          duration: durationSec
        });

        cleanup();
        resolve(fullResolutionUrl);

      } catch (err) {
        cleanup();
        stats.failedGenerations++;
        addLog({ prompt, status: 'FAILED', error: err.message, account: account.email, duration: Math.round((Date.now() - startTime)/1000) });
        reject(err);
      }
    });
  });
}

// ----------------- Dreamina Tasks State Store -----------------
const dreaminaTasks = new Map();

// ----------------- Web Dashboard HTML -----------------
const DASHBOARD_HTML = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>PhotoGPT 多账号反代控制面板</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap');
    body { font-family: 'Inter', sans-serif; background-color: #0b0f19; color: #f3f4f6; }
    .glass-card { background: rgba(17, 24, 39, 0.85); backdrop-filter: blur(16px); border: 1px solid rgba(255, 255, 255, 0.08); }
    .glow-btn { box-shadow: 0 0 20px rgba(99, 102, 241, 0.4); }
    .glow-btn:hover { box-shadow: 0 0 30px rgba(99, 102, 241, 0.7); }
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-track { background: #0b0f19; }
    ::-webkit-scrollbar-thumb { background: #374151; border-radius: 4px; }
    ::-webkit-scrollbar-thumb:hover { background: #4b5563; }
  </style>
</head>
<body class="min-h-screen flex flex-col">
  <!-- Top Navigation -->
  <header class="border-b border-gray-800/80 bg-gray-900/60 sticky top-0 z-50 backdrop-blur-md">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
      <div class="flex items-center space-x-3">
        <div class="w-10 h-10 rounded-xl bg-gradient-to-tr from-indigo-500 via-purple-500 to-pink-500 flex items-center justify-center shadow-lg shadow-indigo-500/20">
          <i class="fa-solid fa-wand-magic-sparkles text-white text-lg"></i>
        </div>
        <div>
          <h1 class="text-lg font-bold bg-gradient-to-r from-white via-gray-200 to-indigo-300 bg-clip-text text-transparent">PhotoGPT 反代服务控制台</h1>
          <p class="text-xs text-gray-400">实时积分同步 · 自动剔除欠费号 · 无限轮询生图</p>
        </div>
      </div>
      <div class="flex items-center space-x-3">
        <button id="btn-sync-all" onclick="triggerSyncAllCredits()" class="px-3 py-1.5 rounded-lg bg-indigo-600/30 hover:bg-indigo-600/50 text-indigo-300 border border-indigo-500/30 text-xs flex items-center space-x-1.5 transition">
          <i class="fa-solid fa-arrows-rotate"></i> <span>同步全部实时积分</span>
        </button>
        <span class="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
          <span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse mr-2"></span> 8180 端口运行中
        </span>
      </div>
    </div>
  </header>

  <!-- Main Content Area -->
  <main class="flex-1 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 w-full space-y-6">
    
    <!-- Top Stats Overview -->
    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      <div class="glass-card rounded-2xl p-4 flex items-center justify-between">
        <div>
          <p class="text-xs text-gray-400 font-medium">账号总数 / 可轮询</p>
          <h3 id="stat-accounts" class="text-2xl font-bold text-white mt-1">-- / --</h3>
        </div>
        <div class="w-12 h-12 rounded-xl bg-blue-500/10 text-blue-400 flex items-center justify-center text-xl">
          <i class="fa-solid fa-users"></i>
        </div>
      </div>
      <div class="glass-card rounded-2xl p-4 flex items-center justify-between">
        <div>
          <p class="text-xs text-gray-400 font-medium">可用总积分 (出图次数)</p>
          <h3 id="stat-credits" class="text-2xl font-bold text-amber-400 mt-1">-- (约 -- 张)</h3>
        </div>
        <div class="w-12 h-12 rounded-xl bg-amber-500/10 text-amber-400 flex items-center justify-center text-xl">
          <i class="fa-solid fa-coins"></i>
        </div>
      </div>
      <div class="glass-card rounded-2xl p-4 flex items-center justify-between">
        <div>
          <p class="text-xs text-gray-400 font-medium">累计请求 / 成功出图</p>
          <h3 id="stat-generations" class="text-2xl font-bold text-emerald-400 mt-1">-- / --</h3>
        </div>
        <div class="w-12 h-12 rounded-xl bg-emerald-500/10 text-emerald-400 flex items-center justify-center text-xl">
          <i class="fa-solid fa-image"></i>
        </div>
      </div>
      <div class="glass-card rounded-2xl p-4 flex items-center justify-between">
        <div>
          <p class="text-xs text-gray-400 font-medium">接口地址 (OpenAI 兼容)</p>
          <p class="text-xs font-mono text-indigo-300 mt-1 truncate max-w-[160px]">/v1/images/generations</p>
        </div>
        <button onclick="copyEndpoint()" class="px-2.5 py-1.5 rounded-lg bg-indigo-500/10 text-indigo-400 hover:bg-indigo-500/20 text-xs flex items-center space-x-1 transition">
          <i class="fa-regular fa-copy"></i> <span>复制</span>
        </button>
      </div>
    </div>

    <!-- Main Grid: Left Playground + Right Account Pool -->
    <div class="grid grid-cols-1 lg:grid-cols-12 gap-6">
      
      <!-- Left Column: Test & Playground (5 cols) -->
      <div class="lg:col-span-5 space-y-6">
        <div class="glass-card rounded-2xl p-5 space-y-4">
          <div class="flex items-center justify-between border-b border-gray-800 pb-3">
            <div class="flex items-center space-x-2">
              <i class="fa-solid fa-flask text-indigo-400"></i>
              <h2 class="font-semibold text-white">在线生图测试 (Playground)</h2>
            </div>
            <span class="text-xs text-gray-400 font-mono">Model: GPT Image 2</span>
          </div>

          <!-- Prompt Input -->
          <div>
            <label class="block text-xs text-gray-300 font-medium mb-1.5">提示词 (Prompt)</label>
            <textarea id="play-prompt" rows="3" class="w-full rounded-xl bg-gray-950/80 border border-gray-800 px-3.5 py-2.5 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-indigo-500 transition" placeholder="例如：可爱金毛小狗幼犬，写实摄影高清，柔和光影，4K..."></textarea>
          </div>

          <!-- Reference Image Dropzone -->
          <div>
            <label class="block text-xs text-gray-300 font-medium mb-1.5">参考图 / 垫图 (可选)</label>
            <div id="drop-zone" class="border-2 border-dashed border-gray-800 hover:border-indigo-500/50 rounded-xl p-4 text-center cursor-pointer transition bg-gray-950/40 relative">
              <input type="file" id="play-file" accept="image/*" class="hidden" onchange="handleFileSelect(event)">
              <div id="drop-prompt" class="space-y-1">
                <i class="fa-solid fa-cloud-arrow-up text-gray-400 text-2xl"></i>
                <p class="text-xs text-gray-300">点击或拖拽图片至此处</p>
                <p class="text-[10px] text-gray-500">支持 PNG / JPG / WebP</p>
              </div>
              <div id="drop-preview-box" class="hidden flex items-center justify-center relative">
                <img id="drop-preview-img" class="max-h-32 rounded-lg object-contain border border-gray-800 shadow">
                <button onclick="clearRefImage(event)" class="absolute top-1 right-1 w-6 h-6 rounded-full bg-rose-500/80 hover:bg-rose-600 text-white flex items-center justify-center text-xs transition">
                  <i class="fa-solid fa-xmark"></i>
                </button>
              </div>
            </div>
          </div>

          <!-- Aspect Ratio & Generate Button -->
          <div class="flex items-center space-x-3 pt-2">
            <select id="play-ratio" class="rounded-xl bg-gray-950/80 border border-gray-800 px-3 py-2.5 text-sm text-gray-200 focus:outline-none focus:border-indigo-500">
              <option value="16:9">16:9 (横版)</option>
              <option value="1:1">1:1 (正方形)</option>
              <option value="9:16">9:16 (竖版)</option>
              <option value="4:3">4:3</option>
              <option value="3:4">3:4</option>
            </select>
            <button id="btn-generate" onclick="startGeneration()" class="flex-1 py-2.5 rounded-xl bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700 text-white font-medium text-sm flex items-center justify-center space-x-2 transition glow-btn">
              <i class="fa-solid fa-bolt"></i> <span>立即生成 (消耗 6 积分)</span>
            </button>
          </div>

          <!-- Result Area -->
          <div id="play-result" class="hidden border-t border-gray-800 pt-4 space-y-3">
            <div class="flex items-center justify-between">
              <span class="text-xs font-medium text-emerald-400 flex items-center space-x-1.5">
                <i class="fa-solid fa-circle-check"></i> <span id="res-duration">生成完成</span>
              </span>
              <a id="res-download-btn" href="#" download="photogpt_result.png" class="text-xs text-indigo-400 hover:text-indigo-300 flex items-center space-x-1">
                <i class="fa-solid fa-download"></i> <span>下载原图</span>
              </a>
            </div>
            <div class="relative group rounded-xl overflow-hidden border border-gray-800 bg-black/40">
              <img id="res-img" class="w-full object-contain max-h-72">
            </div>
          </div>
        </div>

        <!-- Connection Guides for SHUO Canvas -->
        <div class="glass-card rounded-2xl p-5 space-y-3">
          <div class="flex items-center space-x-2 text-white font-semibold">
            <i class="fa-solid fa-circle-nodes text-indigo-400"></i>
            <h3>SHUO Canvas 画布对接状态</h3>
          </div>
          <div class="text-xs text-gray-300 space-y-2 leading-relaxed">
            <div class="flex items-center justify-between p-2.5 rounded-xl bg-gray-950/60 border border-gray-800">
              <span class="text-gray-400">即梦/三视图自动代发：</span>
              <span class="text-emerald-400 font-medium">已自动桥接 (127.0.0.1:8180)</span>
            </div>
            <div class="flex items-center justify-between p-2.5 rounded-xl bg-gray-950/60 border border-gray-800">
              <span class="text-gray-400">OpenAI 标准 API：</span>
              <span class="text-indigo-300 font-mono text-[11px]">http://127.0.0.1:8180/v1</span>
            </div>
            <p class="text-[11px] text-gray-500 pt-1">
              ✨ 提示：系统会在轮询出图前全自动读取账号真实余额，积分 &lt; 6 的账号会自动跳过并标记停用，无需人工逐一核对。
            </p>
          </div>
        </div>
      </div>

      <!-- Right Column: Account Pool Management (7 cols) -->
      <div class="lg:col-span-7 space-y-6">
        <div class="glass-card rounded-2xl p-5 space-y-4">
          <div class="flex items-center justify-between border-b border-gray-800 pb-3">
            <div class="flex items-center space-x-2">
              <i class="fa-solid fa-users-gear text-indigo-400"></i>
              <h2 class="font-semibold text-white">PhotoGPT 账号池管理</h2>
            </div>
            <div class="flex items-center space-x-2">
              <button onclick="openAddAccountModal()" class="px-3 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium flex items-center space-x-1.5 transition">
                <i class="fa-solid fa-plus"></i> <span>添加账号</span>
              </button>
            </div>
          </div>

          <!-- Accounts Table -->
          <div class="overflow-x-auto">
            <table class="w-full text-left text-xs">
              <thead class="text-gray-400 border-b border-gray-800">
                <tr>
                  <th class="py-2.5 px-3">账号 / 邮箱</th>
                  <th class="py-2.5 px-3">实时积分</th>
                  <th class="py-2.5 px-3">轮询状态</th>
                  <th class="py-2.5 px-3 text-right">操作</th>
                </tr>
              </thead>
              <tbody id="accounts-tbody" class="divide-y divide-gray-800/60 text-gray-200">
                <!-- Dynamically populated -->
              </tbody>
            </table>
          </div>
        </div>

        <!-- Real-time Generation Logs -->
        <div class="glass-card rounded-2xl p-5 space-y-3">
          <div class="flex items-center justify-between border-b border-gray-800 pb-3">
            <div class="flex items-center space-x-2">
              <i class="fa-solid fa-clock-rotate-left text-indigo-400"></i>
              <h2 class="font-semibold text-white">实时出图调用日志</h2>
            </div>
            <span class="text-xs text-gray-500" id="log-count">0 条记录</span>
          </div>
          <div id="logs-container" class="space-y-2 max-h-64 overflow-y-auto pr-1">
            <!-- Dynamically populated logs -->
            <p class="text-xs text-gray-500 text-center py-6">暂无调用记录，在左侧或画布中发起生图后将在此处实时显示。</p>
          </div>
        </div>
      </div>

    </div>
  </main>

  <!-- Add Account Modal -->
  <div id="account-modal" class="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 hidden flex items-center justify-center p-4">
    <div class="glass-card rounded-2xl max-w-md w-full p-6 space-y-4 border border-gray-700 shadow-2xl">
      <div class="flex items-center justify-between border-b border-gray-800 pb-3">
        <h3 class="text-base font-semibold text-white flex items-center space-x-2">
          <i class="fa-solid fa-user-plus text-indigo-400"></i> <span>添加 PhotoGPT 账号</span>
        </h3>
        <button onclick="closeAddAccountModal()" class="text-gray-400 hover:text-white transition">
          <i class="fa-solid fa-xmark"></i>
        </button>
      </div>

      <div class="space-y-3 text-xs">
        <div>
          <label class="block text-gray-300 font-medium mb-1">账号邮箱 (Email)</label>
          <input type="email" id="modal-email" class="w-full rounded-xl bg-gray-950/80 border border-gray-800 px-3.5 py-2 text-gray-100 placeholder-gray-500 focus:outline-none focus:border-indigo-500" placeholder="例如：user@gmail.com">
        </div>
        <div>
          <label class="block text-gray-300 font-medium mb-1">认证 Cookie: nc_token (必填)</label>
          <textarea id="modal-token" rows="2" class="w-full rounded-xl bg-gray-950/80 border border-gray-800 px-3.5 py-2 font-mono text-[11px] text-gray-100 placeholder-gray-500 focus:outline-none focus:border-indigo-500" placeholder="复制 Cookie 中的 nc_token 字符串"></textarea>
        </div>
        <div>
          <label class="block text-gray-300 font-medium mb-1">设备 Cookie: anonymous_user_id (可选)</label>
          <input type="text" id="modal-anon" class="w-full rounded-xl bg-gray-950/80 border border-gray-800 px-3.5 py-2 font-mono text-[11px] text-gray-100 placeholder-gray-500 focus:outline-none focus:border-indigo-500" placeholder="例如：b0195994-8396-4257-93e1-...">
        </div>
        <div>
          <label class="block text-gray-300 font-medium mb-1">初始免费积分 (默认 20)</label>
          <input type="number" id="modal-credits" value="20" class="w-full rounded-xl bg-gray-950/80 border border-gray-800 px-3.5 py-2 text-gray-100 placeholder-gray-500 focus:outline-none focus:border-indigo-500">
        </div>
      </div>

      <div class="flex items-center justify-end space-x-3 pt-2">
        <button onclick="closeAddAccountModal()" class="px-4 py-2 rounded-xl bg-gray-800 hover:bg-gray-700 text-gray-300 text-xs font-medium transition">取消</button>
        <button onclick="submitNewAccount()" class="px-5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium transition glow-btn">保存账号</button>
      </div>
    </div>
  </div>

  <script>
    let currentRefBase64 = null;

    async function refreshData() {
      try {
        const [accRes, statsRes, logsRes] = await Promise.all([
          fetch('/api/accounts').then(r => r.json()),
          fetch('/api/stats').then(r => r.json()),
          fetch('/api/logs').then(r => r.json())
        ]);

        renderAccounts(accRes.accounts || []);
        renderStats(statsRes, accRes.accounts || []);
        renderLogs(logsRes.logs || []);
      } catch (e) {
        console.error('Failed to refresh data:', e);
      }
    }

    async function triggerSyncAllCredits() {
      const btn = document.getElementById('btn-sync-all');
      btn.disabled = true;
      btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> <span>正在全自动同步各账号实时积分...</span>';

      try {
        const res = await fetch('/api/accounts/sync-all', { method: 'POST' }).then(r => r.json());
        if (res.success) {
          refreshData();
        } else {
          alert('同步失败: ' + (res.message || res.error));
        }
      } catch (e) {
        alert('同步失败: ' + e.message);
      } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-arrows-rotate"></i> <span>同步全部实时积分</span>';
      }
    }

    function renderStats(stats, accounts) {
      const eligibleAccs = accounts.filter(a => a.active && (a.available_credits === undefined || a.available_credits >= 6));
      document.getElementById('stat-accounts').innerText = \`\${accounts.length} / \${eligibleAccs.length} 可用\`;
      
      const totalCredits = eligibleAccs.reduce((sum, a) => sum + (a.available_credits || 0), 0);
      const estImages = Math.floor(totalCredits / 6);
      document.getElementById('stat-credits').innerText = \`\${totalCredits} (约 \${estImages} 张)\`;

      document.getElementById('stat-generations').innerText = \`\${stats.totalGenerations || 0} / \${stats.successfulGenerations || 0}\`;
    }

    function renderAccounts(accounts) {
      const tbody = document.getElementById('accounts-tbody');
      if (accounts.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" class="text-center py-6 text-gray-500">暂无账号，点击上方添加</td></tr>';
        return;
      }

      tbody.innerHTML = accounts.map(a => {
        const credits = a.available_credits !== undefined ? a.available_credits : 20;
        const progress = Math.min(100, Math.round((credits / 20) * 100));
        const isEligible = a.active && credits >= 6;
        const color = isEligible ? 'bg-indigo-500' : 'bg-rose-500';

        return \`
          <tr class="hover:bg-gray-800/40 transition">
            <td class="py-3 px-3">
              <div class="flex items-center space-x-2.5">
                <div class="w-7 h-7 rounded-full bg-gray-800 flex items-center justify-center font-bold text-indigo-400 text-xs">
                  \${(a.email || 'U')[0].toUpperCase()}
                </div>
                <div>
                  <div class="font-medium text-gray-200">\${a.email}</div>
                  <div class="text-[10px] text-gray-500 font-mono truncate max-w-[140px]">\${a.nc_token ? a.nc_token.slice(0, 10) + '...' : 'No token'}</div>
                </div>
              </div>
            </td>
            <td class="py-3 px-3">
              <div class="w-32 space-y-1">
                <div class="flex items-center justify-between text-[11px]">
                  <span class="font-semibold \${credits >= 6 ? 'text-gray-200' : 'text-rose-400'}">\${credits} 积分</span>
                  <span class="text-gray-500">\${Math.floor(credits / 6)} 张</span>
                </div>
                <div class="w-full bg-gray-800 h-1.5 rounded-full overflow-hidden">
                  <div class="\${color} h-full rounded-full transition-all duration-300" style="width: \${progress}%"></div>
                </div>
              </div>
            </td>
            <td class="py-3 px-3">
              \${isEligible ? 
                '<span class="px-2 py-0.5 rounded text-[10px] font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">🟢 正常轮询</span>' : 
                '<span class="px-2 py-0.5 rounded text-[10px] font-medium bg-rose-500/10 text-rose-400 border border-rose-500/20">🔴 积分不足 (自动停止轮询)</span>'}
            </td>
            <td class="py-3 px-3 text-right space-x-2">
              <button onclick="toggleAccount(\${a.id})" class="text-gray-400 hover:text-indigo-400 transition" title="手动开关">
                <i class="fa-solid \${a.active ? 'fa-toggle-on text-indigo-400 text-sm' : 'fa-toggle-off text-gray-600 text-sm'}"></i>
              </button>
              <button onclick="deleteAccount(\${a.id})" class="text-gray-400 hover:text-rose-400 transition" title="删除">
                <i class="fa-regular fa-trash-can"></i>
              </button>
            </td>
          </tr>
        \`;
      }).join('');
    }

    function renderLogs(logs) {
      const container = document.getElementById('logs-container');
      document.getElementById('log-count').innerText = \`\${logs.length} 条记录\`;

      if (logs.length === 0) {
        container.innerHTML = '<p class="text-xs text-gray-500 text-center py-6">暂无调用记录</p>';
        return;
      }

      container.innerHTML = logs.map(l => {
        const isSuccess = l.status === 'SUCCESS';
        const badge = isSuccess ? 
          '<span class="text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded text-[10px] font-medium">成功</span>' : 
          '<span class="text-rose-400 bg-rose-500/10 px-2 py-0.5 rounded text-[10px] font-medium">失败</span>';

        return \`
          <div class="p-3 rounded-xl bg-gray-950/60 border border-gray-800 hover:border-gray-700 transition space-y-1.5">
            <div class="flex items-center justify-between text-xs">
              <div class="flex items-center space-x-2">
                \${badge}
                <span class="text-gray-400 font-mono text-[11px]">\${l.time}</span>
                <span class="text-gray-400">账号: <strong class="text-gray-300">\${l.account}</strong></span>
              </div>
              <span class="text-gray-500 font-mono text-[11px]">\${l.duration}s</span>
            </div>
            <p class="text-xs text-gray-300 truncate" title="\${l.prompt}">\${l.prompt}</p>
            \${l.error ? \`<p class="text-[11px] text-rose-400/90">\${l.error}</p>\` : ''}
            \${l.imageUrl ? \`
              <div class="pt-1 flex items-center space-x-2">
                <img src="/proxy-image?url=\${encodeURIComponent(l.imageUrl)}" class="w-10 h-10 rounded object-cover border border-gray-800">
                <a href="/proxy-image?url=\${encodeURIComponent(l.imageUrl)}" target="_blank" class="text-[11px] text-indigo-400 hover:underline">查看高清原图</a>
              </div>
            \` : ''}
          </div>
        \`;
      }).join('');
    }

    // Modal controls
    function openAddAccountModal() { document.getElementById('account-modal').classList.remove('hidden'); }
    function closeAddAccountModal() { document.getElementById('account-modal').classList.add('hidden'); }

    async function submitNewAccount() {
      const email = document.getElementById('modal-email').value.trim();
      const token = document.getElementById('modal-token').value.trim();
      const anon = document.getElementById('modal-anon').value.trim();
      const credits = parseInt(document.getElementById('modal-credits').value) || 20;

      if (!email || !token) {
        alert('请填写邮箱和 nc_token');
        return;
      }

      const res = await fetch('/api/accounts/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, nc_token: token, anonymous_user_id: anon, available_credits: credits })
      }).then(r => r.json());

      closeAddAccountModal();
      refreshData();
    }

    async function deleteAccount(id) {
      if (!confirm('确定删除该账号吗？')) return;
      await fetch('/api/accounts/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id })
      });
      refreshData();
    }

    async function toggleAccount(id) {
      await fetch('/api/accounts/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id })
      });
      refreshData();
    }

    // File Drag & Drop
    function handleFileSelect(e) {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (event) => {
        currentRefBase64 = event.target.result;
        document.getElementById('drop-prompt').classList.add('hidden');
        document.getElementById('drop-preview-box').classList.remove('hidden');
        document.getElementById('drop-preview-img').src = currentRefBase64;
      };
      reader.readAsDataURL(file);
    }

    function clearRefImage(e) {
      e.stopPropagation();
      currentRefBase64 = null;
      document.getElementById('play-file').value = '';
      document.getElementById('drop-preview-box').classList.add('hidden');
      document.getElementById('drop-prompt').classList.remove('hidden');
    }

    document.getElementById('drop-zone').addEventListener('click', () => {
      document.getElementById('play-file').click();
    });

    // Generate Playground
    async function startGeneration() {
      const prompt = document.getElementById('play-prompt').value.trim();
      const ratio = document.getElementById('play-ratio').value;
      const btn = document.getElementById('btn-generate');

      if (!prompt) {
        alert('请输入提示词');
        return;
      }

      btn.disabled = true;
      btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> <span>正在全自动生图中 (约 15~25s)...</span>';

      try {
        const res = await fetch('/v1/images/generations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt,
            image: currentRefBase64,
            aspect_ratio: ratio,
            size: ratio === '16:9' ? '1024x576' : (ratio === '9:16' ? '576x1024' : '1024x1024')
          })
        }).then(r => r.json());

        if (res.error) {
          throw new Error(res.error.message || 'Generation failed');
        }

        const imgUrl = res.data[0].url;
        document.getElementById('res-img').src = imgUrl;
        document.getElementById('res-download-btn').href = imgUrl;
        document.getElementById('play-result').classList.remove('hidden');
      } catch (e) {
        alert('生图失败: ' + e.message);
      } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-bolt"></i> <span>立即生成 (消耗 6 积分)</span>';
        refreshData();
      }
    }

    function copyEndpoint() {
      const url = window.location.origin + '/v1/images/generations';
      navigator.clipboard.writeText(url);
      alert('已复制 OpenAI 生图接口地址：' + url);
    }

    // Auto Refresh
    refreshData();
    setInterval(refreshData, 5000);
  </script>
</body>
</html>
`;

// ----------------- Express Endpoints -----------------

// GET / - Web Visual Dashboard
app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(DASHBOARD_HTML);
});

// GET /api/stats
app.get('/api/stats', (req, res) => {
  res.json({
    ...stats,
    uptimeSec: Math.round((Date.now() - stats.startTime) / 1000)
  });
});

// GET /api/logs
app.get('/api/logs', (req, res) => {
  res.json({ logs: generationLogs });
});

// POST /api/accounts/sync-all
app.post('/api/accounts/sync-all', async (req, res) => {
  const result = await syncAllAccountsRealCredits();
  res.json(result);
});

// POST /api/v2/dreamina/image2image & text2image (Canvas Native Compatibility)
const handleDreaminaGenerate = async (req, res) => {
  const prompt = req.body.prompt || req.body.user_prompt || '';
  const refImage = req.body.images?.[0] || req.body.image || req.body.inputUrls?.[0] || null;
  const ratio = req.body.ratio || req.body.aspectRatio || '16:9';

  console.log(`\n[Dreamina API Mock] Received Image Generation Request from Canvas`);
  console.log(`[Dreamina API Mock] Prompt: "${prompt.slice(0, 80)}" | Has Ref: ${Boolean(refImage)}`);

  const submitId = `pgpt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  dreaminaTasks.set(submitId, { status: 'running', phase: 'generating', outputs: [], createdAt: Date.now() });

  res.json({
    success: true,
    submitId: submitId,
    data: { submitId: submitId }
  });

  (async () => {
    try {
      const rawImageUrl = await doPhotoGPTGenerate({ prompt, refImage, aspectRatio: ratio });
      const proxyUrl = `http://127.0.0.1:${PORT}/proxy-image?url=${encodeURIComponent(rawImageUrl)}`;
      
      dreaminaTasks.set(submitId, {
        status: 'success',
        phase: 'done',
        outputs: [
          {
            url: proxyUrl,
            localUrl: proxyUrl,
            imageUrl: proxyUrl,
            sourceUrl: rawImageUrl
          }
        ],
        finishedAt: Date.now()
      });
      console.log(`[Dreamina API Mock] Task ${submitId} completed successfully.`);
    } catch (e) {
      console.error(`[Dreamina API Mock] Task ${submitId} failed:`, e.message);
      dreaminaTasks.set(submitId, {
        status: 'failed',
        phase: 'failed',
        failReason: e.message,
        outputs: [],
        error: e.message
      });
    }
  })();
};

app.post('/api/v2/dreamina/image2image', handleDreaminaGenerate);
app.post('/api/v2/dreamina/text2image', handleDreaminaGenerate);
app.post('/api/v2/dreamina/image_upscale', handleDreaminaGenerate);

// GET /api/v2/dreamina/query_result
app.get('/api/v2/dreamina/query_result', (req, res) => {
  const submitId = req.query.submitId;
  const task = dreaminaTasks.get(submitId);

  if (!task) {
    return res.json({
      success: true,
      status: 'pending',
      data: { queueStatus: 'queued', queueIndex: 1 }
    });
  }

  if (task.status === 'success') {
    return res.json({
      success: true,
      status: 'success',
      data: {
        gen_status: 'success',
        status: 'success',
        image_infos: task.outputs,
        images: task.outputs.map(o => o.url),
        results: task.outputs
      }
    });
  }

  if (task.status === 'failed') {
    return res.json({
      success: false,
      status: 'failed',
      message: task.failReason || 'PhotoGPT Generation failed',
      data: {
        fail_reason: task.failReason,
        status: 'failed'
      }
    });
  }

  return res.json({
    success: true,
    status: 'pending',
    data: {
      gen_status: 'generating',
      status: 'pending'
    }
  });
});

// POST /v1/images/generations (Standard OpenAI API)
app.post('/v1/images/generations', async (req, res) => {
  console.log(`\n[OpenAI API /v1/images/generations] Request received at ${new Date().toLocaleTimeString()}`);
  const { prompt, model, image, n = 1, size = '1024x1024', response_format = 'url', aspect_ratio, ratio } = req.body;
  
  if (!prompt) {
    return res.status(400).json({ error: { message: 'Prompt is required', type: 'invalid_request_error' } });
  }

  const finalRatio = normalizeAspectRatio(aspect_ratio || ratio, size);

  try {
    const rawImageUrl = await doPhotoGPTGenerate({
      prompt,
      refImage: image,
      aspectRatio: finalRatio
    });

    const proxyUrl = `http://127.0.0.1:${PORT}/proxy-image?url=${encodeURIComponent(rawImageUrl)}`;

    if (response_format === 'b64_json') {
      const imgBuffer = await downloadImageWithReferer(rawImageUrl);
      const b64 = imgBuffer.toString('base64');
      return res.json({
        created: Math.floor(Date.now() / 1000),
        data: [{ b64_json: b64, url: proxyUrl }]
      });
    }

    return res.json({
      created: Math.floor(Date.now() / 1000),
      data: [{ url: proxyUrl, sourceUrl: rawImageUrl }]
    });

  } catch (err) {
    console.error('[OpenAI API Error]', err);
    return res.status(500).json({
      error: {
        message: `PhotoGPT 生图失败: ${err.message}`,
        type: 'api_error'
      }
    });
  }
});

// GET /v1/models
app.get('/v1/models', (req, res) => {
  res.json({
    object: 'list',
    data: [
      { id: 'gpt-image-2', object: 'model', created: 1787813800, owned_by: 'photogpt' },
      { id: 'gpt-image-2.0', object: 'model', created: 1787813800, owned_by: 'photogpt' }
    ]
  });
});

// GET /api/accounts - List all accounts & credits
app.get('/api/accounts', (req, res) => {
  const accounts = loadAccounts();
  res.json({ count: accounts.length, accounts });
});

// POST /api/accounts/add - Add a new PhotoGPT account
app.post('/api/accounts/add', (req, res) => {
  const { email, name, nc_token, anonymous_user_id, available_credits = 20 } = req.body;
  if (!email || !nc_token) {
    return res.status(400).json({ error: 'email and nc_token are required' });
  }

  const accounts = loadAccounts();
  const existingIdx = accounts.findIndex(a => a.email === email);
  const newAccount = {
    id: existingIdx >= 0 ? accounts[existingIdx].id : accounts.length + 1,
    email,
    name: name || email.split('@')[0],
    nc_token,
    anonymous_user_id: anonymous_user_id || '',
    available_credits: Number(available_credits) || 20,
    active: true
  };

  if (existingIdx >= 0) {
    accounts[existingIdx] = newAccount;
  } else {
    accounts.push(newAccount);
  }

  saveAccounts(accounts);
  res.json({ message: 'Account saved successfully', account: newAccount });
});

// POST /api/accounts/delete
app.post('/api/accounts/delete', (req, res) => {
  const { id } = req.body;
  let accounts = loadAccounts();
  accounts = accounts.filter(a => a.id !== id);
  saveAccounts(accounts);
  res.json({ success: true });
});

// POST /api/accounts/toggle
app.post('/api/accounts/toggle', (req, res) => {
  const { id } = req.body;
  const accounts = loadAccounts();
  const acc = accounts.find(a => a.id === id);
  if (acc) {
    acc.active = !acc.active;
    saveAccounts(accounts);
  }
  res.json({ success: true, active: acc?.active });
});

// Health check
app.get('/health', (req, res) => {
  const accounts = loadAccounts();
  res.json({ status: 'ok', active_accounts: accounts.filter(a => a.active).length });
});

// Image Proxy to solve anti-hotlink Referer issue
app.get('/proxy-image', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('Missing url');
  try {
    const buffer = await downloadImageWithReferer(url);
    res.setHeader('Content-Type', 'image/png');
    res.send(buffer);
  } catch(e) {
    res.status(500).send(e.message);
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`====================================================`);
  console.log(` [PhotoGPT Multi-Account Reverse Proxy & Dashboard]`);
  console.log(` Web Dashboard:  http://127.0.0.1:${PORT}`);
  console.log(` OpenAI Endpoint: http://127.0.0.1:${PORT}/v1/images/generations`);
  console.log(` Dreamina Mock:   http://127.0.0.1:${PORT}/api/v2/dreamina/*`);
  console.log(` Account API:     http://127.0.0.1:${PORT}/api/accounts`);
  console.log(`====================================================`);
});
