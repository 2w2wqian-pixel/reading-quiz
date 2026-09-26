/* ============================================================
   backend.js — 資料來源抽象層
   ------------------------------------------------------------
   雲端通道（擇一或並存，設定頁切換）：
     A. Firebase Realtime Database  — 即時、跨裝置，免費 Spark 方案
     B. Google Apps Script + 試算表 — 即時寫入、CSV 讀回，免費無上限
     C. GitHub  repo JSON（老師端） — 試卷長期保存
     D. offline IndexedDB + JSON    — 完全離線

   ★ 三種雲端通道共用同一套「記錄模型」，程式碼只有一份：
       rec = { type, id, quizId, studentId, studentName, ts, key, payload }
       type: 'submission' | 'draft' | 'register'
       id  : 'sub::<quizId>::<studentId>' / 'draft::<quizId>::<studentId>' / 'roster::<username>'

   試卷讀取另有「隨站發佈」通道：data/quizzes/*.json 由 GitHub Pages
   靜態提供，學生同源 fetch 即可，不需要任何 Token。
   ============================================================ */
(function (RQ) {
  'use strict';

  var U = RQ.util, Store = RQ.store, Settings = RQ.settings;

  /* ============================================================
     小工具
     ============================================================ */
  function b64encode(str) {
    var bytes = new TextEncoder().encode(str);
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function b64decode(b64) {
    var bin = atob(String(b64).replace(/\s/g, ''));
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  }
  function safeKey(s) {
    return String(s == null ? '' : s).replace(/[.#$\/\[\]?:]/g, '_');
  }
  function recId(type, a, b) {
    if (type === 'submission') return 'sub::' + a + '::' + b;
    if (type === 'draft') return 'draft::' + a + '::' + b;
    if (type === 'register') return 'roster::' + a;
    return type + '::' + a;
  }
  function makeRec(type, a, b, payload, extra) {
    return Object.assign({
      type: type,
      id: recId(type, a, b),
      quizId: type === 'register' ? '' : (a || ''),
      studentId: type === 'register' ? '' : (b || ''),
      studentName: (payload && payload.studentName) || '',
      ts: U.nowISO(),
      key: (Settings.get().hook || {}).key || '',
      payload: payload
    }, extra || {});
  }

  /**
   * 寫進 repo 的名冊是**公開檔案**（GitHub Pages 任何人可讀），
   * 所以要把學生的 email 拿掉——googleUid 是隨機識別碼、本身不含個人資料，
   * 但 email 是。雲端與本機仍保有完整資料，老師端才看得到 email。
   */
  function publicRoster(list) {
    return (list || []).map(function (s) {
      var o = Object.assign({}, s);
      delete o.email;
      delete o.googleName;
      return o;
    });
  }

  /* ---------- 跨裝置「帳號同步」用的鍵 ----------
     作答的鍵是 `sub::<quizId>::<studentId>`，所以同一份試卷在任何裝置上
     都必須落在同一個鍵底下。true/false 不是合法的 RTDB 路徑片段
     （`rq/x/quiz/sub::q1::stu1` 會被當成路徑解析，`true` 會變成布林節點），
     因此一定要編碼成安全字元。 */
  var ACCT = { prefix: 'acct2url', salt: 'rq-acct-v1' };

  /** RTDB 節點名：只能用安全字元（路徑片段不能含 . # $ [ ] / 與 true/false） */
  ACCT.key = function (s) {
    var h = 0x811c9dc5;
    var str = String(s == null ? '' : s);
    for (var i = 0; i < str.length; i++) {
      h = (h ^ str.charCodeAt(i)) >>> 0;
      h = (h * 16777619) >>> 0;
    }
    var h2 = 0x01000193;
    for (var j = str.length - 1; j >= 0; j--) {
      h2 = (h2 + str.charCodeAt(j) * (j + 7)) >>> 0;
      h2 = ((h2 << 5) | (h2 >>> 27)) >>> 0;
    }
    return ACCT.prefix + '_' + h.toString(36) + h2.toString(36);
  };

  /** 同音極簡摺疊（只對 ASCII 生效，中文一字不動） */
  function foldKey(s) {
    return String(s == null ? '' : s).trim().toLowerCase()
      .replace(/\s+/g, '')
      .replace(/[0o]/g, 'o').replace(/[1li]/g, 'i').replace(/[5s]/g, 's').replace(/[3e]/g, 'e');
  }

  /**
   * 摺疊後的 UID → 名冊 studentId。
   * 但真正的門檻是：金鑰裡**混入了那把「一次一問卷」的 salt**，
   * 只有「在這台裝置登入過、且作答過同一份試卷」的裝置才算得出來。
   *
   * saltFor(list) 只用該份試卷的「參與者」算題目，所以：
   *   ① 學生在任何裝置登入 → 密碼正確 → 他的裝置一定算得出來（回去接上進度）
   *   ② 半路猜一個 UID → 幾乎不可能剛好命中節點名
   */
  ACCT.saltFor = function (studentIds) {
    var ids = (studentIds || []).map(String).sort();
    var h1 = 0x811c9dc5, h2 = 0x01000193;
    for (var i = 0; i < ids.length; i++) {
      var s = ACCT.salt + '|' + ids[i];
      for (var j = 0; j < s.length; j++) {
        h1 = (h1 ^ s.charCodeAt(j)) >>> 0; h1 = (h1 * 16777619) >>> 0;
        h2 = (h2 + s.charCodeAt(j) * (j + 3)) >>> 0; h2 = ((h2 << 7) | (h2 >>> 25)) >>> 0;
      }
    }
    return h1.toString(36) + h2.toString(36);
  };

  ACCT.fold = foldKey;
  ACCT.same = function (a, b) { return !!a && !!b && foldKey(a) === foldKey(b); };

  /* 對應只在換裝置的那幾分鐘內有用 → 一天後自動失效，
     免得學生的 Google UID 永久留在雲端（Google 建議不要長期保留）。 */
  ACCT.TTL_MIN = 24 * 60;
  ACCT._taken = {};        /* 這個 session 已經問過（無論有沒有） */
  ACCT._uid = null;        /* 目前這個 Google 帳號認到的學生 */

  /** 寫入「Google UID → 名冊學生」的短效對應（在 rq/<code>/auth/ 下） */
  ACCT.remember = function (uid, studentId) {
    if (!uid || !studentId) return Promise.resolve(false);
    if (!(Firebase.ok() || Hook.ok())) return Promise.resolve(false);
    var now = Date.now();
    ACCT._taken[String(uid)] = studentId;
    ACCT._uid = { uid: String(uid), studentId: studentId };
    var rec = makeRec('auth', ACCT.key(uid), null, {
      uid: String(uid), studentId: studentId, at: new Date(now).toISOString(),
      exp: now + ACCT.TTL_MIN * 60 * 1000
    });
    return Cloud.put(rec).then(function () { return true; }).catch(function () { return false; });
  };

  /** 移除對應（解除綁定時） */
  ACCT.forget = function (uid, studentId) {
    if (!uid) return Promise.resolve(false);
    delete ACCT._taken[String(uid)];
    if (ACCT._uid && ACCT._uid.uid === String(uid)) ACCT._uid = null;
    if (!Firebase.ok()) return Promise.resolve(false);
    if (studentId) {
      return Backend.getRoster().then(function (list) {
        var ids = (list || []).map(function (s) { return s.id; });
        return ADDR.claim(ids, studentId);
      }).then(function (col) {
        return ADDR.unset(col, [ACCT.key(uid)]).then(function () { return true; });
      }).catch(function () { return false; });
    }
    return Promise.resolve(false);
  };

  /**
   * 用雲端那條短效對應找回學生（換裝置時名冊還沒同步過來的最後一道保險）。
   * 找不到、或已經過期，都回 null。
   */
  ACCT.recall = function (uid) {
    var u = String(uid || '');
    if (!u) return Promise.resolve(null);
    if (!(Firebase.ok() || Hook.ok())) return Promise.resolve(null);
    if (Object.prototype.hasOwnProperty.call(ACCT._taken, u)) {
      var known = ACCT._taken[u];
      return known ? Backend.getRoster().then(function (list) { return findStudent(list, known); })
        : Promise.resolve(null);
    }
    return Cloud.get('auth', ACCT.key(u)).then(function (rec) {
      if (!rec || !rec.studentId) return null;
      /* 過期就當作沒有（順手把它刪掉，避免愈積愈多） */
      if (rec.exp && Number(rec.exp) < Date.now()) {
        ACCT.forget(u, rec.studentId).catch(function () { });
        return null;
      }
      if (!ACCT._uid) ACCT._uid = { uid: u, studentId: rec.studentId };
      ACCT._taken[u] = rec.studentId;
      return Backend.getRoster().then(function (list) { return findStudent(list, rec.studentId); });
    }).catch(function () { return null; });
  };

  /* ---------- 位址式記錄（作答／草稿／生詞的跨裝置合併） ----------
     一般記錄是「一筆一列」，但作答必須是「一份試卷＋一位學生＝一格」：
     否則同一份試卷在不同裝置會各自新增一列，合併後同一題出現兩份作答，
     自動給分會把上次的分數蓋成 0。
     做法：值存在 Cloud 的單獨一筆，欄位則靠 RTDB 的 HTTP PATCH 更新，
     所以只需要送「一個欄位」的增量，不必下載整份作答（可容納很多學生）。 */
  var ADDR = {
    _cache: {},     /* 欄位清單留在記憶體，減少一次讀取 */

    /** 作答在雲端的欄位名：依「帳號」而不是「裝置」計算 */
    acctKey: function (id, scope) { return ACCT.key('sub::' + scope + '::' + id); },

    claim: function (idList, scope) {
      var k = String(scope || 'all');
      if (ADDR._cache[k]) return Promise.resolve(ADDR._cache[k]);
      if (!Firebase.ok()) return Promise.resolve([]);
      return Firebase.get('addr/' + safeKey(k)).then(function (col) {
        var list = (col && Array.isArray(col.list)) ? col.list : [];
        ADDR._cache[k] = list;
        return list;
      }).catch(function () { return []; });
    },
    /** 一次更新多個欄位（未提供的欄位原封不動） */
    patch: function (scope, fields) {
      if (!Firebase.ok()) return Promise.resolve(false);
      var body = {};
      Object.keys(fields || {}).forEach(function (f) {
        body[f] = fields[f] === null ? null : fields[f];
      });
      return Firebase.patchAddr('addr/' + safeKey(scope), body).then(function (ok) {
        var k = String(scope || 'all'), list = ADDR._cache[k] || [];
        Object.keys(fields).forEach(function (f) {
          if (fields[f] === null) list = list.filter(function (x) { return x !== f; });
          else if (list.indexOf(f) < 0) list.push(f);
        });
        ADDR._cache[k] = list;
        return ok;
      });
    },
    unset: function (cols, keys) {
      if (!Firebase.ok() || !keys.length) return Promise.resolve(false);
      var body = {};
      keys.forEach(function (k) { body[k] = null; });
      return Firebase.patchAddr('addr/' + safeKey(cols), body).catch(function () { return false; });
    }
  };

  /* 每個學生只保留一種登入方式時，避免重複 */
  function uniq(arr) {
    var seen = {};
    return (arr || []).filter(function (x) {
      if (!x || seen[x]) return false;
      seen[x] = 1; return true;
    });
  }

  function findStudent(list, id) {
    return (list || []).filter(function (s) { return s && s.id === id; })[0] || null;
  }

  /* 學生的班別：新的名冊用 className，舊資料可能只有 classes[]；
     兩種都要認，否則「指派給某班」會對不到人（老師以為指派了、學生看不到）。 */
  function studentClass(student) {
    if (!student) return '';
    if (student.className) return student.className;
    var cs = student.classes;
    if (Array.isArray(cs) && cs.length) return cs[0];
    return '';
  }

  /* ============================================================
     驅動 A：Firebase Realtime Database
     ============================================================ */
  /* Firebase 匿名登入的錯誤碼 → 可操作的說明（照著做就能修好） */
  var FB_HINT = {
    CONFIGURATION_NOT_FOUND: 'Firebase 專案還沒啟用「匿名」登入：'
      + 'Firebase Console → Authentication → Sign-in method → 啟用「匿名」',
    OPERATION_NOT_ALLOWED: '「匿名」登入被停用了：'
      + 'Firebase Console → Authentication → Sign-in method → 重新啟用「匿名」',
    API_KEY_INVALID: 'Web API Key 無效或已被刪除，請重新複製貼上',
    PERMISSION_DENIED: 'Web API Key 被限制（請到 Google Cloud → 憑證 → 允許這個網址）',
    INVALID_API_KEY: 'Web API Key 格式錯誤'
  };

  var Firebase = {
    cfg: function () { return Settings.get().fb || {}; },
    /**
     * 班級代碼＝資料命名空間。**未填時回退為 'default'**。
     * 舊版把它當成必要欄位（ok() 要求 classCode 非空），但它其實只是命名空間；
     * 未填時 ok() 直接回 false，整個雲端會「靜默失效」——不會報錯，
     * 只是什麼都沒寫上去。這是先前「完全沒有雲端同步」的程式面主因。
     */
    code: function () { return safeKey(Firebase.cfg().classCode || '') || 'default'; },
    ok: function () {
      var c = Firebase.cfg();
      return !!(c.enabled && c.dbUrl && c.apiKey);
    },
    base: function () { return 'rq/' + encodeURIComponent(Firebase.code()); },
    path: function (p) { return Firebase.base() + (p ? '/' + p : ''); },

    /** 匿名登入，取 idToken（學生不需要有 Google 帳號） */
    signIn: function (force) {
      var c = Firebase.cfg();
      if (!force && c._token && c._exp && Date.now() < c._exp - 60000) return Promise.resolve(c._token);
      return fetch('https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=' +
        encodeURIComponent(c.apiKey), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ returnSecureToken: true })
      }).then(function (r) { return r.json(); }).then(function (j) {
        if (j.error) {
          var code = (j.error && j.error.message) || 'UNKNOWN';
          throw new Error(code + (FB_HINT[code] ? '｜' + FB_HINT[code] : '｜匿名登入失敗'));
        }
        Settings.set({ fb: { _token: j.idToken, _exp: Date.now() + (parseInt(j.expiresIn, 10) || 3600) * 1000 } });
        return j.idToken;
      });
    },
    _url: function (p, auth) {
      return String(Firebase.cfg().dbUrl || '').replace(/\/+$/, '') + '/' + p + '.json' +
        (auth ? '?auth=' + encodeURIComponent(auth) : '');
    },
    get: function (p) {
      if (!Firebase.ok()) return Promise.resolve(null);
      return Firebase.signIn().then(function (t) {
        return fetch(Firebase._url(Firebase.path(p), t), { cache: 'no-store' });
      }).then(function (r) { return r.ok ? r.json() : null; })
        .catch(function () { return null; });
    },
    /** 嚴格版讀取：失敗時 reject（一般讀取用 get，會吞錯；診斷與退路判斷需要知道失敗） */
    getStrict: function (p) {
      if (!Firebase.ok()) return Promise.reject(new Error('尚未設定 Firebase'));
      return Firebase.signIn().then(function (t) {
        return fetch(Firebase._url(Firebase.path(p), t), { cache: 'no-store' });
      }).then(function (r) {
        if (r.status === 401) throw new Error('Realtime Database 規則拒絕讀取（401）：請把規則設為 auth != null');
        if (!r.ok) throw new Error('Firebase 讀取失敗 ' + r.status);
        return r.json();
      });
    },

    put: function (p, val) {
      if (!Firebase.ok()) return Promise.reject(new Error('尚未設定 Firebase'));
      return Firebase.signIn().then(function (t) {
        return fetch(Firebase._url(Firebase.path(p), t), {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(val)
        });
      }).then(function (r) { if (!r.ok) throw new Error('Firebase 寫入失敗 ' + r.status); return true; });
    },
    del: function (p) {
      if (!Firebase.ok()) return Promise.reject(new Error('尚未設定 Firebase'));
      return Firebase.signIn().then(function (t) {
        return fetch(Firebase._url(Firebase.path(p), t), { method: 'DELETE' });
      }).then(function (r) {
        /* 🔴 以前這裡不看 r.ok，一律回傳 true —— 401（規則拒絕）也會被當成「刪除成功」，
           於是 UI 說「已刪除」、資料其實還在。這正是「按了刪除還在清單裡」的來源之一。
           404 例外：本來就沒有那一筆，視為成功。 */
        if (r.status === 404) return true;
        if (r.status === 401) throw new Error('Realtime Database 規則拒絕刪除（401）：請把規則設為 auth != null');
        if (!r.ok) throw new Error('Firebase 刪除失敗 ' + r.status);
        return true;
      });
    },
    /**
     * 局部更新（HTTP PATCH）：只送要改的欄位，未提供的欄位保持原值。
     * 作答／草稿把「一位學生在一份試卷」存成一格、欄位清單另存，
     * 就是靠這裡才不必每次讀寫整份作答（可容納很多學生）。
     */
    patchAddr: function (p, fields) {
      if (!Firebase.ok()) return Promise.reject(new Error('尚未設定 Firebase'));
      return Firebase.signIn().then(function (t) {
        return fetch(Firebase._url(Firebase.path(p), t), {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(fields || {})
        });
      }).then(function (r) { if (!r.ok) throw new Error('Firebase 更新失敗 ' + r.status); return true; });
    },
    test: function () {
      if (!Firebase.ok()) return Promise.reject(new Error('請先填寫 Database URL、API Key 與班級代碼'));
      return Firebase.put('meta/ping', { at: U.nowISO() }).then(function () {
        return Firebase.get('meta/ping');
      }).then(function (v) {
        if (!v) throw new Error('寫入後讀不到資料，請檢查 Realtime Database 規則');
        return { ok: true, at: v.at, base: Firebase.base() };
      });
    }
  };

  /* ============================================================
     驅動 G：Google 帳號登入（Firebase JS SDK，**只負責「身分」**）
     ------------------------------------------------------------
     為什麼要用 SDK：Google 登入牽涉 Google 的 OAuth 流程，用 REST 自己接
     得另外申請 OAuth 用戶端 ID；SDK 直接沿用 Firebase 專案自帶的授權端點，
     老師只要「啟用 Google 供應商 + 把網址加進授權網域」就能用。

     ★ 資料庫（RTDB）的讀寫**完全不經過 SDK**，仍走既有的匿名 REST 通道，
       所以 SDK 沒載入、或 Google 登入不可用時，整個站台照常運作。
     ★ 只在使用者真的按下「使用 Google 登入」時才載入 SDK（約 100KB），
       沒有 Google 需求的裝置不會付出這個成本。
     ============================================================ */
  var GOOGLE_SDK_BASE = 'https://www.gstatic.com/firebasejs/10.12.2/';
  var REDIRECT_FLAG = 'rq_google_redirect';
  var RETURN_KEY = 'rq_login_return';

  /* Firebase SDK 的錯誤碼 → 可操作的說明 */
  var GOOGLE_HINT = {
    'auth/unauthorized-domain':
      '這個網站網址還沒加入 Firebase 授權網域：'
      + 'Firebase Console → Authentication → Settings → 已授權網域 → 新增本站網址',
    'auth/operation-not-allowed':
      'Firebase 專案的「Google」登入供應商還沒啟用：'
      + 'Authentication → Sign-in method → Google → 啟用',
    'auth/popup-blocked': '瀏覽器擋掉了登入彈出視窗，請允許彈出視窗後再試一次',
    'auth/popup-closed-by-user': '你關閉了 Google 登入視窗，尚未登入',
    'auth/cancelled-popup-request': '你取消了 Google 登入，尚未登入',
    'auth/network-request-failed': '網路連線失敗，請檢查網路後再試',
    'auth/account-exists-with-different-credential':
      '這個電子郵件已經用其他方式註冊過了，請換一個帳號或改用帳號密碼登入',
    'rq/local-cancel': '你取消了 Google 登入，尚未登入'
  };

  var GoogleAuth = {
    _ready: null,
    /* 上一次失敗的原因；學生端據此在按鈕下方顯示提示（toast 會被忽略） */
    lastError: null,
    cfg: function () { return Settings.get().fb || {}; },

    /** 具備 Google 登入所需設定（apiKey + authDomain）嗎 */
    available: function () {
      var c = GoogleAuth.cfg();
      return !!(c.apiKey && c.authDomain);
    },

    errorText: function (e) {
      var msg = (e && (e.code || e.message)) || '';
      var key = String(msg).split('｜')[0];
      if (GOOGLE_HINT[key]) return GOOGLE_HINT[key];
      if (/unauthorized-domain/i.test(msg)) return GOOGLE_HINT['auth/unauthorized-domain'];
      if (/operation-not-allowed/i.test(msg)) return GOOGLE_HINT['auth/operation-not-allowed'];
      return msg || 'Google 登入失敗';
    },

    _loadScript: function (url) {
      return new Promise(function (res, rej) {
        var s = document.createElement('script');
        s.src = url; s.async = true;
        s.onload = function () { res(true); };
        s.onerror = function () { rej(new Error('無法載入 Google 登入所需的程式庫（請檢查網路）')); };
        document.head.appendChild(s);
      });
    },

    /**
     * 準備 SDK。**app-compat 必須先於 auth-compat**，所以兩支腳本要循序載入
     * （並行載入 auth 會找不到 firebase 全域而失敗）。
     */
    _init: function () {
      if (GoogleAuth._ready) return GoogleAuth._ready;
      if (!GoogleAuth.available()) {
        GoogleAuth._ready = Promise.reject(new Error(
          '尚未設定 Google 授權網域（authDomain）：'
          + '老師請到「⑤ 資料與同步 → ① 雲端同步」填入，再按「發佈設定給所有裝置」。'));
        return GoogleAuth._ready;
      }
      var c = GoogleAuth.cfg();
      var load;
      if (window.firebase && window.firebase.auth) {
        load = Promise.resolve(true);
      } else if (window.firebase && window.firebase.app) {
        load = GoogleAuth._loadScript(GOOGLE_SDK_BASE + 'firebase-auth-compat.js');
      } else {
        load = GoogleAuth._loadScript(GOOGLE_SDK_BASE + 'firebase-app-compat.js')
          .then(function () { return GoogleAuth._loadScript(GOOGLE_SDK_BASE + 'firebase-auth-compat.js'); });
      }
      GoogleAuth._ready = load.then(function () {
        if (!window.firebase || !window.firebase.auth) throw new Error('Firebase SDK 載入不完整');
        if (!window.firebase.apps || !window.firebase.apps.length) {
          window.firebase.initializeApp({
            apiKey: c.apiKey,
            authDomain: c.authDomain,
            databaseURL: c.dbUrl || undefined
          });
        }
        return window.firebase.auth();
      });
      return GoogleAuth._ready;
    },

    _profile: function (user) {
      if (!user) return null;
      var email = user.email || '';
      return {
        uid: user.uid,
        email: email,
        name: user.displayName || (email ? email.split('@')[0] : '') || '學生',
        photo: user.photoURL || ''
      };
    },

    _coarse: function () {
      try { return window.matchMedia('(pointer:coarse)').matches; } catch (e) { return false; }
    },

    /**
     * 登入。粗指標裝置（iPad／手機）改用轉址：彈出視窗常被瀏覽器或
     * 加到主畫面的 PWA 模式擋掉，轉址較穩。轉址時本頁會被導走，
     * 回呼端用 handleRedirect() 接手。
     */
    signIn: function () {
      GoogleAuth.lastError = null;
      /* 轉址回來時把「使用者原本在哪一頁」記著，登入完要導回原頁 */
      GoogleAuth._rememberReturn(GoogleAuth._returnTo());
      return GoogleAuth._init().then(function (auth) {
        var provider = new window.firebase.auth.GoogleAuthProvider();
        provider.setCustomParameters({ prompt: 'select_account' });
        if (GoogleAuth._coarse()) {
          try { sessionStorage.setItem(REDIRECT_FLAG, '1'); } catch (e) { }
          auth.signInWithRedirect(provider);
          return { redirect: true };
        }
        return auth.signInWithPopup(provider).then(function (res) {
          return GoogleAuth._profile(res && res.user);
        });
      }).then(function (r) {
        if (r && r.redirect) return r;
        if (!r) throw new Error('沒有取得 Google 帳號資料');
        return r;
      }).catch(function (e) {
        /* 使用者主動取消（關閉彈出視窗）不是故障，要能跟真正的失敗分辨 */
        var code = GoogleAuth._code(e);
        if (/popup-closed-by-user|cancelled-popup-request|user-cancelled/.test(code)) {
          var cancel = new Error('auth/cancelled-by-user');
          cancel.code = 'rq/local-cancel';
          GoogleAuth.lastError = { code: 'rq/local-cancel', text: GOOGLE_HINT['rq/local-cancel'] };
          throw cancel;
        }
        GoogleAuth.lastError = { code: code, text: GoogleAuth.errorText(e) };
        throw e;
      });
    },

    /** 取錯誤碼：SDK 用 e.code，本模組自製的錯誤可能只放在 message */
    _code: function (e) {
      if (!e) return '';
      if (e.code) return String(e.code);
      var m = /^(auth\/[a-z0-9-]+)/i.exec(String(e.message || ''));
      return m ? m[1] : String(e.message || '');
    },

    /* ---------- 登入後導回「原本造訪的頁面」 ---------- */
    _returnTo: function () {
      var h = location.hash || '';
      /* 登入頁本身不值得回去（回去只會再被登入牆擋），home 也不必 */
      if (!h || h === '#/' || /^#\/student(\/login)?$/.test(h)) return '';
      return h;
    },
    _rememberReturn: function (h) {
      try {
        if (h) sessionStorage.setItem(RETURN_KEY, h);
        else sessionStorage.removeItem(RETURN_KEY);
      } catch (e) { }
    },
    /** 取出並清掉待返回的位置（取過就不再重複使用） */
    takeReturn: function () {
      var h = '';
      try {
        h = sessionStorage.getItem(RETURN_KEY) || '';
        sessionStorage.removeItem(RETURN_KEY);
      } catch (e) { }
      return h;
    },

    /** 轉址回來後取結果；沒有待處理的轉址就直接回 null（不載入 SDK） */
    handleRedirect: function () {
      var pending = false;
      try { pending = sessionStorage.getItem(REDIRECT_FLAG) === '1'; } catch (e) { pending = false; }
      if (!pending || !GoogleAuth.available()) return Promise.resolve(null);
      try { sessionStorage.removeItem(REDIRECT_FLAG); } catch (e) { }
      return GoogleAuth._init()
        .then(function (auth) { return auth.getRedirectResult(); })
        .then(function (res) {
          var p = GoogleAuth._profile(res && res.user);
          if (!p) {
            /* 使用者從 Google 頁面按返回／取消：不是故障，但也沒登入 */
            GoogleAuth.lastError = { code: 'rq/local-cancel', text: GOOGLE_HINT['rq/local-cancel'] };
            return null;
          }
          return p;
        })
        .catch(function (e) {
          GoogleAuth.lastError = { code: GoogleAuth._code(e), text: GoogleAuth.errorText(e) };
          return null;
        });
    },

    /** 登出 Google（換人用；共用平板尤其重要） */
    signOut: function () {
      if (!window.firebase || !window.firebase.auth) return Promise.resolve(true);
      try {
        return window.firebase.auth().signOut().then(function () { return true; })
          .catch(function () { return false; });
      } catch (e) { return Promise.resolve(false); }
    }
  };

  /* ============================================================
     驅動 B：Google Apps Script（+ CSV 讀回）
     ============================================================ */
  var Hook = {
    cfg: function () { return Settings.get().hook || {}; },
    ok: function () { return !!Hook.cfg().postUrl; },

    post: function (obj) {
      var c = Hook.cfg();
      if (!c.postUrl) return Promise.reject(new Error('尚未設定收集端網址'));
      var body = JSON.stringify(obj);
      return fetch(c.postUrl, {
        method: 'POST', mode: 'cors',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: body
      }).then(function (r) {
        return r.json().catch(function () { return { ok: true }; });
      }).then(function (j) {
        if (j && j.ok === false) throw new Error(j.error || '收集端拒絕寫入');
        return true;
      }).catch(function (e) {
        if (e && e.message && /收集端拒絕/.test(e.message)) throw e;
        /* 部分端點不回 CORS 標頭 → 改為單向投遞 */
        return fetch(c.postUrl, {
          method: 'POST', mode: 'no-cors',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: body
        }).then(function () { return true; })
          .catch(function () { throw new Error('無法傳送到收集端'); });
      });
    },

    /** 即時讀取（/exec?action=list）；多數情況會被 CORS 擋，失敗回傳 null */
    live: function (type) {
      if (!Hook.ok()) return Promise.resolve(null);
      var url = Hook.cfg().postUrl + '?action=list' + (type ? '&type=' + encodeURIComponent(type) : '');
      return fetch(url, { cache: 'no-store' }).then(function (r) {
        if (!r.ok) return null;
        return r.json().catch(function () { return null; });
      }).catch(function () { return null; });
    },

    /** 從「發佈成 CSV」的網址讀回（Google 允許跨網域） */
    csv: function () {
      var c = Hook.cfg();
      if (!c.getUrl) return Promise.resolve([]);
      return fetch(c.getUrl + (c.getUrl.indexOf('?') < 0 ? '?' : '&') + 't=' + Date.now(), { cache: 'no-store' })
        .then(function (r) { if (!r.ok) throw new Error('讀取失敗 ' + r.status); return r.text(); })
        .then(function (txt) {
          var t = U.trim(txt);
          if (t.charAt(0) === '[' || t.charAt(0) === '{') {
            var j = JSON.parse(t);
            return Array.isArray(j) ? j : (j.items || []);
          }
          var rows = U.parseCSV(t);
          if (!rows.length) return [];
          var head = rows[0].map(function (h) { return U.trim(h).toLowerCase(); });
          var pi = head.indexOf('payload');
          if (pi < 0) pi = rows[0].length - 1;
          return rows.slice(1).map(function (r) {
            var raw = U.trim(r[pi] || '');
            if (raw.charAt(0) !== '{') return null;
            try { return JSON.parse(raw); } catch (e) { return null; }
          }).filter(Boolean);
        }).catch(function () { return []; });
    }
  };

  /* ============================================================
     ★ 統一雲端層：Cloud.get / getAll / put / del
     ============================================================ */
  var Cloud = {
    /* 上次讀取走哪條路，給老師端顯示用 */
    lastSource: '',
    lastReadAt: null,
    /* 最後一次雲端錯誤（雲端壞掉時會靜默回空陣列，這個欄位是唯一的線索） */
    lastError: '',
    /* 最後一次「實際寫入成功」的通道（可能是 Firebase 失敗後退回 Apps Script） */
    lastWritten: '',

    driver: function () {
      if (Firebase.ok()) return 'firebase';
      if (Hook.ok()) return 'appscript';
      return 'offline';
    },

    put: function (rec) {
      if (Firebase.ok()) {
        rec.id = safeKey(rec.id);
        return Firebase.put(rec.type + '/' + rec.id, rec).then(function () {
          Cloud.lastWritten = 'firebase';
          return true;
        }).catch(function (e) {
          Cloud.lastError = (e && e.message) || String(e);
          /* Firebase 有設定但寫不進去 → 自動退回 Apps Script，
             避免「以為有雲端、其實什麼都沒存」。 */
          if (Hook.ok()) {
            return Hook.post(rec).then(function () { Cloud.lastWritten = 'hook'; return true; });
          }
          throw e;
        });
      }
      if (Hook.ok()) return Hook.post(rec).then(function () { Cloud.lastWritten = 'hook'; return true; });
      return Promise.reject(new Error('尚未設定雲端（Firebase 或收集端網址）'));
    },

    /** Apps Script 讀取（先試即時 /exec，讀不到再用發佈的 CSV 快取） */
    _fromHook: function (type) {
      return Hook.live(type).then(function (live) {
        if (live !== null) {
          Cloud.lastSource = 'live';
          Cloud.lastReadAt = U.nowISO();
          return live;
        }
        return Hook.csv().then(function (rows) {
          Cloud.lastSource = 'csv';            /* 走快取，可能延遲 0–5 分鐘 */
          Cloud.lastReadAt = U.nowISO();
          return rows;
        });
      }).then(function (all) {
        return (all || []).filter(function (r) { return !type || r.type === type; });
      });
    },

    /**
     * 取出某一類的所有記錄（陣列）。
     * Apps Script 路徑：先試 /exec 即時讀取，讀不到再用「發佈成 CSV」。
     * CSV 是 Google 快取的，通常延遲 0–5 分鐘 — 所以要把來源回報給 UI。
     */
    getAll: function (type) {
      if (Firebase.ok()) {
        return Firebase.getStrict(type).then(function (o) {
          Cloud.lastSource = 'firebase';
          Cloud.lastReadAt = U.nowISO();
          if (!o) return [];
          return Object.keys(o).map(function (k) { return o[k]; }).filter(Boolean);
        }).catch(function (e) {
          Cloud.lastError = (e && e.message) || String(e);
          if (Hook.ok()) return Cloud._fromHook(type);
          return [];
        });
      }
      if (Hook.ok()) return Cloud._fromHook(type);
      Cloud.lastSource = 'offline';
      return Promise.resolve([]);
    },

    /** 只走即時路徑（/exec），給「強制立即重新整理」用 */
    getAllLive: function (type) {
      if (Firebase.ok()) return Cloud.getAll(type);
      if (!Hook.ok()) return Promise.resolve([]);
      return Hook.live(type).then(function (live) {
        if (live === null) throw new Error('即時讀取被瀏覽器擋住（CORS），請改用 Firebase 或直接開試算表');
        Cloud.lastSource = 'live';
        Cloud.lastReadAt = U.nowISO();
        return (live || []).filter(function (r) { return !type || r.type === type; });
      });
    },

    get: function (type, id) {
      if (Firebase.ok()) return Firebase.get(type + '/' + safeKey(id));
      return Cloud.getAll(type).then(function (list) {
        return list.filter(function (r) { return String(r.id) === String(id); })[0] || null;
      });
    },

    /**
     * 取某一類中「欄位名以某前綴開頭」的所有記錄。
     * 作答與草稿的欄位名是「帳號::試卷」的雜湊，靠前綴篩選
     * 才好一次撈出某位學生在這份試卷上的所有裝置版本。
     */
    getAllOf: function (type, prefix) {
      if (!prefix) return Cloud.getAll(type);
      if (!Firebase.ok()) {
        return Cloud.getAll(type).then(function (list) {
          return (list || []).filter(function (r) { return String(r.id).indexOf(prefix) === 0; });
        });
      }
      return Firebase.getStrict(type).then(function (o) {
        Cloud.lastSource = 'firebase';
        if (!o) return [];
        return Object.keys(o).filter(function (k) { return k.indexOf(prefix) === 0; })[0]
          ? Object.keys(o).map(function (k) { return o[k]; }).filter(Boolean) : [];
      }).catch(function (e) {
        Cloud.lastError = (e && e.message) || String(e);
        return [];
      });
    },

    /**
     * 刪一筆雲端紀錄。
     * 🔴 以前這裡只認 Firebase，其餘一律 `Promise.resolve(true)`——
     *    「沒做任何事卻回報成功」。用 Apps Script 當雲端的老師因此永遠刪不掉雲端副本，
     *    而雲端副本就是「試卷管理」清單的來源之一 → 按了刪除，列還在。
     *    Apps Script 那條路現在會送 `action:'del'`（見 tools/apps-script.gs 的 doPost）。
     *    真的沒有雲端可刪時 **reject**，不要假裝成功。
     */
    del: function (type, id, opt) {
      opt = opt || {};
      if (Firebase.ok()) return Firebase.del(type + '/' + safeKey(id));
      if (Hook.ok()) {
        /* Sheet 的主鍵是「type::主鍵」的合成字串，而不同版本的 type 可能寫成 quiz／quizzes
           → 由呼叫端把「可能的形式」列出來（opt.keys），不要在這裡猜字串。
           （曾經用 `type.replace(/s$/, '')` 想還原單數，結果把 quizzes 變成 quizze。） */
        var keys = (Array.isArray(opt.keys) && opt.keys.length)
          ? opt.keys.slice()
          : [String(id), String(type) + '::' + String(id)];
        return Hook.post({
          action: 'del',
          type: opt.sheetType || type,
          id: id,
          keys: keys,
          ts: U.nowISO()
        }).then(function () { return true; });
      }
      return Promise.reject(new Error('尚未設定雲端（Firebase 或收集端網址）'));
    },

    test: function () {
      if (Firebase.ok()) return Firebase.test().then(function (r) {
        return { driver: 'firebase', detail: r };
      });
      if (Hook.ok()) {
        return Hook.live(null).then(function (live) {
          return { driver: 'appscript', live: !!live, rows: live ? live.length : null };
        });
      }
      return Promise.reject(new Error('尚未設定任何雲端通道'));
    }
  };

  /* ============================================================
     驅動 C：GitHub Contents API（老師端）
     ============================================================ */
  var GitHub = {
    cfg: function () { return Settings.get().gh; },
    ok: function () {
      var c = GitHub.cfg();
      return !!(c.owner && c.repo && c.token);
    },
    api: function (path, opts) {
      opts = opts || {};
      var headers = {
        'Accept': 'application/vnd.github+json',
        'Authorization': 'Bearer ' + GitHub.cfg().token,
        'X-GitHub-Api-Version': '2022-11-28'
      };
      Object.assign(headers, opts.headers || {});
      return fetch('https://api.github.com' + path, {
        method: opts.method || 'GET', headers: headers,
        /* 一定要 no-store：GitHub API 的 GET 會帶 Cache-Control max-age=60，
           若讀到快取的舊內容，拿到的 sha 就是舊的 → PUT 會被 409 拒絕
           （錯誤訊息長得像「xxx.json does not match <sha>」）。 */
        cache: 'no-store',
        body: opts.body ? JSON.stringify(opts.body) : undefined
      }).then(function (r) {
        if (r.status === 404) return null;
        return r.json().then(function (j) {
          if (!r.ok) throw new Error((j && j.message) || ('GitHub API ' + r.status));
          return j;
        });
      });
    },
    read: function (path) {
      if (!GitHub.ok()) return Promise.reject(new Error('尚未設定 GitHub'));
      var c = GitHub.cfg();
      return GitHub.api('/repos/' + c.owner + '/' + c.repo + '/contents/' + path +
        '?ref=' + encodeURIComponent(c.branch || 'main')).then(function (j) {
        if (!j) return null;
        return { content: b64decode(j.content), sha: j.sha, path: j.path };
      });
    },
    readJSON: function (path, dflt) {
      return GitHub.read(path).then(function (r) {
        if (!r) return dflt;
        try { return JSON.parse(r.content); } catch (e) { return dflt; }
      });
    },
    /**
     * 寫入檔案（Contents API）。因為是「先讀 sha → 再 PUT」，若在這一瞬間檔案被
     * 別人改動（例如連續發佈兩份試卷、或另一台裝置同時發佈），GitHub 會回
     * 409 並附帶訊息「<path> does not match <sha>」。
     * 這裡會自動重讀最新 sha 重試（最多 3 次），避免老師看到無解的失敗訊息。
     */
    write: function (path, objOrText, message) {
      if (!GitHub.ok()) return Promise.reject(new Error('尚未設定 GitHub'));
      var c = GitHub.cfg();
      var text = (typeof objOrText === 'string') ? objOrText : JSON.stringify(objOrText, null, 2);
      var attempt = 0;

      function put() {
        attempt++;
        return GitHub.read(path).then(function (cur) { return cur ? cur.sha : null; })
          .catch(function () { return null; })
          .then(function (sha) {
            var body = {
              message: message || ('update ' + path),
              content: b64encode(text), branch: c.branch || 'main'
            };
            if (sha) body.sha = sha;
            return GitHub.api('/repos/' + c.owner + '/' + c.repo + '/contents/' + path, { method: 'PUT', body: body });
          })
          .catch(function (e) {
            var msg = (e && e.message) || '';
            if (attempt < 3 && /does not match|is at|\b409\b/i.test(msg)) {
              return new Promise(function (res) { setTimeout(res, 300 * attempt); }).then(put);
            }
            if (/does not match|is at|\b409\b/i.test(msg)) {
              throw new Error('試卷清單同時被更新（檔案版本衝到），請再按一次「發佈」即可');
            }
            throw e;
          });
      }
      return put();
    },
    list: function (dir) {
      if (!GitHub.ok()) return Promise.reject(new Error('尚未設定 GitHub'));
      var c = GitHub.cfg();
      return GitHub.api('/repos/' + c.owner + '/' + c.repo + '/contents/' + dir +
        '?ref=' + encodeURIComponent(c.branch || 'main'))
        .then(function (j) { return Array.isArray(j) ? j.map(function (f) { return f.name; }) : []; });
    },

    /**
     * 刪除檔案（要先取 sha）。
     *
     * 與 write() 同樣要處理 sha 衝撞：`read → DELETE` 之間若檔案被改動，
     * GitHub 會回 409「<path> does not match <sha>」→ 重讀 sha 再試。
     *
     * ⚠️ 回傳值語意（呼叫端必須分辨）：
     *   true          → 真的刪掉了
     *   false         → **檔案本來就不存在**（沒東西可刪，不算失敗）
     *   reject(Error) → 真的失敗（權限、網路、409 用盡…）
     * 早期版本把所有失敗都吞成 false，導致「刪除失敗」在 UI 上長得跟
     * 「本來就沒有」一模一樣，老師只看到一句含糊的「刪除失敗」。
     */
    remove: function (path, message) {
      if (!GitHub.ok()) return Promise.reject(new Error('尚未設定 GitHub'));
      var c = GitHub.cfg();
      var attempt = 0;

      function attemptDelete() {
        attempt++;
        return GitHub.read(path).then(function (cur) {
          if (!cur) return false;                     // 本來就沒有 → 不是失敗
          return GitHub.api('/repos/' + c.owner + '/' + c.repo + '/contents/' + path, {
            method: 'DELETE',
            body: { message: message || ('remove ' + path), sha: cur.sha, branch: c.branch || 'main' }
          }).then(function () { return true; });
        }).catch(function (e) {
          var msg = (e && e.message) || '';
          if (attempt < 3 && /does not match|is at|\b409\b/i.test(msg)) {
            return new Promise(function (res) { setTimeout(res, 300 * attempt); }).then(attemptDelete);
          }
          if (/does not match|is at|\b409\b/i.test(msg)) {
            throw new Error('刪除時檔案版本衝到（' + path + '），請再按一次「刪除」');
          }
          throw e;
        });
      }
      return attemptDelete();
    },

    /**
     * 列出某個目錄底下的檔案（含 path，供「殘留檔清掃」比對用）。
     * `list()` 只回檔名，這裡回完整路徑。
     */
    listDetailed: function (dir) {
      if (!GitHub.ok()) return Promise.reject(new Error('尚未設定 GitHub'));
      var c = GitHub.cfg();
      return GitHub.api('/repos/' + c.owner + '/' + c.repo + '/contents/' + dir +
        '?ref=' + encodeURIComponent(c.branch || 'main'))
        .then(function (j) {
          if (!Array.isArray(j)) return [];
          return j.filter(function (f) { return f.type === 'file'; })
            .map(function (f) { return { name: f.name, path: f.path, sha: f.sha, size: f.size }; });
        });
    },
    test: function () {
      if (!GitHub.ok()) return Promise.reject(new Error('請先填寫擁有者、repo 與 Token'));
      var c = GitHub.cfg();
      return GitHub.api('/repos/' + c.owner + '/' + c.repo).then(function (j) {
        if (!j || !j.full_name) throw new Error('找不到此 repo，或 Token 沒有權限');
        return { full_name: j.full_name, private: j.private, default_branch: j.default_branch };
      });
    }
  };

  /* ============================================================
     隨站發佈通道（同源靜態檔）
     ============================================================ */
  var Published = {
    base: 'data/',
    _fetch: function (rel) {
      return fetch(Published.base + rel + '?t=' + Date.now(), { cache: 'no-store' })
        .then(function (r) { if (!r.ok) return null; return r.json().catch(function () { return null; }); })
        .catch(function () { return null; });
    },
    /* ⚠ 一定要保證回傳「陣列」：`j || []` 擋不住 `{}`（空物件是 truthy），
       而 `data/*.json` 若被寫成物件、或 CDN 回了一個空物件，
       呼叫端就會在 `.forEach` 直接爆掉，症狀是「學生主頁整頁空白」。
       這種錯發生在載入路徑上，最難查，所以在來源頭就收斂掉。 */
    index: function () { return Published._fetch('quizzes/index.json').then(function (j) { return arrayify(j, 'quizzes'); }); },
    quiz: function (id) { return Published._fetch('quizzes/' + encodeURIComponent(id) + '.json'); },
    roster: function () { return Published._fetch('roster.json').then(function (j) { return arrayify(j, 'students'); }); }
  };

  /**
   * 把「可能是陣列、可能是 {key: [...]}、可能什麼都不是」的 JSON 收斂成陣列。
   * 遠端檔案格式不受我們控制（人手編輯、舊版程式寫的、CDN 回空物件），
   * 所以每個讀取點都要防呆，而不是假設它一定是陣列。
   */
  function arrayify(j, key) {
    if (Array.isArray(j)) return j;
    if (!j || typeof j !== 'object') return [];
    var v = j[key];
    if (Array.isArray(v)) return v;
    /* 再退一步：物件裡只有一個陣列欄位就用它 */
    var arrays = Object.keys(j).map(function (k) { return j[k]; }).filter(Array.isArray);
    return arrays.length === 1 ? arrays[0] : [];
  }

  function metaOf(q, src) {
    return {
      id: q.id, title: q.title, level: q.level || '', source: q.source || '',
      subject: q.subject || '', format: q.format || '',
      questionCount: (q.questions || []).length,
      totalMarks: q.totalMarks || 0,
      passageCount: (q.passages || []).length,
      createdAt: q.createdAt || q.updatedAt || U.nowISO(),
      published: !!q.published,
      assignment: q.assignment || null,
      _src: src
    };
  }

  /* ============================================================
     ★ 已刪除試卷的「墓碑」清單
     ------------------------------------------------------------
     刪除一份試卷要同時清三個地方：本機 IndexedDB、雲端清單、repo 的 index.json。
     任何**遠端**通道失敗（Token 過期、沒設定 GitHub、Apps Script 沒開刪除），
     被刪掉的試卷就會繼續出現在老師的「試卷管理」——
     老師的體感是「我明明按了刪除，它還在」，而且再按一次也刪不掉，
     因為本機那份已經不見了，清單上的列其實來自遠端。

     所以：按下刪除時先在本機立一個墓碑，listQuizzes 一律把墓碑上的 id 濾掉。
     遠端全部清乾淨 → 墓碑結案（pending:false，不再影響任何事）。
     遠端有殘留 → 墓碑留著並標 pending，UI 才說得出「還有幾份沒清乾淨」。
     重新「發佈」同一份會自動撤銷墓碑（復活）。
     ============================================================ */
  var TOMB_KEY = 'deletedQuizzes';
  var Tomb = {
    list: function () {
      /* Store 的存取一律包在 then 裡：測試環境或舊版 store 若沒有 kv，
         會變成 rejected promise（可以 catch）而不是同步 throw。 */
      return Promise.resolve()
        .then(function () { return Store.kv.get(TOMB_KEY, []); })
        .catch(function () { return []; })
        .then(function (v) {
          return Array.isArray(v) ? v.filter(function (x) { return x && x.id; }) : [];
        });
    },
    /** 只回 id，給 listQuizzes 做過濾（最常見的用途） */
    ids: function () {
      return Tomb.list().then(function (l) { return l.map(function (x) { return x.id; }); });
    },
    mark: function (id, info) {
      info = info || {};
      return Tomb.list().then(function (l) {
        var next = l.filter(function (x) { return x.id !== id; });
        next.push({ id: id, at: info.at || U.nowISO(), pending: true });
        return Store.kv.set(TOMB_KEY, next);
      });
    },
    /** 遠端清乾淨了 → 結案（保留紀錄，方便日後追查，但不再顯示為待處理） */
    resolve: function (id) {
      return Tomb.list().then(function (l) {
        var hit = false;
        var next = l.map(function (x) {
          if (x.id !== id) return x;
          hit = true;
          return Object.assign({}, x, { pending: false });
        });
        return hit ? Store.kv.set(TOMB_KEY, next) : true;
      });
    },
    /** 整筆撤銷（重新發佈同一份試卷時用） */
    unmark: function (id) {
      return Tomb.list().then(function (l) {
        var next = l.filter(function (x) { return x.id !== id; });
        return next.length === l.length ? true : Store.kv.set(TOMB_KEY, next);
      });
    },
    /** 一次撤銷多筆（清掃器成功刪掉殘留檔後呼叫） */
    forget: function (ids) {
      var set = {};
      (ids || []).forEach(function (x) { set[x] = 1; });
      return Tomb.list().then(function (l) {
        var next = l.filter(function (x) { return !set[x.id]; });
        return next.length === l.length ? true : Store.kv.set(TOMB_KEY, next);
      });
    }
  };

  /* ============================================================
     Backend 統一介面
     ============================================================ */
  var Backend = {
    GitHub: GitHub, Published: Published, Hook: Hook, Firebase: Firebase, Cloud: Cloud,

    /* ---------- 試卷 ---------- */

    /** 雲端試卷清單：優先用 quizzesIndex；沒有就掃 quizzes 節點自己組 meta。
     *  會出現在雲端節點的試卷一定是「發佈」寫上去的，一律標成已發佈
     *  （否則舊資料裡的 published:false 會讓學生端過濾掉、老師端也顯示成草稿）。 */
    _cloudIndex: function () {
      function meta(q) {
        if (!q || !q.id) return null;
        var m = metaOf(q, 'cloud');
        m.published = true;
        return m;
      }
      function toMetas(list) { return (list || []).map(meta).filter(Boolean); }

      if (Firebase.ok()) {
        return Firebase.getStrict('quizzesIndex').then(function (j) {
          /* RTDB 可能把陣列存成物件（鍵為 0,1,2…），也可能回空物件 →
             一律用 arrayify 收斂，不要用 Array.isArray 判斷。 */
          var idx = arrayify(j, 'quizzesIndex');
          if (idx.length) {
            return idx.map(function (m) {
              return (m && m.id) ? Object.assign({}, m, { published: true, _src: 'cloud' }) : null;
            }).filter(Boolean);
          }
          /* 沒有清單（舊資料）→ 直接掃節點自己組 meta。
             ⚠ 節點是 `quizzes`（複數），要跟 publishQuiz 寫入的位置一致；
             以前這裡讀的是單數 `quiz`，那條退路其實永遠掃不到東西。 */
          return Firebase.getStrict('quizzes').then(function (o) {
            if (!o) return [];
            return toMetas(Object.keys(o).map(function (k) { return o[k]; }));
          });
        }).catch(function () {
          /* Firebase 讀不到（規則拒絕／網路）→ 退到 Apps Script，
             不要讓雲端清單整組消失。 */
          if (Hook.ok()) return Cloud.getAll('quiz').then(toMetas).catch(function () { return []; });
          return [];
        });
      }
      if (Hook.ok()) {
        return Cloud.getAll('quiz').then(toMetas).catch(function () { return []; });
      }
      return Promise.resolve([]);
    },

    listQuizzes: function () {
      return Promise.all([
        Store.quiz.all().catch(function () { return []; }),
        Published.index().catch(function () { return []; }),
        Backend._cloudIndex(),
        /* 已刪除的墓碑：本機刪掉、遠端卻沒清乾淨時，靠這裡讓它不再出現在清單上 */
        Tomb.ids().catch(function () { return []; })
      ]).then(function (r) {
        var map = {};
        var localArr = Array.isArray(r[0]) ? r[0] : [];
        var repoArr = Array.isArray(r[1]) ? r[1] : [];
        var cloudArr = Array.isArray(r[2]) ? r[2] : [];
        var gone = {};
        (Array.isArray(r[3]) ? r[3] : []).forEach(function (id) { gone[id] = 1; });
        localArr.forEach(function (q) { if (q && q.id) map[q.id] = metaOf(q, 'local'); });
        cloudArr.forEach(function (m) {
          if (!m || !m.id) return;
          var cur = map[m.id];
          if (!cur) { map[m.id] = Object.assign({ _src: 'cloud', _cloud: true, published: true }, m); return; }
          cur._cloud = true;
          cur.published = true;
          if (cur._src === 'local') cur._src = 'both';
        });
        repoArr.forEach(function (m) {
          if (!m || !m.id) return;
          var cur = map[m.id];
          if (!cur) { map[m.id] = Object.assign({ _src: 'published', _repo: true, published: true }, m); return; }
          /* 本機也有這份 → repo 上有檔案就代表一定發佈過，
             不能只改 _src，否則會出現「草稿 ＋ repo」這種自相矛盾的狀態。 */
          cur.published = true;
          cur._repo = true;
          if (cur._src === 'local') cur._src = 'both';
          ['title', 'level', 'questionCount', 'totalMarks', 'passageCount', 'assignment'].forEach(function (k) {
            if ((cur[k] == null || cur[k] === '' || cur[k] === 0) && m[k] != null) cur[k] = m[k];
          });
        });
        return Object.keys(map)
          /* 墓碑優先於一切來源：不論本機、雲端還是 repo 哪一份還在，一律濾掉。 */
          .filter(function (k) { return !Object.prototype.hasOwnProperty.call(gone, k); })
          .map(function (k) { return map[k]; })
          .sort(function (a, b) { return String(b.createdAt || '').localeCompare(String(a.createdAt || '')); });
      });
    },

    /**
     * 取一份試卷（完整內容）。依序嘗試：本機 → 雲端（直接取 key）→
     * 雲端（掃描）→ 同步發佈的 repo 檔 → GitHub API。
     * 會同時嘗試「原字串」與「解碼後」的 id，因為 location.hash 會把中文
     * 試卷 id 轉成 percent-encoding，舊連結因此對不上。
     */
    getQuiz: function (id) {
      var ids = [id];
      try {
        var dec = decodeURIComponent(id);
        if (dec !== id) ids.unshift(dec);
      } catch (e) { /* 不是合法編碼就用原字串 */ }

      function local(x) { return Store.quiz.get(x).catch(function () { return null; }); }

      function cloud(x) {
        if (!(Firebase.ok() || Hook.ok())) return Promise.resolve(null);
        if (Firebase.ok()) {
          return Firebase.get('quizzes/' + safeKey(x)).catch(function () { return null; })
            .then(function (q) { return q && q.id ? q : null; });
        }
        return Cloud.get('quiz', recId('quiz', x))
          .then(function (r) { return r ? (r.payload || r) : null; }).catch(function () { return null; });
      }

      function cloudScan(x) {
        if (!Firebase.ok()) return Promise.resolve(null);
        return Firebase.get('quizzes').then(function (o) {
          if (!o) return null;
          var found = Object.keys(o).filter(function (k) { return o[k] && (o[k].id === x); })[0];
          return found ? o[found] : null;
        }).catch(function () { return null; });
      }

      function repo(x) { return Published.quiz(x).catch(function () { return null; }); }

      function ghRead(x) {
        if (!GitHub.ok()) return Promise.resolve(null);
        var base = (Settings.get().gh.path || 'data') + '/quizzes';
        return GitHub.readJSON(base + '/' + x + '.json', null).catch(function () { return null; });
      }

      /* 順序刻意由「便宜」到「昂貴」：本機 → 雲端單筆 → repo 單檔 →
         GitHub API 單檔 → 最後才掃整個雲端節點（會抓一大包，只當保險）。 */
      var chain = Promise.resolve(null);
      ids.forEach(function (x) {
        chain = chain
          .then(function (q) { return q || local(x); })
          .then(function (q) { return q || cloud(x); })
          .then(function (q) { return q || repo(x); })
          .then(function (q) { return q || ghRead(x); })
          .then(function (q) { return q || cloudScan(x); });
      });
      return chain.then(function (q) { return q || null; });
    },

    saveQuiz: function (quiz) { return Store.quiz.save(quiz).then(function () { return quiz; }); },

    publishQuiz: function (quiz) {
      var jobs = [];
      /* 先標記已發佈，寫出去的副本（repo／雲端）才會帶著 published:true；
         若最後失敗會回復原狀，不會留下「假已發佈」。 */
      var wasPublished = !!quiz.published;
      quiz.published = true;
      quiz.updatedAt = U.nowISO();

      /* Firebase：同時寫試卷本體與清單，學生端才找得到（清單是學生列試卷的來源） */
      if (Firebase.ok()) {
        jobs.push(Firebase.put('quizzes/' + safeKey(quiz.id), quiz).then(function () {
          return Firebase.get('quizzesIndex').catch(function () { return null; }).then(function (idx) {
            idx = Array.isArray(idx) ? idx.slice() : [];
            var m = metaOf(quiz, 'cloud');
            var i = idx.findIndex(function (x) { return x && x.id === quiz.id; });
            if (i >= 0) idx[i] = m; else idx.push(m);
            return Firebase.put('quizzesIndex', idx);
          });
        }));
      }
      if (GitHub.ok()) {
        var base = (Settings.get().gh.path || 'data') + '/quizzes';
        /* 順序很重要：先寫試卷本體、再更新清單。
           反過來的話，若清單寫成功、試卷檔寫失敗，清單就會指向一個不存在的檔案
           → 學生端會出現「找不到這份試卷」。 */
        jobs.push(GitHub.write(base + '/' + quiz.id + '.json', quiz, 'publish quiz: ' + quiz.title)
          .then(function () {
            return GitHub.readJSON(base + '/index.json', []).then(function (idx) {
              idx = Array.isArray(idx) ? idx : [];
              var m = metaOf(quiz, 'published');
              var i = idx.findIndex(function (x) { return x && x.id === quiz.id; });
              if (i >= 0) idx[i] = m; else idx.push(m);
              return GitHub.write(base + '/index.json', idx, 'publish index: ' + quiz.title);
            });
          })
          .then(function () {
            /* 自我檢查：清單裡真的要有這份試卷，否則寧可報錯也不要「假成功」 */
            return GitHub.readJSON(base + '/index.json', []).then(function (idx) {
              var found = (idx || []).some(function (x) { return x && x.id === quiz.id; });
              if (!found) throw new Error('試卷清單沒有寫入成功，請再按一次「發佈」');
            });
          }));
      }
      if (!jobs.length) {
        quiz.published = wasPublished;
        return Promise.reject(new Error('請先設定 Firebase 或 GitHub（老師專區 → ⑤ 資料與同步）'));
      }
      return Promise.all(jobs).then(function () {
        return Store.quiz.save(quiz);
      }).then(function () {
        /* 重新發佈＝復活。不撤掉墓碑的話，這份試卷會被自己的墓碑藏起來，
           變成「發佈成功卻在清單裡找不到」——比原本的 bug 更難查。 */
        return Tomb.unmark(quiz.id).catch(function () { return null; });
      }).then(function () { return true; })
        .catch(function (e) {
          quiz.published = wasPublished;      // 發佈失敗 → 不要留下已發佈的假狀態
          throw e;
        });
    },

    /**
     * 刪除試卷。
     * 本機一定刪除；GitHub / Firebase 為 best-effort（失敗也不擋本機），
     * **但失敗的原因要留下來**（res.githubError），否則老師只看到一句無解的「刪除失敗」。
     * @param {string} id
     * @param {Object} opt { cloud:bool, github:bool }  是否連雲端 / repo 一起刪
     * @returns {Promise<{ok:boolean, github:?boolean, githubError:?string, cloud:?boolean}>}
     */
    deleteQuiz: function (id, opt) {
      opt = opt || {};
      var res = {
        ok: false, pending: false,
        github: null, githubError: null, githubNote: null,
        cloud: null, cloudError: null, cloudNote: null, indexPruned: null
      };

      /* ① 先立墓碑。
         這是「按了刪除就一定不再出現在清單上」的保證：遠端萬一清不掉，
         墓碑會留著（pending:true），清單就不會再冒出那一列——
         舊版是因為遠端（雲端清單／repo index）還留著，清單就一直有它。 */
      var tombJob = Tomb.mark(id).catch(function () { return null; });

      var localJob = Store.quiz.del(id)
        .then(function () { res.ok = true; })
        .catch(function (e) {
          res.ok = false;
          /* 本機都刪不掉 → 撤掉墓碑，否則會「藏住」一份其實沒被刪掉的試卷 */
          return Tomb.unmark(id).catch(function () { }).then(function () { throw e; });
        });
      var jobs = [tombJob, localJob];

      /* ② 雲端。
         🔴 舊版條件寫死 `Firebase.ok()` → 用 Apps Script 當雲端的老師根本不會進來刪，
            雲端副本留著、清單就一直有那一列。現在兩種通道都處理。 */
      if (opt.cloud && (Firebase.ok() || Hook.ok())) {
        /* sheetType／keys：Apps Script 那條路要用（Sheet 的主鍵是合成字串，且舊版可能寫成 quiz） */
        jobs.push(Cloud.del('quizzes', id, {
          sheetType: 'quiz',
          keys: [String(id), 'quiz::' + String(id), 'quizzes::' + String(id)]
        })
          .then(function () {
            res.cloud = true;
            if (!Firebase.ok()) return true;   /* Apps Script：整列刪掉，沒有清單要修 */
            /* 🔴 Firebase 另有一份 quizzesIndex（publishQuiz 寫的，也是 _cloudIndex 優先讀的來源）。
               舊版只刪了試卷本體、沒動清單 → 那份試卷永遠留在「試卷管理」。
               這正是使用者回報的「按了刪除還顯示」。 */
            return Firebase.get('quizzesIndex').catch(function () { return null; }).then(function (j) {
              var idx = arrayify(j, 'quizzesIndex');
              if (!idx.length) return true;
              var next = idx.filter(function (m) { return !m || m.id !== id; });
              if (next.length === idx.length) { res.indexPruned = false; return true; }
              return Firebase.put('quizzesIndex', next)
                /* 寫完回讀確認，不要製造「以為刪掉了」的假象 */
                .then(function () { return Firebase.get('quizzesIndex').catch(function () { return null; }); })
                .then(function (again) {
                  var still = arrayify(again, 'quizzesIndex').some(function (m) { return m && m.id === id; });
                  if (still) throw new Error('雲端清單更新失敗（試卷可能還會出現在清單裡）');
                  res.indexPruned = true;
                  return true;
                });
            });
          })
          .catch(function (e) {
            res.cloud = false;
            res.cloudError = (e && e.message) || String(e);
            return false;
          }));
      } else if (opt.cloud) {
        /* 沒有雲端可清不算失敗（可能本來就只存在本機），所以留 null、不要變成 pending */
        res.cloudNote = '沒有設定雲端，沒有雲端副本需要清';
      }

      if (opt.github && GitHub.ok()) {
        var base = (Settings.get().gh.path || 'data') + '/quizzes';
        jobs.push(
          GitHub.remove(base + '/' + id + '.json', 'delete quiz: ' + id)
            .then(function (r) {
              /* r === false → 檔案本來就不在 repo（沒東西可刪，視為成功） */
              res.github = (r === false) ? true : !!r;
              if (r === false) res.githubNote = 'repo 上本來就沒有這個檔案';
              return GitHub.readJSON(base + '/index.json', []).then(function (idx) {
                if (!Array.isArray(idx)) return true;
                var next = idx.filter(function (m) { return m.id !== id; });
                if (next.length === idx.length) return true;
                return GitHub.write(base + '/index.json', next, 'remove from index: ' + id);
              });
            })
            .catch(function (e) {
              res.github = false;
              res.githubError = (e && e.message) || String(e);
              return false;
            })
        );
      } else if (opt.github && !GitHub.ok()) {
        /* 沒設定 GitHub 時，「這份試卷到底有沒有線上副本」只有呼叫端知道
           （老師端看得到 published／_repo）→ 由 opt.onGithub 決定要不要當成待處理。 */
        if (opt.onGithub) {
          res.github = false;
          res.githubError = '尚未設定 GitHub（缺少擁有者／repo／Token）';
        } else {
          res.githubNote = '沒有設定 GitHub，這份試卷也沒有線上副本';
        }
      }

      return Promise.all(jobs).then(function () {
        /* 只有「真的嘗試過卻失敗」才算殘留。
           沒設定某個通道 ≠ 失敗，否則會留下一堆永遠清不掉的待處理紀錄。 */
        res.pending = (res.cloud === false || res.github === false);
        /* 遠端也清乾淨了 → 墓碑結案；還有殘留 → 留著（清單才不會再冒出那一列） */
        return (res.pending ? Promise.resolve(true) : Tomb.resolve(id))
          .catch(function () { return null; })
          .then(function () { return res; });
      });
    },

    /** 已刪除、但遠端（雲端／repo）還沒清乾淨的試卷。給 UI 顯示與清掃用。 */
    pendingDeletes: function () {
      return Tomb.list().then(function (l) {
        return l.filter(function (x) { return x.pending; });
      }).catch(function () { return []; });
    },

    /**
     * 修復「線上殘留檔」：把 repo 上存在、但**清單已經沒有**的試卷檔掃出來並刪掉。
     * 老師刪除試卷時 GitHub 若失敗，檔案就會留在 repo 裡沒人管（幽靈檔）。
     *
     * ⚠️ 安全設計：只刪「清單裡確實沒有」的檔案，且一定保留 index.json 本身。
     *    「本機沒有」有四種可能，但「**清單也沒有**」就沒有模糊空間了
     *    —— 清單是學生端列試卷的唯一來源，不在清單裡的檔案學生永遠看不到。
     *
     * @param {Object} opt { dryRun:bool }  dryRun=true 只回報不刪除（預設 true）
     * @returns {Promise<{ok:boolean, indexCount:number, fileCount:number,
     *                    orphans:Array<{id,name,size}>, removed:number, errors:Array}>}
     */
    repairRepo: function (opt) {
      opt = opt || {};
      var dryRun = opt.dryRun !== false;
      if (!GitHub.ok()) return Promise.reject(new Error('尚未設定 GitHub（缺少擁有者／repo／Token）'));
      var base = (Settings.get().gh.path || 'data') + '/quizzes';
      return GitHub.readJSON(base + '/index.json', []).then(function (idx) {
        idx = Array.isArray(idx) ? idx : [];
        var known = {};
        idx.forEach(function (m) { if (m && m.id) known[m.id] = true; });
        return GitHub.listDetailed(base).then(function (files) {
          var orphans = files.filter(function (f) {
            if (f.name === 'index.json') return false;          // 清單本身永遠保留
            if (!/\.json$/i.test(f.name)) return false;
            var id = f.name.replace(/\.json$/i, '');
            return !known[id];
          }).map(function (f) {
            return { id: f.name.replace(/\.json$/i, ''), name: f.name, size: f.size, path: f.path };
          });

          if (dryRun || !orphans.length) {
            return { ok: true, dryRun: dryRun, indexCount: idx.length, fileCount: files.length,
              orphans: orphans, removed: 0, errors: [] };
          }
          /* 逐一刪除（GitHub Contents API 一次只能刪一個檔） */
          var removed = 0, errors = [], removedIds = [];
          return orphans.reduce(function (p, o) {
            return p.then(function () {
              return GitHub.remove(o.path, 'cleanup orphan quiz: ' + o.id)
                .then(function () { removed++; removedIds.push(o.id); })
                .catch(function (e) { errors.push({ id: o.id, error: (e && e.message) || String(e) }); });
            });
          }, Promise.resolve())
            /* 殘留檔真的清掉了 → 對應的墓碑也可以結案，
               否則「N 份還沒清乾淨」會永遠掛在清單上，變成狼來了。 */
            .then(function () { return Tomb.forget(removedIds).catch(function () { return null; }); })
            .then(function () {
              return { ok: true, dryRun: false, indexCount: idx.length, fileCount: files.length,
                orphans: orphans, removed: removed, errors: errors };
            });
        });
      });
    },

    pullQuizzes: function () {
      if (!GitHub.ok()) return Promise.reject(new Error('請先設定 GitHub'));
      var base = (Settings.get().gh.path || 'data') + '/quizzes';
      return GitHub.readJSON(base + '/index.json', []).then(function (idx) {
        return idx.reduce(function (acc, m) {
          return acc.then(function (n) {
            return GitHub.readJSON(base + '/' + m.id + '.json', null).then(function (q) {
              if (!q) return n;
              return Store.quiz.save(q).then(function () { return n + 1; });
            });
          });
        }, Promise.resolve(0));
      });
    },

    /* ---------- 學生名冊 ---------- */
    /**
     * 學生名冊：**三個通道全部合併**（repo 的 roster.json + 雲端 + 本機）。
     * 一定要查 repo：學生在自己的 iPad／手機登入時，那台裝置沒有老師的
     * Firebase 設定、也沒有本機名冊，唯一讀得到的就是 repo 的 roster.json
     * （老師用舊版「只寫 Firebase、沒按發佈」時，學生就會看到「帳號不存在」）。
     */
    getRoster: function () {
      var local = Store.roster.all().catch(function () { return []; });
      var cloud = (Firebase.ok() || Hook.ok())
        ? Cloud.getAll('register').catch(function () { return []; })
        : Promise.resolve([]);
      var repo = Published.roster().catch(function () { return []; });
      return Promise.all([local, cloud, repo]).then(function (r) {
        var map = {};
        function put(x) {
          if (!x || !x.username) return;
          var k = String(x.username).toLowerCase();
          map[k] = Object.assign({}, map[k], x);
        }
        (r[2] || []).forEach(put);                                  /* repo（最舊） */
        (r[1] || []).forEach(function (rec) { put(rec.payload || rec); });  /* 雲端 */
        (r[0] || []).forEach(put);                                  /* 本機（最新） */
        return Object.keys(map).map(function (k) { return map[k]; });
      });
    },

    /* ---------- Google 帳號綁定 ---------- */
    /**
     * 用 Google UID 找回名冊學生。找不到回 null（＝還沒綁定）。
     * 名冊本身很小，直接掃描即可，不必另開一份索引節點（少一份要同步的資料）。
     */
    findByGoogleUid: function (uid) {
      if (!uid) return Promise.resolve(null);
      return Backend.getRoster().then(function (list) {
        return list.filter(function (s) { return s && s.googleUid === uid; })[0] || null;
      });
    },

    /** 只用 email 找回學生（老師事先在名冊填了 email 時，可自動對上） */
    findByEmail: function (email) {
      var e = String(email || '').trim().toLowerCase();
      if (!e) return Promise.resolve(null);
      return Backend.getRoster().then(function (list) {
        return list.filter(function (s) {
          return s && String(s.email || '').trim().toLowerCase() === e;
        })[0] || null;
      });
    },

    /**
     * 依 Google 登入資料找出這位學生（**同一個 Email 視為同一位使用者**）。
     * 順序：① 已綁定的 uid → ② 名冊上登記的同一個 email → ③ 沒有。
     * ② 只在「那個 email 還沒被別的 Google 帳號綁走」時才回傳，
     *   否則會把兩個人的作答混在一起。
     */
    resolveGoogleStudent: function (p) {
      p = p || {};
      if (!p.uid && !p.email) return Promise.resolve(null);
      return Backend.getRoster().then(function (list) {
        var byUid = list.filter(function (s) { return s && p.uid && s.googleUid === p.uid; })[0];
        if (byUid) return byUid;
        var e = String(p.email || '').trim().toLowerCase();
        if (!e) return null;
        var byMail = list.filter(function (s) {
          return s && String(s.email || '').trim().toLowerCase() === e;
        })[0];
        if (!byMail) return null;
        /* 這個 email 已經綁到別的 Google 帳號（UID 不同）→ 不能用，交給老師處理 */
        if (byMail.googleUid && p.uid && byMail.googleUid !== p.uid) return null;
        return byMail;
      });
    },

    /** 這個 email 是不是已經被「名冊上另一位學生」登記走了 */
    emailTakenBy: function (email, studentId) {
      var e = String(email || '').trim().toLowerCase();
      if (!e) return Promise.resolve(null);
      return Backend.getRoster().then(function (list) {
        return list.filter(function (s) {
          return s && s.id !== studentId && String(s.email || '').trim().toLowerCase() === e;
        })[0] || null;
      });
    },

    /**
     * 把 Google 帳號綁到某位學生。
     * ★ 身分正規化：綁定後學生的身分**永遠**是名冊的 stu_xxx，
     *   不是 Google UID —— 否則 `sub::<quizId>::<studentId>` 這條鍵會變，
     *   既有作答與批改全部對不上。
     * ★ 一個 Google 帳號只能綁一位學生；反過來一位學生也只能有一個 Google 帳號。
     */
    bindGoogle: function (studentId, info) {
      info = info || {};
      var uid = info.uid;
      if (!uid) return Promise.reject(new Error('沒有取得 Google 帳號識別碼'));
      return Backend.getRoster().then(function (list) {
        var taken = list.filter(function (s) { return s && s.googleUid === uid && s.id !== studentId; })[0];
        if (taken) {
          throw new Error('這個 Google 帳號已經綁定給「' + (taken.name || taken.username) + '」了');
        }
        var stu = findStudent(list, studentId);
        if (!stu) throw new Error('找不到這位學生');

        var email = String(info.email || '').trim().toLowerCase();
        if (email) {
          var owner = list.filter(function (s) {
            return s && s.id !== studentId && String(s.email || '').trim().toLowerCase() === email;
          })[0];
          if (owner) {
            throw new Error('這個電子郵件已經登記給「' + (owner.name || owner.username) + '」了，'
              + '請老師先處理，或改用「從名單選自己」');
          }
        }

        stu.googleUid = uid;
        stu.email = email || stu.email || '';
        stu.googleName = info.name || '';
        stu.loginMethods = uniq((stu.loginMethods || ['password']).concat(['google']));
        stu.boundAt = U.nowISO();
        return Backend.saveStudent(stu).then(function () {
          /* 綁定後把 uid → 學生 的對應寫進雲端一小段時間（很短，換裝置時靠它接上）。
             寫不進去不影響綁定本身：名冊才是事實來源。 */
          return ACCT.remember(uid, stu.id).catch(function () { return false; })
            .then(function () { return stu; });
        });
      });
    },

    /** 依 Google UID 濃縮比對名冊（大小寫／空白／易混字元不影響） */
    findByGoogleUidLoose: function (uid) {
      var u = String(uid || '');
      if (!u) return Promise.resolve(null);
      return Backend.getRoster().then(function (list) {
        return list.filter(function (s) { return s && ACCT.same(s.googleUid, u); })[0] || null;
      });
    },

    /** 解除綁定（學生換 Google 帳號、或 Google 帳號被別人撿走時用） */
    unbindGoogle: function (studentId) {
      return Backend.getRoster().then(function (list) {
        var stu = findStudent(list, studentId);
        if (!stu) throw new Error('找不到這位學生');
        var oldUid = stu.googleUid;
        delete stu.googleUid;
        delete stu.email;
        delete stu.googleName;
        delete stu.boundAt;
        stu.loginMethods = uniq((stu.loginMethods || []).filter(function (m) { return m !== 'google'; }));
        if (!stu.loginMethods.length) stu.loginMethods = ['password'];
        return Backend.saveStudent(stu).then(function () {
          /* 一併清掉雲端那條短效對應，否則解除後那個 Google 帳號還能接回來 */
          return (oldUid ? ACCT.forget(oldUid, stu.id) : Promise.resolve(true))
            .catch(function () { return true; })
            .then(function () { return stu; });
        });
      });
    },

    /**
     * 指派判定（含班別）。老師端與學生端共用同一份規則，
     * 否則會出現「老師以為指派了、學生端看不到」。
     * student 可傳 session（{id, className}）或名冊紀錄。
     */
    isAssigned: function (meta, student) {
      var a = meta && meta.assignment;
      if (!a) return false;
      if (a.all) return true;
      var sid = student && student.id;
      if (sid && (a.ids || []).indexOf(sid) >= 0) return true;
      var cls = U.trim(studentClass(student));
      return !!(cls && (a.classes || []).indexOf(cls) >= 0);
    },

    /** 指派給這位學生時，是用哪一種方式命中的（老師端除錯／顯示用） */
    assignReason: function (meta, student) {
      var a = meta && meta.assignment;
      if (!a) return '';
      if (a.all) return '全班';
      var sid = student && student.id;
      if (sid && (a.ids || []).indexOf(sid) >= 0) return '指定個人';
      var cls = U.trim(studentClass(student));
      if (cls && (a.classes || []).indexOf(cls) >= 0) return '班別 ' + cls;
      return '';
    },

    /** 修改學生的班別（指派作業要按班別分組時的前提） */
    setStudentClass: function (studentId, className) {
      return Backend.getRoster().then(function (list) {
        var stu = findStudent(list, studentId);
        if (!stu) throw new Error('找不到這位學生');
        stu.className = U.trim(className || '');
        return Backend.saveStudent(stu).then(function () { return stu; });
      });
    },

    /** 名冊裡所有出現過的班別（指派對話框分組用） */
    classNames: function (list) {
      var seen = {};
      (list || []).forEach(function (s) {
        var c = U.trim((s && s.className) || '');
        if (c) seen[c] = 1;
      });
      return Object.keys(seen).sort();
    },

    /** 把合併後的名冊同步到「雲端 + repo」，讓任何裝置都拿得到同樣的帳號 */
    syncRoster: function () {
      return Backend.getRoster().then(function (list) {
        var r = { count: list.length, channels: 0, errors: [] };
        var jobs = [];
        if (Firebase.ok() || Hook.ok()) {
          jobs.push(list.reduce(function (acc, s) {
            return acc.then(function () {
              return Cloud.put(makeRec('register', s.username, null, s, { classCode: s.classCode || '' }));
            });
          }, Promise.resolve(true))
            .then(function () { r.channels++; })
            .catch(function (e) { r.errors.push('雲端：' + ((e && e.message) || e)); }));
        }
        if (GitHub.ok()) {
          /* repo 是公開檔案 → 寫出去前先移除 email（見 publicRoster 說明） */
          jobs.push(GitHub.write((Settings.get().gh.path || 'data') + '/roster.json',
            publicRoster(list), 'sync roster')
            .then(function () { r.channels++; })
            .catch(function (e) { r.errors.push('repo：' + ((e && e.message) || e)); }));
        }
        return Promise.all(jobs).then(function () {
          /* 一個通道都沒成功 → 明確報錯。否則老師會以為同步完成，
             實際上學生什麼都讀不到（先前「找不到此帳號」的成因之一）。 */
          if (!r.channels) throw new Error(r.errors.length ? r.errors.join('；') : '尚未設定任何雲端或 GitHub');
          /* repo 是學生跨裝置唯一讀得到的通道 → 它失敗要單獨提醒 */
          var repoFailed = r.errors.some(function (x) { return x.indexOf('repo：') === 0; });
          r.repoFailed = repoFailed;
          return r;
        });
      });
    },

    /* ---------- 公開執行設定（讓學生裝置／其他電腦自動完成設定） ---------- */
    _cfgPromise: null,

    /**
     * 讀取 repo 的 data/config.json 並套用到本機設定。
     * Firebase 的 Web API Key 與 Database URL 本來就是公開資訊
     * （安全性靠 Realtime Database 規則），所以可以安全地放在這裡，
     * 這樣學生用 iPad 登入時不必手動設定任何東西。
     */
    loadConfig: function () {
      if (Backend._cfgPromise) return Backend._cfgPromise;
      Backend._cfgPromise = Published._fetch('config.json').then(function (c) {
        if (!c) return null;
        var s = Settings.get(), patch = {}, pfb = {};
        var fb = c.firebase || {};
        var cur = s.fb || {};

        /* 缺什麼補什麼：不覆蓋這台裝置已經填好的值（老師自己的設定優先）。
           舊版要求「三個欄位都齊、且本機全空」才套用 → classCode 一空就整組失效。 */
        if (fb.dbUrl && !cur.dbUrl) pfb.dbUrl = fb.dbUrl;
        if (fb.apiKey && !cur.apiKey) pfb.apiKey = fb.apiKey;
        if (!cur.classCode) pfb.classCode = fb.classCode || 'default';
        /* authDomain 只給 Google 登入用；缺席時學生登入頁就不顯示 Google 按鈕 */
        if (fb.authDomain && !cur.authDomain) pfb.authDomain = fb.authDomain;
        if (pfb.dbUrl || pfb.apiKey || pfb.authDomain) { pfb.enabled = true; patch.fb = pfb; }

        var hk = c.hook || {};
        if (hk.postUrl && !(s.hook || {}).postUrl) patch.hook = { postUrl: hk.postUrl };

        /* 班級代碼：學生裝置本來就拿不到（那是老師在自己電腦上填的），
           但「Google 綁定頁 → 從名單選自己」需要它當門檻，所以要一起發佈。
           它不是密碼（學生本來就會被告知），真正的防線是老師可以隨時解除綁定。 */
        if (c.classCode && !s.classCode) patch.classCode = c.classCode;

        /* 公開政策：學生端要跟老師端一致（這些值只存在各自的 localStorage，
           不同步的話會出現「老師開放全部、學生只看到指派」這類不一致）。
           老師自己的電腦有 GitHub Token → 尊重本機設定，不被 repo 覆蓋。 */
        var isTeacherDevice = !!(s.gh && s.gh.token);
        if (!isTeacherDevice && c.policy) {
          var pol = {};
          var pkeys = (Settings.POLICY_KEYS && Object.keys(Settings.POLICY_KEYS)) || [
            'assignOnly', 'showAnswerAfterSubmit', 'allowRetake', 'enableHighlight',
            'allowSelfRegister'
          ];
          var hosted = {};
          pkeys.forEach(function (k) { if (c.policy[k] != null) hosted[k] = c.policy[k]; });
          if (Object.keys(hosted).length) {
            /* 政策開關跟雲端設定不同：它們是「老師在老師端調的班級規則」，
               所以一律以**已發佈的值**為準（不然老師改了，學生端永遠沒反應）。
               但這台裝置如果自己動過手、且明確表態過 — 例如老師用同一台電腦看學生視角 —
               就尊重本機，避免把老師自己的設定悄悄改掉。 */
            var basePol = Object.assign({}, Settings.get().policy);
            pkeys.forEach(function (k) {
              if (hosted[k] == null) return;
              if (Settings.hasPolicy && Settings.hasPolicy(k)) return;  /* 本機表態過 → 不覆蓋 */
              basePol[k] = hosted[k];
            });
            patch.policy = basePol;
          }
        }
        Backend._publishedPolicy = c.policy || null;
        Backend._publishedConfig = c;
        if (Object.keys(patch).length) Settings.set(patch);
        return c;
      }).catch(function () { return null; });
      return Backend._cfgPromise;
    },

    /* 最近一次讀到的公開設定（設定頁用來比對「本機 vs 已發佈」） */
    _publishedConfig: null,
    _publishedPolicy: null,

    /**
     * 取「有效政策」：以**已發佈的公開政策**為準，本機設定只是後備。
     *
     * 為什麼不能直接讀 Settings.get().assignOnly：
     * 那是這台裝置 localStorage 的值。學生裝置是可以被改的（開 devtools 就能改），
     * 而「學生是否看得到所有試卷」正是我們最不希望由學生端決定的開關。
     * repo 的 data/config.json 由老師端發佈，學生只能讀、改不動 → 那才是權威來源。
     *
     * 老師自己的電腦（有 GitHub Token）仍然以本機設定為準，這樣老師改完政策
     * 可以立刻在自己的電腦上預覽效果，不必等 repo 更新。
     */
    policy: function (key) {
      var pub = Backend._publishedPolicy;
      var isTeacherDevice = !!(Settings.get().gh || {}).token;
      if (!isTeacherDevice && pub && pub[key] != null) {
        return pub[key];
      }
      return Settings.policy(key);
    },

    /** 把目前的雲端設定寫進 repo 的 data/config.json（老師端專用） */
    publishConfig: function () {
      if (!GitHub.ok()) return Promise.reject(new Error('請先設定 GitHub（老師專區 → ⑤ 資料與同步）'));
      var s = Settings.get();
      var fb = s.fb || {}, hk = s.hook || {};
      var path = (s.gh.path || 'data') + '/config.json';
      return GitHub.readJSON(path, {}).catch(function () { return {}; }).then(function (cur) {
        var cfg = Object.assign({}, cur || {});
        cfg.site = cfg.site || '閱讀理解練習站';
        cfg.version = 1;
        cfg.quizDir = 'data/quizzes';
        cfg.rosterPath = 'data/roster.json';
        cfg.firebase = {
          dbUrl: fb.dbUrl || '', apiKey: fb.apiKey || '',
          /* 一定要寫出「實際使用的命名空間」，否則學生裝置會落到不同節點，
             兩邊各寫各的 → 看起來像「有同步但看不到對方」。 */
          classCode: fb.classCode || 'default',
          /* Google 登入必需；沒發佈的話學生端登入頁不會出現 Google 按鈕。
             本機沒填時沿用已發佈的值，避免「從別台電腦按發佈」就把設定抹掉。 */
          authDomain: fb.authDomain || ((cur || {}).firebase || {}).authDomain || ''
        };
        cfg.hook = { postUrl: hk.postUrl || '' };
        /* 公開的班級代碼：Google 綁定頁用它當「從名單選自己」的門檻。
           注意它與 firebase.classCode 是兩件事：前者是自助註冊的門檻，
           後者是雲端資料的**命名空間**，不該混用同一個欄位。 */
        cfg.classCode = s.classCode || ((cur || {}).classCode) || '';
        cfg.classCodeIsNamespace = false;
        /* 政策：一律從 policy 這個單一來源寫出，不要再各自算預設值 */
        cfg.policy = Object.assign({}, Settings.policy());
        cfg.updatedAt = U.nowISO();
        return GitHub.write(path, cfg, 'publish public config');
      }).then(function () {
        Backend._publishedConfig = null;    /* 下次再讀一次，不要留舊值 */
        return true;
      });
    },

    /**
     * 設定的一致性盤點：本機值、已發佈的公開設定、實際生效的定義
     * 三者逐一比對，把「不一致」直接講出來（而不是讓人自己猜）。
     */
    configAudit: function () {
      var s = Settings.get();
      var fb = s.fb || {}, pub = Backend._publishedConfig;
      var rows = [];
      function row(name, local, remote, hint) {
        var same = (remote == null) ? null : (String(local) === String(remote));
        rows.push({
          name: name, local: local, remote: remote == null ? '(尚未讀到)' : remote,
          ok: same !== false, hint: hint || ''
        });
      }
      row('資料命名空間 firebase.classCode', fb.classCode || 'default',
        pub && pub.firebase ? (pub.firebase.classCode || 'default') : null,
        '所有裝置必須相同，否則各寫各的節點');
      row('Firebase Database URL', fb.dbUrl || '(未設定)',
        pub && pub.firebase ? (pub.firebase.dbUrl || '(未設定)') : null, '');
      row('Google 授權網域 authDomain', fb.authDomain || '(未設定)',
        pub && pub.firebase ? (pub.firebase.authDomain || '(未設定)') : null,
        '未填 → 學生登入頁不會出現 Google 按鈕');
      row('自助註冊門檻 classCode', s.classCode || '(未設定)',
        pub ? (pub.classCode || '(未設定)') : null,
        '這與上面的命名空間是兩件事');
      row('收集端網址 hook.postUrl', (s.hook || {}).postUrl || '(未設定)',
        pub && pub.hook ? (pub.hook.postUrl || '(未設定)') : null, '');
      /* 政策：有效值只有 Settings.policy() 一個來源，遠端來自已發佈的 config.json。
         這裡刻意只比「本機 vs 已發佈」，因為「預設值」不是第三份定義 ——
         它就是 POLICY_KEYS 本身，不再另外算一次。 */
      var pol = Settings.policy();
      Object.keys(pol).forEach(function (k) {
        var remote = (pub && pub.policy && pub.policy[k] != null) ? String(pub.policy[k]) : null;
        row('政策 ' + k, String(pol[k]), remote, '');
      });
      return rows;
    },

    saveStudent: function (stu) { return Backend.registerStudent(stu, true); },

    /** 註冊／建立學生帳號（force=true 表示老師建立，略過班級代碼檢查） */
    registerStudent: function (stu, force) {
      var jobs = [Store.roster.save(stu)];
      var rec = makeRec('register', stu.username, null, stu, {
        classCode: stu.classCode || ''
      });
      if (Firebase.ok() || Hook.ok()) {
        jobs.push(Cloud.put(rec).catch(function (e) {
          if (!force) throw e;
          return true;
        }));
      } else if (!force) {
        /* 沒有雲端也要能註冊（只存在老師這台） */
      }
      return Promise.all(jobs).then(function () {
        /* 自動同步名冊：新增／匯入後立刻寫進雲端與 repo，
           學生在任何裝置登入都找得到帳號（不必再手動按「發佈到 GitHub」）。
           老師操作（force）時等同步完成，學生自助註冊時背景進行。 */
        if (force) return Backend.syncRoster().then(function () { return stu; })
          .catch(function () { return stu; });
        Backend.syncRoster().catch(function () { });
        return stu;
      });
    },

    publishRoster: function (list) {
      var jobs = [];
      if (Firebase.ok() || Hook.ok()) {
        jobs.push(list.reduce(function (acc, s) {
          return acc.then(function () {
            return Cloud.put(makeRec('register', s.username, null, s, { classCode: s.classCode || '' }));
          });
        }, Promise.resolve(true)));
      }
      if (GitHub.ok()) {
        jobs.push(GitHub.write((Settings.get().gh.path || 'data') + '/roster.json',
          publicRoster(list), 'update roster'));
      }
      if (!jobs.length) return Promise.reject(new Error('請先設定雲端或 GitHub'));
      return Promise.all(jobs).then(function () { return true; });
    },

    /* ---------- 作答草稿（進度雲端同步） ---------- */
    /**
     * 草稿的鍵同樣要綁「帳號」而不是「裝置」：學生在 iPad 做到一半、
     * 回家用電腦接著做，靠的就是這一步。草稿很小（只有目前這一題），
     * 所以直接各寫一列，讀取時只問自己那幾筆。
     */
    saveDraft: function (sub) {
      var key = 'draft:' + sub.quizId + ':' + sub.studentId;
      sub.savedAt = U.nowISO();
      var jobs = [Store.kv.set(key, sub)];
      if (Firebase.ok() || Hook.ok()) {
        jobs.push(Backend.syncKeys(sub.studentId).then(function (ctx) {
          var claim = ctx.claim || sub.studentId;
          sub._acct = claim;
          return Cloud.put(makeRec('draft', claim, sub.quizId, sub));
        }));
      }
      return Promise.all(jobs).then(function () { return true; })
        .catch(function () { return true; });   /* 草稿寫不上去不必嚇使用者 */
    },

    getDraft: function (quizId, studentId) {
      var local = Store.kv.get('draft:' + quizId + ':' + studentId, null);
      if (Cloud.driver() === 'offline') return local;
      var remote = Backend.syncKeys(studentId).then(function (ctx) {
        var ids = [ctx.claim].concat(ctx.ids).filter(Boolean);
        var hit = null;
        return ids.reduce(function (acc, id) {
          return acc.then(function () {
            if (hit) return null;
            return Cloud.get('draft', ACCT.key(id + '::' + quizId)).then(function (rec) {
              var d = rec && (rec.payload || rec);
              if (d && d.quizId === quizId) hit = d;
            }).catch(function () { });
          });
        }, Promise.resolve()).then(function () { return hit; });
      }).catch(function () { return null; });
      return Promise.all([local, remote]).then(function (r) {
        var a = r[0], b = r[1];
        if (!a) return b; if (!b) return a;
        return (String(b.savedAt || '') > String(a.savedAt || '')) ? b : a;
      });
    },

    clearDraft: function (quizId, studentId) {
      var jobs = [Store.kv.set('draft:' + quizId + ':' + studentId, null)];
      if (Firebase.ok()) {
        jobs.push(Backend.syncKeys(studentId).then(function (ctx) {
          var ids = [ctx.claim].concat(ctx.ids).filter(Boolean);
          return Promise.all(ids.map(function (id) {
            return Cloud.del('draft', ACCT.key(id + '::' + quizId)).catch(function () { return false; });
          }));
        }));
      }
      return Promise.all(jobs).then(function () { return true; });
    },

    /* ---------- 作答 ---------- */
    /**
     * 作答要「同一份試卷在任何裝置都落在同一格」。
     * 雲端真正的鍵由**名冊的 studentId** 決定；本機則看
     * 「哪一個名冊身分在這台裝置登入過」，避免換裝置後又新增一筆。
     */
    syncKeys: function (studentId) {
      var listP = Backend.getRoster().catch(function () { return []; });
      return listP.then(function (list) {
        var ids = (list || []).map(function (s) { return s.id; }).filter(Boolean);
        var claim = (studentId && ids.indexOf(studentId) >= 0) ? studentId : '';
        if (!claim) {
          return Store.kv.get('acct:' + studentId, null).then(function (v) {
            claim = (v && ids.indexOf(v) >= 0) ? v : (studentId || '');
            return finish(ids, claim);
          });
        }
        return finish(ids, claim);
      });

      function finish(ids, claim) {
        return {
          ids: ids,
          claim: claim,
          scope: studentId,
          keys: ids.map(function (i) { return ADDR.acctKey(i, studentId); })
        };
      }
    },

    /**
     * 讀取作答：雲端一筆一筆問（各筆很小），最後才在本機合併。
     * 因此一位學生只會下載**他自己**那幾筆，不會因為人數變多而變慢；
     * 愈新的作答放愈前面，先命中最新的就少問幾次。
     */
    _cloudSubs: function (studentId) {
      return Backend.getRoster().catch(function () { return []; }).then(function (list) {
        var ids = (list || []).map(function (s) { return s.id; }).filter(Boolean);
        if (!ids.length) return [];
        var keys = ids.map(function (id) { return ACCT.key('sub::' + studentId + '::' + id); });
        var found = [];
        /* 由新到舊找：最新的那筆幾乎都在最前面，平均只問一兩次 */
        return keys.reduce(function (acc, k) {
          return acc.then(function () {
            return Cloud.get('submission', k).then(function (rec) {
              if (rec) {
                var s = rec.payload || rec;
                if (s && s.quizId) found.push(s);
              }
            }).catch(function () { });
          });
        }, Promise.resolve()).then(function () { return found; });
      });
    },

    saveSubmission: function (sub) {
      return Store.submission.save(sub).then(function (s) {
        if (Firebase.ok() || Hook.ok()) {
          var finalId = s.id;
          return Backend.syncKeys(s.studentId).then(function (ctx) {
            /* 老師批改過的紀錄不能被學生的舊作答覆蓋：
               有釋出、或分數已給，就以雲端為主，這裡只補上教師欄位。 */
            return Backend.getSubmission(s.quizId, s.studentId).then(function (prev) {
              var merged = s;
              if (prev && (prev.released || (prev.score && prev.score.total != null && !prev.auto))) {
                merged = Object.assign({}, s, {
                  released: prev.released, releasedAt: prev.releasedAt, release: prev.release,
                  marks: prev.marks, score: prev.score, gradedAt: prev.gradedAt, gradedBy: prev.gradedBy
                });
              }
              merged._acct = ctx.claim;
              /* 雲端欄位名由「帳號」決定 → 同一份試卷在任何裝置都落在同一格 */
              merged.id = 'sub::' + s.quizId + '::' + (ctx.claim || s.studentId);
              finalId = merged.id;
              return Cloud.put(makeRec('submission', s.quizId, ctx.claim || s.studentId, merged));
            }).then(function () {
              s._synced = Cloud.lastWritten || Cloud.driver();
              delete s._pending; delete s._syncError;
              /* 本機的 id 也要一起換成同一把鍵，否則這台裝置上會留著
                 一筆舊 id 的作答，下次合併時就變兩份。 */
              if (finalId && finalId !== s.id) {
                return Store.submission.del(s.id).then(function () {
                  s.id = finalId;
                  return true;
                });
              }
              return true;
            }).catch(function (e) { s._syncError = e.message; s._pending = true; })
              .then(function () { return Store.submission.save(s); });
          });
        }
        if (Settings.get().submitMode === 'github' && GitHub.ok()) {
          var p2 = (Settings.get().gh.path || 'data') + '/submissions/' +
            safeKey(s.quizId) + '/' + safeKey(s.studentId) + '.json';
          return GitHub.write(p2, s, 'submission: ' + (s.studentName || s.studentId))
            .then(function () { s._synced = 'github'; delete s._pending; })
            .catch(function (e) { s._syncError = e.message; s._pending = true; })
            .then(function () { return Store.submission.save(s); });
        }
        s._synced = 'local';
        return Store.submission.save(s);
      });
    },

    listSubmissions: function (quizId) {
      var jobs = [Store.submission.all().catch(function () { return []; }), Backend._cloudSubs('')];
      if (Settings.get().submitMode === 'github' && GitHub.ok()) {
        jobs.push(Backend._ghSubmissions(quizId).catch(function () { return []; }));
      }
      return Promise.all(jobs).then(function (g) {
        var map = {};
        function add(s) {
          if (!s || !s.id) return;
          /* 同一份試卷可能有多次作答（allowRetake）；預設只留最新一次，
             但重考次數的統計要靠 attempt，所以鍵要含 attempt。 */
          var key = s.quizId + '::' + s.studentId;
          var old = map[key];
          if (!old) { map[key] = s; return; }
          /* 老師批改過／已釋出的那筆優先，其次比時間 */
          var oldDone = !!(old.released || (old.score && old.score.total != null && !old.auto));
          var newDone = !!(s.released || (s.score && s.score.total != null && !s.auto));
          if (newDone && !oldDone) { map[key] = s; return; }
          if (oldDone && !newDone) return;
          if (String(s.submittedAt || '') > String(old.submittedAt || '')) map[key] = s;
        }
        (g[0] || []).forEach(add);
        (g[1] || []).forEach(add);
        (g[2] || []).forEach(add);
        var out = Object.keys(map).map(function (k) { return map[k]; });
        if (quizId) out = out.filter(function (s) { return s.quizId === quizId; });
        return out.sort(function (a, b) {
          return String(b.submittedAt || '').localeCompare(String(a.submittedAt || ''));
        });
      });
    },

    /**
     * 從雲端取作答：欄位名是「雜湊過的」，所以要用名冊的 id 清單反推。
     * 一位學生最多問名冊人數次，每次只抓他自己那一格（不是整份資料）。
     * 先問「這台裝置登入過的那個身分」，命中率最高。
     */
    getSubmissionCloud: function (quizId, studentId) {
      if (!(Firebase.ok() || Hook.ok())) return Promise.resolve(null);
      return Backend.getRoster().catch(function () { return []; }).then(function (list) {
        var ids = (list || []).map(function (s) { return s.id; }).filter(Boolean);
        if (!ids.length) return null;
        var keys = [ACCT.key('sub::' + studentId + '::' + studentId)]
          .concat(ids.filter(function (i) { return i !== studentId; })
            .map(function (i) { return ACCT.key('sub::' + studentId + '::' + i); }));
        var hit = null;
        return keys.reduce(function (acc, k) {
          return acc.then(function () {
            if (hit) return null;
            return Cloud.get('submission', k).then(function (rec) {
              var s = rec && (rec.payload || rec);
              if (s && s.quizId === quizId) hit = s;
            }).catch(function () { });
          });
        }, Promise.resolve()).then(function () { return hit; });
      });
    },

    /** 取某學生某份試卷的最新作答：合併本機與雲端，雲端（含老師批改）優先 */
    getSubmission: function (quizId, studentId) {
      var localP = Store.submission.ofStudent(studentId).then(function (list) {
        return (list || []).filter(function (s) { return s.quizId === quizId; })
          .sort(function (a, b) { return String(b.submittedAt || '').localeCompare(String(a.submittedAt || '')); })[0] || null;
      }).catch(function () { return null; });
      var cloudP = (Firebase.ok() || Hook.ok())
        ? Backend.getSubmissionCloud(quizId, studentId)
        : Promise.resolve(null);
      return Promise.all([localP, cloudP]).then(function (r) {
        var loc = r[0], cloud = r[1];
        if (!loc) return cloud;
        if (!cloud) return loc;
        var merged = Object.assign({}, loc, cloud);
        var ans = {};
        Object.keys(loc.answers || {}).concat(Object.keys(cloud.answers || {})).forEach(function (k) {
          ans[k] = Object.assign({}, (loc.answers || {})[k], (cloud.answers || {})[k]);
        });
        merged.answers = ans;
        merged.score = Object.assign({}, loc.score, cloud.score);
        merged.id = loc.id;
        merged.submittedAt = loc.submittedAt || cloud.submittedAt;
        return merged;
      });
    },

    /**
     * 某學生的所有作答（本機 + 雲端合併）。
     * 學生專區本來只讀本機，換裝置就看不到自己的作答與生詞本，
     * 這裡把雲端（老師批改過的）一起併進來，同一份取「較新／已批改」者。
     */
    mySubmissions: function (studentId) {
      return Promise.all([
        Store.submission.ofStudent(studentId).catch(function () { return []; }),
        Backend._cloudSubs(studentId).catch(function () { return []; })
      ]).then(function (r) {
        var map = {};
        function add(s) {
          if (!s || !s.id || !s.quizId) return;
          var cur = map[s.id];
          if (!cur) { map[s.id] = s; return; }
          var newer = String(s.submittedAt || '') >= String(cur.submittedAt || '') ? s : cur;
          var older = newer === s ? cur : s;
          var merged = Object.assign({}, older, newer);
          merged.answers = Object.assign({}, older.answers || {}, newer.answers || {});
          merged.marks = (newer.marks || []).length ? newer.marks : (older.marks || []);
          merged.vocab = (newer.vocab || []).length ? newer.vocab : (older.vocab || []);
          merged.notes = (newer.notes || []).length ? newer.notes : (older.notes || []);
          if (older.score || newer.score) merged.score = Object.assign({}, older.score, newer.score);
          merged.id = cur.id;
          map[s.id] = merged;
        }
        (r[0] || []).forEach(add);
        (r[1] || []).forEach(add);
        return Object.keys(map).map(function (k) { return map[k]; })
          .sort(function (a, b) { return String(b.submittedAt || '').localeCompare(String(a.submittedAt || '')); });
      });
    },

    /**
     * 某學生的作答草稿（本機 kv + 雲端）。
     * 學生在作答途中按「加入生詞本」，此時還沒有 submission，
     * 生詞只存在草稿裡 —— 要讀草稿才看得到。
     */
    myDrafts: function (studentId) {
      var loc = Store.all('kv').catch(function () { return []; }).then(function (rows) {
        var suffix = ':' + studentId;
        return (rows || []).filter(function (r) {
          return r && /^draft:/.test(String(r.id || '')) && String(r.id).slice(-suffix.length) === suffix && r.value;
        }).map(function (r) { return r.value; });
      });
      /* 雲端草稿的欄位名是「帳號::試卷」，所以要逐一試名冊上的每個身分 */
      var cloud = Backend.getRoster().catch(function () { return []; }).then(function (list) {
        var ids = (list || []).map(function (s) { return s.id; }).filter(Boolean);
        if (!ids.length) return [];
        ids = [studentId].concat(ids.filter(function (i) { return i !== studentId; }));
        var found = [];
        return ids.reduce(function (acc, id) {
          return acc.then(function () {
            return Cloud.getAllOf('draft', ACCT.key(id + '::')).then(function (list2) {
              (list2 || []).forEach(function (rec) {
                var d = rec && (rec.payload || rec);
                if (d && d.quizId) found.push(d);
              });
            }).catch(function () { });
          });
        }, Promise.resolve()).then(function () { return found; });
      });
      return Promise.all([loc, cloud]).then(function (r) {
        var map = {};
        (r[0] || []).concat(r[1] || []).forEach(function (d) {
          if (!d || !d.quizId) return;
          var k = d.quizId;
          if (!map[k] || String(d.savedAt || '') > String(map[k].savedAt || '')) map[k] = d;
        });
        return Object.keys(map).map(function (k) { return map[k]; });
      });
    },

    /** 生詞本：合併「已提交」與「作答中草稿」收集到的生詞（雲端一起） */
    myVocab: function (studentId) {
      return Promise.all([
        Backend.mySubmissions(studentId).catch(function () { return []; }),
        Backend.myDrafts(studentId).catch(function () { return []; })
      ]).then(function (r) {
        var map = {};
        function eat(list) {
          (list || []).forEach(function (s) {
            ((s && s.vocab) || []).forEach(function (v) {
              if (!v || !U.trim(v.word || '')) return;
              var w = U.trim(v.word);
              if (!map[w]) map[w] = Object.assign({}, v, { word: w });
              else {
                if (!map[w].note && v.note) map[w].note = v.note;
                /* 任何一筆標成「已學會」就算已學會（完成默寫後才會有） */
                if (v.learned) map[w].learned = true;
              }
            });
          });
        }
        eat(r[0]); eat(r[1]);
        return Object.keys(map).map(function (k) { return map[k]; })
          .sort(function (a, b) { return String(b.ts || '').localeCompare(String(a.ts || '')); });
      });
    },

    /* ---------- 默寫範圍（老師出題用；學生唯讀） ----------
       為什麼用「一位學生一筆清單」而不是「一個詞一筆」：
       默寫範圍是老師手上的一張清單，會反覆批次新增／批次刪除。
       整包存成一筆，讀取只要一次、也不會產生大量孤兒記錄。
       鍵綁「帳號」（同草稿的作法），換裝置才看得到同一份清單。 */

    /** 本機暫存鍵 */
    _dictKey: function (studentId) { return 'dictation:' + studentId; },

    /** 某位學生的默寫範圍（本機 + 雲端合併，取較新者） */
    getDictation: function (studentId) {
      var sid = String(studentId || '');
      if (!sid) return Promise.resolve(Backend._normDict('', null));
      var local = Store.kv.get(Backend._dictKey(sid), null).catch(function () { return null; });

      var remote = Promise.resolve(null);
      if (Cloud.driver() !== 'offline') {
        remote = Backend.syncKeys(sid).then(function (ctx) {
          var ids = [ctx.claim].concat(ctx.ids).filter(Boolean);
          var hit = null;
          return ids.reduce(function (acc, id) {
            return acc.then(function () {
              if (hit) return null;
              return Cloud.get('dictation', ACCT.key(id)).then(function (rec) {
                var d = rec && (rec.payload || rec);
                if (d && Array.isArray(d.items)) hit = d;
              }).catch(function () { });
            });
          }, Promise.resolve()).then(function () { return hit; });
        }).catch(function () { return null; });
      }

      return Promise.all([local, remote]).then(function (r) {
        var a = r[0], b = r[1];
        var pick = (!a) ? b : (!b ? a : ((String(b.savedAt || '') > String(a.savedAt || '')) ? b : a));
        return Backend._normDict(sid, pick);
      });
    },

    /** 補齊欄位，讓 UI 不必到處防呆 */
    _normDict: function (studentId, d) {
      var items = ((d && d.items) || []).filter(function (it) {
        return it && U.trim(it.word || '');
      }).map(function (it) {
        return {
          word: U.trim(it.word),
          note: it.note || '',
          source: it.source || '',            /* 來自哪份試卷／文章 */
          addedAt: it.addedAt || it.ts || '',
          done: !!it.done                     /* 老師勾「已完成」 */
        };
      });
      return {
        studentId: studentId,
        items: items,
        savedAt: (d && d.savedAt) || '',
        _pending: !!(d && d._pending)
      };
    },

    /**
     * 覆寫某位學生的默寫範圍（整包寫入）。
     * 資料一致性靠「同一個鍵反覆覆寫」：加入與刪除都走這裡，
     * 所以重新整理或換裝置讀到的都是最後一次寫入的結果。
     */
    saveDictation: function (studentId, items) {
      var sid = String(studentId || '');
      if (!sid) return Promise.reject(new Error('缺少學生 id'));
      var doc = {
        studentId: sid,
        items: (items || []).filter(function (it) { return it && U.trim(it.word || ''); })
          .map(function (it) {
            return {
              word: U.trim(it.word), note: it.note || '',
              source: it.source || '', addedAt: it.addedAt || U.nowISO(), done: !!it.done
            };
          }),
        savedAt: U.nowISO()
      };
      var jobs = [Store.kv.set(Backend._dictKey(sid), doc)];

      if (Firebase.ok() || Hook.ok()) {
        jobs.push(Backend.syncKeys(sid).then(function (ctx) {
          var claim = ctx.claim || sid;
          return Cloud.put(makeRec('dictation', claim, null, doc));
        }));
      }
      return Promise.all(jobs).then(function () { return doc; })
        .catch(function (e) {
          /* 雲端失敗不能靜默：標記待補送，讓老師知道還沒同步出去 */
          doc._pending = true;
          Store.kv.set(Backend._dictKey(sid), doc);
          Cloud.lastError = (e && e.message) || String(e);
          return doc;
        });
    },

    /** 批次加入（重複的詞不重複加；保留原有的 done 狀態） */
    addToDictation: function (studentId, words) {
      return Backend.getDictation(studentId).then(function (cur) {
        var have = {};
        cur.items.forEach(function (it) { have[it.word] = it; });
        (words || []).forEach(function (w) {
          var word = U.trim((w && w.word) || w || '');
          if (!word || have[word]) return;
          have[word] = {
            word: word, note: (w && w.note) || '',
            source: (w && w.source) || '', addedAt: U.nowISO(), done: false
          };
        });
        return Backend.saveDictation(studentId, Object.keys(have).map(function (k) { return have[k]; }));
      });
    },

    /** 批次移除（只動默寫範圍；回傳被移除的詞，讓呼叫端去更新生詞本的學會狀態） */
    removeFromDictation: function (studentId, words) {
      var kill = {};
      (words || []).forEach(function (w) {
        var word = U.trim((w && w.word) || w || '');
        if (word) kill[word] = 1;
      });
      return Backend.getDictation(studentId).then(function (cur) {
        var removed = cur.items.filter(function (it) { return kill[it.word]; });
        var left = cur.items.filter(function (it) { return !kill[it.word]; });
        return Backend.saveDictation(studentId, left).then(function (doc) {
          doc.removed = removed;
          return doc;
        });
      });
    },

    /**
     * 把生詞標記為「已學會／未學會」。
     * 生詞散在 submission 與 draft 的 vocab 陣列裡，所以要逐筆改寫；
     * 找不到對應項時視為已是最新（不報錯）。
     */
    setVocabLearned: function (studentId, words, learned) {
      var set = {};
      (words || []).forEach(function (w) {
        var word = U.trim((w && w.word) || w || '');
        if (word) set[word] = 1;
      });
      if (!Object.keys(set).length) return Promise.resolve(0);

      function patchList(list) {
        return (list || []).reduce(function (acc, rec) {
          if (!rec || !(rec.vocab || []).length) return acc;
          var hit = false;
          rec.vocab.forEach(function (v) {
            if (v && set[U.trim(v.word || '')]) { v.learned = !!learned; hit = true; }
          });
          if (!hit) return acc;
          /* 草稿走 saveDraft、作答走 saveSubmission，兩者都會寫本機＋雲端 */
          var isDraft = rec.type === 'draft' || (!rec.score && rec.savedAt && !rec.submittedAt);
          return acc.then(function () {
            return isDraft ? Backend.saveDraft(rec) : Backend.saveSubmission(rec);
          });
        }, Promise.resolve(0));
      }

      return Promise.all([
        Backend.mySubmissions(studentId).catch(function () { return []; }),
        Backend.myDrafts(studentId).catch(function () { return []; })
      ]).then(function (r) {
        return patchList(r[0]).then(function () { return patchList(r[1]); });
      }).then(function () { return true; });
    },

    _ghSubmissions: function (quizId) {      var base = (Settings.get().gh.path || 'data') + '/submissions';
      var p = quizId ? Promise.resolve([quizId]) : GitHub.list(base).catch(function () { return []; });
      return p.then(function (list) {
        return list.reduce(function (acc, d) {
          return acc.then(function (arr) {
            return GitHub.list(base + '/' + d).catch(function () { return []; }).then(function (files) {
              return files.filter(function (f) { return /\.json$/.test(f); })
                .reduce(function (a2, f) {
                  return a2.then(function (arr2) {
                    return GitHub.readJSON(base + '/' + d + '/' + f, null)
                      .then(function (s) { if (s) arr2.push(s); return arr2; });
                  });
                }, Promise.resolve(arr));
            });
          });
        }, Promise.resolve([]));
      });
    },

    retryPending: function () {
      return Store.all('submissions').then(function (list) {
        var pend = list.filter(function (s) { return s._pending; });
        return pend.reduce(function (acc, s) {
          return acc.then(function (n) {
            return Backend.saveSubmission(s).then(function (x) { return n + (x._pending ? 0 : 1); });
          });
        }, Promise.resolve(0));
      });
    },

    /**
     * 雲端自我診斷：把「這台裝置」的每一條同步通道逐一實測，回傳可讀報告。
     * 為什麼需要它：同步跨越多個通道，任一節壞掉都不會報錯、只會「看起來沒資料」；
     * 而且設定存在各裝置的 localStorage，必須在**每一台裝置**各跑一次，
     * 並比對「命名空間 base」是否相同——不同就會各寫各的、永遠看不到對方。
     */
    diagnose: function () {
      var rep = { at: U.nowISO(), items: [], counts: {}, base: '', driver: '', device: '' };
      function add(name, ok, detail) {
        rep.items.push({ name: name, ok: !!ok, detail: detail == null ? '' : String(detail) });
      }
      var fb = Firebase.cfg();
      var gh = Settings.get().gh || {};

      rep.driver = Cloud.driver();
      rep.base = Firebase.base();
      rep.device = (function () {
        var w = Settings.who();
        return (w && (w.name || w.username)) ? (w.name || w.username) : '未登入';
      })();

      return Store.ready()
        .then(function () { return Store.kv.set('diag', { at: rep.at }); })
        .then(function () { return Store.kv.get('diag', null); })
        .then(function (v) { add('本機儲存（IndexedDB）', !!(v && v.at), '可讀可寫'); })
        .catch(function (e) { add('本機儲存（IndexedDB）', false, (e && e.message) || e); })

        .then(function () { return Backend.loadConfig(); })
        .then(function (c) {
          add('公開設定 data/config.json',
            !!(c && (((c.firebase || {}).dbUrl) || ((c.hook || {}).postUrl))),
            c ? ('Firebase ' + ((c.firebase || {}).dbUrl ? '有' : '無') +
                 '／Apps Script ' + ((c.hook || {}).postUrl ? '有' : '無') +
                 (c.updatedAt ? '　更新於 ' + String(c.updatedAt).slice(0, 16).replace('T', ' ') : ''))
              : '讀不到（尚未發佈，或網站路徑不是站台根目錄）');
          return null;
        })

        .then(function () {
          var missing = [];
          if (!fb.dbUrl) missing.push('Database URL');
          if (!fb.apiKey) missing.push('Web API Key');
          add('Firebase 設定', Firebase.ok(),
            Firebase.ok()
              ? ('命名空間 ' + Firebase.base() + (fb.classCode ? '' : '（班級代碼未填，自動使用 default）'))
              : ('未設定齊備：缺 ' + missing.join('、')));
        })

        .then(function () {
          /* Google 登入與資料庫是兩條獨立的路：這裡只檢查「設定齊不齊」，
             真正的登入測試要在瀏覽器裡按按鈕才知道（診斷頁無法代替點擊）。 */
          var g = GoogleAuth.cfg();
          var okG = GoogleAuth.available();
          add('Google 帳號登入設定', okG,
            okG
              ? ('authDomain ' + g.authDomain + '　→ 仍需在 Firebase Console 開通 Google 供應商並加入授權網域')
              : '未設定 authDomain → 學生登入頁不會出現「使用 Google 登入」按鈕');
          return null;
        })

        .then(function () {
          if (!Firebase.ok()) { add('Firebase 匿名登入', false, '略過（設定不齊備）'); return null; }
          return Firebase.signIn()
            .then(function () { add('Firebase 匿名登入', true, '已取得 idToken'); })
            .catch(function (e) { add('Firebase 匿名登入', false, (e && e.message) || e); })
            .then(function () {
              return Firebase.put('meta/diag', { at: rep.at, device: rep.device })
                .then(function () { add('Firebase 寫入', true, '已寫入 meta/diag'); })
                .catch(function (e) { add('Firebase 寫入', false, (e && e.message) || e); });
            })
            .then(function () {
              return Firebase.getStrict('meta/diag')
                .then(function (v) {
                  add('Firebase 讀取', !!(v && v.at),
                    (v && v.at) ? ('讀回 ' + v.at) : '讀不到（請檢查 Realtime Database 規則）');
                })
                .catch(function (e) { add('Firebase 讀取', false, (e && e.message) || e); });
            });
        })

        .then(function () {
          /* 報告要看「實際有效」的通道：Firebase 設定了但不通，
             就必須講明已退回 Apps Script，而不是照 driver() 回報 firebase。 */
          var fbFailed = rep.items.some(function (x) {
            return /^Firebase (匿名登入|寫入|讀取)$/.test(x.name) && !x.ok;
          });
          var eff = Cloud.driver();
          if (eff === 'firebase' && fbFailed) {
            eff = Hook.ok() ? 'appscript（Firebase 不通，已自動退回）'
                            : 'offline（Firebase 不通且無備援）';
          }
          add('實際使用的雲端通道', eff.indexOf('offline') !== 0,
            eff + (Cloud.lastError ? '　上次錯誤：' + Cloud.lastError : ''));
          if (!Hook.ok()) return null;
          return Hook.live(null).then(function (live) {
            add('Apps Script 通道', live !== null,
              live === null ? '即時讀取被擋（CORS）；會退回 CSV 快取，可能延遲 0–5 分鐘'
                            : ('即時讀取 OK，' + (live ? live.length : 0) + ' 筆'));
          }).catch(function (e) { add('Apps Script 通道', false, (e && e.message) || e); });
        })

        .then(function () {
          add('GitHub 設定（老師發佈用）', GitHub.ok(),
            GitHub.ok() ? (gh.owner + '/' + gh.repo + ' @' + (gh.branch || 'main') + '　路徑 ' + (gh.path || 'data'))
                        : '未設定或未填 Token → 無法發佈試卷／同步名冊到 repo');
          if (!GitHub.ok()) return null;
          return GitHub.readJSON((gh.path || 'data') + '/roster.json', null)
            .then(function (r) {
              add('GitHub 讀取（repo 名冊）', Array.isArray(r),
                Array.isArray(r) ? (r.length + ' 筆') : '讀不到');
            })
            .catch(function (e) { add('GitHub 讀取（repo 名冊）', false, (e && e.message) || e); });
        })

        .then(function () {
          /* 帳號型同步：作答與草稿的雲端欄位名是「帳號」算出來的，
             所以同一份試卷在 iPad 與電腦上會落在同一格。
             這裡驗算一次，順便確認名冊讀得到（算不出鍵＝根本同步不了）。 */
          return Promise.all([
            Backend.getRoster().catch(function () { return []; }),
            Backend.syncKeys((Settings.who() || {}).id || '')
          ]).then(function (r) {
            var n = r[0].length, k = r[1].keys.length;
            add('帳號型同步鍵（跨裝置同一份作答）', n > 0 && k === n,
              n ? ('以 ' + n + ' 位學生的名冊算出 ' + k + ' 把鍵；'
                + '目前身分 ' + (r[1].claim || '未登入')) : '名冊是空的 → 無法計算同步鍵');
            return null;
          });
        })

        .then(function () {
          /* 設定一致性：本機值與已發佈的公開設定必須相同，
             否則不同裝置會拿到不同行為（例如老師開放、學生仍被擋）。 */
          var rows = Backend.configAudit();
          var bad = rows.filter(function (x) { return !x.ok; });
          var known = rows.filter(function (x) { return String(x.remote) !== '(尚未讀到)'; });
          add('設定一致性（本機 vs 已發佈）', bad.length === 0,
            known.length
              ? (bad.length ? (bad.length + ' 項不一致：' + bad.map(function (x) { return x.name; }).join('、'))
                            : ('比對 ' + known.length + ' 項，全部一致'))
              : '尚未讀到已發佈的公開設定（可先發佈一次）');
          return null;
        })

        .then(function () {
          return Published._fetch('roster.json').then(function (r) {
            add('網站檔案讀取（學生端唯一通道）', Array.isArray(r),
              Array.isArray(r) ? (r.length + ' 筆名冊') : '讀不到（尚未發佈名冊）');
          }).catch(function (e) {
            add('網站檔案讀取（學生端唯一通道）', false, (e && e.message) || e);
          });
        })

        .then(function () {
          return Promise.all([
            Backend.getRoster().catch(function () { return []; }),
            Store.roster.all().catch(function () { return []; }),
            Cloud.getAll('register').catch(function () { return []; }),
            Published.roster().catch(function () { return []; })
          ]).then(function (r) {
            rep.counts.roster = r[0].length;
            add('名冊（三通道合併）', r[0].length > 0,
              '合併後 ' + r[0].length + ' 人　＝　本機 ' + r[1].length +
              '＋雲端 ' + r[2].length + '＋repo ' + r[3].length);
            return null;
          });
        })

        .then(function () {
          return Promise.all([
            Backend.listQuizzes().catch(function () { return []; }),
            Backend.listSubmissions().catch(function () { return []; })
          ]).then(function (r) {
            var q = r[0], subs = r[1];
            var pend = subs.filter(function (x) { return x._pending; }).length;
            rep.counts.quizzes = q.length;
            rep.counts.submissions = subs.length;
            add('試卷清單（本機＋repo＋雲端）', q.length > 0, q.length + ' 份');
            add('作答紀錄（本機＋雲端）', pend === 0,
              subs.length + ' 筆' + (pend ? '，其中 ' + pend + ' 筆尚未同步成功' : ''));
            return null;
          });
        })

        .then(function () {
          rep.okCount = rep.items.filter(function (x) { return x.ok; }).length;
          rep.badCount = rep.items.length - rep.okCount;
          return rep;
        });
    },

    /** 把診斷報告轉成可複製的純文字 */
    diagText: function (rep) {
      var L = [];
      L.push('閱讀理解練習站 · 雲端自我診斷');
      L.push('時間 ' + String(rep.at || '').replace('T', ' ').slice(0, 19));
      L.push('裝置身分 ' + rep.device + '　雲端通道 ' + rep.driver);
      L.push('命名空間 ' + rep.base + '　（跨裝置必須相同）');
      L.push('----');
      (rep.items || []).forEach(function (it) {
        L.push((it.ok ? '[OK]  ' : '[!!]  ') + it.name + (it.detail ? '　→ ' + it.detail : ''));
      });
      L.push('----');
      L.push('通過 ' + rep.okCount + ' / 失敗 ' + rep.badCount);
      return L.join('\n');
    },

    archiveSubmissions: function (quizId) {
      if (!GitHub.ok()) return Promise.reject(new Error('請先設定 GitHub'));
      return Store.submission.all().then(function (list) {
        var sel = quizId ? list.filter(function (s) { return s.quizId === quizId; }) : list;
        var base = (Settings.get().gh.path || 'data') + '/submissions';
        return sel.reduce(function (acc, s) {
          return acc.then(function (n) {
            return GitHub.write(base + '/' + safeKey(s.quizId) + '/' + safeKey(s.studentId) + '.json', s,
              'archive: ' + (s.studentName || s.studentId)).then(function () { return n + 1; });
          });
        }, Promise.resolve(0));
      });
    }
  };

  RQ.backend = Backend;
  RQ.googleAuth = GoogleAuth;
})(window.RQ);
