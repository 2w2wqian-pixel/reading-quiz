/**
 * ============================================================
 *  免費的「學生作答收集端」— Google Apps Script
 * ============================================================
 *  用途：學生在瀏覽器送出作答 → 寫入 Google 試算表 → 老師讀回。
 *  為什麼不直接用 GitHub？
 *    因為寫入 GitHub 需要 Token，而 Token 不能交給學生。
 *    Apps Script 部署成「任何人（含匿名）」即可公開收件，免費且無流量上限。
 *
 *  ── 設定步驟 ────────────────────────────────────────────
 *  1. 建立一個新的 Google 試算表（或用現有的），複製網址裡的 SPREADSHEET_ID。
 *  2. 試算表 → 擴充功能 → Apps Script，把本檔內容全部貼上。
 *  3. 把底下的 SPREADSHEET_ID 改成你的。
 *  4. 部署 → 新增部署作業 → 選「網頁應用程式」
 *       - 執行身分：我（擁有者）
 *       - 誰可以存取：任何人（這樣學生才送得進來；不需要登入 Google）
 *  5. 複製產生的 Web App 網址（…/exec）→ 貼到網站「設定 → 學生作答收集端 → 送出網址」。
 *  6. 試算表 → 檔案 → 共用 → 發佈到網路 → 整份文件或指定工作表 → CSV
 *       → 複製那個 https://docs.google.com/spreadsheets/d/e/…/pub?output=csv
 *       → 貼到網站「讀取網址」。（Google 的 CSV 發佈允許跨網域讀取，老師端才讀得到）
 *
 *  安全性：任何知道 Web App 網址的人都能送出資料。若擔心，可在 CODE 常數
 *  填一組班級代碼，學生端送出時會帶上（設定頁的 secret 欄位）。
 * ============================================================
 */

var SPREADSHEET_ID = '請填入你的試算表 ID';
var SHEET_NAME = 'Submissions';
var CODE = '';   // 選填：班級代碼，留空表示不檢查

function getSheet_() {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME);
    sh.appendRow(['id', 'quizId', 'quizTitle', 'studentId', 'studentName',
      'attempt', 'submittedAt', 'durationSec', 'autoScore', 'manualScore',
      'total', 'max', 'marks', 'vocab', 'payload']);
  }
  return sh;
}

/** 學生送出：接收 POST（Content-Type: text/plain） */
function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    if (CODE && data.classCode !== CODE) {
      return jsonOut_({ ok: false, error: 'class code mismatch' });
    }

    var sc = data.score || {};
    var sh = getSheet_();
    sh.appendRow([
      data.id || Utilities.getUuid(),
      data.quizId || '',
      data.quizTitle || '',
      data.studentId || '',
      data.studentName || data.username || '',
      data.attempt || 1,
      data.submittedAt || new Date().toISOString(),
      data.durationSec || 0,
      sc.auto || 0,
      sc.manual || 0,
      sc.total || 0,
      sc.max || 0,
      (data.marks || []).length,
      (data.vocab || []).map(function (v) { return v.word; }).join(' / '),
      JSON.stringify(data)          // 完整內容放最後一欄，老師端用 CSV 讀回後解析
    ]);

    return jsonOut_({ ok: true, id: data.id });
  } catch (err) {
    return jsonOut_({ ok: false, error: String(err) });
  }
}

/** 老師讀取：GET ?action=list */
function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) || 'list';
  if (action === 'list') {
    var sh = getSheet_();
    var rows = sh.getDataRange().getValues();
    if (rows.length <= 1) return jsonOut_([]);
    var head = rows[0].map(function (h) { return String(h).toLowerCase(); });
    var pi = head.indexOf('payload');
    if (pi < 0) pi = rows[0].length - 1;
    var out = [];
    for (var i = 1; i < rows.length; i++) {
      var raw = String(rows[i][pi] || '');
      if (raw.charAt(0) === '{') {
        try { out.push(JSON.parse(raw)); } catch (err) { /* 略過壞資料 */ }
      }
    }
    return jsonOut_(out);
  }
  return jsonOut_({ ok: true, service: 'reading-quiz collector' });
}

function jsonOut_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/** 第一次執行：確保工作表存在 */
function setup() {
  getSheet_();
  Logger.log('工作表已建立：' + SHEET_NAME);
}
