/**
 * ============================================================
 *  免費的跨裝置資料庫 — Google Apps Script + Google 試算表
 * ============================================================
 *  這個檔案解決三件事：
 *    1. 學生在自己手機／iPad／電腦送出作答 → 老師在任何地方都看得到
 *    2. 學生做到一半的進度存在雲端 → 換裝置也能繼續
 *    3. 學生可自助註冊（班級代碼）→ 名冊自動同步給老師
 *
 *  為什麼不直接寫 GitHub？
 *    寫入 repo 需要 Token，把 Token 給學生＝把 repo 控制權交出去。
 *    Apps Script 部署成「任何人（含匿名）」即可公開收件，免費、無流量上限。
 *
 *  ── 設定步驟（約 5 分鐘）────────────────────────────────
 *  1. 新增一個 Google 試算表，從網址複製 SPREADSHEET_ID
 *       https://docs.google.com/spreadsheets/d/【這串就是 ID】/edit
 *  2. 試算表 → 擴充功能 → Apps Script → 清空後貼上本檔 → 填入底下的 ID
 *  3. 選單執行 setup() 一次（建立工作表與標題列）
 *  4. 部署 → 新增部署作業 → 「網頁應用程式」
 *       執行身分：我 │ 誰可以存取：任何人（含匿名）
 *     → 複製 Web App 網址（…/exec）＝【寫入網址】
 *  5. 回到試算表 → 檔案 → 共用 → 發佈到網路
 *       選擇「Data」這個工作表、格式「逗號分隔值（CSV）」
 *     → 複製網址（…/pub?output=csv）＝【讀取網址】
 *  6. 把兩個網址貼到網站「老師專區 → ⑤ 資料與同步」
 *
 *  重要：CSV 是 Google 快取的，學生送出後老師約 0–5 分鐘才看得到。
 *       網站會先嘗試即時讀取（/exec），失敗才用 CSV，所以通常很快。
 * ============================================================
 */

var SPREADSHEET_ID = '請填入你的試算表 ID';
var SHEET_NAME = 'Data';
var HEADERS = ['type', 'id', 'quizId', 'studentId', 'studentName', 'ts', 'payload'];

/* 自助註冊的班級代碼；留空＝不開放自助註冊（只接受老師建立的帳號） */
var CLASS_CODE = '';
/* key 用來防止路人亂寫；網站送出時會帶上 */
var WRITE_KEY = '';

/* ============================================================
   AI 代理（選用）
   ------------------------------------------------------------
   用途：讓「設定 → AI 助理」的 hook 通道把請求轉給大模型，
   金鑰留在這裡（指令碼屬性），學生的瀏覽器完全看不到。

   ★★★ 香港／中國大陸的老師請看這裡 ★★★
   Google AI Studio **不支援香港地區**，所以在那邊連「申請免費金鑰」
   都做不到。但 **Apps Script 本身在香港是正常可用的**，而它的伺服器
   在 Google 的支援區域內 → 由它代打 Gemini 就完全繞過地區限制，
   而且**不需要 VPN**。

   設定方式：Apps Script → 專案設定 → 指令碼屬性，新增：
     AI_PROVIDER  deepseek | gemini | direct | openrouter   （預設 direct）
     AI_ENDPOINT  留空即可（會依 provider 自動決定）
     AI_MODEL     留空即可（gemini／deepseek 都會自動帶入可用的型號）
     AI_KEY       你的金鑰
   另外把 AI_ENABLED 設成 true 才會生效（避免沒設定就被打）。

   ★ 香港／中國大陸最推薦：AI_PROVIDER = deepseek
     DeepSeek 不擋香港 IP，金鑰在 platform.deepseek.com 就能申請，
     完全不必 VPN、不必經中間服務（OpenRouter）。
     ⚠ 模型名不要填 deepseek-chat／deepseek-reasoner，官方已於 2026-07-24 停用。

   若要拿 Gemini 金鑰但人在香港：可以先請在支援地區的朋友代為申請，
   或直接用 DeepSeek／OpenRouter 的金鑰（這兩家在香港可直接申請）。
   ============================================================ */
