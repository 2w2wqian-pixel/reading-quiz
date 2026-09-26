/* 驗證「刪除試卷」的完整語意（不需要真的連線）。
   這一支是為了修一個真實回報：「我按了刪除，試卷還顯示在試卷管理裡」。

   當初的兩個根因：
     1. Firebase 有一份 `quizzesIndex`（publishQuiz 寫的、_cloudIndex 優先讀它）。
        舊版 deleteQuiz 只刪了試卷本體 `quizzes/<id>`，**沒有清這份清單**
        → 清單還留著那一列 → 管理頁永遠顯示它。
     2. 雲端分支寫死 `Firebase.ok()`，而且 Cloud.del / Firebase.del 在
        「什麼都沒做」的情況下也回報成功（`Promise.resolve(true)`、不看 r.ok）
        → 用 Apps Script 的老師根本沒刪到雲端，UI 卻說成功。

   修法：① 刪除時一路清到雲端清單（寫完回讀驗證）② 兩種雲端通道都處理
        ③ 刪除當下立「墓碑」，遠端萬一失敗，清單也不會再冒出那一列。

   用法：node tools/_test_delete_flow.js                                        */
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = 'C:/Users/user/WorkBuddy/2026-09-16-21-14-08/reading-quiz';

/* ---------------- 記憶體狀態 ---------------- */
let KVMAP = {};      /* IndexedDB kv（墓碑存在這裡） */
let LOCAL = {};      /* IndexedDB quizzes */
let FB = {};         /* Firebase RTDB：path -> value */
let GHR = {};        /* GitHub repo：path -> {sha, text} */
let HOOK_POSTS = [];
const MODE = { fbDel: 'ok', fbIndexStubborn: false, github: 'ok' };
let settings = {};

function reset() {
  KVMAP = {}; LOCAL = {}; FB = {}; HOOK_POSTS = [];
  MODE.fbDel = 'ok'; MODE.fbIndexStubborn = false; MODE.github = 'ok';
  settings = {
    gh: { owner: 'o', repo: 'r', branch: 'main', token: 't', path: 'data' },
    fb: { enabled: true, dbUrl: 'https://x.firebaseio.com', apiKey: 'k', classCode: 'c' },
    hook: {}
  };
  GHR = {
    'data/quizzes/index.json': { sha: 's-idx', text: JSON.stringify([{ id: 'q-1' }, { id: 'q-2' }]) },
    'data/quizzes/q-1.json': { sha: 's-1', text: '{"id":"q-1"}' },
    'data/quizzes/q-2.json': { sha: 's-2', text: '{"id":"q-2"}' }
  };
  LOCAL = {
    'q-1': { id: 'q-1', title: '卷一', published: true, createdAt: '2026-01-01' },
    'q-2': { id: 'q-2', title: '卷二', published: true, createdAt: '2026-01-02' }
  };
  FB = {
    'rq/c/quizzesIndex': [
      { id: 'q-1', title: '卷一', createdAt: '2026-01-01' },
      { id: 'q-2', title: '卷二', createdAt: '2026-01-02' }
    ],
    'rq/c/quizzes/q-1': { id: 'q-1', title: '卷一' },
    'rq/c/quizzes/q-2': { id: 'q-2', title: '卷二' }
  };
}

global.window = global;
global.window.RQ = {
  util: {
    nowISO: function () { return new Date().toISOString(); },
    trim: function (s) { return String(s == null ? '' : s).trim(); },
    slug: function (s) { return String(s || '').toLowerCase().replace(/\s+/g, '-'); },
    uid: function (p) { return String(p || 'u') + '_' + Math.random().toString(36).slice(2, 8); },
    parseCSV: function () { return []; }
  },
  store: {
    kv: {
      get: function (k, dflt) { return Promise.resolve(KVMAP[k] ? KVMAP[k].value : dflt); },
      set: function (k, v) { KVMAP[k] = { id: k, value: v }; return Promise.resolve(KVMAP[k]); }
    },
    quiz: {
      all: function () { return Promise.resolve(Object.keys(LOCAL).map(function (k) { return LOCAL[k]; })); },
      get: function (id) { return Promise.resolve(LOCAL[id] || null); },
      save: function (q) { LOCAL[q.id] = q; return Promise.resolve(q); },
      del: function (id) { delete LOCAL[id]; return Promise.resolve(true); }
    }
  },
  settings: {
    get: function () { return settings; },
    /* 真版 Settings.set 對 gh/hook/fb/ai 四個區塊做深層 merge —— 假環境要照做，
       否則 signIn() 寫入 _token 時會把 fb.dbUrl 整個蓋掉。 */
    set: function (patch) {
      var deep = ['gh', 'hook', 'fb', 'ai'];
      Object.keys(patch || {}).forEach(function (k) {
        if (deep.indexOf(k) >= 0) settings[k] = Object.assign({}, settings[k], patch[k]);
        else settings[k] = patch[k];
      });
      return settings;
    }
  },
  crypto: {}
};

