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

  /* ============================================================
     驅動 A：Firebase Realtime Database
     ============================================================ */
  var Firebase = {
    cfg: function () { return Settings.get().fb || {}; },
    ok: function () {
      var c = Firebase.cfg();
      return !!(c.enabled && c.dbUrl && c.apiKey && c.classCode);
    },
    base: function () {
      return 'rq/' + encodeURIComponent(safeKey((Firebase.cfg().classCode || 'default')));
    },
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
        if (j.error) throw new Error((j.error && j.error.message) || '匿名登入失敗');
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
    put: function (p, val) {
      if (!Firebase.ok()) return Promise.reject(new Error('尚未設定 Firebase'));
      return Firebase.signIn().then(function (t) {
        return fetch(Firebase._url(Firebase.path(p), t), {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(val)
        });
      }).then(function (r) { if (!r.ok) throw new Error('Firebase 寫入失敗 ' + r.status); return true; });
    },
    del: function (p) {
      if (!Firebase.ok()) return Promise.resolve(true);
      return Firebase.signIn().then(function (t) {
        return fetch(Firebase._url(Firebase.path(p), t), { method: 'DELETE' });
      }).then(function () { return true; }).catch(function () { return false; });
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

    driver: function () {
      if (Firebase.ok()) return 'firebase';
      if (Hook.ok()) return 'appscript';
      return 'offline';
    },

    put: function (rec) {
      if (Firebase.ok()) {
        rec.id = safeKey(rec.id);
        return Firebase.put(rec.type + '/' + rec.id, rec);
      }
      if (Hook.ok()) return Hook.post(rec);
      return Promise.reject(new Error('尚未設定雲端（Firebase 或收集端網址）'));
    },

    /**
     * 取出某一類的所有記錄（陣列）。
     * Apps Script 路徑：先試 /exec 即時讀取，讀不到再用「發佈成 CSV」。
     * CSV 是 Google 快取的，通常延遲 0–5 分鐘 — 所以要把來源回報給 UI。
     */
    getAll: function (type) {
      if (Firebase.ok()) {
        return Firebase.get(type).then(function (o) {
          Cloud.lastSource = 'firebase';
          Cloud.lastReadAt = U.nowISO();
          if (!o) return [];
          return Object.keys(o).map(function (k) { return o[k]; }).filter(Boolean);
        });
      }
      if (Hook.ok()) {
        return Hook.live(type).then(function (live) {
          if (live !== null) {                   // 即時讀取成功（即使是空陣列）
            Cloud.lastSource = 'live';
            Cloud.lastReadAt = U.nowISO();
            return live;
          }
          return Hook.csv().then(function (rows) {
            Cloud.lastSource = 'csv';            // 走快取，可能延遲
            Cloud.lastReadAt = U.nowISO();
            return rows;
          });
        }).then(function (all) {
          return (all || []).filter(function (r) { return !type || r.type === type; });
        });
      }
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

    del: function (type, id) {
      if (Firebase.ok()) return Firebase.del(type + '/' + safeKey(id));
      return Promise.resolve(true);
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

    /** 刪除檔案（要先取 sha） */
    remove: function (path, message) {
      if (!GitHub.ok()) return Promise.reject(new Error('尚未設定 GitHub'));
      var c = GitHub.cfg();
      return GitHub.read(path).then(function (cur) {
        if (!cur) return false;                       // 本來就沒有
        return GitHub.api('/repos/' + c.owner + '/' + c.repo + '/contents/' + path, {
          method: 'DELETE',
          body: { message: message || ('remove ' + path), sha: cur.sha, branch: c.branch || 'main' }
        }).then(function () { return true; });
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
    index: function () { return Published._fetch('quizzes/index.json').then(function (j) { return j || []; }); },
    quiz: function (id) { return Published._fetch('quizzes/' + encodeURIComponent(id) + '.json'); },
    roster: function () { return Published._fetch('roster.json').then(function (j) { return j || []; }); }
  };

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
      if (Firebase.ok()) {
        return Firebase.get('quizzesIndex').then(function (j) {
          if (Array.isArray(j) && j.length) {
            return j.map(function (m) {
              return (m && m.id) ? Object.assign({}, m, { published: true, _src: 'cloud' }) : null;
            }).filter(Boolean);
          }
          return Cloud.getAll('quiz').then(function (list) { return (list || []).map(meta).filter(Boolean); });
        }).catch(function () { return []; });
      }
      if (Hook.ok()) {
        return Cloud.getAll('quiz').then(function (list) { return (list || []).map(meta).filter(Boolean); })
          .catch(function () { return []; });
      }
      return Promise.resolve([]);
    },

    listQuizzes: function () {
      return Promise.all([
        Store.quiz.all().catch(function () { return []; }),
        Published.index().catch(function () { return []; }),
        Backend._cloudIndex()
      ]).then(function (r) {
        var map = {};
        r[0].forEach(function (q) { map[q.id] = metaOf(q, 'local'); });
        (r[2] || []).forEach(function (m) {
          if (!m || !m.id) return;
          var cur = map[m.id];
          if (!cur) { map[m.id] = Object.assign({ _src: 'cloud', _cloud: true, published: true }, m); return; }
          cur._cloud = true;
          cur.published = true;
          if (cur._src === 'local') cur._src = 'both';
        });
        (r[1] || []).forEach(function (m) {
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
        return Object.keys(map).map(function (k) { return map[k]; })
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
      }).then(function () { return true; })
        .catch(function (e) {
          quiz.published = wasPublished;      // 發佈失敗 → 不要留下已發佈的假狀態
          throw e;
        });
    },

    /**
     * 刪除試卷。
     * 本機一定刪除；GitHub / Firebase 為 best-effort（失敗也不擋本機）。
     * @param {string} id
     * @param {Object} opt { cloud:bool, github:bool }  是否連雲端 / repo 一起刪
     * @returns {Promise<{ok:boolean, github:?boolean, cloud:?boolean}>}
     */
    deleteQuiz: function (id, opt) {
      opt = opt || {};
      var res = { ok: false, github: null, cloud: null };

      var localJob = Store.quiz.del(id)
        .then(function () { res.ok = true; })
        .catch(function (e) { res.ok = false; throw e; });
      var jobs = [localJob];

      if (opt.cloud && Firebase.ok()) {
        jobs.push(Cloud.del('quizzes', id)
          .then(function (r) { res.cloud = !!r; return r; })
          .catch(function () { res.cloud = false; return false; }));
      }

      if (opt.github && GitHub.ok()) {
        var base = (Settings.get().gh.path || 'data') + '/quizzes';
        jobs.push(
          GitHub.remove(base + '/' + id + '.json', 'delete quiz: ' + id)
            .then(function (r) {
              res.github = !!r;
              return GitHub.readJSON(base + '/index.json', []).then(function (idx) {
                var next = idx.filter(function (m) { return m.id !== id; });
                if (next.length === idx.length) return true;
                return GitHub.write(base + '/index.json', next, 'remove from index: ' + id);
              });
            })
            .catch(function () { res.github = false; return false; })
        );
      }

      return Promise.all(jobs).then(function () { return res; });
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

    /** 把合併後的名冊同步到「雲端 + repo」，讓任何裝置都拿得到同樣的帳號 */
    syncRoster: function () {
      return Backend.getRoster().then(function (list) {
        var jobs = [];
        if (Firebase.ok() || Hook.ok()) {
          jobs.push(list.reduce(function (acc, s) {
            return acc.then(function () {
              return Cloud.put(makeRec('register', s.username, null, s, { classCode: s.classCode || '' }));
            });
          }, Promise.resolve(true)));
        }
        if (GitHub.ok()) {
          jobs.push(GitHub.write((Settings.get().gh.path || 'data') + '/roster.json', list, 'sync roster'));
        }
        return Promise.all(jobs).then(function () {
          return { count: list.length, channels: jobs.length };
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
        var s = Settings.get(), patch = {};
        var fb = c.firebase || {};
        var cur = s.fb || {};
        if (fb.dbUrl && fb.apiKey && fb.classCode &&
            !(cur.dbUrl && cur.apiKey && cur.classCode)) {
          patch.fb = { enabled: true, dbUrl: fb.dbUrl, apiKey: fb.apiKey, classCode: fb.classCode };
        }
        var hk = c.hook || {};
        if (hk.postUrl && !(s.hook || {}).postUrl) patch.hook = { postUrl: hk.postUrl };
        if (Object.keys(patch).length) Settings.set(patch);
        return c;
      }).catch(function () { return null; });
      return Backend._cfgPromise;
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
        cfg.firebase = { dbUrl: fb.dbUrl || '', apiKey: fb.apiKey || '', classCode: fb.classCode || '' };
        cfg.hook = { postUrl: hk.postUrl || '' };
        cfg.updatedAt = U.nowISO();
        return GitHub.write(path, cfg, 'publish public config');
      }).then(function () { return true; });
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
        jobs.push(GitHub.write((Settings.get().gh.path || 'data') + '/roster.json', list, 'update roster'));
      }
      if (!jobs.length) return Promise.reject(new Error('請先設定雲端或 GitHub'));
      return Promise.all(jobs).then(function () { return true; });
    },

    /* ---------- 作答草稿（進度雲端同步） ---------- */
    saveDraft: function (sub) {
      var key = 'draft:' + sub.quizId + ':' + sub.studentId;
      sub.savedAt = U.nowISO();
      var jobs = [Store.kv.set(key, sub)];
      if (Firebase.ok() || Hook.ok()) {
        jobs.push(Cloud.put(makeRec('draft', sub.quizId, sub.studentId, sub)));
      }
      return Promise.all(jobs).then(function () { return true; });
    },

    getDraft: function (quizId, studentId) {
      var local = Store.kv.get('draft:' + quizId + ':' + studentId, null);
      if (Cloud.driver() === 'offline') return local;
      var remote = Cloud.get('draft', recId('draft', quizId, studentId))
        .then(function (rec) { return rec ? (rec.payload || rec) : null; })
        .catch(function () { return null; });
      return Promise.all([local, remote]).then(function (r) {
        var a = r[0], b = r[1];
        if (!a) return b; if (!b) return a;
        return (String(b.savedAt || '') > String(a.savedAt || '')) ? b : a;
      });
    },

    clearDraft: function (quizId, studentId) {
      var jobs = [Store.kv.set('draft:' + quizId + ':' + studentId, null)];
      if (Firebase.ok()) jobs.push(Cloud.del('draft', recId('draft', quizId, studentId)));
      return Promise.all(jobs).then(function () { return true; });
    },

    /* ---------- 作答 ---------- */
    saveSubmission: function (sub) {
      return Store.submission.save(sub).then(function (s) {
        if (Firebase.ok() || Hook.ok()) {
          return Cloud.put(makeRec('submission', s.quizId, s.studentId, s))
            .then(function () { s._synced = Cloud.driver(); delete s._pending; })
            .catch(function (e) { s._syncError = e.message; s._pending = true; })
            .then(function () { return Store.submission.save(s); });
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
      var jobs = [Store.submission.all().catch(function () { return []; }), Cloud.getAll('submission')];
      if (Settings.get().submitMode === 'github' && GitHub.ok()) {
        jobs.push(Backend._ghSubmissions(quizId).catch(function () { return []; }));
      }
      return Promise.all(jobs).then(function (g) {
        var map = {};
        function add(s) {
          if (!s || !s.id) return;
          var key = s.quizId + '::' + s.studentId + '::' + (s.attempt || 1);
          var old = map[key];
          if (!old || String(s.submittedAt || '') > String(old.submittedAt || '')) map[key] = s;
        }
        (g[0] || []).forEach(add);
        (g[1] || []).forEach(function (rec) { add(rec.payload || rec); });
        (g[2] || []).forEach(add);
        var out = Object.keys(map).map(function (k) { return map[k]; });
        if (quizId) out = out.filter(function (s) { return s.quizId === quizId; });
        return out.sort(function (a, b) {
          return String(b.submittedAt || '').localeCompare(String(a.submittedAt || ''));
        });
      });
    },

    /** 取某學生某份試卷的最新作答：合併本機與雲端，雲端（含老師批改）優先 */
    getSubmission: function (quizId, studentId) {
      var localP = Store.submission.ofStudent(studentId).then(function (list) {
        return (list || []).filter(function (s) { return s.quizId === quizId; })
          .sort(function (a, b) { return String(b.submittedAt || '').localeCompare(String(a.submittedAt || '')); })[0] || null;
      }).catch(function () { return null; });
      var cloudP = (Firebase.ok() || Hook.ok())
        ? Cloud.get('submission', recId('submission', quizId, studentId))
          .then(function (rec) { return rec && (rec.payload || rec); })
          .catch(function () { return null; })
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
        Cloud.getAll('submission').catch(function () { return []; })
      ]).then(function (r) {
        var map = {};
        function add(s) {
          if (!s || !s.id || !s.quizId) return;
          if (s.studentId != null && String(s.studentId) !== String(studentId)) return;
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
        (r[1] || []).forEach(function (rec) { add(rec && (rec.payload || rec)); });
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
      var cloud = Cloud.getAll('draft').catch(function () { return []; }).then(function (list) {
        return (list || []).map(function (rec) { return rec && (rec.payload || rec); })
          .filter(function (d) { return d && String(d.studentId) === String(studentId); });
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
              else if (!map[w].note && v.note) map[w].note = v.note;
            });
          });
        }
        eat(r[0]); eat(r[1]);
        return Object.keys(map).map(function (k) { return map[k]; })
          .sort(function (a, b) { return String(b.ts || '').localeCompare(String(a.ts || '')); });
      });
    },

    _ghSubmissions: function (quizId) {
      var base = (Settings.get().gh.path || 'data') + '/submissions';
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
})(window.RQ);
