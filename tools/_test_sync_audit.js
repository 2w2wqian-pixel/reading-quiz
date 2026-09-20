/* 驗證「跨裝置同步」整條鏈路（不需要真的連網）。
   模擬情境：
     ① classCode 未填時雲端是否仍然可用（舊版會靜默失效）
     ② 公開設定 config.json 是否「缺什麼補什麼」
     ③ 公開政策是否只在學生的裝置生效（不覆蓋老師自己的設定）
     ④ Firebase 壞掉時是否自動退回 Apps Script（寫入與讀取）
     ⑤ 自我診斷是否如實回報（不掩蓋失敗）
     ⑥ 名冊同步是否會「假成功」
     ⑦ 提交時雲端不通是否標記為待補送
   用法：node tools/_test_sync_audit.js                                        */
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = 'C:/Users/user/WorkBuddy/2026-09-16-21-14-08/reading-quiz';

let pass = 0, fail = 0;
function check(label, ok, extra) {
  if (ok) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (extra ? '  :: ' + extra : '')); }
}

/* ================= 可重置的假環境 ================= */
let MEM = { quizzes: {}, submissions: {}, roster: {}, kv: {} };
let NET = function () { return Promise.resolve({ ok: false, status: 404 }); };
let HITS = [];

/* ⚠ STATE 是「即時讀取」而不是快照。
   以前這裡寫成 `STATE = RQ.settings.get()`，存下來的是重置當下的複本，
   於是 loadConfig() 之後寫進 localStorage 的新值，斷言永遠看不到 ——
   測試會一直紅，但產品其實是對的（反過來也可能讓錯的產品看起來是對的）。
   用 getter 之後，斷言讀到的就是當下真正的設定。 */
const STATE_PROXY = new Proxy({}, {
  get: (t, k) => RQ.settings.get()[k],
  has: (t, k) => k in RQ.settings.get(),
  ownKeys: () => Reflect.ownKeys(RQ.settings.get()),
  getOwnPropertyDescriptor: (t, k) => ({ configurable: true, enumerable: true, value: RQ.settings.get()[k] })
});
const STATE = STATE_PROXY;

function resetEnv(settings, net) {
  RQ.settings.reset();
  RQ.settings.set(settings || {});
  Object.keys(MEM).forEach(k => { MEM[k] = {}; });
  HITS = [];
  NET = net || function () { return Promise.resolve({ ok: false, status: 404 }); };
  window.RQ.backend._cfgPromise = null;      // 清掉 config 快取
  window.RQ.backend.Cloud.lastError = '';
  window.RQ.backend.Cloud.lastWritten = '';
  window.RQ.backend.Cloud.lastSource = '';
}