function b64(s) { return Buffer.from(s, 'utf8').toString('base64'); }
function fromB64(s) { return Buffer.from(String(s || ''), 'base64').toString('utf8'); }

global.fetch = function (url, init) {
  url = String(url);
  const method = (init && init.method) || 'GET';
  const body = init && init.body;

  /* 匿名登入 */
  if (url.indexOf('identitytoolkit.googleapis.com') >= 0) {
    return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve({ idToken: 'tok', expiresIn: '3600' }); } });
  }

  /* Firebase RTDB */
  const mf = url.match(/^https:\/\/x\.firebaseio\.com\/(.+?)\.json/);
  if (mf) {
    const p = decodeURIComponent(mf[1]);
    if (method === 'DELETE') {
      if (MODE.fbDel === 'deny') return Promise.resolve({ ok: false, status: 401, json: function () { return Promise.resolve({ error: 'Permission denied' }); } });
      delete FB[p];
      return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(null); } });
    }
    if (method === 'PUT') {
      const val = JSON.parse(body || 'null');
      /* 模擬「寫入回 200 但其實沒生效」——用來驗證回讀檢查真的抓得到 */
      if (!(MODE.fbIndexStubborn && p === 'rq/c/quizzesIndex')) FB[p] = val;
      return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(val); } });
    }
    return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(p in FB ? FB[p] : null); } });
  }

  /* Apps Script 收集端 */
  if (url.indexOf('script.google.com') >= 0) {
    HOOK_POSTS.push(JSON.parse(body || '{}'));
    return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve({ ok: true, removed: 1 }); } });
  }

  /* GitHub Contents API */
  if (url.indexOf('api.github.com') >= 0) {
    const mm = url.match(/\/contents\/([^?]+)/);
    const p = mm ? decodeURIComponent(mm[1]) : '';
    if (method === 'GET') {
      if (/\.[a-z0-9]+$/i.test(p)) {
        const node = GHR[p];
        if (!node) return Promise.resolve({ ok: false, status: 404, json: function () { return Promise.resolve({ message: 'Not Found' }); } });
        return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve({ content: b64(node.text), sha: node.sha, path: p, type: 'file' }); } });
      }
      const items = Object.keys(GHR).filter(function (k) {
        return k.indexOf(p + '/') === 0 && k.slice(p.length + 1).indexOf('/') < 0;
      }).map(function (k) {
        return { name: k.slice(p.length + 1), path: k, sha: GHR[k].sha, type: 'file', size: GHR[k].text.length };
      });
      return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(items); } });
    }
    if (method === 'DELETE') {
      if (MODE.github === 'deny') return Promise.resolve({ ok: false, status: 403, json: function () { return Promise.resolve({ message: 'Resource not accessible by integration' }); } });
      if (!GHR[p]) return Promise.resolve({ ok: false, status: 404, json: function () { return Promise.resolve({ message: 'Not Found' }); } });
      delete GHR[p];
      return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve({ commit: {} }); } });
    }
    if (method === 'PUT') {
      const payload = JSON.parse(body || '{}');
      GHR[p] = { sha: 's-' + Math.random().toString(36).slice(2, 8), text: fromB64(payload.content) };
      return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve({ content: { sha: GHR[p].sha } }); } });
    }
  }

  /* 隨站發佈通道：同源靜態檔，直接反映 repo 現況 */
  if (url.indexOf('data/') === 0) {
    const rel = url.split('?')[0];
    const node = GHR[rel];
    if (!node) return Promise.resolve({ ok: false, status: 404, json: function () { return Promise.resolve(null); } });
    return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(JSON.parse(node.text)); } });
  }

  return Promise.resolve({ ok: false, status: 400, json: function () { return Promise.resolve({ message: 'unexpected ' + method + ' ' + url }); } });
};

