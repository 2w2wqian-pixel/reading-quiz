/* 驗證「Google 帳號登入 + 綁定」與「依班別指派」（不需要真的連網、不需要瀏覽器）。
   重點在於守住兩個容易出錯的不變式：
     ① 身分一律是名冊的 stu_xxx —— 絕不能變成 Google UID（否則既有作答對不上）。
     ② 寫進 repo 的公開名冊不能含學生 email。
   用法：node tools/_test_google_bind.js                                      */
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = 'C:/Users/user/WorkBuddy/2026-09-16-21-14-08/reading-quiz';

/* ---------- 假資料 ---------- */
const REPO_CONFIG = {
  site: '閱讀理解練習站', version: 1,
  firebase: {
    dbUrl: 'https://demo-default-rtdb.firebaseio.com', apiKey: 'AIzaDEMO',
    classCode: 'chi-f2', authDomain: 'demo.firebaseapp.com'
  },
  policy: { assignOnly: true }
};
const REPO_ROSTER = [
  { id: 'stu1', username: 'waiwai', name: '歪歪', className: '2A', pass: 'a:h' },
  { id: 'stu2', username: 'kate', name: '陳小美', className: '2A', pass: 'b:h' },
  { id: 'stu3', username: 'edward', name: '溫德華', className: '2B', pass: 'c:h', googleUid: 'uid-edward' }
];
const CLOUD_ROSTER = {};

/* ---------- 假 Settings ----------
   改用真的 store.js（載入到假的 localStorage 上），
   否則這裡的 stub 會自己實作一份設定邏輯 —— 那就測不到
   「政策開關只有一個來源」這件事（原本就是這樣漏掉的）。 */
const LOCALSTORAGE = {};
global.localStorage = {
  getItem: k => (k in LOCALSTORAGE ? LOCALSTORAGE[k] : null),
  setItem: (k, v) => { LOCALSTORAGE[k] = String(v); },
  removeItem: k => { delete LOCALSTORAGE[k]; }
};
global.window = global;
global.window.RQ = {
  util: {
    nowISO: () => new Date().toISOString(),
    trim: s => String(s == null ? '' : s).trim(),
    uid: p => (p || 'id') + '_x',
    debounce: (fn) => fn,
    esc: s => String(s == null ? '' : s),
    el: () => ({}),
    fmtDate: s => String(s || '')
  }
};
global.document = { createElement: () => ({ style: {}, setAttribute() { } }) };

vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'assets/js/core/store.js'), 'utf8'));

/* 真的 Settings 出來後，把「本機名冊」換成假的（測試不碰真的 IndexedDB） */
const SETTINGS = window.RQ.settings;
const RQ = window.RQ;
RQ.store = {
  roster: {
    all: () => Promise.resolve(LOCAL_ROSTER),
    /* 真實的 IndexedDB 是「同 id 就覆蓋」，不是新增一筆；
       若這裡模擬成 push，解除綁定後舊資料還會留在合併結果裡。 */
    save: s => {
      const i = LOCAL_ROSTER.findIndex(x => x.id === s.id);
      if (i >= 0) LOCAL_ROSTER[i] = s; else LOCAL_ROSTER.push(s);
      return Promise.resolve(s);
    }
  },
  kv: {
    _m: {},
    get(k, d) { return Promise.resolve(k in this._m ? this._m[k] : (d === undefined ? null : d)); },
    set(k, v) { this._m[k] = v; return Promise.resolve(true); }
  },
  quiz: {}, submission: {}
};
let LOCAL_ROSTER = [];
SETTINGS.set({ gh: { path: 'data' }, fb: {}, hook: {}, classCode: 'chi-f2' });