const RQ = {
  util: {
    nowISO: () => new Date().toISOString(),
    trim: s => String(s == null ? '' : s).trim(),
    uid: p => (p || 'id') + '_x',
    esc: s => String(s == null ? '' : s)
  },
  /* 真的 store.js 會覆寫掉這個 stub（見下方），
     這裡先留著是為了讓 RQ 物件在載入前就是完整的。 */
  settings: null,
  store: {
    /* 真的 Store.ready() 會 resolve 成 IDBDatabase 物件（diagnose() 就是看這個
       來判斷 IndexedDB 是否可用）。這裡若只回 true，診斷會誤判成
       「IndexedDB 不可用」—— 假環境要跟真的一樣，否則測的是假象。 */
    ready: () => Promise.resolve({ objectStoreNames: { contains: () => true } }),
    all: s => Promise.resolve(Object.keys(MEM[s] || {}).map(k => MEM[s][k])),
    get: (s, id) => Promise.resolve((MEM[s] || {})[id] || null),
    put: (s, o) => { MEM[s][o.id] = o; return Promise.resolve(o); },
    del: (s, id) => { delete MEM[s][id]; return Promise.resolve(true); },
    byIndex: (s, idx, v) => Promise.resolve(Object.keys(MEM[s] || {}).map(k => MEM[s][k]).filter(x => x[idx] === v)),
    clear: () => Promise.resolve(true),
    quiz: {
      all: () => Promise.resolve(Object.keys(MEM.quizzes).map(k => MEM.quizzes[k])),
      get: id => Promise.resolve(MEM.quizzes[id] || null),
      save: q => { MEM.quizzes[q.id] = q; return Promise.resolve(q); },
      del: id => { delete MEM.quizzes[id]; return Promise.resolve(true); }
    },
    submission: {
      all: () => Promise.resolve(Object.keys(MEM.submissions).map(k => MEM.submissions[k])),
      ofStudent: sid => Promise.resolve(Object.keys(MEM.submissions).map(k => MEM.submissions[k]).filter(s => s.studentId === sid)),
      save: s => { s.id = s.id || 'sub_x'; MEM.submissions[s.id] = s; return Promise.resolve(s); },
      del: id => { delete MEM.submissions[id]; return Promise.resolve(true); }
    },
    roster: {
      all: () => Promise.resolve(Object.keys(MEM.roster).map(k => MEM.roster[k])),
      save: s => { s.id = s.id || 'stu_x'; MEM.roster[s.id] = s; return Promise.resolve(s); },
      del: id => { delete MEM.roster[id]; return Promise.resolve(true); }
    },
    kv: {
      get: (k, d) => Promise.resolve(MEM.kv[k] ? MEM.kv[k].value : d),
      set: (k, v) => { MEM.kv[k] = { id: k, value: v }; return Promise.resolve(true); }
    },
    /* 作答與草稿的跨裝置鍵靠這兩個查名冊成員，缺了會讓測試的假環境失真 */
    all: s2 => Promise.resolve(Object.keys(MEM[s2] || {}).map(k => MEM[s2][k])),
    get: (s2, id) => Promise.resolve((MEM[s2] || {})[id] || null),
    put: (s2, o) => { MEM[s2][o.id] = o; return Promise.resolve(o); }
  },
  crypto: {}
};
global.window = global;
global.window.RQ = RQ;

/* ★ 用真的 settings（store.js）而不是自己再寫一份：政策開關的預設值
   只能有一個來源，測試若自備一份，就永遠測不出「兩份定義不一致」。
   STATE 仍由 resetEnv 餵進來，只是改走真的 Settings.set()。 */
const _ls = {};
global.localStorage = {
  getItem: k => (k in _ls ? _ls[k] : null),
  setItem: (k, v) => { _ls[k] = String(v); },
  removeItem: k => { delete _ls[k]; }
};
global.document = { createElement: () => ({ style: {}, setAttribute() { } }) };

/* ★ store.js 載入時會把 RQ.store 換成**真的** Store（測試手寫的那份會被覆蓋），
   而真的 Store 需要 window.indexedDB 才會走「正常」路徑，否則降級成記憶體暫存、
   診斷報告就會回「此瀏覽器不支援 IndexedDB」——那是 Node 的事實，不是產品的問題。
   這裡補一個最小可用的 in-memory IndexedDB，讓測試跑在跟瀏覽器同一條路徑上。 */
(function installFakeIDB() {
  const DBS = {};
  function makeReq(result) {
    const req = { result, onsuccess: null, onerror: null };
    setTimeout(() => { if (req.onsuccess) req.onsuccess({ target: req }); }, 0);
    return req;
  }
  function makeStore(name, data) {
    return {
      _data: data,
      createIndex() { return {}; },
      get(id) { return makeReq(this._data[id]); },
      getAll() { return makeReq(Object.keys(this._data).map(k => this._data[k])); },
      put(obj) { this._data[obj.id] = obj; return makeReq(obj.id); },
      delete(id) { delete this._data[id]; return makeReq(true); }
    };
  }
  global.indexedDB = {
    open(name, ver) {
      const db = {
        objectStoreNames: { contains: n => !!(DBS[name] && DBS[name][n]) },
        createObjectStore(n) { DBS[name][n] = DBS[name][n] || {}; return makeStore(n, DBS[name][n]); },
        transaction(n) { return { objectStore: () => makeStore(n, (DBS[name] = DBS[name] || {})[n] = DBS[name][n] || {}) }; }
      };
      const req = { result: db, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
      DBS[name] = DBS[name] || {};
      setTimeout(() => {
        const fresh = !db._init;
        if (!db._init) { db._init = true; if (req.onupgradeneeded) req.onupgradeneeded({ target: req }); }
        if (req.onsuccess) req.onsuccess({ target: req });
      }, 0);
      return req;
    },
    deleteDatabase() { return makeReq(true); }
  };
})();

vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'assets/js/core/store.js'), 'utf8'));
RQ.settings = window.RQ.settings;
RQ.settings.POLICY_KEYS = window.RQ.settings.POLICY_KEYS;
/* 真的 Store 需要被「重新指向」本機的假資料容器：store.js 已把 RQ.store 換掉，
   所以 MEM 相關的斷言要改用 Store 的實際內容（見下方 byStore 輔助）。 */
