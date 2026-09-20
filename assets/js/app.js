/* ============================================================
   app.js — 路由、首頁、共用設定頁
   路由： #/  #/student  #/quiz/:id  #/result/:id
         #/teacher[/tab]  #/edit/:id  #/settings
   ============================================================ */
(function (RQ) {
  'use strict';

  var U = RQ.util, Settings = RQ.settings, Store = RQ.store, Backend = RQ.backend;
  var view, whoEl;

  /* location.hash 會把非 ASCII 字元（例如中文試卷 id）轉成 percent-encoding，
     讀回來時是 %E4%B8%AD…，必須解碼才對得上真正的 id。 */
  function decodeSeg(s) {
    if (s == null) return s;
    try { return decodeURIComponent(s); } catch (e) { return s; }
  }

  function route() {
    var hash = location.hash.replace(/^#\/?/, '');
    var parts = hash.split('/').filter(function (x) { return x !== ''; }).map(decodeSeg);
    var page = parts[0] || 'home';
    var arg = parts[1] || null;

    U.$$('.nav-link').forEach(function (a) { a.classList.remove('active'); });
    var navKey = ({ home: 'home', student: 'student', teacher: 'teacher', settings: 'settings', quiz: 'student', result: 'student', edit: 'teacher' })[page];
    var navEl = U.$('.nav-link[data-route="' + navKey + '"]');
    if (navEl) navEl.classList.add('active');

    renderWho();
    view.scrollTop = 0;

    switch (page) {
      case 'home': home(); break;
      case 'student':
        var who = Settings.who();
        if (!who || who.role !== 'student') RQ.student.login(view);
        else RQ.student.home(view);
        break;
      case 'quiz': requireStudent(function () { RQ.student.take(view, arg); }); break;
      case 'result': requireStudent(function () { RQ.student.result(view, arg); }); break;
      case 'teacher': RQ.teacher.render(view, arg); break;
      case 'edit': requireTeacher(function () { RQ.teacher.edit(view, arg); }); break;
      case 'settings': settings(); break;
      default: home();
    }
  }

  function requireStudent(fn) {
    var who = Settings.who();
    if (!who || who.role !== 'student') { location.hash = '#/student'; return; }
    fn();
  }
  function requireTeacher(fn) {
    var who = Settings.who();
    if (!who || who.role !== 'teacher') { location.hash = '#/teacher'; return; }
    fn();
  }

  function renderWho() {
    var who = Settings.who();
    whoEl.innerHTML = '';
    if (!who) {
      /* 未登入時，導覽列本身就提供登入入口（手機版導覽列可橫向滑動，
         所以這裡也要能點到，不必先捲到頁面中間去找表單）。 */
      appendGoogleEntry(whoEl);
      whoEl.appendChild(U.el('a.btn.xs', { href: '#/student', text: '學生登入' }));
      whoEl.appendChild(U.el('a.btn.xs.ghost', { href: '#/teacher', text: '老師登入' }));
      return;
    }
    whoEl.appendChild(U.el('span.chip', {
      text: (who.role === 'teacher' ? '👩‍🏫 老師' : '🧒 ' + (who.name || '學生'))
    }));
    whoEl.appendChild(U.el('button.btn.xs.ghost', {
      text: '登出', onclick: function () {
        Settings.logout();
        /* 一併登出 Google：共用平板換人時，否則下一個人按 Google 登入會直接
           沿用上一個人的帳號。失敗不影響本站的登出。 */
        if (RQ.googleAuth) RQ.googleAuth.signOut().catch(function () { });
        U.toast('已登出');
        location.hash = '#/';
        renderWho();
        route();          /* hash 沒變就不會觸發 hashchange，這裡主動重畫一次 */
      }
    }));
  }

  /**
   * 導覽列的「使用 Google 登入」。與學生登入頁是**同一條流程**
   * （RQ.student.loginPage 內的入口），所以不會出現兩套行為不一致。
   * 沒設定 authDomain 時整顆按鈕不出現，導覽列不會多一個按不動的東西。
   */
  function appendGoogleEntry(host) {
    var G = RQ.googleAuth;
    if (!G || !G.available()) return;
    var b = U.el('button.btn.xs', {
      text: '使用 Google 登入', title: '使用 Google 帳號登入（學生）',
      style: { display: 'flex', alignItems: 'center', gap: '6px' },
      onclick: function () {
        b.disabled = true;
        U.toast('正在開啟 Google 登入…', null, 2000);
        /* 記住使用者原本在哪一頁，登入完導回原頁 */
        var back = location.hash && !/^#\/?$/.test(location.hash) &&
          !/^#\/student(\/login)?$/.test(location.hash) ? location.hash : '';
        if (back) { try { sessionStorage.setItem('rq_login_return', back); } catch (e) { } }
        G.signIn().then(function (p) {
          if (p && p.redirect) return;
          return RQ.student.loginGoogle(p);
        }).catch(function (e) {
          b.disabled = false;
          U.toast(G.errorText(e), 'bad', 6500);
        });
      }
    });
    host.appendChild(b);
  }

  /* ============================================================
     首頁
     ============================================================ */
  function home() {
    var who = Settings.who();
    view.innerHTML = '';

    view.appendChild(U.el('div.hero', {}, [
      U.el('img.hero-art', { src: 'assets/img/hero.svg', alt: '' }),
      U.el('div.hero-body', {}, [
        U.el('div.row', {}, [
          U.el('a.btn.primary', { href: '#/student', text: '開始作答' }),
          U.el('a.btn', { href: '#/teacher/upload', text: '上載試卷' }),
          U.el('a.btn.ghost', { href: '#/settings', text: '設定' })
        ])
      ])
    ]));

    /* 可用試卷 */
    var box = U.el('div.mt3');
    view.appendChild(box);
    Backend.listQuizzes().then(function (list) {
      box.innerHTML = '';
      box.appendChild(U.el('h2', { text: '可作答的試卷（' + list.length + '）' }));
      if (!list.length) {
        box.appendChild(U.el('div.empty', {}, [
          U.el('div.big', { text: '📚' }),
          U.el('small', { text: '目前沒有試卷' })
        ]));
        return;
      }
      var grid = U.el('div.grid.g3');
      list.forEach(function (m) {
        grid.appendChild(U.el('div.card.mb0', {}, [
          U.el('h3.mb0', { html: U.esc(m.title) }),
          U.el('div.tiny.muted.mt1', {
            text: (m.level ? m.level + '・' : '') + (m.subject ? m.subject + '・' : '') +
              (m.questionCount || 0) + ' 題・' + (m.totalMarks || 0) + ' 分'
          }),
          U.el('div.row.mt2', {}, [
            U.el('a.btn.sm.primary', { href: '#/quiz/' + m.id, text: '開始作答' })
          ])
        ]));
      });
      box.appendChild(grid);
    });
  }

  /* ============================================================
     設定頁（老師與學生共用）
     ============================================================ */
  function settings() {
    view.innerHTML = '';
    var s = Settings.get();
    var pol = Settings.policy();

    var card = U.el('div.card');
    card.appendChild(U.el('h2', { text: '設定' }));
    card.appendChild(U.el('div.infobox', {
      html: '這裡的開關是全站共用的<b>單一來源</b>（老師端的「② 試卷管理」、'
        + '「⑤ 資料與同步」也讀寫同一組值）。改完按「儲存並套用到所有裝置」，'
        + '學生在任何一台裝置開啟網站都會拿到同樣的設定。'
    }));

    var mode = U.el('select.input', { style: { maxWidth: '280px' } });
    [['offline', '只存本機（完全離線）'], ['github', '同步到 GitHub repo']].forEach(function (x) {
      mode.appendChild(U.el('option', { value: x[0], text: x[1] }));
    });
    mode.value = s.quizMode || 'offline';
    card.appendChild(U.el('div', {}, [U.el('label.tiny.muted', { text: '試卷存放方式' }), mode]));

    var hi = U.el('input', { type: 'checkbox' });
    hi.checked = pol.enableHighlight !== false;
    var ans = U.el('input', { type: 'checkbox' });
    ans.checked = pol.showAnswerAfterSubmit !== false;
    var rt = U.el('input', { type: 'checkbox' });
    rt.checked = !!pol.allowRetake;
    var ao = U.el('input', { type: 'checkbox' });
    ao.checked = pol.assignOnly !== false;

    card.appendChild(U.el('div.mt2', {},
      [
        [hi, '啟用螢光標示／筆記／生詞本'],
        [ans, '學生提交後可查看正確答案'],
        [rt, '允許學生重複作答同一份試卷'],
        [ao, '指派後學生才看得到試卷（未指派的不顯示）']
      ].map(function (x) {
        return U.el('label.check', { style: { display: 'flex', marginBottom: '6px' } }, [x[0], U.el('span', { text: x[1] })]);
      })
    ));

    card.appendChild(U.el('div.mt2.row', {}, [
      U.el('button.btn.primary.sm', {
        text: '儲存並套用到所有裝置', onclick: function () {
          Settings.set({ quizMode: mode.value });
          Settings.setPolicy({
            enableHighlight: hi.checked,
            showAnswerAfterSubmit: ans.checked,
            allowRetake: rt.checked,
            assignOnly: ao.checked
          });
          /* 只存本機的話，其他裝置永遠看不到 → 有 GitHub 就一併發佈 */
          Backend.publishConfig().then(function () {
            U.toast('已儲存，並發佈給所有裝置', 'ok', 3600);
            route();
          }).catch(function () {
            U.toast('已儲存在這台裝置（尚未設定 GitHub，無法發佈給其他裝置）', 'bad', 5000);
          });
        }
      }),
      U.el('a.btn.sm', { href: '#/teacher/data', text: '進階：GitHub 與收集端' })
    ]));
    view.appendChild(card);

    /* ---------- 設定一致性：本機 vs 已發佈 ---------- */
    var cons = U.el('div.card');
    cons.appendChild(U.el('h3', { text: '設定一致性（本機 ↔ 已發佈）' }));
    var consBox = U.el('div', {}, [U.el('div.tiny.muted', { text: '正在讀取已發佈的公開設定…' })]);
    cons.appendChild(consBox);
    view.appendChild(cons);

    Backend.loadConfig().then(function () {
      var rows = Backend.configAudit();
      consBox.innerHTML = '';
      var bad = rows.filter(function (r) { return !r.ok; });
      consBox.appendChild(U.el('div' + (bad.length ? '.warnbox' : '.infobox'), {
        text: bad.length
          ? ('有 ' + bad.length + ' 項不一致：其他裝置可能看到不一樣的設定，按上面的「儲存並套用到所有裝置」即可同步。')
          : '本機與已發佈的設定一致，所有裝置拿到的值相同。'
      }));
      var tbl = U.el('table.tbl');
      tbl.innerHTML = '<thead><tr><th>項目</th><th>這台裝置</th><th>已發佈</th><th>狀態</th></tr></thead>';
      var tb = U.el('tbody');
      rows.forEach(function (r) {
        var tr = U.el('tr');
        tr.appendChild(U.el('td', { text: r.name }));
        tr.appendChild(U.el('td', { text: String(r.local) }));
        tr.appendChild(U.el('td', { text: String(r.remote) }));
        tr.appendChild(U.el('td', {}, [
          U.el('span.tag' + (r.ok ? '.mint' : '.bad'), { text: r.ok ? '一致' : '不一致' }),
          r.hint ? U.el('div.tiny.faint', { text: r.hint }) : null
        ]));
        tb.appendChild(tr);
      });
      tbl.appendChild(tb);
      consBox.appendChild(U.el('div.tbl-wrap', {}, [tbl]));
      if (Backend.GitHub.ok()) {
        consBox.appendChild(U.el('div.row.mt2', {}, [
          U.el('button.btn.sm', {
            text: '重新發佈設定給所有裝置', onclick: function () {
              Backend.publishConfig().then(function () { U.toast('已發佈', 'ok'); route(); })
                .catch(function (e) { U.toast('發佈失敗：' + e.message, 'bad', 4500); });
            }
          })
        ]));
      }
    }).catch(function () {
      consBox.innerHTML = '';
      consBox.appendChild(U.el('div.tiny.muted', { text: '讀不到已發佈的公開設定（離線或尚未發佈）。' }));
    });

    /* 本機資料總覽 */
    var stat = U.el('div.card');
    view.appendChild(stat);
    Promise.all([Store.all('quizzes'), Store.all('submissions'), Store.all('roster')]).then(function (r) {
      stat.innerHTML = '';
      stat.appendChild(U.el('h3', { text: '本機資料' }));
      var g = U.el('div.grid.g3');
      [['試卷', r[0].length], ['作答記錄', r[1].length], ['學生帳號', r[2].length]].forEach(function (x) {
        g.appendChild(U.el('div.stat', {}, [U.el('b', { text: String(x[1]) }), U.el('span', { text: x[0] })]));
      });
      stat.appendChild(g);
      stat.appendChild(U.el('div.row.mt2', {}, [
        U.el('button.btn.sm', {
          text: '匯出全部（JSON）', onclick: function () {
            Store.exportAll().then(function (b) { U.download('rq-backup-' + U.fmtDate(U.nowISO()) + '.json', JSON.stringify(b, null, 2)); });
          }
        }),
        U.el('button.btn.sm.danger', {
          text: '清空本機資料', onclick: function () {
            U.confirm('這會清除這台電腦上所有試卷、作答與名冊，確定嗎？', function () {
              Promise.all([Store.clear('quizzes'), Store.clear('submissions'), Store.clear('roster')])
                .then(function () { U.toast('已清空'); route(); });
            });
          }
        })
      ]));
    });
  }

  /* ============================================================
     啟動
     ============================================================ */
  function boot() {
    view = document.getElementById('view');
    whoEl = document.getElementById('who');

    if (!window.indexedDB) {
      U.toast('此瀏覽器不支援 IndexedDB，將改用記憶體暫存（關閉分頁即消失）', 'bad', 4200);
    }

    /* 先讀 repo 的公開設定（Firebase／Apps Script）：
       學生的 iPad、其他電腦不必手動設定就能連上雲端。 */
    Backend.loadConfig().then(function () {
      window.addEventListener('hashchange', route);
      if (!location.hash) location.hash = '#/';
      route();

      /* 之前雲端不通時，提交會標記 _pending（只存在本機）。
         開站後與恢復連線時各自動補送一次，否則那筆作答永遠不會到老師那邊。 */
      function retryPending() {
        Backend.retryPending().then(function (n) {
          if (n) U.toast('已補送 ' + n + ' 筆先前未同步的作答', 'ok', 3600);
        }).catch(function () { /* 沒雲端或仍不通：下次再試 */ });
      }
      setTimeout(retryPending, 1500);
      window.addEventListener('online', retryPending);
    });

    /* 供偵錯 */
    window.RQ.debug = { store: Store, settings: Settings, backend: Backend };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  RQ.route = route;
})(window.RQ);