var AI_ENABLED = false;

function aiProps_() {
  var p = PropertiesService.getScriptProperties();
  return {
    provider: (p.getProperty('AI_PROVIDER') || 'direct').toLowerCase(),
    endpoint: p.getProperty('AI_ENDPOINT') || '',
    model: p.getProperty('AI_MODEL') || '',
    key: p.getProperty('AI_KEY') || ''
  };
}

/** Gemini 偏好序（新→舊）；執行時會先問 ListModels，這裡只是後備 */
var AI_GEMINI_PREFERENCE = [
  'gemini-flash-latest', 'gemini-3-flash-preview', 'gemini-2.5-flash',
  'gemini-2.5-flash-lite', 'gemini-2.0-flash-lite', 'gemini-2.0-flash'
];

/**
 * 問 Google「這把金鑰能用哪些模型」，挑一個最新的 flash。
 * 為什麼要問：Google 會定期淘汰舊模型（gemini-2.0-flash 已在 2026-06-01 停用），
 * 寫死模型名會在某天突然 404。
 */
function aiPickGeminiModel_(endpoint, key, want) {
  var url = String(endpoint).replace(/\/+$/, '') + '/models?key=' + encodeURIComponent(key) + '&pageSize=200';
  var models = [];
  try {
    var res = UrlFetchApp.fetch(url, { method: 'get', muteHttpExceptions: true });
    if (res.getResponseCode() === 200) {
      var j = JSON.parse(res.getContentText());
      models = (j.models || []).filter(function (m) {
        var methods = m.supportedGenerationMethods || [];
        return methods.indexOf('generateContent') >= 0;
      }).map(function (m) {
        return String(m.name || '').replace(/^models\//, '');
      }).filter(function (n) {
        /* embedding / imagen / veo / tts 不是聊天模型 */
        return n && !/embedding|aqa|imagen|veo|tts|native-audio/i.test(n);
      });
    }
  } catch (e) { /* 讀不到就退回偏好序 */ }

  if (want && models.indexOf(want) >= 0) return want;
  for (var i = 0; i < AI_GEMINI_PREFERENCE.length; i++) {
    if (models.indexOf(AI_GEMINI_PREFERENCE[i]) >= 0) return AI_GEMINI_PREFERENCE[i];
  }
  var flash = models.filter(function (n) { return /flash/i.test(n); });
  if (flash.length) return flash[0];
  return want || AI_GEMINI_PREFERENCE[2];
}

/** 代理一次對話請求；回傳 {text, model, usage} */
function aiChat_(d) {
  if (!AI_ENABLED) throw new Error('代理未啟用（請在 Apps Script 設 AI_ENABLED = true）');
  var c = aiProps_();

  /* 允許呼叫端覆寫模型／端點，但金鑰一律以這裡為準 */
  var provider = (d.provider || c.provider || 'direct').toLowerCase();
  var endpoint = d.endpoint || c.endpoint;
  var model = d.model || c.model;
  if (!c.key) throw new Error('尚未在 Apps Script 設定 AI_KEY');

  if (provider === 'gemini') {
    if (!endpoint) endpoint = 'https://generativelanguage.googleapis.com/v1beta';
    /* 沒指定模型（或指定的已下架）→ 自動問一個可用的 */
    if (!model) model = aiPickGeminiModel_(endpoint, c.key, '');
  } else if (provider === 'openrouter') {
    if (!endpoint) endpoint = 'https://openrouter.ai/api/v1';
    if (!model) model = 'google/gemini-2.5-flash';
  } else if (provider === 'deepseek') {
    /* 香港／中國大陸最省事：不擋 IP、直連、不必中間服務 */
    if (!endpoint) endpoint = 'https://api.deepseek.com';
    /* ⚠ deepseek-chat／deepseek-reasoner 已於 2026-07-24 停用 */
    if (!model) model = 'deepseek-v4-flash';
  } else {
    if (!endpoint) endpoint = 'https://api.openai.com/v1';
  }

  var messages = d.messages || [];
  var body, url, headers;
  if (provider === 'gemini') {
    var sys = messages.filter(function (m) { return m.role === 'system'; })
      .map(function (m) { return m.content; }).join('\n');
    var contents = messages.filter(function (m) { return m.role !== 'system'; })
      .map(function (m) { return { role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }; });
    url = String(endpoint).replace(/\/+$/, '') + '/models/' + encodeURIComponent(model) +
      ':generateContent?key=' + encodeURIComponent(c.key);
    body = { contents: contents, generationConfig: { temperature: d.temperature || 0.2, maxOutputTokens: 8192 } };
    if (sys) body.systemInstruction = { parts: [{ text: sys }] };
    headers = { 'Content-Type': 'application/json' };
  } else {
    var base = String(endpoint).replace(/\/+$/, '');
    url = base + (/\/v\d/.test(base) ? '/chat/completions' : '/v1/chat/completions');
    body = { model: model || 'gpt-4o-mini', temperature: d.temperature || 0.2, messages: messages };
    headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + c.key };
    if (provider === 'openrouter') {
      headers['HTTP-Referer'] = 'https://2w2wqian-pixel.github.io/reading-quiz/';
      headers['X-Title'] = 'reading-quiz';
    }
  }

  var res = UrlFetchApp.fetch(url, {
    method: 'post', contentType: 'application/json', headers: headers,
    payload: JSON.stringify(body), muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  var txt = res.getContentText();
  var j = null;
  try { j = JSON.parse(txt); } catch (e) { }
  if (code < 200 || code >= 300) {
    var msg = (j && j.error && (j.error.message || j.error)) || txt.slice(0, 300);
    if (j && j.error && j.error.status === 'FAILED_PRECONDITION') {
      msg += '（這把金鑰的地區沒有免費層；請在 AI Studio 開啟帳單，或改用 OpenRouter／DeepSeek）';
    }
    if (code === 404 && provider === 'gemini' && d.model) {
      msg += '（模型「' + d.model + '」可能已下架；把 AI_MODEL 留空讓程式自動挑）';
    }
    throw new Error('AI 服務回應錯誤（' + code + '）：' + msg);
  }
  var out = '';
  if (provider === 'gemini') {
    var cand = j && j.candidates && j.candidates[0];
    out = cand && cand.content && cand.content.parts
      ? cand.content.parts.map(function (p) { return p.text || ''; }).join('') : '';
    if (!out && cand && cand.finishReason === 'MAX_TOKENS') {
      throw new Error('AI 回應被長度上限截斷（finishReason=MAX_TOKENS）：這次的試卷太長，請分批送出');
    }
  } else {
    var ch = j && j.choices && j.choices[0];
    out = ch && ((ch.message && ch.message.content) || ch.text) || '';
  }
  if (!out) throw new Error('AI 回應沒有內容');
  return { text: out, model: model, usage: (j && (j.usage || j.usageMetadata)) || null };
}

function getSheet_() {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME);
    sh.appendRow(HEADERS);
    sh.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

/** 第一次執行：建立工作表 */
function setup() {
  var sh = getSheet_();
  Logger.log('工作表已建立：' + SHEET_NAME + '，共 ' + sh.getLastRow() + ' 列');
}

/**
 * 寫入（學生送出作答／存草稿／註冊；老師更新名冊）
 * 以 id 為主鍵：已存在就覆寫，否則新增。
 */
function doPost(e) {
  try {
    var d = JSON.parse(e.postData.contents);

    /* AI 代理：優先處理，且只認 WRITE_KEY（若設了） */
    if (d.action === 'ai') {
      if (WRITE_KEY && d.key !== WRITE_KEY) return jsonOut_({ ok: false, error: 'bad key' });
      try {
        var r = aiChat_(d);
        return jsonOut_({ ok: true, text: r.text, model: r.model, usage: r.usage });
      } catch (aiErr) {
        return jsonOut_({ ok: false, error: String(aiErr) });
      }
    }

    /* 刪除（老師刪試卷時會用到）。
       ⚠️ 以前**完全沒有這個動作**：前端的 Cloud.del 在沒有 Firebase 時直接回傳「成功」，
       於是試卷永遠留在試算表裡 —— 症狀是「按了刪除，試卷還在清單裡」。
       只比對 id 欄（不篩 type）：id 本身已經是「type::主鍵」的合成字串，不會撞號，
       而 type 欄在不同版本可能寫成 quiz／quizzes。 */
    if (d.action === 'del') {
      if (WRITE_KEY && d.key !== WRITE_KEY) return jsonOut_({ ok: false, error: 'bad key' });
      var keys = (d.keys && d.keys.length) ? d.keys : [d.id];
      var wanted = {};
      for (var w = 0; w < keys.length; w++) if (keys[w]) wanted[String(keys[w])] = 1;
      var shDel = getSheet_();
      var lastDel = shDel.getLastRow();
      var removed = 0;
      if (lastDel > 1) {
        var col = shDel.getRange(2, 2, lastDel - 1, 1).getValues();
        /* 由下往上刪，刪掉一列才不會讓後面的列號位移 */
        for (var i = col.length - 1; i >= 0; i--) {
          if (wanted[String(col[i][0])] === 1) { shDel.deleteRow(i + 2); removed++; }
        }
      }
      return jsonOut_({ ok: true, removed: removed });
    }

    if (WRITE_KEY && d.key !== WRITE_KEY) return jsonOut_({ ok: false, error: 'bad key' });
    if (!d.type || !d.id) return jsonOut_({ ok: false, error: 'missing type/id' });
    /* 自助註冊要檢查班級代碼 */
    if (d.type === 'register' && CLASS_CODE && d.classCode !== CLASS_CODE) {
      return jsonOut_({ ok: false, error: 'class code mismatch' });
    }

    var sh = getSheet_();
    var lastRow = sh.getLastRow();
    var rowIndex = -1;

    if (lastRow > 1) {
      var ids = sh.getRange(2, 2, lastRow - 1, 1).getValues();
      for (var i = 0; i < ids.length; i++) {
        if (String(ids[i][0]) === String(d.id)) { rowIndex = i + 2; break; }
      }
    }

    var row = [
      d.type,
      d.id,
      d.quizId || '',
      d.studentId || '',
      d.studentName || '',
      d.ts || new Date().toISOString(),
      JSON.stringify(d)
    ];

    if (rowIndex > 0) sh.getRange(rowIndex, 1, 1, row.length).setValues([row]);
    else sh.appendRow(row);

    return jsonOut_({ ok: true, id: d.id, updated: rowIndex > 0 });
  } catch (err) {
    return jsonOut_({ ok: false, error: String(err) });
  }
}

/**
 * 讀取（即時）。瀏覽器直接打這裡會被 CORS 擋住，
 * 但網站會先試一次、失敗就改用「發佈成 CSV」的網址，所以兩個都留著最好。
 */
function doGet(e) {
  var p = (e && e.parameter) || {};
  if (p.action === 'list') return jsonOut_(readAll_(p.type));
  if (p.action === 'ping') return jsonOut_({ ok: true, service: 'reading-quiz', rows: getSheet_().getLastRow() - 1 });
  /* 讓老師從瀏覽器直接確認 AI 代理有沒有設定好（不會回傳金鑰本體） */
  if (p.action === 'ai-status') {
    var c = aiProps_();
    return jsonOut_({
      ok: true, aiEnabled: AI_ENABLED,
      provider: c.provider, endpoint: c.endpoint, model: c.model, hasKey: !!c.key
    });
  }
  return jsonOut_({ ok: true, service: 'reading-quiz collector' });
}

function readAll_(typeFilter) {
  var sh = getSheet_();
  var rows = sh.getDataRange().getValues();
  var out = [];
  for (var i = 1; i < rows.length; i++) {
    var raw = String(rows[i][6] || '');
    if (raw.charAt(0) !== '{') continue;
    var obj;
    try { obj = JSON.parse(raw); } catch (err) { continue; }
    if (typeFilter && obj.type !== typeFilter) continue;
    out.push(obj);
  }
  return out;
}

function jsonOut_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