RQ.store = window.RQ.store;

global.fetch = (u, i) => { HITS.push(((i && i.method) || 'GET') + ' ' + String(u).split('?')[0]); return Promise.resolve(NET(String(u), i || {})); };

vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'assets/js/core/backend.js'), 'utf8'));
const B = window.RQ.backend;

/* ---------- 常用假回應 ---------- */
const FB = { enabled: true, dbUrl: 'https://demo-default-rtdb.firebaseio.com', apiKey: 'AIzaDEMO' };
const REPO_CONFIG = {
  firebase: { dbUrl: FB.dbUrl, apiKey: FB.apiKey, classCode: '' },
  hook: { postUrl: 'https://script.google.com/macros/s/AAA/exec' },
  policy: { assignOnly: false, showAnswerAfterSubmit: true, allowRetake: false, enableHighlight: true, allowSelfRegister: false }
};
const OK = body => ({ ok: true, status: 200, json: () => Promise.resolve(body) });

/* Firebase 正常 */
function netFirebaseOk(extra) {
  return function (u, i) {
    if (/identitytoolkit/.test(u)) return OK({ idToken: 'tok', expiresIn: '3600' });
    if (/firebaseio/.test(u)) {
      if (((i && i.method) || 'GET') === 'PUT') return OK(true);
      if (/meta\/diag/.test(u)) return OK({ at: '2026-09-18T12:00:00.000Z' });
      return OK(null);
    }
    if (/config\.json/.test(u)) return OK(REPO_CONFIG);
    if (/roster\.json/.test(u)) return OK([{ id: 's1', username: 'waiwai', name: '歪歪' }]);
    if (extra) { const r = extra(u, i); if (r) return r; }
    return { ok: false, status: 404, json: () => Promise.resolve(null) };
  };
}
/* Firebase 壞掉（重現目前線上的真實狀況：Auth 未啟用）＋ Apps Script 可用 */
function netFirebaseBroken(hookRows) {
  return function (u, i) {
    if (/identitytoolkit/.test(u)) return OK({ error: { code: 400, message: 'CONFIGURATION_NOT_FOUND' } });
    if (/firebaseio/.test(u)) return { ok: false, status: 401, json: () => Promise.resolve({ error: 'Permission denied' }) };
    if (/script\.google\.com/.test(u)) {
      if (/action=list/.test(u)) return OK(hookRows || []);
      return OK({ ok: true });
    }
    if (/api\.github\.com/.test(u)) return { ok: false, status: 403, json: () => Promise.resolve({}) };
    if (/config\.json/.test(u)) return OK(REPO_CONFIG);
    if (/roster\.json/.test(u)) return OK([{ id: 's1', username: 'waiwai', name: '歪歪' }]);
    return { ok: false, status: 404, json: () => Promise.resolve(null) };
  };
}