/* ---------- 假 fetch ---------- */
const ghWrites = [];
global.fetch = function (url, init) {
  const u = String(url), method = (init && init.method) || 'GET';
  /* ★ api.github.com 一定要先判斷：GitHub 的檔案網址長這樣
       https://api.github.com/repos/o/r/contents/data/roster.json
     它也含 "roster.json"，若讓下面的靜態檔分支先命中，寫入就會被吃掉。 */
  if (/api\.github\.com/.test(u)) {
    if (method === 'PUT') {
      ghWrites.push({ url: u, body: JSON.parse(init.body || '{}') });
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ content: {}, sha: 'newsha' }) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ content: '', sha: 'sha1' }) });
  }
  if (/config\.json/.test(u)) {
    return Promise.resolve({ ok: true, json: () => Promise.resolve(REPO_CONFIG) });
  }
  if (/roster\.json/.test(u)) {
    return Promise.resolve({ ok: true, json: () => Promise.resolve(REPO_ROSTER) });
  }
  if (/identitytoolkit/.test(u)) {
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ idToken: 'tok', expiresIn: '3600' }) });
  }
  if (/firebaseio/.test(u)) {
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
const G = window.RQ.googleAuth;

let pass = 0, fail = 0;
function check(label, ok, extra) {
  if (ok) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (extra ? '  :: ' + extra : '')); }
}
function lastRosterWrite() {
  const w = ghWrites.filter(x => /roster\.json/.test(x.url)).pop();
  if (!w) return null;
  try { return JSON.parse(Buffer.from(w.body.content, 'base64').toString('utf8')); }
  catch (e) { return null; }
}

