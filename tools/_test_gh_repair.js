/* 驗證「刪除」與「清掃線上殘留檔」的語意（不需要真的連 GitHub）。
   重點（這些都是踩過的雷）：
     1. GitHub.remove 的**三態**回傳：
          true  = 真的刪掉了
          false = 檔案本來就不存在（**不算失敗**，不能讓 UI 顯示紅色錯誤）
          reject= 真的失敗（權限／網路／409 用盡）
     2. DELETE 遇到 409（sha 對不上）要自動重讀 sha 再試，最多 3 次。
     3. repairRepo 預設 **dryRun = true**（只報告、不動手）——
        這是因為本專案曾發生「誤刪整批試卷」的事故，清掃器必須先看一眼才准刪。
     4. repairRepo 只刪「id 不在 index.json 裡」的檔案，index 是學生看得到的唯一依據。
   用法：node tools/_test_gh_repair.js                                        */
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = 'C:/Users/user/WorkBuddy/2026-09-16-21-14-08/reading-quiz';

global.window = global;
global.window.RQ = {
  util: {
    nowISO: function () { return new Date().toISOString(); },
    trim: function (s) { return String(s == null ? '' : s).trim(); },
    slug: function (s) { return String(s || '').toLowerCase().replace(/\s+/g, '-'); }
  },
  store: { kv: {}, quiz: {} },
  settings: {
    get: function () {
      return { gh: { owner: 'o', repo: 'r', branch: 'main', token: 't', path: 'data' }, fb: {}, hook: {} };
    }
  },
  crypto: {}
};

/* ---- 假 repo 狀態 ----
   index.json 只認得 q-a、q-b。
   磁碟上卻有 q-a、q-b、q-orphan（孤兒）、readme.txt（非 json）。 */
const INDEX = [{ id: 'q-a' }, { id: 'q-b' }];
let DISK = {
  'data/quizzes/index.json': { type: 'file', sha: 'sha-index', text: JSON.stringify(INDEX) },
  'data/quizzes/q-a.json': { type: 'file', sha: 'sha-a', text: '{"id":"q-a"}' },
  'data/quizzes/q-b.json': { type: 'file', sha: 'sha-b', text: '{"id":"q-b"}' },
  'data/quizzes/q-orphan.json': { type: 'file', sha: 'sha-orphan', text: '{"id":"q-orphan"}' },
  'data/quizzes/readme.txt': { type: 'file', sha: 'sha-readme', text: 'note' }
};

const calls = [];
let deleteAttempts = 0;
let mode = 'clean';          /* 'clean' | 'conflictOnce' | 'forbid' */

function b64(s) { return Buffer.from(s, 'utf8').toString('base64'); }

global.fetch = function (url, init) {
  url = String(url);
  const method = (init && init.method) || 'GET';
  calls.push({ url: url, method: method });

  /* GET：單檔 vs 目錄。
     兩者 URL 形狀一樣（都是 /contents/<p>?ref=…），差別只在「有附檔名的是檔案」。
     真實的 GitHub API 也是這樣分辨的（檔案回物件、目錄回陣列），所以假 fetch 照做。 */
  if (method === 'GET') {
    const m = url.match(/\/contents\/([^?]+)\?ref=/);
    const p = m ? decodeURIComponent(m[1]) : '';
    const isFile = /\.[a-z0-9]+$/i.test(p);
    if (isFile) {
      const node = DISK[p];
      if (!node) return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({ message: 'Not Found' }) });
      return Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve({ content: b64(node.text), sha: node.sha, path: p, type: 'file' })
      });
    }
    /* 目錄 */
    const items = Object.keys(DISK)
      .filter(function (k) { return k.startsWith(p + '/') && k.slice(p.length + 1).indexOf('/') < 0; })
      .map(function (k) { return { name: k.slice(p.length + 1), path: k, sha: DISK[k].sha, type: 'file', size: DISK[k].text.length }; });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(items) });
  }

  /* DELETE */
  if (method === 'DELETE') {
    deleteAttempts++;
    if (mode === 'forbid') {
      return Promise.resolve({ ok: false, status: 403, json: () => Promise.resolve({ message: 'Resource not accessible by integration' }) });
    }
    const m = url.match(/\/contents\/([^?]+)/);
    const p = m ? decodeURIComponent(m[1]) : '';
    const node = DISK[p];
    if (!node) return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({ message: 'Not Found' }) });
    /* conflictOnce：第一次刪除故意回 409，逼出重試路徑 */
    if (mode === 'conflictOnce' && deleteAttempts === 1) {
      return Promise.resolve({
        ok: false, status: 409,
        json: () => Promise.resolve({ message: p + ' does not match ' + node.sha })
      });
    }
    /* 刪除成功要帶對 sha */
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ commit: {} }) });
  }

  return Promise.resolve({ ok: false, status: 400, json: () => Promise.resolve({ message: 'unexpected ' + method }) });
};

vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'assets/js/core/backend.js'), 'utf8'));
const BE = global.window.RQ.backend;
const GH = BE.GitHub;