reset();
vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'assets/js/core/backend.js'), 'utf8'));
const BE = global.window.RQ.backend;

/* ---------------- 斷言工具 ---------------- */
let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? ' :: ' + extra : '')); }
}
function fbIdxIds() { return (FB['rq/c/quizzesIndex'] || []).map(function (m) { return m.id; }); }
function ghIdxIds() { return JSON.parse(GHR['data/quizzes/index.json'].text).map(function (m) { return m.id; }); }
function ids(list) { return list.map(function (m) { return m.id; }).sort(); }

(async function () {
  /* ── 0. 基準：清單來源同時有本機／雲端／repo ───────── */
  let l = await BE.listQuizzes();
  check('基準：q-1 與 q-2 都在清單上', ids(l).join(',') === 'q-1,q-2', ids(l).join(','));
  const one = l.filter(function (m) { return m.id === 'q-1'; })[0];
  check('基準：q-1 同時被標成本機、雲端、repo（_cloud/_repo）',
    !!(one && one._cloud && one._repo), one && JSON.stringify({ c: one._cloud, r: one._repo }));

  /* ── 1. 正常刪除：三個地方都要清乾淨 ─────────────── */
  reset();
  const r1 = await BE.deleteQuiz('q-1', { cloud: true, github: true, onGithub: true });
  check('刪除成功回報 ok', r1.ok === true, JSON.stringify(r1.ok));
  check('雲端刪除成功（res.cloud === true）', r1.cloud === true, JSON.stringify(r1.cloud));
  check('GitHub 刪除成功（res.github === true）', r1.github === true, JSON.stringify(r1.github));
  check('沒有殘留（res.pending === false）', r1.pending === false, JSON.stringify(r1.pending));
  check('🔴 雲端清單 quizzesIndex 已經不含 q-1（這是回報 bug 的根因）',
    fbIdxIds().indexOf('q-1') < 0, JSON.stringify(fbIdxIds()));
  check('回讀驗證有跑（indexPruned === true）', r1.indexPruned === true, JSON.stringify(r1.indexPruned));
  check('雲端試卷本體也刪了', !FB['rq/c/quizzes/q-1']);
  check('repo index.json 已經不含 q-1', ghIdxIds().indexOf('q-1') < 0, JSON.stringify(ghIdxIds()));
  check('repo 上的試卷檔也刪了', !GHR['data/quizzes/q-1.json']);
  check('本機資料已刪除', !LOCAL['q-1']);

  l = await BE.listQuizzes();
  check('刪除後清單只剩 q-2', ids(l).join(',') === 'q-2', ids(l).join(','));
  check('遠端都清乾淨了 → 墓碑結案、不再算待處理', (await BE.pendingDeletes()).length === 0);

  /* ── 2. 遠端失敗：清單仍不得再出現那一列 ─────────── */
  reset();
  MODE.fbDel = 'deny';       /* Firebase 規則拒絕刪除（401） */
  MODE.github = 'deny';      /* Token 沒權限（403） */
  const r2 = await BE.deleteQuiz('q-2', { cloud: true, github: true, onGithub: true });
  check('本機仍算刪除成功', r2.ok === true);
  check('雲端失敗要誠實回報 cloud === false', r2.cloud === false, JSON.stringify(r2.cloud));
  check('雲端失敗要帶原因（不是只有一句「失敗」）',
    !!r2.cloudError && /401|規則|拒絕/.test(r2.cloudError), String(r2.cloudError));
  check('GitHub 失敗要誠實回報 github === false', r2.github === false);
  check('GitHub 失敗要帶原因', !!r2.githubError && /403|not accessible/i.test(r2.githubError), String(r2.githubError));
  check('🔴 有殘留 → pending === true', r2.pending === true, JSON.stringify(r2.pending));

  check('前提：雲端清單其實還留著 q-2（模擬遠端刪不掉）', fbIdxIds().indexOf('q-2') >= 0, JSON.stringify(fbIdxIds()));
  l = await BE.listQuizzes();
  check('🔴 就算遠端還留著，清單也不得再顯示 q-2（墓碑生效）',
    ids(l).join(',') === 'q-1', ids(l).join(','));
  const pend = await BE.pendingDeletes();
  check('待處理清單抓得到 1 筆（UI 才說得出「還有幾筆沒清乾淨」）',
    pend.length === 1 && pend[0].id === 'q-2' && pend[0].pending === true, JSON.stringify(pend));

  /* ── 3. Apps Script 通道：以前「假裝成功」 ─────────── */
  reset();
  settings.fb.enabled = false;
  settings.hook.postUrl = 'https://script.google.com/macros/s/abc/exec';
  HOOK_POSTS = [];
  const r3 = await BE.deleteQuiz('q-2', { cloud: true, github: true, onGithub: true });
  const delPost = HOOK_POSTS.filter(function (d) { return d.action === 'del'; })[0];
  check('🔴 只設定 Apps Script 時，雲端分支要真的跑起來',
    !!(delPost), JSON.stringify(HOOK_POSTS.map(function (d) { return d.action || d.type; })));
  check('Apps Script 收到 action:"del"', !!(delPost && delPost.action === 'del'));
  check('送出的 keys 同時涵蓋 quiz::q-2 與 q-2（Sheet 的主鍵是合成字串）',
    !!(delPost && delPost.keys && delPost.keys.indexOf('quiz::q-2') >= 0 && delPost.keys.indexOf('q-2') >= 0),
    delPost && JSON.stringify(delPost.keys));
  check('Apps Script 路徑視為刪除成功', r3.cloud === true, JSON.stringify(r3));

  /* ── 4. 完全沒有雲端時，Cloud.del 必須 reject 而不是假成功 ── */
  settings.hook.postUrl = '';
  const r4 = await BE.Cloud.del('quizzes', 'q-9').then(function () { return null; }).catch(function (e) { return e.message; });
  check('🔴 沒有任何雲端通道時 Cloud.del 要 reject（不是回 true）',
    !!r4 && /尚未設定雲端/.test(r4), String(r4));

  /* ── 5. 雲端清單「寫了但沒生效」→ 回讀檢查要抓到 ─────── */
  reset();
  MODE.fbIndexStubborn = true;
  const r5 = await BE.deleteQuiz('q-1', { cloud: true, github: true, onGithub: true });
  check('🔴 清單沒更新成功時，不能回報成功（cloud === false）', r5.cloud === false, JSON.stringify(r5.cloud));
  check('並說明是雲端清單的問題', !!r5.cloudError && /清單/.test(r5.cloudError), String(r5.cloudError));
  check('這種情況也算殘留（pending === true）', r5.pending === true, JSON.stringify(r5.pending));
  MODE.fbIndexStubborn = false;

  /* ── 6. 重新發佈要能復活（墓碑必須被撤掉） ─────────── */
  MODE.fbDel = 'deny'; MODE.github = 'deny';
  await BE.deleteQuiz('q-2', { cloud: true, github: true, onGithub: true });
  check('前提：q-2 已被墓碑藏起來', ids(await BE.listQuizzes()).length === 0);
  MODE.fbDel = 'ok'; MODE.github = 'ok';
  const q2 = { id: 'q-2', title: '卷二', published: false, createdAt: '2026-01-02' };
  await BE.publishQuiz(q2);
  l = await BE.listQuizzes();
  check('🔴 重新發佈後 q-2 要回到清單（墓碑被撤銷）',
    ids(l).indexOf('q-2') >= 0, ids(l).join(','));
  check('前提：這一輪還有其他筆待處理（測試 5 的 q-1），所以只檢查 q-2 是否結案',
    (await BE.pendingDeletes()).some(function (p) { return p.id === 'q-1'; }));
  const pend2 = await BE.pendingDeletes();
  check('發佈清掉 q-2 的待處理狀態（其他筆不受影響）',
    pend2.every(function (p) { return p.id !== 'q-2'; }), JSON.stringify(pend2));
  check('發佈有寫回雲端清單', fbIdxIds().indexOf('q-2') >= 0, JSON.stringify(fbIdxIds()));

  console.log('\nDELETE FLOW TEST:', pass + ' pass / ' + fail + ' fail');
  process.exit(fail ? 1 : 0);
})();
