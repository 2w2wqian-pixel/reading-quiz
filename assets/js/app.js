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
      whoEl.appendChild(U.el('span.chip', { text: '未登入' }));
      return;
    }
    whoEl.appendChild(U.el('span.chip', {
      text: (who.role === 'teacher' ? '👩‍🏫 老師' : '🧒 ' + (who.name || '學生'))
    }));
    whoEl.appendChild(U.el('button.btn.xs.ghost', {
      text: '登出', onclick: function () {
        Settings.logout();
        U.toast('已登出');
        location.hash = '#/';
        renderWho();
      }
    }));
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

    var card = U.el('div.card');
    card.appendChild(U.el('h2', { text: '設定' }));

    var mode = U.el('select.input', { style: { maxWidth: '280px' } });
    [['offline', '只存本機（完全離線）'], ['github', '同步到 GitHub repo']].forEach(function (x) {
      mode.appendChild(U.el('option', { value: x[0], text: x[1] }));
    });
    mode.value = s.quizMode || 'offline';
    card.appendChild(U.el('div', {}, [U.el('label.tiny.muted', { text: '試卷存放方式' }), mode]));

    var hi = U.el('input', { type: 'checkbox' });
    hi.checked = s.enableHighlight !== false;
    var ans = U.el('input', { type: 'checkbox' });
    ans.checked = s.showAnswerAfterSubmit !== false;
    var rt = U.el('input', { type: 'checkbox' });
    rt.checked = !!s.allowRetake;

    card.appendChild(U.el('div.mt2', {},
      [
        [hi, '啟用螢光標示／筆記／生詞本'],
        [ans, '學生提交後可查看正確答案'],
        [rt, '允許學生重複作答同一份試卷']
      ].map(function (x) {
        return U.el('label.check', { style: { display: 'flex', marginBottom: '6px' } }, [x[0], U.el('span', { text: x[1] })]);
      })
    ));

    card.appendChild(U.el('div.mt2.row', {}, [
      U.el('button.btn.primary.sm', {
        text: '儲存設定', onclick: function () {
          Settings.set({
            quizMode: mode.value,
            enableHighlight: hi.checked,
            showAnswerAfterSubmit: ans.checked,
            allowRetake: rt.checked
          });
          U.toast('已儲存', 'ok');
        }
      }),
      U.el('a.btn.sm', { href: '#/teacher/data', text: '進階：GitHub 與收集端' })
    ]));
    view.appendChild(card);

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

    window.addEventListener('hashchange', route);
    if (!location.hash) location.hash = '#/';
    route();

    /* 供偵錯 */
    window.RQ.debug = { store: Store, settings: Settings, backend: Backend };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  RQ.route = route;
})(window.RQ);