(async function () {
  let pass = 0, fail = 0;
  function check(name, ok, extra) {
    if (ok) { pass++; console.log('  PASS  ' + name); }
    else { fail++; console.log('  FAIL  ' + name + (extra ? ' :: ' + extra : '')); }
  }

  /* ── 1. remove() 三態 ───────────────────────────────── */
  mode = 'clean'; deleteAttempts = 0; calls.length = 0;
  const r1 = await GH.remove('data/quizzes/q-a.json', 'x').catch(e => 'ERR:' + e.message);
  check('remove 既有檔案 → 回 true', r1 === true, 'got=' + JSON.stringify(r1));
  check('remove 真的有送 DELETE', calls.some(c => c.method === 'DELETE'));

  mode = 'clean'; deleteAttempts = 0; calls.length = 0;
  const r2 = await GH.remove('data/quizzes/does-not-exist.json', 'x').catch(e => 'ERR:' + e.message);
  check('remove 不存在的檔案 → 回 false（不是 reject、不算失敗）', r2 === false, 'got=' + JSON.stringify(r2));
  check('remove 不存在的檔案時「沒有」送出 DELETE（不製造無謂的成功幻覺）',
    !calls.some(c => c.method === 'DELETE'), 'DELETE 次數=' + calls.filter(c => c.method === 'DELETE').length);

  /* ── 2. 409 自動重試 ─────────────────────────────────── */
  mode = 'conflictOnce'; deleteAttempts = 0; calls.length = 0;
  const r3 = await GH.remove('data/quizzes/q-b.json', 'x').catch(e => 'ERR:' + e.message);
  check('DELETE 遇到 409 會自動重讀 sha 重試並成功', r3 === true, 'got=' + JSON.stringify(r3));
  check('409 後共送 2 次 DELETE', deleteAttempts === 2, 'deleteAttempts=' + deleteAttempts);

  /* ── 3. 真的失敗要 reject（不能被吞掉） ──────────────── */
  mode = 'forbid'; deleteAttempts = 0; calls.length = 0;
  const r4 = await GH.remove('data/quizzes/q-a.json', 'x').then(() => null).catch(e => e.message);
  check('權限不足（403）→ reject 並帶著原因（UI 才顯示得出紅色錯誤）',
    !!r4 && /403|not accessible|權限|失敗/i.test(r4), 'got=' + String(r4));

  /* ── 4. repairRepo 預設 dry-run，且只挑孤兒 ─────────── */
  mode = 'clean'; deleteAttempts = 0; calls.length = 0;
  const dry = await BE.repairRepo();
  check('repairRepo 預設 dryRun = true', dry && dry.dryRun === true, JSON.stringify(dry && dry.dryRun));
  check('dryRun 階段「完全沒有」送 DELETE', deleteAttempts === 0, 'deleteAttempts=' + deleteAttempts);
  check('抓到 index 有 2 筆、磁碟有 5 個檔（含 index.json 與 readme.txt）',
    dry.indexCount === 2 && dry.fileCount === 5,
    'index=' + dry.indexCount + ' file=' + dry.fileCount);
  check('只標出 1 個孤兒（q-orphan），且不含 readme.txt／index.json',
    dry.orphans.length === 1 && dry.orphans[0].id === 'q-orphan',
    JSON.stringify(dry.orphans && dry.orphans.map(o => o.id)));
  check('孤兒帶著 size（UI 要顯示 KB）與 path',
    dry.orphans.length === 1 && typeof dry.orphans[0].size === 'number' && /q-orphan\.json$/.test(dry.orphans[0].path || ''),
    JSON.stringify(dry.orphans[0]));
  check('dryRun 的 removed 是 0（只報告不動手）',
    dry.removed === 0, JSON.stringify(dry.removed));

  /* ── 5. 真刪：只刪孤兒 ──────────────────────────────── */
  mode = 'clean'; deleteAttempts = 0; calls.length = 0;
  const real = await BE.repairRepo({ dryRun: false });
  check('dryRun:false 時真的送 DELETE', deleteAttempts >= 1, 'deleteAttempts=' + deleteAttempts);
  check('removed 計數為 1（回傳是數字，不是陣列）', real.removed === 1, JSON.stringify(real.removed));
  check('dryRun:false 的報告仍然是 dryRun:false',
    real.dryRun === false, JSON.stringify(real.dryRun));
  const deletedPaths = calls.filter(c => c.method === 'DELETE').map(c => decodeURIComponent((c.url.match(/\/contents\/([^?]+)/) || [])[1] || ''));
  check('被刪的路徑只有 q-orphan.json（沒有誤刪 q-a／q-b／index／readme.txt）',
    deletedPaths.length === 1 && deletedPaths.every(p => /q-orphan\.json$/.test(p)),
    JSON.stringify(deletedPaths));
  check('沒有錯誤', real.errors.length === 0, JSON.stringify(real.errors));

  console.log('\nGH REPAIR TEST:', pass + ' pass / ' + fail + ' fail');
  process.exit(fail ? 1 : 0);
})();