(async function () {
  /* ============ ① classCode 未填不再讓雲端靜默失效 ============ */
  console.log('\n① 班級代碼（命名空間）');
  resetEnv({ fb: Object.assign({}, FB), gh: {}, hook: {} });
  check('未填 classCode 時 Firebase 仍視為可用', B.Firebase.ok() === true);
  check('命名空間自動回退為 rq/default', B.Firebase.base() === 'rq/default', B.Firebase.base());
  resetEnv({ fb: Object.assign({}, FB, { classCode: 'chi-f2' }), gh: {}, hook: {} });
  check('有填 classCode 時命名空間正確', B.Firebase.base() === 'rq/chi-f2', B.Firebase.base());
  check('classCode 會過濾不安全字元（. # $ / 等）',
    (function () {
      resetEnv({ fb: Object.assign({}, FB, { classCode: 'a.b#c/d' }), gh: {}, hook: {} });
      return B.Firebase.base() === 'rq/a_b_c_d';
    })(), B.Firebase.base());

  /* ============ ② config.json 缺什麼補什麼 ============ */
  console.log('\n② 公開設定補齊');
  resetEnv({ fb: { enabled: true, dbUrl: 'https://mine.firebaseio.com' }, gh: {}, hook: {} }, netFirebaseOk());
  await B.loadConfig();
  check('本機已有的 dbUrl 不被覆蓋', STATE.fb.dbUrl === 'https://mine.firebaseio.com', STATE.fb.dbUrl);
  check('缺少的 apiKey 由 config.json 補上', STATE.fb.apiKey === FB.apiKey, STATE.fb.apiKey);
  check('缺少的 classCode 補為 default', STATE.fb.classCode === 'default', STATE.fb.classCode);
  check('補齊後 Firebase 變可用', B.Firebase.ok() === true);

  resetEnv({ fb: { enabled: true, dbUrl: 'https://mine.firebaseio.com', apiKey: 'X', classCode: 'my-class' }, gh: {}, hook: {} }, netFirebaseOk());
  await B.loadConfig();
  check('本機既有的 classCode 不被覆蓋', STATE.fb.classCode === 'my-class', STATE.fb.classCode);

  /* ============ ③ 公開政策：學生裝置生效、老師裝置不覆蓋 ============ */
  console.log('\n③ 公開政策（assignOnly 等）');
  /* 學生裝置：沒動過任何政策開關 → 以已發佈的值為準。
     注意「assignOnly: true」不可以出現在這裡 —— 那等於這台裝置自己表態過，
     依規則就該保留本機值，測試反而測不到「公開政策有沒有生效」。 */
  resetEnv({ gh: {}, hook: {}, fb: {} }, netFirebaseOk());
  check('未動過政策前，本機沒有表態', RQ.settings.hasPolicy('assignOnly') === false);
  await B.loadConfig();
  check('學生裝置套用 repo 的政策（assignOnly → false）', STATE.assignOnly === false, String(STATE.assignOnly));
  check('公開政策涵蓋所有開關，不只是 assignOnly',
    STATE.allowRetake === false && STATE.enableHighlight === true && STATE.showAnswerAfterSubmit === true,
    JSON.stringify({ r: STATE.allowRetake, h: STATE.enableHighlight, s: STATE.showAnswerAfterSubmit }));

  /* 學生裝置自己開過某個開關（例如在設定頁動過）→ 保留本機，不被公開政策蓋掉 */
  resetEnv({ policy: { allowRetake: true }, gh: {}, hook: {}, fb: {} }, netFirebaseOk());
  await B.loadConfig();
  check('本機明確改過的開關不被公開政策覆蓋', STATE.allowRetake === true, String(STATE.allowRetake));
  check('本機沒改過的其餘開關仍套用公開政策', STATE.assignOnly === false, String(STATE.assignOnly));

  resetEnv({ assignOnly: true, gh: { owner: 'o', repo: 'r', token: 'tok' }, hook: {}, fb: {} }, netFirebaseOk());
  await B.loadConfig();
  check('老師裝置（有 GitHub Token）不被 repo 政策覆蓋', STATE.assignOnly === true, String(STATE.assignOnly));

  /* ============ ④ Firebase 壞掉 → 自動退回 Apps Script ============ */
  console.log('\n④ 雲端通道退回');
  resetEnv({ fb: Object.assign({}, FB), hook: { postUrl: REPO_CONFIG.hook.postUrl }, gh: {} }, netFirebaseBroken());
  const rec = { type: 'submission', id: 'sub::q1::s1', quizId: 'q1', studentId: 's1', payload: {} };
  const putRes = await B.Cloud.put(rec).then(r => 'ok').catch(e => 'err:' + e.message);
  check('Firebase 不通時寫入仍成功（退回 Apps Script）', putRes === 'ok', putRes);
  check('寫入確實打到 Apps Script', HITS.some(h => /POST https:\/\/script\.google\.com/.test(h)), JSON.stringify(HITS));
  check('記錄了實際寫入的通道', B.Cloud.lastWritten === 'hook', B.Cloud.lastWritten);
  check('保留了失敗原因（不靜默）', /CONFIGURATION_NOT_FOUND/.test(B.Cloud.lastError), B.Cloud.lastError);

  resetEnv({ fb: Object.assign({}, FB), hook: { postUrl: REPO_CONFIG.hook.postUrl }, gh: {} },
    netFirebaseBroken([{ type: 'submission', id: 'sub::q9::s9', payload: { studentId: 's9' } }]));
  const rows = await B.Cloud.getAll('submission');
  check('Firebase 讀取失敗時退回 Apps Script 並取回資料', rows.length === 1, JSON.stringify(rows.length));
  check('來源標記為 Apps Script 即時讀取', B.Cloud.lastSource === 'live', B.Cloud.lastSource);
  check('記錄了讀取失敗原因', /CONFIGURATION_NOT_FOUND|401|Permission/.test(B.Cloud.lastError), B.Cloud.lastError);

  resetEnv({ fb: Object.assign({}, FB), hook: {}, gh: {} }, netFirebaseBroken());
  const putErr = await B.Cloud.put(rec).then(() => 'ok').catch(e => 'err:' + e.message);
  check('沒有任何備援時，寫入失敗要如實報錯', /^err:/.test(putErr), putErr);

  /* ============ ⑤ 自我診斷 ============ */
  console.log('\n⑤ 自我診斷報告');
  resetEnv({ fb: Object.assign({}, FB), hook: { postUrl: REPO_CONFIG.hook.postUrl }, gh: {}, session: { name: '測試老師' } },
    netFirebaseBroken([{ type: 'submission', id: 'x' }]));
  const rep = await B.diagnose();
  const byName = {};
  rep.items.forEach(it => { byName[it.name] = it; });
  check('報告含各關鍵檢查項', ['本機儲存（IndexedDB）', '公開設定 data/config.json', 'Firebase 設定',
    'Firebase 匿名登入', 'Firebase 寫入', 'Firebase 讀取', '名冊（三通道合併）', '試卷清單（本機＋repo＋雲端）',
    '作答紀錄（本機＋雲端）'].every(n => byName[n]), JSON.stringify(Object.keys(byName)));
  check('Firebase 匿名登入被判定為失敗（不掩蓋）', byName['Firebase 匿名登入'].ok === false);
  check('失敗訊息包含可操作的指引', /匿名|Authentication/.test(byName['Firebase 匿名登入'].detail),
    byName['Firebase 匿名登入'].detail);
  check('Firebase 讀取被判定為失敗', byName['Firebase 讀取'].ok === false);
  check('實際通道顯示已退回 Apps Script', /appscript/.test(byName['實際使用的雲端通道'].detail),
    byName['實際使用的雲端通道'].detail);
  check('報告指出命名空間（跨裝置要一致）', /rq\//.test(rep.base), rep.base);
  check('本機儲存檢測通過', byName['本機儲存（IndexedDB）'].ok === true);
  check('名冊合併計數正確（repo 1 人）', byName['名冊（三通道合併）'].ok === true &&
    /合併後 1 人/.test(byName['名冊（三通道合併）'].detail), byName['名冊（三通道合併）'].detail);
  check('計數欄位齊備', rep.okCount > 0 && rep.badCount > 0, rep.okCount + '/' + rep.badCount);
  check('可輸出純文字報告', /\[!!\]/.test(B.diagText(rep)) && /命名空間/.test(B.diagText(rep)));

  /* ============ ⑥ 名冊同步不假成功 ============ */
  console.log('\n⑥ 名冊同步');
  resetEnv({ fb: Object.assign({}, FB), hook: {}, gh: { owner: 'o', repo: 'r', branch: 'main', token: 'tok', path: 'data' } },
    netFirebaseBroken());
  const syncErr = await B.syncRoster().then(() => 'ok').catch(e => 'err:' + e.message);
  check('兩個通道都失敗時要報錯，不能假裝同步完成', /^err:/.test(syncErr), syncErr);

  const ghWrites = [];
  resetEnv({ fb: Object.assign({}, FB), hook: {}, gh: { owner: 'o', repo: 'r', branch: 'main', token: 'tok', path: 'data' } },
    function (u, i) {
      if (/api\.github\.com/.test(u)) {
        if (((i && i.method) || 'GET') === 'PUT') { ghWrites.push(JSON.parse(i.body)); return OK({ content: {}, sha: 's' }); }
        return OK({ content: '', sha: 'sha1' });
      }
      if (/identitytoolkit/.test(u)) return OK({ error: { code: 400, message: 'CONFIGURATION_NOT_FOUND' } });
      if (/config\.json/.test(u)) return OK(REPO_CONFIG);
      if (/roster\.json/.test(u)) return OK([{ id: 's1', username: 'waiwai', name: '歪歪' }]);
      return { ok: false, status: 404, json: () => Promise.resolve(null) };
    });
  MEM.roster['stu1'] = { id: 'stu1', username: 'waiwai', name: '歪歪' };
  const r2 = await B.syncRoster();
  check('雲端失敗但 repo 成功 → 回報 1 個通道成功', r2.channels === 1, JSON.stringify(r2));
  check('同時回報雲端失敗原因', r2.errors.length === 1 && /雲端/.test(r2.errors[0]), JSON.stringify(r2.errors));
  check('repo 名冊確實被寫入', ghWrites.some(b => /roster/.test(b.message || '')), JSON.stringify(ghWrites.map(b => b.message)));

  /* ============ ⑦ 提交時雲端不通 → 標記待補送 ============ */
  console.log('\n⑦ 提交與補送');
  resetEnv({ fb: Object.assign({}, FB), hook: {}, gh: {} }, netFirebaseBroken());
  MEM.roster['s1'] = { id: 's1', username: 'waiwai', name: '小明' };
  B.Cloud.lastWritten = '';
  const sub = await B.saveSubmission({ quizId: 'q1', studentId: 's1', studentName: '小明', answers: {}, id: 'sub1' });
  /* 提交完成後 id 會被改寫成「帳號型同步鍵」——這是跨裝置同一份作答的關鍵，
     所以這裡斷言的是新鍵，而不再是呼叫端隨便帶進來的 'sub1'。 */
  check('雲端不通時提交仍完成（本機保存）', !!sub && !!sub.id, JSON.stringify(sub && sub.id));
  check('提交改用帳號型同步鍵（跨裝置同一份）', sub.id === 'sub::q1::s1', String(sub.id));
  check('本機舊鍵已清除，不會留下重複紀錄', !MEM.submissions['sub1'], JSON.stringify(Object.keys(MEM.submissions)));
  check('標記為待補送（_pending）', sub._pending === true, JSON.stringify(sub._pending));
  check('保留失敗原因', /CONFIGURATION_NOT_FOUND/.test(String(sub._syncError || '')), String(sub._syncError));

  resetEnv({ fb: Object.assign({}, FB), hook: { postUrl: REPO_CONFIG.hook.postUrl }, gh: {} },
    netFirebaseOk());
  MEM.roster['s1'] = { id: 's1', username: 'waiwai', name: '小明' };
  const sub2 = await B.saveSubmission({ quizId: 'q2', studentId: 's1', answers: {}, id: 'sub2' });
  check('雲端通時提交標記為已同步', !sub2._pending && sub2._synced === 'firebase', JSON.stringify({ p: sub2._pending, s: sub2._synced }));

  /* 同一份作答換一台裝置再交一次 → 必須落在同一個雲端欄位，而不是變成第二筆 */
  const keyA = (await B.syncKeys('s1', 'q2')).keys[0];
  const keyB = (await B.syncKeys('s1', 'q2')).keys[0];
  check('同一人同一卷的同步鍵可重現（換裝置也一樣）', keyA === keyB && !!keyA, keyA);
  check('同步鍵不含裝置資訊', !/[0-9a-f]{8}-[0-9a-f]{4}/.test(String(keyA)), String(keyA));

  console.log('\nSUMMARY: ' + pass + ' pass / ' + fail + ' fail');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e && e.stack); process.exit(1); });