(async function () {
  /* ============ ① Google 登入的可用性判斷 ============ */
  check('還沒讀公開設定前，Google 登入視為不可用', G.available() === false,
    JSON.stringify(SETTINGS.get().fb));

  await B.loadConfig();
  check('loadConfig 會把 authDomain 一併補進來（缺什麼補什麼）',
    (SETTINGS.get().fb || {}).authDomain === 'demo.firebaseapp.com', JSON.stringify(SETTINGS.get().fb));
  check('設定齊備後 Google 登入可用', G.available() === true);
  check('沒有 authDomain 時不可用（只有 apiKey）',
    (function () {
      const keep = SETTINGS.get().fb.authDomain;
      SETTINGS.set({ fb: { authDomain: '' } });
      const r = G.available() === false;
      SETTINGS.set({ fb: { authDomain: keep } });
      return r;
    })());

  /* ============ ② 指派判定（全班／個人／班別） ============ */
  check('沒有 assignment → 未指派', B.isAssigned({}, { id: 'stu1' }) === false);
  check('all:true → 指派給所有人', B.isAssigned({ assignment: { all: true } }, { id: 'zzz' }) === true);
  check('ids 命中本人 → 指派',
    B.isAssigned({ assignment: { ids: ['stu1'] } }, { id: 'stu1' }) === true);
  check('ids 未命中 → 未指派',
    B.isAssigned({ assignment: { ids: ['stu1'] } }, { id: 'stu2' }) === false);
  check('classes 命中本人的班別 → 指派',
    B.isAssigned({ assignment: { classes: ['2A'] } }, { id: 'stu9', className: '2A' }) === true);
  check('classes 不符本人的班別 → 未指派',
    B.isAssigned({ assignment: { classes: ['2A'] } }, { id: 'stu9', className: '2B' }) === false);
  check('沒有班別的學生不會被班別指派命中',
    B.isAssigned({ assignment: { classes: ['2A'] } }, { id: 'stu9', className: '' }) === false);
  check('assignReason 說得出命中的原因',
    B.assignReason({ assignment: { classes: ['2A'] } }, { className: '2A' }) === '班別 2A' &&
    B.assignReason({ assignment: { all: true } }, {}) === '全班' &&
    B.assignReason({ assignment: { ids: ['x'] } }, { id: 'x' }) === '指定個人');

  /* ============ ③ 用 Google UID 找回學生 ============ */
  const byUid = await B.findByGoogleUid('uid-edward');
  check('已綁定的 Google 帳號找得到對應學生', !!byUid && byUid.id === 'stu3',
    JSON.stringify(byUid));
  check('尚未綁定的 Google UID 回 null', (await B.findByGoogleUid('uid-nobody')) === null);

  /* ============ ④ 綁定：身分正規化 + 寫入 ============ */
  SETTINGS.set({ gh: { owner: 'o', repo: 'r', branch: 'main', token: 'tok', path: 'data' } });
  ghWrites.length = 0;

  const bound = await B.bindGoogle('stu1', { uid: 'uid-wai', email: 'wai@gmail.com', name: 'Wai' });
  check('綁定後 googleUid 寫進名冊紀錄', bound.googleUid === 'uid-wai');
  check('綁定後保留原本的 id（身分仍是 stu_xxx，不是 Google UID）',
    bound.id === 'stu1' && bound.id !== bound.googleUid);
  check('綁定後記下 email 與登入方式',
    bound.email === 'wai@gmail.com' &&
    (bound.loginMethods || []).indexOf('google') >= 0 &&
    (bound.loginMethods || []).indexOf('password') >= 0,
    JSON.stringify(bound.loginMethods));
  check('綁定後立刻查得到', (await B.findByGoogleUid('uid-wai')).id === 'stu1');

  const pub = lastRosterWrite();
  check('綁定會把名冊同步到 repo', !!pub);
  check('repo 的公開名冊不含任何學生 email（只留 googleUid）',
    !!pub && pub.every(s => !('email' in s)),
    pub ? JSON.stringify(pub.map(s => Object.keys(s))) : 'no write');
  check('repo 的公開名冊仍帶著 googleUid（學生裝置才查得到綁定）',
    !!pub && pub.filter(s => s.id === 'stu1')[0].googleUid === 'uid-wai');

  /* ============ ⑤ 一個 Google 帳號只能綁一位學生 ============ */
  let dupErr = null;
  try { await B.bindGoogle('stu2', { uid: 'uid-wai', email: 'wai@gmail.com' }); }
  catch (e) { dupErr = e.message; }
  check('同一個 Google 帳號不能綁第二位學生', !!dupErr && /已經綁定給/.test(dupErr), dupErr);

  let missErr = null;
  try { await B.bindGoogle('stu-not-exist', { uid: 'uid-x' }); }
  catch (e) { missErr = e.message; }
  check('綁定不存在的學生會明確報錯', !!missErr && /找不到/.test(missErr), missErr);

  let noUidErr = null;
  try { await B.bindGoogle('stu2', {}); }
  catch (e) { noUidErr = e.message; }
  check('沒有 UID 時拒絕綁定', !!noUidErr && /識別碼/.test(noUidErr), noUidErr);

  /* ============ ⑥ 重新綁定同一位學生（換 Google 帳號） ============ */
  const again = await B.bindGoogle('stu1', { uid: 'uid-wai2', email: 'wai2@gmail.com' });
  check('可以為同一位學生換綁另一個 Google 帳號', again.googleUid === 'uid-wai2');
  check('舊的 Google UID 隨之失效', (await B.findByGoogleUid('uid-wai')) === null);

  /* ============ ⑦ 解除綁定 ============ */
  const un = await B.unbindGoogle('stu1');
  check('解除綁定會清掉 googleUid／email',
    !un.googleUid && !un.email, JSON.stringify(un));
  check('解除綁定後 loginMethods 不再含 google',
    (un.loginMethods || []).indexOf('google') < 0, JSON.stringify(un.loginMethods));
  check('解除綁定後查不到', (await B.findByGoogleUid('uid-wai2')) === null);
  check('解除綁定不會動到作答紀錄用的 id', un.id === 'stu1');

  /* ============ ⑧ 班別 ============ */
  const list0 = await B.getRoster();
  check('classNames 取出名冊裡所有班別（去重、排序）',
    JSON.stringify(B.classNames(list0)) === JSON.stringify(['2A', '2B']),
    JSON.stringify(B.classNames(list0)));
  const sc = await B.setStudentClass('stu1', ' 2C ');
  check('設定班別會去除前後空白', sc.className === '2C', sc.className);

  /* ============ ⑨ 發佈設定要帶上 authDomain ============ */
  ghWrites.length = 0;
  await B.publishConfig();
  const cfgWrite = ghWrites.filter(x => /config\.json/.test(x.url)).pop();
  let cfgOut = null;
  try { cfgOut = JSON.parse(Buffer.from(cfgWrite.body.content, 'base64').toString('utf8')); } catch (e) { }
  check('publishConfig 會把 authDomain 寫進公開設定',
    !!cfgOut && cfgOut.firebase.authDomain === 'demo.firebaseapp.com',
    cfgOut ? JSON.stringify(cfgOut.firebase) : 'no write');
  check('publishConfig 仍保留 classCode 與 policy',
    !!cfgOut && cfgOut.firebase.classCode === 'chi-f2' && !!cfgOut.policy);
  check('policy 只寫一份（不再散落在設定的最上層）',
    !!cfgOut && cfgOut.policy && Object.keys(cfgOut.policy).length ===
      Object.keys(window.RQ.settings.POLICY_KEYS).length,
    cfgOut ? JSON.stringify(cfgOut.policy) : '');

  /* ============ ⑩ 「同一個 Email＝同一位使用者」 ============ */
  /* 名冊上預先填好 email（老師在名冊頁做的），學生用該 Google 帳號登入要直接對上 */
  await B.saveStudent(Object.assign({}, (await B.getRoster())
    .filter(s => s.id === 'stu2')[0], { email: 'kate@school.hk' }));

  const r1 = await B.resolveGoogleStudent({ uid: 'uid-kate', email: 'kate@school.hk' });
  check('名冊有同一個 email → 直接認出是同一位學生', !!r1 && r1.id === 'stu2',
    JSON.stringify(r1 && r1.id));
  check('email 比對忽略大小寫與前後空白',
    (await B.resolveGoogleStudent({ uid: 'uid-x', email: '  KATE@School.HK ' })).id === 'stu2');
  check('email 沒對上就回 null（交給連結頁處理）',
    (await B.resolveGoogleStudent({ uid: 'uid-x', email: 'nobody@x.com' })) === null);

  /* 已經被別的 Google 帳號綁走 → 不能再用 email 認領（否則兩人作答會混在一起） */
  await B.bindGoogle('stu2', { uid: 'uid-kate', email: 'kate@school.hk' });
  check('email 已綁定其他 UID 時不再自動認領',
    (await B.resolveGoogleStudent({ uid: 'uid-imposter', email: 'kate@school.hk' })) === null,
    '這一步是防止兩個人共用同一份作答');
  check('原本那個 UID 仍可正常登入',
    (await B.resolveGoogleStudent({ uid: 'uid-kate', email: 'kate@school.hk' })).id === 'stu2');

  /* email 也不能重複登記給兩個人 */
  let mailErr = null;
  try { await B.bindGoogle('stu1', { uid: 'uid-new2', email: 'kate@school.hk' }); }
  catch (e) { mailErr = e.message; }
  check('同一個 email 不能登記給第二位學生', !!mailErr && /已經登記給/.test(mailErr), mailErr);

  check('findByEmail 找得到登記過的學生',
    (await B.findByEmail('kate@school.hk')).id === 'stu2');
  check('findByEmail 對沒登記的 email 回 null',
    (await B.findByEmail('none@x.com')) === null);

  /* ============ ⑪ 政策開關只有一個來源（不再各自算預設值） ============ */
  const P = window.RQ.settings;
  check('policy 預設值定義在 store.js 一處',
    JSON.stringify(P.policy()) === JSON.stringify(P.POLICY_KEYS),
    JSON.stringify(P.policy()));
  P.setPolicy({ allowRetake: true });
  check('setPolicy 改一個開關不影響其他開關',
    P.policy('allowRetake') === true && P.policy('assignOnly') === true);
  check('攤平的舊欄位與 policy 讀到同一個值（不會兩份定義打架）',
    P.get().allowRetake === P.policy('allowRetake'));
  check('攤平的舊欄位不會被寫進 localStorage（避免又變兩份）',
    !('allowRetake' in JSON.parse(localStorage.getItem('rq.settings.v1') || '{}')),
    localStorage.getItem('rq.settings.v1'));
  check('舊版攤平的設定值仍讀得到（相容既有裝置）', (function () {
    localStorage.setItem('rq.settings.v1', JSON.stringify({
      gh: { path: 'data' }, fb: {}, allowRetake: true, enableHighlight: false
    }));
    const ok = P.policy('allowRetake') === true && P.policy('enableHighlight') === false;
    P.set({ gh: { path: 'data' }, fb: {}, classCode: 'chi-f2' });
    return ok;
  })());

  /* ============ ⑫ 帳號型同步鍵：跨裝置要落在同一格 ============ */
  /* 這是「換一台裝置就變成另一份作答」的根因：欄位名必須由帳號決定。
     用同一個「試卷＋學生」算兩次要相同；不同學生之間一定不同。 */
  const idsOf = await B.getRoster();
  const ctx = await B.syncKeys('stu1');
  check('syncKeys 依名冊人數產生對應數量的鍵',
    ctx.keys.length === idsOf.length && ctx.keys.length === 3,
    'keys=' + ctx.keys.length + ' roster=' + idsOf.length);
  check('syncKeys 會認出這台裝置登入過的身分', ctx.claim === 'stu1', ctx.claim);
  check('別台裝置的同一位學生算出同一把鍵（跨裝置同一格）', (function () {
    const a = ctx.keys[idsOf.map(s => s.id).indexOf('stu1')];
    const b = ctx.keys[idsOf.map(s => s.id).indexOf('stu1')];
    return !!a && a === b && /^acct2url_/.test(a);
  })(), ctx.keys.join(','));
  check('不同學生的鍵不會碰撞', new Set(ctx.keys).size === ctx.keys.length);
  check('鍵只含安全字元（不會被 RTDB 當成路徑）',
    ctx.keys.every(k => /^[A-Za-z0-9_]+$/.test(k)) &&
    !ctx.keys.some(k => /^(true|false)$/.test(k)),
    ctx.keys.join(','));

  /* ============ ⑬ 設定一致性盤點 ============ */
  const audit = B.configAudit();
  check('configAudit 會列出命名空間與 Google 授權網域',
    audit.some(x => /命名空間/.test(x.name)) && audit.some(x => /authDomain/.test(x.name)),
    audit.map(x => x.name).join('｜'));
  check('configAudit 涵蓋全部政策開關',
    Object.keys(P.POLICY_KEYS).every(k => audit.some(x => x.name === '政策 ' + k)),
    audit.filter(x => /^政策/.test(x.name)).map(x => x.name).join('｜'));

  /* ============ ⑭ 「已儲存的值」要能跟「預設值」分辨 ============ */
  /* 這是公開政策蓋不掉本機預設的根因：以前 Settings.get().policy 一律把
     POLICY_KEYS 併進去，於是「沒動過」看起來跟「動過」一模一樣，
     loadConfig() 就永遠不曉得該不該套用已發佈的政策。 */
  P.reset();
  check('剛重置時，policy 物件是空的（沒存過任何偏好）',
    Object.keys(P.get().policy).length === 0, JSON.stringify(P.get().policy));
  check('但讀單一開關仍拿得到預設值（有效值）',
    P.policy('assignOnly') === true && P.policy('allowRetake') === false,
    JSON.stringify(P.policy()));
  check('hasPolicy() 沒表態時回 false', P.hasPolicy('assignOnly') === false);
  P.setPolicy({ allowRetake: true });
  check('表態之後 hasPolicy() 回 true', P.hasPolicy('allowRetake') === true);
  check('沒表態的其餘開關仍是 false', P.hasPolicy('assignOnly') === false);
  check('已儲存的 policy 不含未表態的開關',
    Object.keys(P.get().policy).length === 1 &&
    P.get().policy.allowRetake === true, JSON.stringify(P.get().policy));
  check('只存表態值可避免「預設被誤認為使用者的選擇」',
    !('assignOnly' in P.get().policy));

  /* ============ ⑮ 設定盤點要反映「本機 vs 已發佈」 ============ */
  /* 沒讀到公開設定時，遠端欄位要標「尚未讀到」且不算不一致（ok !== false），
     否則老師一開設定頁就看到一片紅，反而不知道真正該修哪一項。 */
  B._publishedConfig = null;
  const audit2 = B.configAudit();
  check('尚未讀到公開設定時，遠端標為「尚未讀到」',
    audit2.every(x => x.remote === '(尚未讀到)' || x.remote !== undefined),
    audit2.map(x => x.name + '=' + x.remote).join('｜'));
  check('沒讀到公開設定不算「不一致」（不誤報紅字）',
    audit2.every(x => x.ok !== false), JSON.stringify(audit2.filter(x => x.ok === false)));
  /* 讀到之後，值不同就必須明確標成不一致 */
  B._publishedConfig = {
    firebase: { classCode: 'other-class', dbUrl: 'https://other.firebaseio.com', authDomain: 'x' },
    classCode: 'zzz', hook: { postUrl: 'y' },
    policy: { assignOnly: false }
  };
  const audit3 = B.configAudit();
  const nsRow = audit3.filter(x => /命名空間/.test(x.name))[0];
  check('命名空間不同時會被標成不一致', !!nsRow && nsRow.ok === false,
    JSON.stringify(nsRow));
  check('不一致的項目會同時顯示本機值與已發佈值',
    !!nsRow && nsRow.local !== nsRow.remote, JSON.stringify(nsRow));
  const polRow = audit3.filter(x => x.name === '政策 assignOnly')[0];
  check('政策項目也納入本機／已發佈比對', !!polRow && polRow.ok === false,
    JSON.stringify(polRow));
  B._publishedConfig = null;

  console.log('\nSUMMARY: ' + pass + ' pass / ' + fail + ' fail');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e && e.stack); process.exit(1); });
