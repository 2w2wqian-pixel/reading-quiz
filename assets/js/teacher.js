/* ============================================================
   teacher.js — 老師端：上傳 .docx、微調欄位、發佈、查看學生作答
   ============================================================ */
(function (RQ) {
  'use strict';

  var U = RQ.util, Store = RQ.store, Settings = RQ.settings, Backend = RQ.backend;
  var TABS = [
    { id: 'upload', label: '① 上傳試卷' },
    { id: 'quizzes', label: '② 試卷管理' },
    { id: 'reports', label: '③ 學生作答' },
    { id: 'roster', label: '④ 學生名冊' },
    { id: 'data', label: '⑤ 資料與同步' }
  ];

  var Teacher = {};
  var state = { tab: 'upload', quizId: null };

  /* ---------- 年級分類（小一～小六、中一～中六） ---------- */
  var PRIMARY_GRADES = ['小一', '小二', '小三', '小四', '小五', '小六'];
  var SECONDARY_GRADES = ['中一', '中二', '中三', '中四', '中五', '中六'];
  var GRADES = PRIMARY_GRADES.concat(SECONDARY_GRADES);

  function gradeSelect(value, attrs) {
    var sel = U.el('select.input', attrs || {});
    sel.appendChild(U.el('option', { value: '', text: '（未分類）' }));
    [['小學', PRIMARY_GRADES], ['中學', SECONDARY_GRADES]].forEach(function (grp) {
      var og = U.el('optgroup', { label: grp[0] });
      grp[1].forEach(function (g) { og.appendChild(U.el('option', { value: g, text: g })); });
      sel.appendChild(og);
    });
    sel.value = value || '';
    if (String(value || '') && sel.value !== value) sel.value = '';   /* 認不得的年級 → 未分類 */
    return sel;
  }

  /* ---------- 科目分類 ---------- */
  var SUBJECTS = ['中文', '英文', '數學'];
  function subjectSelect(value, attrs) {
    var sel = U.el('select.input', attrs || {});
    sel.appendChild(U.el('option', { value: '', text: '（未分類）' }));
    SUBJECTS.forEach(function (x) { sel.appendChild(U.el('option', { value: x, text: x })); });
    sel.value = value || '';
    if (String(value || '') && sel.value !== value) sel.value = '';
    return sel;
  }

  /* 年級＋科目標籤（清單與卡片共用） */
  function metaTags(m) {
    var tags = [];
    if (m && m.level) tags.push(m.level);
    if (m && m.subject) tags.push(m.subject);
    return tags.join('・');
  }

  /* 某份作業是否指派給某學生 */
  function assignedTo(meta, studentId) {
    var a = meta && meta.assignment;
    if (!a) return false;
    if (a.all) return true;
    return (a.ids || []).indexOf(studentId) >= 0;
  }

  /* 讀圖檔 → dataURL（順便縮圖，避免儲存過大） */
  function imageToDataURL(file, maxW) {
    maxW = maxW || 1200;
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        var raw = reader.result;
        try {
          var img = new Image();
          img.onload = function () {
            try {
              var scale = Math.min(1, maxW / (img.width || maxW));
              var c = document.createElement('canvas');
              c.width = Math.max(1, Math.round((img.width || maxW) * scale));
              c.height = Math.max(1, Math.round((img.height || maxW) * scale));
              c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
              resolve(c.toDataURL('image/jpeg', 0.82));
            } catch (e) { resolve(raw); }
          };
          img.onerror = function () { resolve(raw); };
          img.src = raw;
        } catch (e) { resolve(raw); }
      };
      reader.onerror = function () { reject(new Error('讀取圖片失敗')); };
      reader.readAsDataURL(file);
    });
  }

  /**
   * 指派追蹤：列出「指派給誰」以及每個人的完成狀態
   * （未作答／已提交待批改／已批改＋分數），老師才能跟進。
   */
  function assignTrackDialog(quiz) {
    Promise.all([
      Backend.getRoster().catch(function () { return []; }),
      Backend.listSubmissions(quiz.id).catch(function () { return []; })
    ]).then(function (r) {
      var roster = (r[0] || []).filter(function (s) { return s && s.role !== 'teacher'; });
      var subs = r[1] || [];
      var a = quiz.assignment || {};

      function latestSub(sid) {
        return subs.filter(function (x) { return String(x.studentId) === String(sid); })
          .sort(function (x, y) { return String(y.submittedAt || '').localeCompare(String(x.submittedAt || '')); })[0] || null;
      }
      /* 一位學生可能分段提交多次 → 取最新一次代表進度 */
      var targets = a.all ? roster : roster.filter(function (s) { return (a.ids || []).indexOf(s.id) >= 0; });

      var nDone = 0, nGraded = 0;
      var rowsHtml = targets.map(function (s) {
        var sub = latestSub(s.id);
        var st, tag;
        if (!sub || !sub.submittedAt) { st = '未作答'; tag = 'gray'; }
        else if (sub.score && sub.score.graded) {
          st = '已批改 <b>' + (sub.score.total || 0) + ' / ' + (sub.score.max || 0) + '</b>';
          tag = 'mint'; nGraded++; nDone++;
        } else {
          st = '已提交，待批改（自動 ' + ((sub.score && sub.score.total) || 0) + ' 分）';
          tag = 'sun'; nDone++;
        }
        var when = sub && sub.submittedAt ? U.fmtDate(sub.submittedAt, true) : '—';
        var ops = sub ? '<a class="btn xs" href="#/teacher/reports">批改</a>' : '';
        return '<tr><td>' + U.esc(s.name || s.username) + '</td>' +
          '<td><span class="tag ' + tag + '">' + st + '</span></td>' +
          '<td class="tiny">' + U.esc(when) + '</td><td>' + ops + '</td></tr>';
      }).join('');

      var body = U.el('div');
      body.appendChild(U.el('div.row.mt1', { style: { gap: '8px', flexWrap: 'wrap' } }, [
        U.el('span.tag.mint', { text: '指派 ' + targets.length + ' 人' }),
        U.el('span.tag.sky', { text: '已交 ' + nDone + ' 人' }),
        U.el('span.tag.lav', { text: '已批改 ' + nGraded + ' 人' }),
        U.el('span.tag' + (targets.length - nDone ? '.gray' : '.mint'), { text: '未交 ' + Math.max(0, targets.length - nDone) + ' 人' })
      ]));
      if (a.due) body.appendChild(U.el('div.tiny.muted.mt1', { text: '截止日期：' + a.due }));
      if (a.note) body.appendChild(U.el('div.tiny.muted', { text: '備註：' + a.note }));

      if (!targets.length) {
        body.appendChild(U.el('div.warnbox.mt2', { text: '這份試卷還沒指派給任何人（或名冊是空的）。' }));
      } else {
        var t = U.el('table.tbl.mt2');
        t.innerHTML = '<thead><tr><th>學生</th><th>狀態</th><th>提交時間</th><th></th></tr></thead><tbody>' + rowsHtml + '</tbody>';
        body.appendChild(U.el('div.tbl-wrap', {}, [t]));
      }

      U.modal({
        title: '指派追蹤：' + quiz.title,
        width: 640,
        body: body,
        actions: [
          { label: '關閉', close: true },
          {
            label: '修改指派', kind: 'lav', onClick: function () {
              assignDialog(quiz, function () { U.toast('指派已更新', 'ok'); });
            }
          }
        ]
      });
    }).catch(function (e) { U.toast('讀取追蹤資料失敗：' + ((e && e.message) || ''), 'bad'); });
  }

  /**
   * 存檔並把指派同步上線。
   * 指派資訊必須跟著試卷一起發佈（寫 repo／雲端），學生端的清單才看得到
   * ——否則會出現「老師指派了、學生卻看不到」。
   */
  function saveAndSync(quiz, okMsg, onSaved) {
    (quiz.questions || []).forEach(syncAnswerKeys);
    quiz.updatedAt = U.nowISO();
    return Store.quiz.save(quiz).then(function () {
      return Backend.publishQuiz(quiz).then(function () {
        U.toast(okMsg + '，已同步上線（學生重新載入即可看到）', 'ok', 4500);
      }).catch(function (e) {
        U.toast(okMsg + '，但無法同步上線：' + ((e && e.message) || '請先設定 Firebase／GitHub') +
          '（學生暫時看不到，請按「發佈」）', 'bad', 7000);
      });
    }).then(function () { onSaved && onSaved(); });
  }

  /* ---------- 指派作業 ---------- */
  function assignDialog(quiz, onSaved) {
    Backend.getRoster().then(function (list) {
      list = list || [];
      var a = quiz.assignment || {};
      var allChk = U.el('input', { type: 'checkbox' });
      allChk.checked = !!a.all;
      var dueInp = U.el('input.input', { type: 'date' });
      dueInp.value = a.due ? String(a.due).slice(0, 10) : '';
      var noteInp = U.el('input.input', { placeholder: '例如：下週一前完成', value: a.note || '' });

      var body = U.el('div');
      body.appendChild(U.el('label.opt', {}, [allChk, U.el('span', { text: ' 指派給全班' })]));
      var stud = U.el('div.mt2', {
        style: { maxHeight: '220px', overflow: 'auto', border: '1.5px solid var(--line)', borderRadius: 'var(--r-sm)', padding: '8px' }
      });
      var rows = [];
      if (!list.length) {
        stud.appendChild(U.el('div.tiny.muted', { text: '名冊尚無學生。學生可自行註冊，或到「④ 學生名冊」新增。' }));
      } else {
        list.forEach(function (s) {
          var chk = U.el('input', { type: 'checkbox' });
          chk.checked = (a.ids || []).indexOf(s.id) >= 0;
          rows.push({ id: s.id, chk: chk });
          stud.appendChild(U.el('label.opt', { style: { marginTop: '4px' } }, [
            chk, U.el('span', { text: ' ' + (s.name || s.username) + (s.className ? '（' + s.className + '）' : '') })
          ]));
        });
      }
      body.appendChild(U.el('div.tiny.muted.mt2', { text: '選擇學生（可多選）' }));
      body.appendChild(stud);
      body.appendChild(U.el('div.mt2', {}, [U.el('label.tiny.muted', { text: '截止日期（選填）' }), dueInp]));
      body.appendChild(U.el('div.mt1', {}, [U.el('label.tiny.muted', { text: '備註（選填）' }), noteInp]));

      U.modal({
        title: '指派作業：' + quiz.title,
        width: 560,
        body: body,
        actions: [
          { label: '取消', close: true },
          {
            label: '清除指派', onClick: function () {
              quiz.assignment = null;
              quiz.updatedAt = U.nowISO();
              saveAndSync(quiz, '已清除指派', onSaved);
            }
          },
          {
            label: '儲存', kind: 'primary', onClick: function () {
              var ids = rows.filter(function (r) { return r.chk.checked; }).map(function (r) { return r.id; });
              if (!allChk.checked && !ids.length) { U.toast('請選「全班」或至少一位學生', 'bad'); return false; }
              quiz.assignment = {
                all: allChk.checked, ids: ids,
                due: dueInp.value || '', note: U.trim(noteInp.value),
                assignedAt: U.nowISO()
              };
              saveAndSync(quiz, '已指派作業', onSaved);
            }
          }
        ]
      });
    }).catch(function (e) { U.toast('讀取名冊失敗：' + ((e && e.message) || ''), 'bad'); });
  }

  /* ============================================================
     入口
     ============================================================ */
  Teacher.render = function (view, tab) {
    var who = Settings.who();
    if (!who || who.role !== 'teacher') { Teacher.login(view); return; }
    state.tab = tab || state.tab || 'upload';
    view.innerHTML = '';

    var tabs = U.el('div.row', { style: { gap: '6px', marginBottom: '16px', flexWrap: 'wrap' } });
    TABS.forEach(function (t) {
      tabs.appendChild(U.el('button.btn.sm' + (state.tab === t.id ? '.primary' : ''), {
        text: t.label,
        onclick: function () { location.hash = '#/teacher/' + t.id; }
      }));
    });
    view.appendChild(tabs);

    var body = U.el('div');
    view.appendChild(body);
    Teacher[state.tab] && Teacher[state.tab](body);
  };

  Teacher.login = function (view) {
    view.innerHTML = '';
    var set = Settings.get();
    var card = U.el('div.card', { style: { maxWidth: '440px', margin: '30px auto' } });
    card.appendChild(U.el('h2', { text: '老師登入' }));

    if (!set.teacherPass) {
      card.appendChild(U.el('div.infobox', {
        html: '尚未設定老師密碼。請先設定一組密碼（只存在這台電腦的瀏覽器裡）。'
      }));
      var p1 = U.el('input.input', { type: 'password', placeholder: '設定老師密碼' });
      card.appendChild(p1);
      card.appendChild(U.el('div.mt2', {}, [
        U.el('button.btn.primary', {
          text: '設定並登入', onclick: function () {
            var v = U.trim(p1.value);
            if (v.length < 4) { U.toast('密碼至少 4 個字', 'bad'); return; }
            RQ.crypto.hashPassword(v).then(function (h) {
              Settings.set({ teacherPass: h });
              Settings.login({ role: 'teacher', name: '老師' });
              U.toast('已設定，歡迎使用', 'ok');
              location.hash = '#/teacher/upload';
            });
          }
        })
      ]));
    } else {
      var pw = U.el('input.input', { type: 'password', placeholder: '老師密碼' });
      card.appendChild(pw);
      card.appendChild(U.el('div.mt2.row', {}, [
        U.el('button.btn.primary', {
          text: '登入', onclick: function () {
            RQ.crypto.verifyPassword(pw.value, set.teacherPass).then(function (ok) {
              if (!ok) { U.toast('密碼不正確', 'bad'); return; }
              Settings.login({ role: 'teacher', name: '老師' });
              location.hash = '#/teacher/upload';
            });
          }
        }),
        U.el('button.btn.sm.ghost', {
          text: '忘記密碼（重設）', onclick: function () {
            U.confirm('重設會清除這台電腦的老師密碼（試卷與作答不會受影響），確定嗎？', function () {
              Settings.set({ teacherPass: '' });
              location.hash = '#/teacher';
              setTimeout(function () { location.reload(); }, 200);
            });
          }
        })
      ]));
      pw.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') U.$('.btn.primary', card).click();
      });
    }
    view.appendChild(card);
  };

  /* ============================================================
     ① 上傳試卷
     ============================================================ */
  Teacher.upload = function (view) {
    var card = U.el('div.card');
    card.appendChild(U.el('h2', { text: '上傳試卷（.docx／.pdf）' }));
    card.appendChild(U.el('p.tiny.muted', {
      html: '程式會在<b>你的瀏覽器裡</b>直接解讀檔案，自動拆成「文章／題目／選項／答案與解析」。<br>' +
        '<b>Word（.docx）</b>：若同一檔含「學生版＋教師版」（如啟思試卷），答案會自動帶入；也可分開上傳兩個檔。<br>' +
        '<b>PDF</b>：電子 PDF 直接抽文字出題；<b>掃描／影印的 PDF 沒有文字層</b>，' +
        '會自動改成「每頁一題、顯示原頁畫面」，學生在原頁下方作答。'
    }));

    var opt = { answerColor: 'FF0000', studentFile: null, teacherFile: null };

    /* 進階選項 */
    var adv = U.el('div.row.mt2', {});
    adv.appendChild(U.el('label.tiny.muted', { text: '答案標記顏色：' }));
    var colorInp = U.el('input.input', { value: 'FF0000', style: { width: '110px', flex: '0 0 auto' } });
    colorInp.addEventListener('change', function () { opt.answerColor = U.trim(colorInp.value) || 'FF0000'; });
    adv.appendChild(colorInp);
    adv.appendChild(U.el('span.tiny.faint', { text: '（教師版答案文字的顏色，預設紅色 FF0000）' }));
    card.appendChild(adv);

    /* 年級分類（小學／中學）＋ 科目分類 */
    var metaRow = U.el('div.row.mt2', { style: { flexWrap: 'wrap', gap: '8px' } });
    metaRow.appendChild(U.el('label.tiny.muted', { text: '年級：' }));
    var gSel = gradeSelect('', { style: { maxWidth: '150px', flex: '0 0 auto' } });
    gSel.addEventListener('change', function () { opt.level = gSel.value; });
    metaRow.appendChild(gSel);
    metaRow.appendChild(U.el('label.tiny.muted', { text: '科目：' }));
    var sSel = subjectSelect('', { style: { maxWidth: '130px', flex: '0 0 auto' } });
    sSel.addEventListener('change', function () { opt.subject = sSel.value; });
    metaRow.appendChild(sSel);
    metaRow.appendChild(U.el('span.tiny.faint', { text: '（可留空，選檔後會自動判斷；學生首頁會依年級分組）' }));
    card.appendChild(metaRow);

    /* 發佈選項 */
    var pubChk = U.el('input', { type: 'checkbox' });
    pubChk.checked = true;
    card.appendChild(U.el('div.mt2', {}, [
      U.el('label.check', { style: { display: 'flex' } }, [
        pubChk,
        U.el('span', { text: '解析後直接發佈，讓學生立刻看到（需先在「⑤ 資料與同步」設定 GitHub 或 Firebase）' })
      ])
    ]));

    /* 學生卷 */
    var dropS = dropZone('學生卷（題目卷）', function (f) {
      opt.studentFile = f;
      U.$('.drop-name', dropS).textContent = f.name;
      /* 自動判斷年級／科目（老師手動選過的就不覆蓋） */
      if (!gSel.value) { var g = U.guessLevel(f.name); if (g) { gSel.value = g; opt.level = g; } }
      if (!sSel.value) { var sb = U.guessSubject(f.name); if (sb) { sSel.value = sb; opt.subject = sb; } }
      if (/\.pdf$/i.test(f.name)) U.toast('PDF 會在解析時自動判斷是電子檔還是掃描檔', 'ok', 3500);
    });
    card.appendChild(U.el('label.tiny.muted.mt2', { text: '學生卷' }));
    card.appendChild(dropS);

    /* 教師卷 */
    var dropT = dropZone('教師卷／答案卷（可留空：若學生卷已內含教師版）', function (f) {
      opt.teacherFile = f;
      U.$('.drop-name', dropT).textContent = f.name;
    }, true);
    card.appendChild(U.el('label.tiny.muted.mt2', { text: '教師卷（選填，Word 用；PDF 一般已含答案請留空）' }));
    card.appendChild(dropT);

    var btnRow = U.el('div.row.mt2', {}, [
      U.el('button.btn.primary', {
        text: '開始解析', onclick: function () {
          if (!opt.studentFile) { U.toast('請先選擇學生卷', 'bad'); return; }
          opt.autoPublish = false;
          runParse(view, opt);
        }
      }),
      U.el('button.btn.mint', {
        text: '解析並發佈', onclick: function () {
          if (!opt.studentFile) { U.toast('請先選擇學生卷', 'bad'); return; }
          opt.autoPublish = true;
          runParse(view, opt);
        }
      })
    ]);
    card.appendChild(btnRow);
    view.appendChild(card);

    /* 解析規則說明 */
    view.appendChild(U.el('div.card.tinted', {}, [
      U.el('h3', { text: '解析規則（給會想微調的人看）' }),
      U.el('div.tiny', {
        html: [
          '<b>R1</b>　.docx 其實是 zip，讀取 word/document.xml 後依文件順序還原段落與表格。',
          '<b>R2</b>　教師版答案用紅色標記（<code>&lt;w:color w:val="FF0000"/&gt;</code>）→ 紅字即答案。',
          '<b>R3</b>　選擇題選項前是 Wingdings 符號：Wingdings F081→A、F082→B…；Wingdings 2 F06A→A、F06B→B…',
          '<b>R4</b>　題號＝段落以 1～2 位數字開頭，且該行含（n分）或「？」；分數＝題幹內（n分）加總。',
          '<b>R5</b>　文章＝「閱讀能力考材」到「－完－」之間，以「第一篇／第二篇」分段，長度 ≥ 25 字視為正文。',
          '<b>R6</b>　【整合】【引申】等能力標記會從題幹抽出來，另存為標籤。',
          '<b>R7</b>　表格題逐一比對學生版／教師版儲存格，產生子題；教師版有紅色勾選記號者，答案取該欄標題。',
          '<b>R8</b>　「答案分析：」之後的文字視為解析。',
          '<b>R9（PDF）</b>　有文字層的 PDF：抽出文字行後<b>沿用上面同一套出題規則</b>；' +
            'PDF 常把 A/B/C/D 選項排在同一行，程式會先切成獨立選項。',
          '<b>R10（PDF）</b>　沒有文字層（掃描／影印檔，例如影印的數學卷）：' +
            '<b>無法無中生有文字</b>，改為每頁轉成圖片、每頁一題，學生在原頁下方作答；' +
            '老師可在編輯頁「附加截圖」把某頁的圖帶到指定題目。'
        ].map(function (x) { return '<div style="padding:2px 0">' + x + '</div>'; }).join('')
      })
    ]));
  };

  function dropZone(label, onFile, wordOnly) {
    var ok = function (n) { return wordOnly ? /\.docx$/i.test(n) : (/\.docx$/i.test(n) || /\.pdf$/i.test(n)); };
    var tip = wordOnly ? '點擊選擇，或把 .docx 拖到這裡' : '點擊選擇，或把 .docx／.pdf 拖到這裡';
    var z = U.el('div.drop', {}, [
      U.el('div.big', { text: '📄' }),
      U.el('b', { text: label }),
      U.el('small', { text: tip }),
      U.el('div.drop-name.tiny', { style: { marginTop: '6px', color: 'var(--pink-deep)' } })
    ]);
    z.addEventListener('click', function () {
      U.pickFile(wordOnly
        ? '.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        : '.docx,.pdf,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        function (f) {
          if (!ok(f.name)) { U.toast(wordOnly ? '教師卷請用 .docx（舊的 .doc 請先另存為 .docx）' : '只支援 .docx 或 .pdf', 'bad'); return; }
          onFile(f);
        });
    });
    ['dragenter', 'dragover'].forEach(function (ev) {
      z.addEventListener(ev, function (e) { e.preventDefault(); z.classList.add('over'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      z.addEventListener(ev, function (e) { e.preventDefault(); z.classList.remove('over'); });
    });
    z.addEventListener('drop', function (e) {
      var f = e.dataTransfer.files[0];
      if (f && ok(f.name)) onFile(f);
      else if (f) U.toast(wordOnly ? '教師卷請用 .docx' : '只支援 .docx 或 .pdf', 'bad');
    });
    return z;
  }

  function runParse(view, opt) {
    var isPdf = /\.pdf$/i.test(opt.studentFile.name);
    var card = U.el('div.card', {}, [
      U.el('div.center', {}, [
        U.el('b', { text: '解析中…' }),
        U.el('div.tiny.muted', {
          text: isPdf
            ? 'PDF 需要先判斷有沒有文字層；掃描檔還要逐頁轉圖，約需數秒到一分鐘'
            : '視試卷長度約需 1–5 秒'
        })
      ])
    ]);
    view.appendChild(card);

    var p;
    if (isPdf) {
      if (opt.teacherFile) {
        U.toast('PDF 解析不使用教師卷（PDF 通常已含答案頁，教師卷只支援 Word）', 'bad', 4000);
      }
      p = RQ.pdf.parse(opt.studentFile, { fileName: opt.studentFile.name, lang: '' });
    } else if (opt.teacherFile) {
      p = RQ.docx.parsePair(opt.studentFile, opt.teacherFile, {
        answerColor: opt.answerColor,
        studentName: opt.studentFile.name, teacherName: opt.teacherFile.name
      });
    } else {
      p = RQ.docx.parse(opt.studentFile, { answerColor: opt.answerColor, fileName: opt.studentFile.name });
    }

    p.then(function (res) {
      var quiz = {
        id: U.slug(res.title) + '-' + Date.now().toString(36).slice(-4),
        title: res.title,
        level: opt.level || res.level || '',
        subject: opt.subject || res.subject || '',
        format: res.mode === 'image' ? 'pdf-image' : (res.mode === 'text' ? 'pdf-text' : 'docx'),
        source: res.source || '',
        createdAt: U.nowISO(),
        updatedAt: U.nowISO(),
        published: false,
        passages: res.passages,
        questions: res.questions,
        totalMarks: res.totalMarks,
        warnings: res.warnings,
        stats: res.stats
      };
      return Store.quiz.save(quiz).then(function () {
        var whatPdf = res.mode === 'image' ? '（掃描檔：每頁一題、顯示原頁畫面）' : '';
        if (!opt.autoPublish) {
          U.toast('解析完成：' + res.questions.length + ' 題' +
            (res.mode === 'image' ? '' : '／' + res.passages.length + ' 篇文章') + whatPdf +
            '（已存為草稿，請按「發佈」）', 'ok', 4500);
          location.hash = '#/edit/' + quiz.id;
          return null;
        }
        return Backend.publishQuiz(quiz).then(function () {
          U.toast('解析完成並已發佈！學生重新載入即可看到', 'ok', 4500);
          location.hash = '#/edit/' + quiz.id;
        }).catch(function (e) {
          U.toast('已解析但發佈失敗：' + ((e && e.message) || '') + '（可到編輯頁手動發佈）', 'bad', 6000);
          location.hash = '#/edit/' + quiz.id;
        });
      });
    }).catch(function (e) {
      card.innerHTML = '';
      card.appendChild(U.el('div.warnbox', { text: '解析失敗：' + (e && e.message ? e.message : e) }));
      console.error(e);
    });
  }

  /* ============================================================
     試卷編輯（手動微調）
     ============================================================ */
  Teacher.edit = function (view, quizId) {
    view.innerHTML = '<div class="empty">載入中…</div>';
    Store.quiz.get(quizId).then(function (quiz) {
      if (!quiz) { view.innerHTML = '<div class="empty">找不到這份試卷</div>'; return; }
      renderEditor(view, quiz);
    });
  };

  function renderEditor(view, quiz) {
    view.innerHTML = '';

    /* 頂端：基本資料 + 動作 */
    var top = U.el('div.card');
    var tInp = U.el('input.input', { value: quiz.title || '' });
    var lInp = gradeSelect(quiz.level || '', { style: { maxWidth: '160px' } });
    var subSel = subjectSelect(quiz.subject || '', { style: { maxWidth: '140px' } });
    top.appendChild(U.el('div.row.between', {}, [
      U.el('h2.mb0', { text: '微調試卷內容' }),
      U.el('span.tag' + (quiz.published ? '.mint' : '.gray'), { text: quiz.published ? '已發佈' : '尚未發佈' })
    ]));
    top.appendChild(U.el('div.inline-fields.mt2', {}, [
      U.el('div', {}, [U.el('label.tiny.muted', { text: '試卷名稱' }), tInp]),
      U.el('div', { style: { maxWidth: '180px' } }, [U.el('label.tiny.muted', { text: '年級分類' }), lInp]),
      U.el('div', { style: { maxWidth: '150px' } }, [U.el('label.tiny.muted', { text: '科目' }), subSel])
    ]));

    /* 作業指派狀態 */
    var asg = quiz.assignment;
    var asgLine = U.el('div.tiny.mt1', {
      html: asg
        ? '📌 <b>已指派</b>：' + (asg.all ? '全班' : ((asg.ids || []).length + ' 位學生')) +
          (asg.due ? '　截止 ' + asg.due : '') + (asg.note ? '　' + U.esc(asg.note) : '')
        : '<span class="muted">尚未指派為作業</span>'
    });
    top.appendChild(asgLine);

    /* 發佈狀態提示：草稿學生看不到，要按「發佈到 GitHub」 */
    if (!quiz.published) {
      var hasCloud = (Backend.GitHub && Backend.GitHub.ok && Backend.GitHub.ok()) ||
                     (Backend.Firebase && Backend.Firebase.ok && Backend.Firebase.ok());
      top.appendChild(U.el('div.warnbox.mt2', {
        html: hasCloud
          ? '📄 <b>這份試卷仍是草稿，學生還看不到。</b>確認內容無誤後，按下方「<b>發佈到 GitHub</b>」即可發佈。'
          : '📄 <b>這份試卷仍是草稿，學生還看不到。</b>而且目前<b>尚未設定雲端</b>，請先到「<b>⑤ 資料與同步</b>」填好 GitHub（擁有者／repo／Token）或 Firebase，再回來按「<b>發佈到 GitHub</b>」發佈。'
      }));
    }

    if ((quiz.warnings || []).length) {
      var w = U.el('div.warnbox.mt2');
      w.appendChild(U.el('b', { text: '解析提醒：' }));
      var ul = U.el('ul', { style: { margin: '4px 0 0', paddingLeft: '20px' } });
      quiz.warnings.forEach(function (x) { ul.appendChild(U.el('li', { text: x })); });
      w.appendChild(ul);
      top.appendChild(w);
    }

    var acts = U.el('div.row.mt2', {}, [
      U.el('button.btn.primary', { text: '儲存', onclick: save }),
      U.el('button.btn.mint', { text: '預覽（學生視角）', onclick: preview }),
      U.el('button.btn.lav', { text: '指派作業', onclick: assign }),
      U.el('button.btn.sun', { text: '下載 JSON', onclick: download }),
      U.el('button.btn.lav', { text: '發佈到 GitHub', onclick: publish }),
      U.el('button.btn.danger', { text: '刪除試卷', onclick: remove })
    ]);
    top.appendChild(acts);
    view.appendChild(top);

    /* 文章 */
    var pcard = U.el('div.card');
    pcard.appendChild(U.el('h3', { text: '閱讀文章（' + (quiz.passages || []).length + ' 篇）' }));
    (quiz.passages || []).forEach(function (p, pi) {
      pcard.appendChild(passageEditor(quiz, p, pi, refresh));
    });
    pcard.appendChild(U.el('div.mt2', {}, [
      U.el('button.btn.sm.ghost', {
        text: '＋ 新增一篇文章', onclick: function () {
          quiz.passages.push({ id: 'p' + ((quiz.passages.length) + 1), title: '第 ' + (quiz.passages.length + 1) + ' 篇', paragraphs: [''], notes: [] });
          refresh();
        }
      })
    ]));
    view.appendChild(pcard);

    /* 題目 */
    var qcard = U.el('div.card');
    qcard.appendChild(U.el('div.row.between', {}, [
      U.el('h3.mb0', { text: '題目（' + (quiz.questions || []).length + ' 題，共 ' + (quiz.totalMarks || 0) + ' 分）' }),
      U.el('button.btn.sm.ghost', {
        text: '＋ 新增題目', onclick: function () {
          var no = (quiz.questions.length ? Math.max.apply(null, quiz.questions.map(function (q) { return q.no || 0; })) : 0) + 1;
          quiz.questions.push({
            id: 'q' + no, no: no, stem: '', type: 'text', marks: 0, options: [],
            subQuestions: [], answer: '', answerKeys: [], explanation: '',
            passageId: (quiz.passages[0] || {}).id || null, skills: []
          });
          refresh();
        }
      })
    ]));
    (quiz.questions || []).forEach(function (q, qi) {
      qcard.appendChild(questionEditor(quiz, q, qi, refresh));
    });
    view.appendChild(qcard);

    function refresh() {
      quiz.totalMarks = (quiz.questions || []).reduce(function (a, q) { return a + (parseFloat(q.marks) || 0); }, 0);
      renderEditor(view, quiz);
    }
    function save() {
      (quiz.questions || []).forEach(syncAnswerKeys);
      quiz.title = U.trim(tInp.value) || quiz.title;
      quiz.level = U.trim(lInp.value);
      quiz.subject = subSel.value;
      quiz.updatedAt = U.nowISO();
      Store.quiz.save(quiz).then(function () { U.toast('已儲存', 'ok'); });
    }
    function assign() {
      (quiz.questions || []).forEach(syncAnswerKeys);
      quiz.title = U.trim(tInp.value) || quiz.title;
      quiz.level = U.trim(lInp.value);
      quiz.subject = subSel.value;
      assignDialog(quiz, function () { Store.quiz.get(quiz.id).then(function (q) { renderEditor(view, q || quiz); }); });
    }
    function preview() {
      quiz.title = U.trim(tInp.value) || quiz.title;
      U.modal({
        title: '學生視角預覽',
        width: 900,
        body: buildPreview(quiz),
        actions: [{ label: '關閉' }]
      });
    }
    function download() {
      U.download(U.slug(quiz.title) + '.json', JSON.stringify(quiz, null, 2));
    }
    function publish() {
      (quiz.questions || []).forEach(syncAnswerKeys);
      quiz.title = U.trim(tInp.value) || quiz.title;
      quiz.level = U.trim(lInp.value);
      quiz.subject = subSel.value;
      /* 注意：published 只可在「發佈成功」後才設為 true（Backend.publishQuiz 內部會設），
         否則發佈失敗時會被誤標成「已發佈」，之後按儲存就會把假狀態存起來。 */
      Backend.publishQuiz(quiz).then(function () {
        U.toast('已發佈，學生重新載入頁面即可看到', 'ok');
        refresh();
      }).catch(function (e) { U.toast('發佈失敗：' + e.message, 'bad'); });
    }
    function remove() {
      U.confirm('確定刪除這份試卷？學生的作答記錄不會被刪除。', function () {
        Store.quiz.del(quiz.id).then(function () {
          U.toast('已刪除'); location.hash = '#/teacher/quizzes';
        });
      });
    }
  }

  function passageEditor(quiz, p, pi, refresh) {
    var box = U.el('div.subq');
    var t = U.el('input.input', { value: p.title || '' });
    t.addEventListener('input', function () { p.title = t.value; });
    var ta = U.el('textarea.input', { rows: 6 });
    ta.value = (p.paragraphs || []).join('\n');
    ta.addEventListener('input', function () {
      p.paragraphs = ta.value.split('\n').map(function (x) { return U.trim(x); }).filter(function (x) { return x; });
    });
    var nt = U.el('textarea.input', { rows: 2 });
    nt.value = (p.notes || []).join('\n');
    nt.addEventListener('input', function () {
      p.notes = nt.value.split('\n').map(function (x) { return U.trim(x); }).filter(function (x) { return x; });
    });

    box.appendChild(U.el('div.row.between', {}, [
      U.el('div', { style: { flex: '1' } }, [U.el('label.tiny.muted', { text: '標題' }), t]),
      U.el('button.btn.xs.danger', {
        text: '刪除本篇', onclick: function () {
          U.confirm('刪除「' + (p.title || '') + '」？', function () {
            quiz.passages.splice(pi, 1); refresh();
          });
        }
      })
    ]));
    box.appendChild(U.el('div.mt1', {}, [U.el('label.tiny.muted', { text: '正文（一行一段落）' }), ta]));
    box.appendChild(U.el('div.mt1', {}, [U.el('label.tiny.muted', { text: '注釋（一行一則）' }), nt]));
    return box;
  }

  /**
   * 由「正確答案」文字推出自動批改用的答案鍵。
   * 有些原檔（例如英文卷的 Suggested Answers）**沒有標記選擇題答案**，
   * 老師只要在這裡填 A/B/C/D，就能自動批改。
   * 只接受單純的字母答案，避免把整句當成答案。
   */
  function syncAnswerKeys(q) {
    if (!q || q.type !== 'mcq') return;
    var a = U.trim(q.answer || '');
    var m = a.match(/^[（(]?([A-Ha-h])[）)]?(?:[.、)．:：]\s*.*)?$/);
    q.answerKeys = m ? [m[1].toUpperCase()] : [];
  }

  function questionEditor(quiz, q, qi, refresh) {
    var box = U.el('div.q');
    box.appendChild(U.el('div.row.between', {}, [
      U.el('div.row', {}, [
        U.el('div.q-no', { text: String(q.no != null ? q.no : qi + 1) }),
        (function () {
          var s = U.el('select.input', { style: { maxWidth: '150px' } });
          [['text', '文字題'], ['mcq', '選擇題'], ['table', '填充／表格題'], ['matching', '配對題']].forEach(function (o) {
            s.appendChild(U.el('option', { value: o[0], text: o[1] }));
          });
          s.value = q.type || 'text';
          s.addEventListener('change', function () { q.type = s.value; refresh(); });
          return s;
        })()
      ]),
      U.el('div.row', {}, [
        U.el('button.btn.xs', { text: '↑', onclick: move(-1) }),
        U.el('button.btn.xs', { text: '↓', onclick: move(1) }),
        U.el('button.btn.xs.danger', {
          text: '刪除', onclick: function () {
            U.confirm('刪除第 ' + q.no + ' 題？', function () { quiz.questions.splice(qi, 1); refresh(); });
          }
        })
      ])
    ]));

    function move(d) {
      return function () {
        var j = qi + d;
        if (j < 0 || j >= quiz.questions.length) return;
        var tmp = quiz.questions[qi]; quiz.questions[qi] = quiz.questions[j]; quiz.questions[j] = tmp;
        refresh();
      };
    }

    /* 題幹 */
    var stem = U.el('textarea.input', { rows: 2 });
    stem.value = q.stem || '';
    stem.addEventListener('input', function () { q.stem = stem.value; });
    box.appendChild(U.el('div.mt1', {}, [U.el('label.tiny.muted', { text: '題幹' }), stem]));

    /* 略過此題（例如段落劃分／概括題） */
    var skipChk = U.el('input', { type: 'checkbox' });
    skipChk.checked = !!q.skip;
    skipChk.addEventListener('change', function () { q.skip = skipChk.checked; });
    box.appendChild(U.el('label.check.mt1', { style: { display: 'flex' } }, [
      skipChk,
      U.el('span', { text: '略過此題（學生不會看到、不計分）' + (q.skipReason ? '　— ' + q.skipReason : '') })
    ]));

    /* 題目截圖（原文樣式仍不夠清楚時，用截圖取代） */
    var imgPrev = U.el('div.mt1');
    var imgOnlyChk = U.el('input', { type: 'checkbox' });
    imgOnlyChk.checked = !!q.imageOnly;
    imgOnlyChk.addEventListener('change', function () { q.imageOnly = imgOnlyChk.checked; });
    function drawImg() {
      imgPrev.innerHTML = '';
      if (!q.image) return;
      imgPrev.appendChild(U.el('img', {
        src: q.image,
        style: { maxWidth: '260px', borderRadius: '6px', border: '1.5px solid var(--line)' }
      }));
    }
    var imgRow = U.el('div.row.mt1', {}, [
      U.el('button.btn.xs', {
        text: q.image ? '更換截圖' : '附加截圖',
        onclick: function () {
          U.pickFile('image/*', function (f) {
            imageToDataURL(f).then(function (d) {
              q.image = d; drawImg(); U.toast('已附加截圖（記得按儲存）', 'ok');
            }).catch(function (e) { U.toast('讀取圖片失敗：' + e.message, 'bad'); });
          });
        }
      }),
      U.el('button.btn.xs.danger', { text: '移除截圖', onclick: function () { q.image = null; drawImg(); } }),
      U.el('label.check', { style: { display: 'flex', marginLeft: '8px' } }, [
        imgOnlyChk, U.el('span', { text: '只顯示截圖（隱藏解析出的題目內容）' })
      ])
    ]);
    box.appendChild(U.el('label.tiny.muted.mt1', { text: '題目截圖（選填；上載後記得按「儲存」）' }));
    box.appendChild(imgRow);
    box.appendChild(imgPrev);
    drawImg();

    /* 分數 / 所屬文章 */
    var mk = U.el('input.input', { type: 'number', value: q.marks || 0, style: { maxWidth: '110px' } });
    mk.addEventListener('input', function () { q.marks = parseFloat(mk.value) || 0; });
    var ps = U.el('select.input', { style: { maxWidth: '180px' } });
    ps.appendChild(U.el('option', { value: '', text: '（不指定）' }));
    quiz.passages.forEach(function (p) { ps.appendChild(U.el('option', { value: p.id, text: p.title })); });
    ps.value = q.passageId || '';
    ps.addEventListener('change', function () { q.passageId = ps.value || null; });
    box.appendChild(U.el('div.inline-fields.mt1', {}, [
      U.el('div', { style: { maxWidth: '140px' } }, [U.el('label.tiny.muted', { text: '分數' }), mk]),
      U.el('div', { style: { maxWidth: '220px' } }, [U.el('label.tiny.muted', { text: '所屬文章' }), ps])
    ]));

    /* 選擇題：選項 + 正確答案 */
    if (q.type === 'mcq') {
      var ob = U.el('div.mt2');
      ob.appendChild(U.el('label.tiny.muted', { text: '選項（勾選者為正確答案）' }));
      (q.options || []).forEach(function (o, oi) {
        var row = U.el('div.row', { style: { gap: '6px', marginBottom: '6px' } });
        var cb = U.el('input', { type: 'checkbox', style: { width: '18px', height: '18px' } });
        cb.checked = (q.answerKeys || []).indexOf(o.key) >= 0;
        cb.addEventListener('change', function () {
          q.answerKeys = (q.answerKeys || []).filter(function (k) { return k !== o.key; });
          if (cb.checked) q.answerKeys.push(o.key);
          q.answerKeys.sort();
          q.multi = q.answerKeys.length > 1;
        });
        var kt = U.el('input.input', { value: o.key, style: { maxWidth: '60px' } });
        kt.addEventListener('input', function () { o.key = U.trim(kt.value) || o.key; });
        var vt = U.el('input.input', { value: o.text, style: { flex: '1' } });
        vt.addEventListener('input', function () { o.text = vt.value; });
        row.appendChild(cb); row.appendChild(kt); row.appendChild(vt);
        row.appendChild(U.el('button.btn.xs.danger', {
          text: '✕', onclick: function () { q.options.splice(oi, 1); refresh(); }
        }));
        ob.appendChild(row);
      });
      ob.appendChild(U.el('button.btn.xs.ghost', {
        text: '＋ 選項', onclick: function () {
          var keys = (q.options || []).map(function (o) { return o.key; });
          var nk = 'ABCDEFGH'.split('').filter(function (k) { return keys.indexOf(k) < 0; })[0] || String(keys.length);
          q.options.push({ key: nk, text: '' }); refresh();
        }
      }));
      box.appendChild(ob);
    }

    /* 表格題：子題 */
    if (q.type === 'table') {
      var sb = U.el('div.mt2');
      sb.appendChild(U.el('label.tiny.muted', { text: '子題（學生看到的提示 / 正確答案）' }));
      (q.subQuestions || []).forEach(function (s2, si) {
        var row = U.el('div.subq');
        var l = U.el('input.input', { value: s2.label || '', placeholder: '標籤，如 (1)' });
        l.addEventListener('input', function () { s2.label = l.value; });
        var pr = U.el('input.input', { value: s2.prompt || '', placeholder: '提示文字（學生版該格內容）' });
        pr.addEventListener('input', function () { s2.prompt = pr.value; });
        var an = U.el('input.input', { value: s2.answer || '', placeholder: '正確答案' });
        an.addEventListener('input', function () { s2.answer = an.value; s2.marks = U.sumMarks(an.value); });
        row.appendChild(U.el('div.inline-fields', {}, [
          U.el('div', { style: { maxWidth: '140px' } }, [U.el('label.tiny.faint', { text: '標籤' }), l]),
          U.el('div', {}, [U.el('label.tiny.faint', { text: '提示' }), pr]),
          U.el('div', {}, [U.el('label.tiny.faint', { text: '答案' }), an])
        ]));
        row.appendChild(U.el('div.row.end.mt1', {}, [
          U.el('button.btn.xs.danger', { text: '刪除子題', onclick: function () { q.subQuestions.splice(si, 1); refresh(); } })
        ]));
        sb.appendChild(row);
      });
      sb.appendChild(U.el('button.btn.xs.ghost', {
        text: '＋ 子題', onclick: function () {
          q.subQuestions.push({
            id: 'q' + q.no + '_s' + (q.subQuestions.length + 1),
            label: '(' + (q.subQuestions.length + 1) + ')', prompt: '', answer: '', marks: 0
          });
          refresh();
        }
      }));
      box.appendChild(sb);
    }

    /* 答案 / 解析 */
    var an2 = U.el('textarea.input', { rows: q.type === 'mcq' ? 1 : 3 });
    an2.value = q.answer || '';
    an2.addEventListener('input', function () { q.answer = an2.value; syncAnswerKeys(q); paintKeyHint(); });
    var keyHint = U.el('div.tiny.mt1', {});
    function paintKeyHint() {
      if (q.type !== 'mcq') { keyHint.textContent = ''; return; }
      if (q.answerKeys && q.answerKeys.length) {
        keyHint.innerHTML = '✔ 自動批改答案鍵：<b>' + U.esc(q.answerKeys.join('、')) + '</b>';
        keyHint.className = 'tiny mt1 muted';
      } else {
        keyHint.innerHTML = '<span class="warnbox">⚠ 這一題還沒有答案，學生提交後無法自動計分。' +
          '請在此填 <b>A／B／C／D</b>（原檔若沒有標記答案，需老師手動補）。</span>';
        keyHint.className = 'tiny mt1';
      }
    }
    var ex = U.el('textarea.input', { rows: 2 });
    ex.value = q.explanation || '';
    ex.addEventListener('input', function () { q.explanation = ex.value; });

    box.appendChild(U.el('div.inline-fields.mt2', {}, [
      U.el('div', {}, [U.el('label.tiny.muted', { text: '正確答案（學生提交後會看到）' }), an2, keyHint]),
      U.el('div', {}, [U.el('label.tiny.muted', { text: '答案解析' }), ex])
    ]));
    paintKeyHint();

    return box;
  }

  function buildPreview(quiz) {
    var d = U.el('div');
    (quiz.passages || []).forEach(function (p) {
      var holder = U.el('div.passage', { style: { marginBottom: '12px' } });
      d.appendChild(holder);
      RQ.Highlighter.readonly(holder, p, []);
    });
    (quiz.questions || []).forEach(function (q, i) {
      var box = U.el('div.q');
      if (q.skip) box.appendChild(U.el('div.tiny.faint', { text: '（此題已略過，學生不會看到）' }));
      box.appendChild(U.el('div.q-head', {}, [
        U.el('div.q-no', { text: String(q.no != null ? q.no : i + 1) }),
        U.el('div.q-stem', { html: U.esc(q.stem) })
      ]));
      if (q.image) {
        box.appendChild(U.el('div.q-image', {}, [
          U.el('img', { src: q.image, style: { maxWidth: '100%', borderRadius: '8px', border: '1.5px solid var(--line)' } })
        ]));
      }
      var qb = RQ.forms.quotesBlock(q);
      if (qb) box.appendChild(qb);
      box.appendChild(RQ.forms.input(q, {}, { disabled: true }));
      d.appendChild(box);
    });
    return d;
  }

  /* ============================================================
     ② 試卷管理
     ============================================================ */
  Teacher.quizzes = function (view) {
    var box = U.el('div');
    view.appendChild(box);
    Backend.listQuizzes().then(function (list) {
      box.innerHTML = '';
      if (!list.length) {
        box.appendChild(U.el('div.empty', {}, [
          U.el('div.big', { text: '📚' }),
          U.el('div', { text: '還沒有試卷，請到「① 上傳試卷」開始' })
        ]));
        return;
      }
      /* 指派政策開關：預設「學生只看得到老師指派的試卷」 */
      var assignOnlyOn = Settings.get().assignOnly !== false;
      var policyChk = U.el('input', { type: 'checkbox' });
      policyChk.checked = assignOnlyOn;
      var policyHint = U.el('span.tiny.muted', {});
      function drawPolicyHint() {
        policyHint.textContent = policyChk.checked
          ? '（學生端只會看到「指派給他」的試卷）'
          : '（學生端會看到所有已發佈的試卷）';
      }
      drawPolicyHint();
      policyChk.addEventListener('change', function () {
        Settings.set({ assignOnly: policyChk.checked });
        drawPolicyHint();
        U.toast(policyChk.checked ? '已改為：指派後學生才看得到' : '已改為：學生看得到所有已發佈試卷', 'ok');
      });
      box.appendChild(U.el('div.card.tinted.mb2', {}, [
        U.el('label.opt', {}, [policyChk, U.el('b', { text: ' 指派後學生才看得到試卷', style: { marginLeft: '6px' } })]),
        U.el('div.tiny.muted.mt1', {}, [policyHint]),
        U.el('div.tiny.muted', { text: '發佈＝把試卷放上線；指派＝指定給哪位學生。兩者都完成，學生才答得到。' })
      ]));

      var tbl = U.el('table.tbl');
      tbl.innerHTML = '<thead><tr><th>試卷</th><th>年級／科目</th><th>題數</th><th>分數</th><th>狀態</th><th>作業</th><th>更新</th><th>操作</th></tr></thead>';
      var tb = U.el('tbody');
      list.forEach(function (m) {
        var tr = U.el('tr');
        tr.appendChild(U.el('td', { html: U.esc(m.title) }));
        tr.appendChild(U.el('td', { text: metaTags(m) || '—' }));
        tr.appendChild(U.el('td', { text: m.questionCount || 0 }));
        tr.appendChild(U.el('td', { text: m.totalMarks || 0 }));
        tr.appendChild(U.el('td', {}, [
          U.el('span.tag' + (m.published ? '.mint' : '.gray'), { text: m.published ? '已發佈' : '草稿' }),
          m._repo ? U.el('span.tag.sky', { text: ' repo', style: { marginLeft: '4px' } }) : null,
          m._cloud ? U.el('span.tag.sky', { text: ' 雲端', style: { marginLeft: '4px' } }) : null,
          !m.published ? U.el('span.tiny.faint', { text: '（學生看不到）', style: { marginLeft: '4px' } }) : null
        ]));
        var a = m.assignment;
        var asgTd = U.el('td');
        if (a) {
          asgTd.appendChild(U.el('span.tag.sun', { text: (a.all ? '全班' : (a.ids || []).length + ' 人') + (a.due ? '・' + a.due : '') }));
          asgTd.appendChild(U.el('button.btn.xs', {
            text: '追蹤', style: { marginLeft: '4px' },
            onclick: function () { Backend.getQuiz(m.id).then(function (q) { assignTrackDialog(q || m); }); }
          }));
        } else {
          asgTd.appendChild(U.el('span.tiny.faint', { text: '未指派' }));
        }
        tr.appendChild(asgTd);
        tr.appendChild(U.el('td', { text: U.fmtDate(m.createdAt) }));
        var ops = U.el('td');
        ops.appendChild(U.el('a.btn.xs', { href: '#/edit/' + m.id, text: '編輯' }));
        /* 發佈／重新發佈：草稿一鍵上線（寫 repo／雲端），不必再進編輯頁 */
        var pubBtn = U.el('button.btn.xs' + (m.published ? '' : '.mint'), {
          text: m.published ? '重新發佈' : '發佈', style: { marginLeft: '4px' },
          onclick: function () {
            pubBtn.disabled = true; pubBtn.textContent = '發佈中…';
            Backend.getQuiz(m.id).then(function (q) {
              if (!q) throw new Error('找不到試卷內容，請先確認試卷是否存在');
              return Backend.publishQuiz(q);
            }).then(function () {
              U.toast('已發佈「' + m.title + '」，學生重新載入就看得到（若已指派）', 'ok', 4200);
              view.innerHTML = ''; Teacher.quizzes(view);
            }).catch(function (e) {
              pubBtn.disabled = false; pubBtn.textContent = m.published ? '重新發佈' : '發佈';
              U.toast('發佈失敗：' + ((e && e.message) || ''), 'bad', 6000);
            });
          }
        });
        ops.appendChild(pubBtn);
        ops.appendChild(U.el('button.btn.xs.lav', {
          text: a ? '改指派' : '指派', style: { marginLeft: '4px' },
          onclick: function () { Backend.getQuiz(m.id).then(function (q) { assignDialog(q || m, function () { view.innerHTML = ''; Teacher.quizzes(view); }); }); }
        }));
        ops.appendChild(U.el('a.btn.xs', { href: '#/quiz/' + m.id, text: '試作', style: { marginLeft: '4px' } }));
        ops.appendChild(U.el('button.btn.xs', {
          text: '報表', style: { marginLeft: '4px' },
          onclick: function () { location.hash = '#/teacher/reports'; setTimeout(function () { RQ._reportQuiz = m.id; location.reload(); }, 50); }
        }));
        var onGithub = m.published || m._repo;
        var delBtn = U.el('button.btn.xs.danger', {
          text: '刪除', style: { marginLeft: '4px' },
          onclick: function () {
            var scope = '本機資料' + (onGithub ? '以及 GitHub 上的副本' : '') + '都會被移除';
            U.confirm('確定要刪除試卷「' + m.title + '」嗎？' + scope + '，此動作無法復原。', function () {
              delBtn.disabled = true;
              Backend.deleteQuiz(m.id, { cloud: true, github: true }).then(function (r) {
                if (!r.ok) { U.toast('本機刪除失敗', 'bad'); delBtn.disabled = false; return; }
                if (onGithub && r.github === false) {
                  U.toast('試卷已刪除，但 GitHub 副本刪除失敗（請稍後重試）', 'bad');
                } else {
                  U.toast('試卷已刪除', 'ok');
                }
                view.innerHTML = '';
                Teacher.quizzes(view);
              }).catch(function (e) {
                delBtn.disabled = false;
                U.toast('刪除失敗：' + ((e && e.message) || '未知錯誤'), 'bad');
              });
            });
          }
        });
        ops.appendChild(delBtn);
        tr.appendChild(ops);
        tb.appendChild(tr);
      });
      tbl.appendChild(tb);
      box.appendChild(U.el('div.tbl-wrap', {}, [tbl]));
    });
  };

  /* ============================================================
     ③ 學生作答報表
     ============================================================ */
  Teacher.reports = function (view) {
    var box = U.el('div');
    view.appendChild(box);
    if (Teacher._poll) { clearInterval(Teacher._poll); Teacher._poll = null; }

    Promise.all([Backend.listQuizzes(), Backend.listSubmissions()]).then(function (r) {
      var quizzes = r[0], subs = r[1];
      var sel = null;
      draw(RQ._reportQuiz || (quizzes[0] && quizzes[0].id) || null);
      RQ._reportQuiz = null;

      function reload(thenDraw) {
        return Promise.all([Backend.listQuizzes(), Backend.listSubmissions()])
          .then(function (r2) {
            quizzes = r2[0]; subs = r2[1];
            if (thenDraw) draw(sel && sel.value);
          });
      }

      function sourceBadge() {
        var src = Backend.Cloud.lastSource;
        var map = {
          firebase: ['mint', '雲端即時（Firebase）'],
          live: ['mint', '雲端即時（Apps Script）'],
          csv: ['sun', '試算表 CSV 快取（可能延遲 0–5 分鐘）'],
          offline: ['gray', '只讀本機（尚未設定雲端）']
        };
        var m = map[src] || map.offline;
        return U.el('span.tag.' + m[0], {
          text: m[1] + (Backend.Cloud.lastReadAt ? '・' + U.fmtDate(Backend.Cloud.lastReadAt, true).slice(11) : '')
        });
      }

      /* 一次把「已批改但尚未發回」的作答全部發回 */
      function releaseAll(quizId) {
        var targets = (quizId ? subs.filter(function (s) { return s.quizId === quizId; }) : subs)
          .filter(function (s) { return (s.score && s.score.graded) && !s.released; });
        if (!targets.length) {
          U.toast('沒有「已批改但尚未發回」的作答（未批改的不會自動發回）', 'bad', 4000);
          return;
        }
        U.confirm('要把這 ' + targets.length + ' 份已批改的作答發回給學生嗎？\n發回後學生會看到分數、評語與參考答案。', function () {
          Promise.all(targets.map(function (st) {
            st.released = true; st.releasedAt = U.nowISO();
            st.release = { withAnswers: true, at: U.nowISO() };
            return Store.submission.save(st).then(function () { return Backend.saveSubmission(st); });
          })).then(function () {
            U.toast('已發回 ' + targets.length + ' 份', 'ok', 4000);
            return reload(true);
          }).catch(function (e) { U.toast('發回失敗：' + ((e && e.message) || e), 'bad'); });
        });
      }

      function draw(selId) {
        box.innerHTML = '';
        var header = U.el('div.card');
        sel = U.el('select.input', { style: { maxWidth: '320px' } });
        sel.appendChild(U.el('option', { value: '', text: '（全部試卷）' }));
        quizzes.forEach(function (q) { sel.appendChild(U.el('option', { value: q.id, text: q.title })); });
        sel.value = selId || '';
        sel.addEventListener('change', function () { draw(sel.value); });

        var refreshBtn = U.el('button.btn.sm.primary', {
          text: '重新整理',
          onclick: function () {
            refreshBtn.disabled = true; refreshBtn.textContent = '讀取中…';
            reload(true).then(function () {
              refreshBtn.disabled = false; refreshBtn.textContent = '重新整理';
              U.toast('已更新', 'ok', 1200);
            });
          }
        });
        var cbAuto = U.el('input', { type: 'checkbox' });
        cbAuto.checked = !!Teacher._poll;
        cbAuto.addEventListener('change', function () {
          if (Teacher._poll) { clearInterval(Teacher._poll); Teacher._poll = null; }
          if (cbAuto.checked) {
            Teacher._poll = setInterval(function () { reload(true); }, 45000);
            U.toast('已開啟自動更新（每 45 秒）', 'ok');
          }
        });

        header.appendChild(U.el('div.row.between', {}, [
          U.el('div.row', {}, [U.el('label.tiny.muted', { text: '選擇試卷：' }), sel]),
          U.el('div.row', {}, [
            refreshBtn,
            U.el('button.btn.sm', { text: '匯出 CSV', onclick: function () { exportCSV(sel.value, subs); } }),
            U.el('button.btn.sm', { text: '匯出 JSON', onclick: function () { exportJSON(sel.value, subs); } }),
            U.el('button.btn.sm.lav', { text: '發回全部', onclick: function () { releaseAll(sel.value); } })
          ])
        ]));
        header.appendChild(U.el('div.row.between.mt2', {}, [
          U.el('div.row', {}, [
            sourceBadge(),
            U.el('label.check', {}, [cbAuto, U.el('span.tiny', { text: '每 45 秒自動更新' })])
          ]),
          (function () {
            var su = (Settings.get().hook || {}).sheetUrl;
            return su ? U.el('a.btn.sm.ghost', {
              href: su, target: '_blank', rel: 'noopener', text: '直接開試算表（最即時）'
            }) : null;
          })()
        ]));
        box.appendChild(header);

        var list = sel.value ? subs.filter(function (s) { return s.quizId === sel.value; }) : subs;
        var quiz = quizzes.filter(function (q) { return q.id === sel.value; })[0];

        if (!list.length) {
          var tip = Backend.Cloud.lastSource === 'csv'
            ? '若學生剛送出，試算表 CSV 快取可能要幾分鐘才更新，請按「重新整理」或直接用上方「直接開試算表」確認。'
            : (Backend.Cloud.driver() === 'offline'
              ? '目前沒有設定雲端，學生的作答只存在他自己的裝置上，請先到「⑤ 資料與同步」設定。'
              : '學生送出後會出現在這裡。');
          box.appendChild(U.el('div.empty', {}, [
            U.el('div.big', { text: '📝' }),
            U.el('div', { text: '這份試卷還沒有人作答' }),
            U.el('small', { text: tip })
          ]));
          return;
        }

        /* 統計 */
        var scores = list.map(function (s) { return (s.score && s.score.total) || 0; });
        var max = (quiz && quiz.totalMarks) || (list[0].score && list[0].score.max) || 0;
        var avg = scores.reduce(function (a, b) { return a + b; }, 0) / (scores.length || 1);
        var stats = U.el('div.grid.g4.mb0');
        [
          ['作答人次', list.length],
          ['平均分數', (Math.round(avg * 10) / 10) + (max ? ' / ' + max : '')],
          ['平均正確率', U.percent(avg, max) + '%'],
          ['平均用時', U.fmtDur(Math.round(list.reduce(function (a, s) { return a + (s.durationSec || 0); }, 0) / list.length))]
        ].forEach(function (x) {
          stats.appendChild(U.el('div.stat', {}, [U.el('b', { text: String(x[1]) }), U.el('span', { text: x[0] })]));
        });
        box.appendChild(stats);

        /* 明細表 */
        var tbl = U.el('table.tbl');
        tbl.innerHTML = '<thead><tr><th>學生</th><th>提交時間</th><th>得分</th><th>正確率</th><th>用時</th><th>標記</th><th>生詞</th><th>發回</th><th>操作</th></tr></thead>';
        var tb = U.el('tbody');
        list.forEach(function (s) {
          var tr = U.el('tr');
          tr.appendChild(U.el('td', { html: U.esc(s.studentName || s.username || s.studentId) }));
          tr.appendChild(U.el('td', { text: U.fmtDate(s.submittedAt, true) }));
          tr.appendChild(U.el('td', { html: '<b>' + ((s.score && s.score.total) || 0) + '</b> / ' + ((s.score && s.score.max) || max || 0) }));
          var pct = U.percent((s.score && s.score.total) || 0, (s.score && s.score.max) || max || 0);
          tr.appendChild(U.el('td', {}, [
            U.el('div.bar.' + U.barClass(pct), { style: { margin: '0', height: '8px' } }, [U.el('i', { style: { width: pct + '%' } })]),
            U.el('small', { text: pct + '%' })
          ]));
          tr.appendChild(U.el('td', { text: U.fmtDur(s.durationSec) }));
          tr.appendChild(U.el('td', { text: (s.marks || []).length }));
          tr.appendChild(U.el('td', {
            html: (s.vocab || []).length
              ? '<span class="tag pink">' + (s.vocab || []).map(function (v) { return U.esc(v.word); }).join('、') + '</span>'
              : '—'
          }));
          tr.appendChild(U.el('td', {}, [
            s.released
              ? U.el('span.tag.mint', { text: '已發回' })
              : U.el('button.btn.xs.lav', {
                text: '發回', onclick: function () {
                  var graded = !!(s.score && s.score.graded);
                  var go = function () {
                    s.released = true; s.releasedAt = U.nowISO();
                    s.release = { withAnswers: true, at: U.nowISO() };
                    Store.submission.save(s).then(function () { return Backend.saveSubmission(s); })
                      .then(function () { U.toast('已發回給 ' + (s.studentName || s.username || '學生'), 'ok'); return reload(true); })
                      .catch(function (e) { U.toast('發回失敗：' + ((e && e.message) || e), 'bad'); });
                  };
                  if (graded) go();
                  else U.confirm('這份還沒批改完成，確定要直接發回嗎？（學生會看到目前的分數與答案）', go);
                }
              })
          ]));
          tr.appendChild(U.el('td', {}, [
            U.el('button.btn.xs.primary', { text: '查看', onclick: function () { detail(s, quiz); } })
          ]));
          tb.appendChild(tr);
        });
        tbl.appendChild(tb);
        box.appendChild(U.el('div.tbl-wrap', {}, [tbl]));

        /* 誰還沒交 */
        Backend.getRoster().then(function (roster) {
          if (!roster.length) return;
          var doneIds = {};
          list.forEach(function (s) { doneIds[s.studentId] = 1; });
          var notDone = roster.filter(function (st) { return !doneIds[st.id]; });
          var card2 = U.el('div.card.mt3');
          card2.appendChild(U.el('h3', {
            text: '尚未提交（' + notDone.length + ' / ' + roster.length + ' 人）'
          }));
          if (!notDone.length) {
            card2.appendChild(U.el('div.tiny.muted', { text: '全部都交了 🎉' }));
          } else {
            card2.appendChild(U.el('div.row', { style: { gap: '6px', flexWrap: 'wrap' } },
              notDone.map(function (st) {
                return U.el('span.tag.gray', { text: (st.name || st.username) + (st.className ? '（' + st.className + '）' : '') });
              })
            ));
          }
          box.appendChild(card2);
        });
      }
    });
  };

  /**
   * 查看單一學生的作答詳情。
   * 注意：必需要用 Backend.getQuiz() 拿「完整試卷」，
   * listQuizzes() 回傳的只是摘要（沒有 questions），直接拿來用會炸。
   */
  function detail(sub, quiz) {
    var d = U.el('div');
    var loading = U.el('div.empty', { text: '載入試卷題目中…' });
    d.appendChild(loading);
    var m = U.modal({ title: '作答詳情', width: 880, body: d, actions: [{ label: '關閉' }] });

    Promise.resolve(
      (quiz && quiz.questions) ? quiz : Backend.getQuiz(sub.quizId)
    ).then(function (full) {
      d.innerHTML = '';
      renderDetail(d, sub, full);
    }).catch(function (e) {
      d.innerHTML = '';
      d.appendChild(U.el('div.warnbox', { text: '無法載入試卷：' + (e.message || e) }));
    });
    return m;
  }

  function renderDetail(d, sub, quiz) {
    var head = U.el('div.row.between', {}, [
      U.el('div', {}, [
        U.el('h3.mb0', { text: (sub.studentName || sub.username || '') + ' 的作答' }),
        U.el('div.tiny.muted', {
          text: U.fmtDate(sub.submittedAt, true) + '　用時 ' + U.fmtDur(sub.durationSec) +
            '　得分 ' + ((sub.score && sub.score.total) || 0) + ' / ' + ((sub.score && sub.score.max) || 0)
        })
      ])
    ]);
    d.appendChild(head);

    if (!quiz) {
      d.appendChild(U.el('div.warnbox.mt2', { text: '找不到對應試卷，僅顯示原始作答內容。' }));
    }

    /* 發回給學生（發回前學生看不到答案／老師給分／評語） */
    var relCard = U.el('div.card.tinted.mt2');
    var relChk = U.el('input', { type: 'checkbox' });
    relChk.checked = !!(sub.release ? sub.release.withAnswers !== false : true);
    var relState = U.el('div.tiny.mt1', {});
    function paintRel() {
      relState.innerHTML = sub.released
        ? '<span class="tag mint">已發回</span> ' + U.fmtDate(sub.releasedAt || sub.submittedAt, true) +
          (sub.release && sub.release.withAnswers ? '　（已附參考答案）' : '　（未附答案）')
        : '<span class="tag gray">尚未發回</span>　學生目前只看到選擇題自動計分，看不到答案與評語';
    }
    relCard.appendChild(U.el('h3', { text: '發回給學生' }));
    relCard.appendChild(U.el('div.tiny.muted', {
      html: '「發回」之前，學生<b>看不到</b>參考答案、老師給的分數與評語；按下發回後才會一次看到。'
    }));
    relCard.appendChild(relState);
    relCard.appendChild(U.el('label.check.mt2', {}, [
      relChk, U.el('span', { text: '發回時附上試卷所有參考答案與解析' })
    ]));
    relCard.appendChild(U.el('div.row.mt2', {}, [
      U.el('button.btn.sm.primary', { text: '儲存並發回', onclick: function () { doRelease(true); } }),
      U.el('button.btn.sm', { text: '取消發回', onclick: function () { doRelease(false); } })
    ]));
    d.appendChild(relCard);

    /* 畫面上的給分輸入框：發回時一起寫回去，避免老師改了卻沒按「儲存給分」 */
    var markRows = [];
    function doRelease(v) {
      markRows.forEach(function (r) {
        r.ans.manualScore = r.mk.value === '' ? null : (parseFloat(r.mk.value) || 0);
        r.ans.teacherComment = U.trim(r.cm.value);
        sub.answers[r.q.id] = r.ans;
      });
      recalc(sub, quiz);
      if (v) {
        sub.released = true;
        sub.releasedAt = U.nowISO();
        sub.release = { withAnswers: !!relChk.checked, at: U.nowISO() };
      } else {
        sub.released = false;
        sub.releasedAt = null;
        sub.release = null;
      }
      Store.submission.save(sub).then(function () {
        return Backend.saveSubmission(sub);
      }).then(function () {
        U.toast(v ? '已發回給學生，學生重新載入即可看到' : '已取消發回', 'ok', 4000);
        paintRel();
      }).catch(function (e) {
        U.toast('發回失敗：' + ((e && e.message) || e), 'bad');
      });
    }

    (quiz ? quiz.questions : []).forEach(function (q, i) {
      var box = U.el('div.q');
      box.appendChild(U.el('div.q-head', {}, [
        U.el('div.q-no', { text: String(q.no != null ? q.no : i + 1) }),
        U.el('div.q-stem', { html: U.esc(q.stem) + '　<span class="tag sun">' + (q.marks || 0) + ' 分</span>' })
      ]));
      var ans = sub.answers[q.id] || {};
      box.appendChild(U.el('div.ansbox.mt1', {}, [
        U.el('span.lbl', { text: '學生作答' }),
        U.el('div', { html: U.nl2br(RQ.forms.answerText(q, ans)) })
      ]));
      box.appendChild(RQ.forms.reveal(q, ans));

      /* 手動給分 */
      var mk = U.el('input.input', { type: 'number', value: (ans.manualScore != null ? ans.manualScore : ''), placeholder: '0 ~ ' + (q.marks || 0), style: { maxWidth: '110px' } });
      var cm = U.el('input.input', { value: ans.teacherComment || '', placeholder: '評語（學生會看到）' });
      markRows.push({ q: q, ans: ans, mk: mk, cm: cm });
      var saveBtn = U.el('button.btn.xs.primary', {
        text: '儲存給分', onclick: function () {
          ans.manualScore = mk.value === '' ? null : (parseFloat(mk.value) || 0);
          ans.teacherComment = U.trim(cm.value);
          sub.answers[q.id] = ans;
          recalc(sub, quiz);
          Store.submission.save(sub).then(function () {
            Backend.saveSubmission(sub);
            U.toast('已儲存' + (sub.released ? '' : '（學生還看不到，記得按「儲存並發回」）'), 'ok', 3000);
          });
        }
      });
      box.appendChild(U.el('div.inline-fields.mt1', {}, [
        U.el('div', { style: { maxWidth: '140px' } }, [U.el('label.tiny.muted', { text: '老師給分' }), mk]),
        U.el('div', {}, [U.el('label.tiny.muted', { text: '評語' }), cm])
      ]));
      box.appendChild(U.el('div.mt1', {}, [saveBtn]));
      d.appendChild(box);
    });

    /* 標記與筆記 */
    if ((sub.marks || []).length) {
      var mc = U.el('div.card.mt2');
      mc.appendChild(U.el('h3', { text: '螢光標示與筆記（' + sub.marks.length + ' 處）' }));
      sub.marks.forEach(function (m) {
        mc.appendChild(U.el('div.row', { style: { padding: '4px 0', borderBottom: '1px dashed var(--line)' } }, [
          U.el('span.hl.' + (m.color || 'yellow'), { text: m.text, style: { padding: '2px 8px', borderRadius: '6px' } }),
          U.el('span.tiny.muted', { text: m.note || '（無筆記）' })
        ]));
      });
      d.appendChild(mc);
    }
    if ((sub.vocab || []).length) {
      var vc = U.el('div.card.mt2');
      vc.appendChild(U.el('h3', { text: '不懂的詞語（' + sub.vocab.length + '）' }));
      sub.vocab.forEach(function (v) {
        vc.appendChild(U.el('div.row', { style: { padding: '4px 0' } }, [
          U.el('b', { text: v.word, style: { minWidth: '120px' } }),
          U.el('span.tiny.muted', { text: v.note || '' })
        ]));
      });
      d.appendChild(vc);
    }
    if ((sub.notes || []).length) {
      var nc = U.el('div.card.mt2');
      nc.appendChild(U.el('h3', { text: '篇章筆記' }));
      sub.notes.forEach(function (n) {
        nc.appendChild(U.el('div', { html: '<b>' + U.esc(n.pid) + '：</b>' + U.nl2br(n.text) }));
      });
      d.appendChild(nc);
    }

    /* 遠端同步狀態 */
    var syncTxt = sub._synced
      ? '雲端同步：' + sub._synced + (sub._syncError ? '（失敗：' + sub._syncError + '）' : '')
      : '本機記錄';
    d.appendChild(U.el('div.tiny.faint.mt2', { text: syncTxt }));
  }

  function recalc(sub, quiz) {
    var auto = 0, manual = 0, max = quiz ? (quiz.totalMarks || 0) : ((sub.score && sub.score.max) || 0);
    (quiz ? quiz.questions : []).forEach(function (q) {
      var a = sub.answers[q.id] || {};
      var got = RQ.forms.autoScore(q, a);
      if (got !== null) auto += got;
      else if (a.manualScore != null) manual += a.manualScore;
    });
    sub.score = Object.assign({}, sub.score || {}, {
      auto: auto, manual: manual, total: auto + manual, max: max, graded: true
    });
  }

  function exportCSV(quizId, subs) {
    var list = quizId ? subs.filter(function (s) { return s.quizId === quizId; }) : subs;
    var rows = [['學生', '試卷', '提交時間', '用時(秒)', '自動得分', '老師給分', '總分', '滿分', '正確率%', '標記數', '生詞']];
    list.forEach(function (s) {
      var sc = s.score || {};
      rows.push([
        s.studentName || s.username || '', s.quizTitle || '', s.submittedAt || '', s.durationSec || 0,
        sc.auto || 0, sc.manual || 0, sc.total || 0, sc.max || 0,
        U.percent(sc.total || 0, sc.max || 0),
        (s.marks || []).length,
        (s.vocab || []).map(function (v) { return v.word; }).join(' / ')
      ]);
    });
    var csv = rows.map(function (r) {
      return r.map(function (c) { return '"' + String(c).replace(/"/g, '""') + '"'; }).join(',');
    }).join('\r\n');
    U.download('成績報表_' + U.fmtDate(U.nowISO()) + '.csv', '\ufeff' + csv, 'text/csv;charset=utf-8');
  }

  function exportJSON(quizId, subs) {
    var list = quizId ? subs.filter(function (s) { return s.quizId === quizId; }) : subs;
    U.download('作答記錄_' + U.fmtDate(U.nowISO()) + '.json', JSON.stringify(list, null, 2));
  }

  /* ============================================================
     ④ 學生名冊
     ============================================================ */
  Teacher.roster = function (view) {
    var box = U.el('div');
    view.appendChild(box);

    var addCard = U.el('div.card');
    addCard.appendChild(U.el('h3', { text: '新增學生帳號' }));
    var un = U.el('input.input', { placeholder: '登入帳號（英文/數字）' });
    var nm = U.el('input.input', { placeholder: '姓名' });
    var cl = U.el('input.input', { placeholder: '班別（選填）' });
    var pw = U.el('input.input', { placeholder: '密碼' });
    addCard.appendChild(U.el('div.inline-fields', {}, [
      U.el('div', {}, [U.el('label.tiny.muted', { text: '帳號' }), un]),
      U.el('div', {}, [U.el('label.tiny.muted', { text: '姓名' }), nm]),
      U.el('div', {}, [U.el('label.tiny.muted', { text: '班別' }), cl]),
      U.el('div', {}, [U.el('label.tiny.muted', { text: '密碼' }), pw])
    ]));
    addCard.appendChild(U.el('div.mt2.row', {}, [
      U.el('button.btn.primary.sm', {
        text: '新增', onclick: function () {
          var u = U.trim(un.value), p = U.trim(pw.value);
          if (!u || !p) { U.toast('帳號與密碼必填', 'bad'); return; }
          Backend.getRoster().then(function (list) {
            if (list.filter(function (x) { return x.username === u; }).length) { U.toast('此帳號已存在', 'bad'); return; }
            return RQ.crypto.hashPassword(p).then(function (h) {
              return Backend.saveStudent({
                id: U.uid('stu'), username: u, name: U.trim(nm.value) || u,
                className: U.trim(cl.value), pass: h, createdAt: U.nowISO()
              });
            });
          }).then(function () {
            un.value = nm.value = cl.value = pw.value = '';
            U.toast('已新增，並已同步到雲端與 repo（學生任何裝置都能登入）', 'ok', 4200); draw();
          }).catch(function (e) { U.toast('新增失敗：' + ((e && e.message) || e), 'bad', 4200); });
        }
      }),
      U.el('button.btn.sm.ghost', {
        text: '匯入名冊 JSON', onclick: function () {
          U.pickFile('.json', function (f) {
            U.readFileAsText(f).then(function (txt) {
              var arr = JSON.parse(txt);
              if (!Array.isArray(arr)) throw new Error('格式應為陣列');
              return arr.reduce(function (acc, s) {
                return acc.then(function () { return Backend.saveStudent(s); });
              }, Promise.resolve());
            }).then(function () { U.toast('匯入完成', 'ok'); draw(); })
              .catch(function (e) { U.toast('匯入失敗：' + e.message, 'bad'); });
          });
        }
      }),
      U.el('button.btn.sm', {
        text: '下載名冊', onclick: function () {
          Backend.getRoster().then(function (l) { U.download('roster.json', JSON.stringify(l, null, 2)); });
        }
      }),
      U.el('button.btn.sm.sun', {
        text: '同步名冊到所有裝置', onclick: function () {
          Backend.syncRoster().then(function (r) {
            U.toast('名冊已同步（' + r.count + ' 人 · ' + r.channels + ' 個通道）', 'ok', 4000);
          }).catch(function (e) { U.toast('失敗：' + e.message, 'bad'); });
        }
      })
    ]));
    view.appendChild(addCard);

    var listBox = U.el('div.card');
    view.appendChild(listBox);
    draw();

    function draw() {
      Backend.getRoster().then(function (list) {
        listBox.innerHTML = '';
        listBox.appendChild(U.el('h3', { text: '學生名冊（' + list.length + ' 人）' }));
        if (!list.length) {
          listBox.appendChild(U.el('div.tiny.muted', { text: '尚未建立任何學生帳號。' }));
          return;
        }
        var tbl = U.el('table.tbl');
        tbl.innerHTML = '<thead><tr><th>帳號</th><th>姓名</th><th>班別</th><th>建立時間</th><th>操作</th></tr></thead>';
        var tb = U.el('tbody');
        list.forEach(function (s) {
          var tr = U.el('tr');
          tr.appendChild(U.el('td', { text: s.username }));
          tr.appendChild(U.el('td', { text: s.name || '' }));
          tr.appendChild(U.el('td', { text: s.className || '—' }));
          tr.appendChild(U.el('td', { text: U.fmtDate(s.createdAt) }));
          tr.appendChild(U.el('td', {}, [
            U.el('button.btn.xs', {
              text: '重設密碼', onclick: function () {
                var inp = U.el('input.input', { placeholder: '新密碼' });
                U.modal({
                  title: '重設 ' + (s.name || s.username) + ' 的密碼', body: inp,
                  actions: [{ label: '取消' }, {
                    label: '設定', kind: 'primary', onClick: function () {
                      var v = U.trim(inp.value);
                      if (!v) return false;
                      return RQ.crypto.hashPassword(v).then(function (h) {
                        s.pass = h; return Backend.saveStudent(s);
                      }).then(function () { U.toast('已重設', 'ok'); });
                    }
                  }]
                });
              }
            }),
            U.el('button.btn.xs.danger', {
              text: '刪除', style: { marginLeft: '4px' }, onclick: function () {
                U.confirm('刪除 ' + (s.name || s.username) + '？', function () {
                  Store.roster.del(s.id).then(draw);
                });
              }
            })
          ]));
          tb.appendChild(tr);
        });
        tbl.appendChild(tb);
        listBox.appendChild(U.el('div.tbl-wrap', {}, [tbl]));
      });
    }
  };

  /* ============================================================
     ⑤ 資料與同步
     ============================================================ */
  Teacher.data = function (view) {
    var s = Settings.get();

    /* ---------- 雲端同步（學生跨裝置 + 老師即時看到） ---------- */
    var fb = U.el('div.card');
    fb.appendChild(U.el('h3', { text: '① 雲端同步（讓學生用手機／iPad／電腦都能用）' }));
    fb.appendChild(U.el('div.infobox', {
      html: '沒有設定雲端時，學生的作答只存在他自己的瀏覽器裡，你看不到。<br>' +
        '底下<b>任選一種</b>填好並按「啟用並測試」即可：' +
        '<b>Firebase</b>（即時、最順）或 <b>Google Apps Script</b>（免費無上限）。'
    }));

    var fbUrl = U.el('input.input', { value: (s.fb || {}).dbUrl || '', placeholder: 'https://你的專案.firebaseio.com' });
    var fbKey = U.el('input.input', { value: (s.fb || {}).apiKey || '', placeholder: 'Web API Key（AIza…）' });
    var fbCode = U.el('input.input', { value: (s.fb || {}).classCode || '', placeholder: '例如：2A-CHI' });
    fb.appendChild(U.el('div', {}, [U.el('label.tiny.muted', { text: 'Firebase Realtime Database URL' }), fbUrl]));
    fb.appendChild(U.el('div.mt1', {}, [U.el('label.tiny.muted', { text: 'Firebase Web API Key' }), fbKey]));
    fb.appendChild(U.el('div.mt1', {}, [U.el('label.tiny.muted', { text: '班級代碼（所有資料放在這個命名空間下）' }), fbCode]));
    fb.appendChild(U.el('div.mt2.row', {}, [
      U.el('button.btn.primary.sm', {
        text: '啟用 Firebase 並測試', onclick: function () {
          Settings.set({ fb: { enabled: true, dbUrl: U.trim(fbUrl.value), apiKey: U.trim(fbKey.value), classCode: U.trim(fbCode.value) } });
          Backend.Cloud.test().then(function (r) {
            U.toast('雲端連線成功（' + r.driver + '）', 'ok', 3600);
            /* 順手把公開設定寫進 repo：學生的 iPad、其他電腦一開網站就自動連上，
               不必再手動輸入 Database URL／API Key。 */
            return Backend.publishConfig().then(function () {
              U.toast('已把雲端設定發佈給所有裝置', 'ok', 3600);
            }).catch(function () {
              U.toast('雲端可用，但未能發佈設定（請設定 GitHub 後按「發佈設定給所有裝置」）', 'bad', 5000);
            }).then(function () { Teacher.render(view, 'data'); });
          }).catch(function (e) { U.toast('連線失敗：' + e.message, 'bad', 4200); });
        }
      }),
      U.el('button.btn.sm.ghost', {
        text: '停用 Firebase', onclick: function () {
          Settings.set({ fb: { enabled: false } });
          U.toast('已停用'); Teacher.render(view, 'data');
        }
      }),
      U.el('button.btn.sm.lav', {
        text: '發佈設定給所有裝置', onclick: function () {
          Settings.set({ fb: { enabled: true, dbUrl: U.trim(fbUrl.value), apiKey: U.trim(fbKey.value), classCode: U.trim(fbCode.value) } });
          Backend.publishConfig().then(function () {
            U.toast('已寫入 repo 的 data/config.json：學生用 iPad／其他電腦開網站會自動連上雲端', 'ok', 5000);
          }).catch(function (e) { U.toast('發佈失敗：' + e.message, 'bad', 4500); });
        }
      })
    ]));
    fb.appendChild(U.el('div.tiny.faint.mt2', {
      html: 'Firebase 免費額度（Spark）：' +
        'Realtime Database 1 GB 儲存／每月 10 GB 流量，' +
        '一個班級綽綽有餘。<b>API Key 本來就設計成放在前端</b>，' +
        '真正的防護是資料庫規則：' +
        '<code>{"rules":{"rq":{".read":"auth != null",".write":"auth != null"}}}</code>（只允許匿名登入者）。'
    }));
    view.appendChild(fb);

    /* 註冊設定 */
    var reg = U.el('div.card');
    reg.appendChild(U.el('h3', { text: '② 學生註冊方式' }));
    var cbSelf = U.el('input', { type: 'checkbox' });
    cbSelf.checked = !!s.allowSelfRegister;
    var codeInp = U.el('input.input', { value: s.classCode || '', placeholder: '例如 2A-CHI', style: { maxWidth: '220px' } });
    reg.appendChild(U.el('label.check', { style: { display: 'flex', marginBottom: '8px' } }, [
      cbSelf, U.el('span', { text: '開放學生自助註冊（學生填姓名＋自選帳號＋密碼＋班級代碼）' })
    ]));
    reg.appendChild(U.el('div.row', {}, [
      U.el('label.tiny.muted', { text: '班級代碼：' }), codeInp,
      U.el('span.tiny.faint', { text: '（告訴學生這組代碼；Apps Script 端也要填一樣的 CLASS_CODE）' })
    ]));
    reg.appendChild(U.el('div.mt2', {}, [
      U.el('button.btn.primary.sm', {
        text: '儲存註冊設定', onclick: function () {
          Settings.set({ allowSelfRegister: cbSelf.checked, classCode: U.trim(codeInp.value) });
          U.toast('已儲存', 'ok');
        }
      })
    ]));
    reg.appendChild(U.el('div.tiny.faint.mt2', {
      html: '邏輯：學生自助註冊後，帳號會寫進雲端名冊 → 你在「④ 學生名冊」立刻看到 → ' +
        '學生在任何裝置用同一組帳號密碼登入，作答進度與提交結果都跟著帳號走。'
    }));
    view.appendChild(reg);

    var gh = U.el('div.card');
    gh.appendChild(U.el('h3', { text: '③ GitHub 設定（老師端：試卷長期保存）' }));
    gh.appendChild(U.el('div.infobox', {
      html: 'Token 只會存在<b>這台電腦的 localStorage</b>，不會寫進程式碼、也不會上傳。' +
        '建議使用 <b>fine-grained token</b>，只授權單一 repo 的 Contents 讀寫，並設定到期日。'
    }));
    var o = U.el('input.input', { value: s.gh.owner, placeholder: 'GitHub 使用者名稱' });
    var r = U.el('input.input', { value: s.gh.repo, placeholder: 'repo 名稱' });
    var b = U.el('input.input', { value: s.gh.branch, placeholder: 'main' });
    var tk = U.el('input.input', { type: 'password', value: s.gh.token, placeholder: 'ghp_...' });
    gh.appendChild(U.el('div.inline-fields', {}, [
      U.el('div', {}, [U.el('label.tiny.muted', { text: '擁有者 owner' }), o]),
      U.el('div', {}, [U.el('label.tiny.muted', { text: 'repo' }), r]),
      U.el('div', { style: { maxWidth: '140px' } }, [U.el('label.tiny.muted', { text: '分支' }), b]),
      U.el('div', {}, [U.el('label.tiny.muted', { text: 'Personal Access Token' }), tk])
    ]));
    gh.appendChild(U.el('div.mt2.row', {}, [
      U.el('button.btn.primary.sm', {
        text: '儲存並測試連線', onclick: function () {
          Settings.set({ gh: { owner: U.trim(o.value), repo: U.trim(r.value), branch: U.trim(b.value) || 'main', token: U.trim(tk.value) } });
          Backend.GitHub.test().then(function (info) {
            U.toast('連線成功：' + info.full_name, 'ok', 3200);
          }).catch(function (e) { U.toast('連線失敗：' + e.message, 'bad', 3600); });
        }
      }),
      U.el('button.btn.sm.danger', {
        text: '清除 Token', onclick: function () {
          Settings.set({ gh: { token: '' } }); tk.value = '';
          U.toast('已清除本機 Token');
        }
      })
    ]));
    view.appendChild(gh);

    var hk = U.el('div.card');
    hk.appendChild(U.el('h3', { text: '④ 學生作答收集端（Google Apps Script）' }));
    hk.appendChild(U.el('div.infobox', {
      html: '學生不能用你的 Token 寫入 repo，所以提交要經由另一個免費端點。' +
        '最簡單的做法是用 <b>Google Apps Script</b>（免費、無流量上限），程式碼放在 <code>tools/apps-script.gs</code>。' +
        '送出用 Web App 網址；老師讀取用「試算表發佈成 CSV」的網址（Google 允許跨網域讀取）。'
    }));
    var pu = U.el('input.input', { value: s.hook.postUrl, placeholder: 'https://script.google.com/macros/s/.../exec' });
    var gu = U.el('input.input', { value: s.hook.getUrl, placeholder: 'https://docs.google.com/spreadsheets/d/e/.../pub?output=csv' });
    var wk = U.el('input.input', { value: s.hook.key || '', placeholder: '可留空（對應 Apps Script 的 WRITE_KEY）' });
    var su = U.el('input.input', { value: s.hook.sheetUrl || '', placeholder: 'https://docs.google.com/spreadsheets/d/.../edit（選填）' });
    hk.appendChild(U.el('div', {}, [U.el('label.tiny.muted', { text: '送出網址（POST，Web App 的 /exec）' }), pu]));
    hk.appendChild(U.el('div.mt1', {}, [U.el('label.tiny.muted', { text: '讀取網址（GET，試算表發佈成 CSV）' }), gu]));
    hk.appendChild(U.el('div.mt1', {}, [U.el('label.tiny.muted', { text: '試算表網址（選填，報表頁會有「直接開試算表」按鈕）' }), su]));
    hk.appendChild(U.el('div.mt1', {}, [U.el('label.tiny.muted', { text: '寫入金鑰（選填）' }), wk]));
    hk.appendChild(U.el('div.warnbox.mt2', {
      html: '<b>關於即時性：</b>學生一按提交，資料<b>立刻</b>寫進你的 Google 試算表' +
        '（這部分沒有延遲）。但網站的報表是讀「試算表發佈成 CSV」的網址，' +
        'Google 對它有快取，通常 <b>0–5 分鐘</b>才會更新。' +
        '程式會先嘗試即時讀取（/exec），多數瀏覽器會因 CORS 擋住而改走 CSV。' +
        '<b>想要秒級即時，請改用 Firebase。</b>'
    }));
    var cbDraft = U.el('input', { type: 'checkbox' });
    cbDraft.checked = s.cloudDraft !== false;
    hk.appendChild(U.el('div.mt2', {}, [
      U.el('label.check', { style: { display: 'flex' } }, [cbDraft, U.el('span', { text: '學生作答進度同步到雲端（換裝置可接續）' })])
    ]));
    var sm = U.el('select.input', { style: { maxWidth: '260px' } });
    [['offline', '只存本機（離線可用）'], ['webhook', '本機 + 傳到收集端'], ['github', '本機 + 寫入 GitHub repo']].forEach(function (x) {
      sm.appendChild(U.el('option', { value: x[0], text: x[1] }));
    });
    sm.value = s.submitMode || 'offline';
    hk.appendChild(U.el('div.mt2', {}, [U.el('label.tiny.muted', { text: '學生提交方式（若已用 Firebase 就不用改）' }), sm]));
    hk.appendChild(U.el('div.mt2.row', {}, [
      U.el('button.btn.primary.sm', {
        text: '儲存', onclick: function () {
          Settings.set({
            hook: {
              postUrl: U.trim(pu.value), getUrl: U.trim(gu.value),
              key: U.trim(wk.value), sheetUrl: U.trim(su.value)
            },
            submitMode: sm.value, cloudDraft: cbDraft.checked
          });
          U.toast('已儲存', 'ok');
        }
      }),
      U.el('button.btn.sm', {
        text: '測試雲端讀取', onclick: function () {
          Backend.Cloud.getAll('submission').then(function (l) {
            U.toast('讀到 ' + l.length + ' 筆作答（' + Backend.Cloud.driver() + '）', 'ok');
          }).catch(function (e) { U.toast('讀取失敗：' + e.message, 'bad'); });
        }
      }),
      U.el('button.btn.sm', {
        text: '重試未同步的作答', onclick: function () {
          Backend.retryPending().then(function (n) { U.toast('已補送 ' + n + ' 筆', 'ok'); });
        }
      })
    ]));
    view.appendChild(hk);

    var sync = U.el('div.card');
    sync.appendChild(U.el('h3', { text: '⑤ 同步與備份' }));
    sync.appendChild(U.el('div.row', {}, [
      U.el('button.btn.sm', {
        text: '從 repo 拉取試卷', onclick: function () {
          Backend.pullQuizzes().then(function (n) { U.toast('拉取 ' + n + ' 份試卷', 'ok'); })
            .catch(function (e) { U.toast(e.message, 'bad'); });
        }
      }),
      U.el('button.btn.sm', {
        text: '封存作答到 repo', onclick: function () {
          Backend.archiveSubmissions().then(function (n) { U.toast('封存 ' + n + ' 筆', 'ok'); })
            .catch(function (e) { U.toast(e.message, 'bad'); });
        }
      }),
      U.el('button.btn.sm', {
        text: '匯出全部資料（JSON）', onclick: function () {
          Store.exportAll().then(function (b) { U.download('rq-backup-' + U.fmtDate(U.nowISO()) + '.json', JSON.stringify(b, null, 2)); });
        }
      }),
      U.el('button.btn.sm', {
        text: '匯入備份', onclick: function () {
          U.pickFile('.json', function (f) {
            U.readFileAsText(f).then(function (t) {
              var b = JSON.parse(t);
              return Store.importAll(b, 'merge');
            }).then(function () { U.toast('匯入完成', 'ok'); })
              .catch(function (e) { U.toast('匯入失敗：' + e.message, 'bad'); });
          });
        }
      })
    ]));
    sync.appendChild(U.el('div.mt2', {}, [
      U.el('label.check', {}, [
        (function () {
          var c = U.el('input', { type: 'checkbox' });
          c.checked = !!Settings.get().allowRetake;
          c.addEventListener('change', function () { Settings.set({ allowRetake: c.checked }); });
          return c;
        })(),
        U.el('span', { text: '允許學生重複作答同一份試卷' })
      ])
    ]));
    view.appendChild(sync);
  };

  RQ.teacher = Teacher;
})(window.RQ);
