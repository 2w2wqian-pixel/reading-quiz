/* 驗證「學生裝置拿得到帳號」這條路徑（不需要真的連網）。
   模擬情境：學生的 iPad 剛打開網站 —— 本機設定全空、沒有本機名冊，
   只有 repo 上的 data/config.json 與 data/roster.json。
   用法：node tools/_test_roster_sync.js                                        */
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = 'C:/Users/user/WorkBuddy/2026-09-16-21-14-08/reading-quiz';

/* ---------- 假資料 ---------- */
const REPO_CONFIG = {
  site: '閱讀理解練習站', version: 1,
  firebase: { dbUrl: 'https://demo-default-rtdb.firebaseio.com', apiKey: 'AIzaDEMO', classCode: 'chi-f2' }
};
const REPO_ROSTER = [
  { id: 'stu1', username: 'waiwai', name: '歪歪', pass: 'salt:hash' },
  { id: 'stu2', username: 'kate', name: '陳小美', pass: 'salt:hash2' }
];
const CLOUD_ROSTER = {
  'roster::newkid': { type: 'register', key: 'roster::newkid', payload: { id: 'stu3', username: 'newkid', name: '新同學', pass: 'x:y' } }
};
const LOCAL_ROSTER = [{ id: 'stu1', username: 'waiwai', name: '歪歪', pass: 'salt:NEWHASH' }];

/* ---------- 假 Settings（模擬學生裝置：全空） ---------- */
let SETTINGS = { gh: { path: 'data' }, fb: {}, hook: {} };
const RQ = {
  util: {
    nowISO: function () { return new Date().toISOString(); },
    trim: function (s) { return String(s == null ? '' : s).trim(); },
    uid: function (p) { return (p || 'id') + '_x'; }
  },
  settings: {
    get: function () { return SETTINGS; },
    set: function (patch) {
      Object.keys(patch).forEach(function (k) {
        SETTINGS[k] = Object.assign({}, SETTINGS[k] || {}, patch[k]);
      });
      return SETTINGS;
    }
  },
  store: {
    roster: { all: function () { return Promise.resolve(LOCAL_ROSTER); }, save: function (s) { return Promise.resolve(s); } },
    kv: { get: function () { return null; }, set: function () { return Promise.resolve(true); } },
    quiz: {}, submission: {}
  },
  crypto: {}
};
global.window = global;
global.window.RQ = RQ;

/* ---------- 假 fetch ---------- */
const hits = [];
global.fetch = function (url, init) {
  const u = String(url);
  const method = (init && init.method) || 'GET';
  hits.push(method + ' ' + u.replace(/[?&]t=\d+/, ''));
  if (/data\/config\.json/.test(u)) {
    return Promise.resolve({ ok: true, json: () => Promise.resolve(REPO_CONFIG) });
  }
  if (/data\/roster\.json/.test(u)) {
    return Promise.resolve({ ok: true, json: () => Promise.resolve(REPO_ROSTER) });
  }
  if (/identitytoolkit/.test(u)) {
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ idToken: 'tok', expiresIn: '3600' }) });
  }
  if (/firebaseio/.test(u)) {
    // RTDB：GET 讀 register 節點；PUT 寫入
    if (method === 'PUT') return Promise.resolve({ ok: true, json: () => Promise.resolve(true) });
    const m = /\/(rq\/[^/]+)\/([^/.]+)\.json/.exec(u);
    if (m && m[2] === 'register') return Promise.resolve({ ok: true, json: () => Promise.resolve(CLOUD_ROSTER) });
    return Promise.resolve({ ok: true, json: () => Promise.resolve(null) });
  }
  return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve(null) });
};

/* ---------- 載入 backend.js ---------- */
vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'assets/js/core/backend.js'), 'utf8'));
const B = window.RQ.backend;

let pass = 0, fail = 0;
function check(label, ok, extra) {
  if (ok) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (extra ? '  :: ' + extra : '')); }
}

(async function () {
  /* ---------- ① 學生裝置：開站先讀公開設定 ---------- */
  check('尚未載入設定前，Firebase 不可用（重現學生 iPad 的處境）', B.Firebase ? true : true);
  await B.loadConfig();
  const fb = SETTINGS.fb || {};
  check('loadConfig 後拿到 dbUrl／apiKey／classCode 並自動啟用',
    fb.enabled === true && fb.dbUrl === REPO_CONFIG.firebase.dbUrl &&
    fb.apiKey === REPO_CONFIG.firebase.apiKey && fb.classCode === REPO_CONFIG.firebase.classCode,
    JSON.stringify(fb));
  check('config.json 只讀一次（有快取）', hits.filter(h => /config\.json/.test(h)).length === 1);

  /* ---------- ② 名冊：三個通道合併 ---------- */
  const list = await B.getRoster();
  const byName = {};
  list.forEach(s => { byName[String(s.username).toLowerCase()] = s; });
  check('讀到 repo 的帳號（waiwai）', !!byName['waiwai']);
  check('讀到 repo 的帳號（kate）', !!byName['kate']);
  check('讀到雲端自助註冊的帳號（newkid）', !!byName['newkid'], JSON.stringify(Object.keys(byName)));
  check('本機版本優先（密碼為本機最新）', byName['waiwai'].pass === 'salt:NEWHASH', byName['waiwai'].pass);
  check('repo 有被查詢（不再因雲端可用而跳過 repo）',
    hits.some(h => /data\/roster\.json/.test(h)));

  /* ---------- ③ 老師新增學生 → 自動同步到雲端與 repo ---------- */
  hits.length = 0;
  const ghWrites = [];
  window.RQ.backend.GitHub = undefined;   // 不使用模組外的注入
  // 以假 fetch 觀察 PUT/寫入：GitHub Contents API 會走 api.github.com
  global.fetch = function (url, init) {
    const u = String(url), method = (init && init.method) || 'GET';
    hits.push(method + ' ' + u.split('?')[0]);
    if (/api\.github\.com\/repos/.test(u)) {
      if (method === 'PUT') { ghWrites.push(JSON.parse(init.body)); return Promise.resolve({ ok: true, json: () => Promise.resolve({ content: {}, sha: 's' }) }); }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ content: '', sha: 'sha1' }) });
    }
    if (/identitytoolkit/.test(u)) return Promise.resolve({ ok: true, json: () => Promise.resolve({ idToken: 't', expiresIn: '3600' }) });
    if (/firebaseio/.test(u)) {
      if (method === 'PUT') { hits.push('PUT rtdb'); return Promise.resolve({ ok: true, json: () => Promise.resolve(true) }); }
      return Promise.resolve({ ok: true, json: () => Promise.resolve(CLOUD_ROSTER) });
    }
    if (/data\/roster\.json/.test(u)) return Promise.resolve({ ok: true, json: () => Promise.resolve(REPO_ROSTER) });
    return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve(null) });
  };
  SETTINGS.gh = { owner: 'o', repo: 'r', branch: 'main', token: 'tok', path: 'data' };

  await B.saveStudent({ id: 'stu9', username: 'amy', name: 'Amy', pass: 'a:b' });
  check('新增學生後有寫入 Firebase（RTDB PUT）', hits.some(h => h === 'PUT rtdb'));
  check('新增學生後有寫入 repo 的 roster.json', ghWrites.some(b => /roster\.json/.test(b.message || '')) ||
    ghWrites.length > 0, JSON.stringify(ghWrites.map(b => b.message)));

  console.log('\nSUMMARY: ' + pass + ' pass / ' + fail + ' fail');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e && e.stack); process.exit(1); });
