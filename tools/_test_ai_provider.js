/* 驗證 AI 通道的「路由與預設值」語意（不需要真的打網路）。
   重點（這些是實際踩過的雷）：
     1. DeepSeek 走 OpenAI 相容形狀 → kind 必須是 'direct'，但預設端點／模型
        要跟著 provider 走（不可退回 gpt-4o-mini）。
     2. base 尾端有沒有 /v1 都要能接成正確的 URL
        （https://api.deepseek.com 與 https://api.deepseek.com/v1 都要通）。
        歷史上 DeepSeek 官方文件兩個寫法都出現過，老師會照抄。
     3. 🔴 金鑰**只能**放在 Authorization 標頭。Gemini 那種 `?key=` 寫法
        若被沿用到 DeepSeek，金鑰會留在 URL 裡（proxy log、瀏覽器歷史）。
     4. 模型名會過期：DeepSeek 已於 2026-07-24 停用 deepseek-chat/reasoner，
        所以「模型清單」要查得到（GET /models），不能靠寫死。
     5. 🔴 callHook 在 provider==='hook' 時必須把 provider 送成**空字串**，
        否則會蓋掉 Apps Script 端的 AI_PROVIDER 指令碼屬性
        ——那正是「香港用 Apps Script 代打 Gemini」失效的原因。
   用法：node tools/_test_ai_provider.js                                     */
const fs = require('fs'), vm = require('vm');
const ROOT = 'C:/Users/user/WorkBuddy/2026-09-16-21-14-08/reading-quiz';

let pass = 0, fail = 0;
function check(name, ok, extra) {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok || extra === undefined ? '' : '   → ' + extra));
  ok ? pass++ : fail++;
}

/* ---------- 假的瀏覽器環境 ---------- */
let SETTINGS = { ai: {}, hook: {} };
const calls = [];            /* 每一次 fetch 的 { url, method, headers, body } */
let nextReply = null;        /* 覆寫下一次回應 */

global.window = global;
global.window.RQ = {
  util: { trim: function (s) { return String(s == null ? '' : s).trim(); } },
  settings: {
    get: function () { return SETTINGS; },
    set: function (patch) {
      Object.keys(patch || {}).forEach(function (k) {
        SETTINGS[k] = Object.assign({}, SETTINGS[k], patch[k]);
      });
      return Promise.resolve(SETTINGS);
    }
  }
};

function jsonReply(status, obj) {
  return {
    ok: status >= 200 && status < 300,
    status: status,
    text: function () { return Promise.resolve(JSON.stringify(obj)); }
  };
}

global.fetch = function (url, opt) {
  opt = opt || {};
  calls.push({
    url: String(url),
    method: opt.method || 'GET',
    headers: opt.headers || {},
    body: opt.body ? JSON.parse(opt.body) : null
  });
  if (nextReply) { const r = nextReply; nextReply = null; return Promise.resolve(r); }
  return Promise.resolve(jsonReply(200, {
    model: 'deepseek-v4-flash',
    choices: [{ message: { content: '成功' }, finish_reason: 'stop' }]
  }));
};

vm.runInThisContext(fs.readFileSync(ROOT + '/assets/js/core/ai.js', 'utf8'), { filename: 'ai.js' });
const AI = global.window.RQ.ai;
const ask = () => AI.chat([{ role: 'user', content: 'hi' }], { noFallback: true });

/* ---------- 1. 預設值 ---------- */
check('PROVIDERS 有 deepseek 通道',
  !!AI.PROVIDERS.deepseek, Object.keys(AI.PROVIDERS).join(','));
check('deepseek 預設端點是 https://api.deepseek.com',
  AI.PROVIDERS.deepseek.endpoint === 'https://api.deepseek.com',
  AI.PROVIDERS.deepseek.endpoint);
check('deepseek 預設模型是 deepseek-v4-flash（不是已停用的 deepseek-chat）',
  AI.PROVIDERS.deepseek.model === 'deepseek-v4-flash',
  AI.PROVIDERS.deepseek.model);
check('deepseek 的說明文字有提到不必 VPN',
  /不必 VPN|不擋/.test(AI.PROVIDERS.deepseek.label + JSON.stringify(AI.PROVIDERS.deepseek)),
  AI.PROVIDERS.deepseek.label);

/* ---------- 2. route() ---------- */
function setAI(patch) { SETTINGS.ai = Object.assign({}, SETTINGS.ai, patch); }

