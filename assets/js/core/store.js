/* ============================================================
   store.js — 本機儲存（IndexedDB 為主，localStorage 為輔）
   物件庫：quizzes / submissions / roster / kv / outbox
   ============================================================ */
(function (RQ) {
  'use strict';

  var U = RQ.util;
  var DB_NAME = 'rq-reading-quiz';
  var DB_VER = 1;
  var STORES = ['quizzes', 'submissions', 'roster', 'kv', 'outbox'];

  var _dbp = null;
  var _dbFailed = false;

  /** IndexedDB 可能因為隱私模式、file:// 或瀏覽器限制而無法開啟 → 降級到記憶體 */
  function openDB() {
    if (_dbFailed) return Promise.reject(new Error('IndexedDB 不可用，改用記憶體暫存'));
    if (_dbp) return _dbp;
    _dbp = new Promise(function (res, rej) {
      var settled = false;
      function fail(msg) {
        if (settled) return;
        settled = true; clearTimeout(timer); _dbFailed = true;
        rej(new Error(msg));
      }
      var timer = setTimeout(function () {
        fail('IndexedDB 開啟逾時，改用記憶體暫存');
      }, 3000);

      if (!window.indexedDB) { fail('此瀏覽器不支援 IndexedDB'); return; }
      var req;
      try { req = indexedDB.open(DB_NAME, DB_VER); }
      catch (e) { fail('IndexedDB 開啟失敗：' + e.message); return; }

      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        STORES.forEach(function (s) {
          if (!db.objectStoreNames.contains(s)) {
            var os = db.createObjectStore(s, { keyPath: 'id' });
            if (s === 'submissions') {
              os.createIndex('quizId', 'quizId', { unique: false });
              os.createIndex('studentId', 'studentId', { unique: false });
            }
            if (s === 'roster') os.createIndex('username', 'username', { unique: false });
          }
        });
      };
      req.onsuccess = function (e) {
        if (settled) return;
        settled = true; clearTimeout(timer); res(e.target.result);
      };
      req.onerror = function (e) { fail('無法開啟 IndexedDB'); };
      req.onblocked = function () { fail('IndexedDB 被其他分頁鎖住'); };
    });
    return _dbp;
  }

  function tx(store, mode) {
    return openDB().then(function (db) {
      return db.transaction(store, mode).objectStore(store);
    });
  }

  function wrap(os, action) {
    return new Promise(function (res, rej) {
      var req = action(os);
      req.onsuccess = function () { res(req.result); };
      req.onerror = function (e) { rej(e.target.error || new Error('資料庫操作失敗')); };
    });
  }

  /* ---------- 記憶體降級（無 IndexedDB 時） ---------- */
  var _mem = { quizzes: {}, submissions: {}, roster: {}, kv: {}, outbox: {} };

  function fallbackGet(store, id) { return Promise.resolve(_mem[store][id] || null); }
  function fallbackAll(store) { return Promise.resolve(Object.keys(_mem[store]).map(function (k) { return _mem[store][k]; })); }
  function fallbackPut(store, obj) { _mem[store][obj.id] = obj; return Promise.resolve(obj); }
  function fallbackDel(store, id) { delete _mem[store][id]; return Promise.resolve(true); }

  var Store = {
    ready: function () { return openDB(); },

    get: function (store, id) {
      return tx(store, 'readonly').then(function (os) { return wrap(os, function (o) { return o.get(id); }); })
        .catch(function () { return fallbackGet(store, id); });
    },

    all: function (store) {
      return tx(store, 'readonly').then(function (os) { return wrap(os, function (o) { return o.getAll(); }); })
        .catch(function () { return fallbackAll(store); });
    },

    put: function (store, obj) {
      return tx(store, 'readwrite').then(function (os) { return wrap(os, function (o) { return o.put(obj); }); })
        .then(function () { return obj; })
        .catch(function () { return fallbackPut(store, obj); });
    },

    del: function (store, id) {
      return tx(store, 'readwrite').then(function (os) { return wrap(os, function (o) { return o.delete(id); }); })
        .then(function () { return true; })
        .catch(function () { return fallbackDel(store, id); });
    },

    /** 依 index 查詢 */
    byIndex: function (store, index, value) {
      return tx(store, 'readonly').then(function (os) {
        return wrap(os, function (o) { return o.index(index).getAll(value); });
      }).catch(function () {
        return fallbackAll(store).then(function (list) {
          return list.filter(function (x) { return x[index] === value; });
        });
      });
    },

    clear: function (store) {
      return tx(store, 'readwrite').then(function (os) { return wrap(os, function (o) { return o.clear(); }); })
        .catch(function () { _mem[store] = {}; return true; });
    },

    /* ---------- 高階：試卷 ---------- */
    quiz: {
      all: function () { return Store.all('quizzes'); },
      get: function (id) { return Store.get('quizzes', id); },
      save: function (q) { q.updatedAt = U.nowISO(); return Store.put('quizzes', q); },
      del: function (id) { return Store.del('quizzes', id); }
    },

    /* ---------- 高階：作答 ---------- */
    submission: {
      all: function () { return Store.all('submissions'); },
      ofQuiz: function (quizId) { return Store.byIndex('submissions', 'quizId', quizId); },
      ofStudent: function (sid) { return Store.byIndex('submissions', 'studentId', sid); },
      get: function (id) { return Store.get('submissions', id); },
      save: function (s) {
        s.id = s.id || U.uid('sub');
        s.savedAt = U.nowISO();
        return Store.put('submissions', s);
      },
      del: function (id) { return Store.del('submissions', id); }
    },

    /* ---------- 高階：學生名冊 ---------- */
    roster: {
      all: function () { return Store.all('roster'); },
      get: function (id) { return Store.get('roster', id); },
      save: function (u) { u.id = u.id || U.uid('stu'); return Store.put('roster', u); },
      del: function (id) { return Store.del('roster', id); },
      byUsername: function (name) {
        return Store.byIndex('roster', 'username', name).then(function (l) { return l[0] || null; });
      }
    },

    /* ---------- kv（簡單設定） ---------- */
    kv: {
      get: function (k, dflt) {
        return Store.get('kv', k).then(function (r) { return r ? r.value : dflt; });
      },
      set: function (k, v) { return Store.put('kv', { id: k, value: v }); }
    },

    /* ---------- 匯出 / 匯入整包 ---------- */
    exportAll: function () {
      return Promise.all([
        Store.all('quizzes'), Store.all('submissions'), Store.all('roster')
      ]).then(function (r) {
        return {
          format: 'rq-bundle',
          version: 1,
          exportedAt: U.nowISO(),
          quizzes: r[0], submissions: r[1], roster: r[2]
        };
      });
    },

    importAll: function (bundle, mode) {
      // mode: 'merge'（預設，同 id 覆蓋）| 'replace'（先清空）
      var jobs = [];
      var keys = ['quizzes', 'submissions', 'roster'];
      function step(i) {
        if (i >= keys.length) return Promise.resolve(true);
        var k = keys[i];
        var list = bundle[k] || [];
        var p = (mode === 'replace') ? Store.clear(k) : Promise.resolve(true);
        return p.then(function () {
          return list.reduce(function (acc, item) {
            return acc.then(function () { return Store.put(k, item); });
          }, Promise.resolve(true));
        }).then(function () { return step(i + 1); });
      }
      return step(0);
    }
  };

  /* ============================================================
     設定（localStorage）：含 GitHub Token、後端模式等
     ============================================================ */
  var LS_KEY = 'rq.settings.v1';

  /* ============================================================
     設定的**單一來源**
     ------------------------------------------------------------
     這些開關以前散在「設定頁」「試卷管理頁」「學生名冊頁」各自一份，
     每一份都用 `s.x !== false` 自己判斷預設值 —— 只要有人改了一處的預設，
     三處就會互相矛盾（例如老師端說開放、學生端仍被擋）。
     現在一律由 POLICY_KEYS 定義，讀寫都經過 Settings.policy()。
     ============================================================ */
  var POLICY_KEYS = {
    assignOnly: true,             /* 學生只看得到老師指派的試卷 */
    showAnswerAfterSubmit: true,  /* 學生提交後可看答案 */
    allowRetake: false,           /* 允許重複作答 */
    enableHighlight: true,        /* 螢光筆／筆記／生詞本 */
    allowSelfRegister: false      /* 開放學生自助註冊 */
  };

  var DEFAULT_SETTINGS = {
    /* 試卷存放：offline | github */
    quizMode: 'offline',
    /* 作答收集：offline | webhook | github */
    submitMode: 'offline',
    /* GitHub（老師端同步試卷／封存作答） */
    gh: { owner: '', repo: '', branch: 'main', token: '', path: 'data' },
    /* 收集端（學生提交／註冊／草稿，全部走同一個端點） */
    hook: { postUrl: '', getUrl: '', key: '', sheetUrl: '' },
    /* Firebase Realtime Database（跨裝置雲端同步）
       authDomain 只有「Google 帳號登入」用到（學生按 Google 登入時才載入 SDK），
       留空不影響既有的匿名通道與資料庫讀寫。 */
    fb: { enabled: false, dbUrl: '', apiKey: '', classCode: '', authDomain: '' },
    /* AI 大模型（老師端「設定 → AI 助理」）
       金鑰只存在這台裝置的 localStorage，不會寫進 repo／雲端。
       詳細欄位語意見 core/ai.js 的 DEFAULT_AI。 */
    ai: { enabled: false, provider: 'direct', endpoint: '', model: '', apiKey: '', keyQuery: 'key', viaHook: false },
    /* 自助註冊的班級代碼（與雲端命名空間 classCode 是兩件事，見 teacher.js 說明） */
    classCode: '',
    /* 雲端草稿 */
    cloudDraft: true,
    /* 老師密碼（"salt:hash"） */
    teacherPass: '',
    /* policy 是一組不可分割的開關 → 寫成巢狀物件，避免與其他欄位混在一起 */
    policy: Object.assign({}, POLICY_KEYS),
    /* 目前登入者（session） */
    session: null
  };

  /** 布林轉換：只認真正的布林、0/1 與 "true"/"false"，
   *  其他值（含 undefined）一律回 fallback。 */
  function toBool(v, fallback) {
    if (v === true || v === 'true' || v === 1 || v === '1') return true;
    if (v === false || v === 'false' || v === 0 || v === '0') return false;
    return fallback;
  }

  var Settings = {
    get: function () {
      var s;
      try { s = JSON.parse(localStorage.getItem(LS_KEY) || '{}'); }
      catch (e) { s = {}; }
      var merged = Object.assign({}, DEFAULT_SETTINGS, s, {
        gh: Object.assign({}, DEFAULT_SETTINGS.gh, s.gh || {}),
        hook: Object.assign({}, DEFAULT_SETTINGS.hook, s.hook || {}),
        fb: Object.assign({}, DEFAULT_SETTINGS.fb, s.fb || {}),
        ai: Object.assign({}, DEFAULT_SETTINGS.ai, s.ai || {}),
        /* ⚠ 這裡**不能**寫成 Object.assign({}, POLICY_KEYS, s.policy)：
           POLICY_KEYS 是「預設值」，不是「已儲存的值」。先併進去的話，
           沒被改過的開關也會長得像「使用者存過的偏好」，
           loadConfig() 就再也分不出「這台裝置已經表態」還是「只是套用預設」，
           結果公開政策永遠蓋不掉本機預設 → 學生端與老師端各看各的。
           正確做法：只放使用者真的存過的值，缺的留 undefined，
           要讀「有效值」時再走 Settings.policy() 補預設。 */
        policy: Object.assign({}, s.policy || {})
      });
      /* 相容舊版：舊機器的設定是把五個開關攤在最上層，
         搬進 policy 之後才不會「同一件事有兩個地方在定義」。 */
      Object.keys(POLICY_KEYS).forEach(function (k) {
        if (s[k] !== undefined) merged.policy[k] = toBool(s[k], POLICY_KEYS[k]);
      });
      /* 攤平一份「有效值」給既有程式碼讀（只活在回傳值上，不寫回 localStorage） */
      Object.keys(POLICY_KEYS).forEach(function (k) {
        merged[k] = merged.policy[k] === undefined ? POLICY_KEYS[k] : merged.policy[k];
      });
      return merged;
    },
    set: function (patch) {
      var cur = Settings.get();
      var next = Object.assign({}, cur, patch);
      if (patch.gh) next.gh = Object.assign({}, cur.gh, patch.gh);
      if (patch.hook) next.hook = Object.assign({}, cur.hook, patch.hook);
      if (patch.fb) next.fb = Object.assign({}, cur.fb, patch.fb);
      if (patch.ai) next.ai = Object.assign({}, cur.ai, patch.ai);
      /* 開關一律寫進 policy；攤平的舊欄位順手清掉，避免兩份定義並存 */
      var pol = Object.assign({}, cur.policy, patch.policy || {});
      Object.keys(POLICY_KEYS).forEach(function (k) {
        if (patch[k] !== undefined && !patch.policy) pol[k] = patch[k];
        delete next[k];
      });
      next.policy = pol;
      localStorage.setItem(LS_KEY, JSON.stringify(next));
      return Settings.get();
    },
    reset: function () { localStorage.removeItem(LS_KEY); return Settings.get(); },

    /* ---- 開關（單一來源） ---- */
    /** 讀單一開關的**有效值**（使用者存過就用它，沒存過才用 POLICY_KEYS 的預設） */
    policy: function (key) {
      var p = Settings.get().policy;
      if (key == null) {
        var all = {};
        Object.keys(POLICY_KEYS).forEach(function (k) {
          all[k] = p[k] === undefined ? POLICY_KEYS[k] : p[k];
        });
        return all;
      }
      return p[key] === undefined ? POLICY_KEYS[key] : p[key];
    },
    /** 寫單一開關（會被視為「這台裝置表態了」） */
    setPolicy: function (patch) {
      var p = {};
      p.policy = Object.assign({}, Settings.get().policy, patch);
      return Settings.set(p);
    },
    /** 這台裝置是否「明確表態過」某個開關（loadConfig 用來決定可否被公開政策覆蓋） */
    hasPolicy: function (key) {
      var p = Settings.get().policy;
      return key == null ? Object.keys(p).length > 0 : p[key] !== undefined;
    },

    /* ---- session ---- */
    login: function (who) { return Settings.set({ session: who }); },
    logout: function () { return Settings.set({ session: null }); },
    who: function () { return Settings.get().session; }
  };

  Settings.POLICY_KEYS = POLICY_KEYS;

  RQ.store = Store;
  RQ.settings = Settings;
})(window.RQ);