setAI({ provider: 'deepseek', enabled: true, apiKey: '' });
let r = AI.route();
check('deepseek 沒金鑰 → 未就緒，且 why 說出是 DeepSeek 缺金鑰',
  r.ready === false && /DeepSeek/.test(r.why || ''), JSON.stringify(r));

setAI({ apiKey: 'sk-test-deepseek' });
r = AI.route();
check('deepseek 有金鑰 → kind="direct"（OpenAI 相容形狀）、ready=true',
  r.ready === true && r.kind === 'direct', JSON.stringify(r));

setAI({ enabled: false });
check('未啟用時 isReady() 為 false', AI.isReady() === false);

/* ---------- 3. URL 組裝：base 有沒有 /v1 都要通 ---------- */
(async function () {
  setAI({ provider: 'deepseek', enabled: true, apiKey: 'sk-test-deepseek', endpoint: '', model: '' });

  /* endpoint 留空 → 應退回 provider 的預設端點，而不是報錯 */
  calls.length = 0;
  await ask();
  check('endpoint 留空時退回 PROVIDERS.deepseek.endpoint',
    calls[0].url === 'https://api.deepseek.com/v1/chat/completions', calls[0].url);
  check('模型留空時退回 deepseek-v4-flash',
    calls[0].body && calls[0].body.model === 'deepseek-v4-flash',
    JSON.stringify(calls[0].body && calls[0].body.model));

  setAI({ endpoint: 'https://api.deepseek.com/v1' });
  calls.length = 0;
  await ask();
  check('base 寫成 …/v1 時不會變成 …/v1/v1/chat/completions',
    calls[0].url === 'https://api.deepseek.com/v1/chat/completions', calls[0].url);

  setAI({ endpoint: 'https://api.deepseek.com/' });     /* 尾端多一個斜線 */
  calls.length = 0;
  await ask();
  check('base 尾端多餘斜線會被吃掉',
    calls[0].url === 'https://api.deepseek.com/v1/chat/completions', calls[0].url);

  setAI({ endpoint: 'https://api.openai.com/v1' });
  calls.length = 0;
  await ask();
  check('OpenAI 端點維持原樣（沒有被打成 /v1/v1）',
    calls[0].url === 'https://api.openai.com/v1/chat/completions', calls[0].url);

  /* ---------- 4. 金鑰不能出現在 URL ---------- */
  setAI({ endpoint: 'https://api.deepseek.com', apiKey: 'sk-SECRET-1234' });
  calls.length = 0;
  await ask();
  check('🔴 金鑰只在 Authorization 標頭，沒有跑進 URL',
    /^Bearer sk-SECRET-1234$/.test(calls[0].headers['Authorization'] || '') &&
    calls[0].url.indexOf('SECRET') < 0,
    calls[0].url + '  auth=' + calls[0].headers['Authorization']);
  check('deepseek 請求沒有把金鑰塞成 query string（不像 Gemini）',
    calls[0].url.indexOf('key=') < 0, calls[0].url);

  /* ---------- 5. 模型清單（GET /models） ---------- */
  setAI({ model: '' });
  nextReply = jsonReply(200, {
    object: 'list',
    data: [
      { id: 'deepseek-v4-pro' },
      { id: 'deepseek-v4-flash' },
      { id: 'deepseek-embedding-v1' }
    ]
  });
  calls.length = 0;
  let lm = await AI.listModels();
  check('listModels 走 GET <base>/v1/models',
    calls[0].method === 'GET' && calls[0].url === 'https://api.deepseek.com/v1/models', calls[0].url);
  check('listModels 帶 Authorization（且沒有把金鑰放 query）',
    /^Bearer /.test(calls[0].headers['Authorization'] || '') && calls[0].url.indexOf('key=') < 0,
    calls[0].url);
  check('listModels 排除 embedding 類模型',
    lm.all.indexOf('deepseek-embedding-v1') < 0, JSON.stringify(lm.all));
  check('listModels 建議 deepseek-v4-flash（便宜快的排前面）',
    lm.suggested === 'deepseek-v4-flash', lm.suggested);
  check('listModels 回報 kind="openai"（UI 才知道要講哪套話）',
    lm.kind === 'openai', lm.kind);

  /* 老師自己填的型號若還在清單裡，就尊重他 */
  setAI({ model: 'deepseek-v4-pro' });
  nextReply = jsonReply(200, { data: [{ id: 'deepseek-v4-flash' }, { id: 'deepseek-v4-pro' }] });
  lm = await AI.listModels();
  check('老師指定的模型仍在清單時，建議值尊重他的選擇',
    lm.suggested === 'deepseek-v4-pro', lm.suggested);

  /* 金鑰壞掉 → 401 要原樣透出，不能被吞 */
  nextReply = jsonReply(401, { error: { message: 'Authentication Fails, Your api key is invalid' } });
  try {
    await AI.listModels();
    check('listModels 遇到 401 要 reject', false, '竟然成功了');
  } catch (e) {
    check('listModels 遇到 401 原樣透出訊息（含 401 與 provider 原文）',
      /401/.test(e.message) && /api key is invalid/i.test(e.message), e.message);
  }

  /* hook 通道沒有模型清單可查 */
  setAI({ provider: 'hook' });
  try {
    await AI.listModels();
    check('hook 通道查模型清單要 reject', false, '竟然成功了');
  } catch (e) {
    check('hook 通道查模型清單時，訊息明說模型填在 Apps Script',
      /Apps Script/.test(e.message), e.message);
  }

  /* ---------- 6. callDirect 的錯誤原樣透出 ---------- */
  setAI({ provider: 'deepseek', endpoint: 'https://api.deepseek.com', model: 'deepseek-chat' });
  nextReply = jsonReply(400, { error: { message: 'Model Not Exist', type: 'invalid_request_error' } });
  try {
    await ask();
    check('模型不存在要 reject', false, '竟然成功了');
  } catch (e) {
    check('模型不存在的 400 原樣透出（老師才知道是模型名過期）',
      /400/.test(e.message) && /Model Not Exist/.test(e.message), e.message);
    check('400（模型問題）不該被誤判成地區限制', e.regionBlocked !== true, String(e.regionBlocked));
  }

  /* ---------- 7. callHook 的 provider 傳遞（香港代打 Gemini 的關鍵） ---------- */
  SETTINGS.hook = { postUrl: 'https://script.google.com/macros/s/FAKE/exec', key: 'K' };
  setAI({ provider: 'hook', upstream: '' });
  calls.length = 0;
  await ask().catch(function () { });
  check('🔴 provider="hook" 時送出的 provider 是空字串（讓 Apps Script 的 AI_PROVIDER 生效）',
    calls[0].body && calls[0].body.provider === '',
    JSON.stringify(calls[0].body && calls[0].body.provider));
  check('hook 沒有把 provider 寫死成 "direct"（那會蓋掉指令碼屬性）',
    calls[0].body && calls[0].body.provider !== 'direct',
    JSON.stringify(calls[0].body && calls[0].body.provider));
  check('hook 用 text/plain 送出（避免 Apps Script preflight）',
    /text\/plain/.test(calls[0].headers['Content-Type'] || ''), calls[0].headers['Content-Type']);

  setAI({ provider: 'hook', upstream: 'gemini' });
  calls.length = 0;
  await ask().catch(function () { });
  check('hook + upstream="gemini" 時就照送 gemini',
    calls[0].body && calls[0].body.provider === 'gemini',
    JSON.stringify(calls[0].body && calls[0].body.provider));

  /* 直接通道 + viaHook：主要通道失敗時要帶對 provider 去代打
     ⚠ 這條必須「不帶 noFallback」，否則 chat() 不會走備援分支 */
  setAI({ provider: 'deepseek', upstream: '', viaHook: true, endpoint: 'https://api.deepseek.com', model: 'deepseek-v4-flash' });
  nextReply = jsonReply(401, { error: { message: 'bad key' } });
  calls.length = 0;
  await AI.chat([{ role: 'user', content: 'hi' }]).catch(function () { });
  const hookCall = calls.filter(function (c) { return /script\.google\.com/.test(c.url); })[0];
  check('deepseek 失敗且開了 viaHook → 會改走代理',
    !!hookCall, JSON.stringify(calls.map(function (c) { return c.url; })));
  check('改走代理時 provider 帶的是 deepseek（不是預設值）',
    hookCall && hookCall.body.provider === 'deepseek',
    JSON.stringify(hookCall && hookCall.body.provider));

  console.log('\nSUMMARY: ' + pass + ' pass / ' + fail + ' fail');
  process.exit(fail ? 1 : 0);
})();
