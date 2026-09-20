/* ============================================================
   student.js — 學生端：登入 / 作答 / 對答案 / 螢光筆 / 生詞本
   ============================================================ */
(function (RQ) {
  'use strict';

  var U = RQ.util, Store = RQ.store, Settings = RQ.settings, Backend = RQ.backend;

  /* ============================================================
     表單元件（老師端預覽也會用到）
     ============================================================ */
  var Forms = {};

  /** 渲染一題的作答介面。ans = submission.answers[qid] */
  Forms.input = function (q, ans, opts) {
    opts = opts || {};
    ans = ans || {};
    var wrap = U.el('div.q-input');
    var disabled = !!opts.disabled;

    /* 老師指定「只顯示截圖」：原卷內容以圖片為準，作答用一個通用輸入框 */
    if (q.imageOnly && q.image) {
      var ta0 = U.el('textarea.input', { rows: 4, placeholder: '請在此作答…' });
      ta0.value = ans.value || '';
      if (disabled) ta0.disabled = true;
      else ta0.addEventListener('input', U.debounce(function () {
        opts.onChange && opts.onChange({ value: ta0.value });
      }, 300));
      wrap.appendChild(ta0);
      return wrap;
    }

    /* 配對題：左邊題項、右邊選項籤，可拖拽或點選作答 */
    if (q.type === 'matching' && q.matching) {
      wrap.appendChild(Forms.matchingInput(q, ans, opts));
      return wrap;
    }

    if (q.type === 'mcq') {
      var box = U.el('div.opts');
      var val = Array.isArray(ans.value) ? ans.value.slice() : (ans.value ? [ans.value] : []);
      (q.options || []).forEach(function (o) {
        var checked = val.indexOf(o.key) >= 0;
        var item = U.el('label.opt' + (checked ? '.checked' : ''));
        var input = U.el('input', {
          type: (q.multi ? 'checkbox' : 'radio'),
          name: 'q_' + (opts.uid || '') + q.id,
          value: o.key,
          style: { display: 'none' }
        });
        input.checked = checked;
        if (disabled) input.disabled = true;
        item.appendChild(input);
        item.appendChild(U.el('span.key', { text: o.key }));
        item.appendChild(U.el('span', { html: U.esc(o.text) }));
        if (!disabled) {
          input.addEventListener('change', function () {
            if (!q.multi) {
              val = [o.key];
              U.$$('input', box).forEach(function (i) { i.checked = (i.value === o.key); });
              U.$$('.opt', box).forEach(function (el, i2) {
                el.classList.toggle('checked', i2 === (q.options || []).map(function (x) { return x.key; }).indexOf(o.key));
              });
            } else {
              if (input.checked) { if (val.indexOf(o.key) < 0) val.push(o.key); }
              else val = val.filter(function (x) { return x !== o.key; });
              item.classList.toggle('checked', input.checked);
            }
            val.sort();
            opts.onChange && opts.onChange({ value: val });
          });
        }
        box.appendChild(item);
      });
      if (q.multi) {
        box.appendChild(U.el('div.tiny.faint', { text: '（本題可複選）' }));
      }
      wrap.appendChild(box);

    } else if (q.type === 'table') {
      var tw = (q.fillin && (q.fillin.blanks || []).length)
        ? Forms.fillinInput(q, ans, opts)
        : Forms.tableInput(q, ans, opts);
      /* 保險：若整題還原不出任何可作答元件（例如只有選項標記的單列表格），
         補一個通用作答框，確保每題都答得到 */
      if (typeof tw.querySelector === 'function' && !tw.querySelector('input,select,textarea')) {
        var ta3 = U.el('textarea.input', { rows: 3, placeholder: '請在此作答…' });
        ta3.value = ans.value || '';
        if (disabled) ta3.disabled = true;
        else ta3.addEventListener('input', U.debounce(function () {
          opts.onChange && opts.onChange({ value: ta3.value });
        }, 300));
        tw.appendChild(ta3);
      }
      wrap.appendChild(tw);

    } else {
      var ta = U.el('textarea.input', { rows: 3, placeholder: '請在此作答…' });
      ta.value = ans.value || '';
      if (disabled) ta.disabled = true;
      else ta.addEventListener('input', U.debounce(function () {
        opts.onChange && opts.onChange({ value: ta.value });
      }, 300));
      wrap.appendChild(ta);
    }
    return wrap;
  };

  /** 作答結果純文字化（老師報表用） */
  Forms.answerText = function (q, ans) {
    ans = ans || {};
    if (q.type === 'mcq') {
      var v = Array.isArray(ans.value) ? ans.value : (ans.value ? [ans.value] : []);
      return v.map(function (k) {
        var o = (q.options || []).filter(function (x) { return x.key === k; })[0];
        return k + (o ? '. ' + o.text : '');
      }).join('、') || '（未作答）';
    }
    if (q.type === 'matching' && q.matching) {
      var msub = ans.sub || {};
      return (q.matching.items || []).map(function (it) {
        var k = U.trim(msub[it.id] || '');
        var o = (q.matching.options || []).filter(function (x) { return x.key === k; })[0];
        return (it.label ? it.label + '：' : '') + (k ? k + (o ? '. ' + o.text : '') : '（未作答）');
      }).join('\n');
    }
    if (q.type === 'table') {
      var sub = ans.sub || {};
      if ((q.subQuestions || []).length) {
        return q.subQuestions.map(function (s) {
          return (s.label ? s.label + '：' : '') + (sub[s.id] || '（空白）');
        }).join('\n');
      }
      var filled = Object.keys(sub).filter(function (k) { return U.trim(sub[k]); })
        .map(function (k) {
          /* 對回原表格的列標籤，老師才知道答案對應哪一格／哪一列 */
          var m = /^q\d+_r(\d+)c\d+$/.exec(k);
          if (m && q.table && q.table.rows) {
            var row = q.table.rows[+m[1]] || [];
            var label = row.map(function (c) { return _ct(c); }).filter(Boolean).join(' ');
            if (label) return label + '：' + U.trim(sub[k]);
          }
          return U.trim(sub[k]);
        });
      return filled.length ? filled.join('\n') : '（未作答）';
    }
    return ans.value || '（未作答）';
  };

  /* ============================================================
     表格題：忠實還原成「可填寫」的 HTML 表格
     （保留原卷的表格樣式：填充格 → 輸入框；T/F/NG → 下拉；
      組合選擇格 → 選項按鈕）
     ============================================================ */
  /* 取儲存格最完整的文字：text（含符號轉字母）與 visible（原始可見字）取較長者，
     避免漏字或漏符號造成「表格內容顯示不完整」 */
  function _ct(cell) {
    if (!cell) return '';
    var t = U.trim(cell.text || ''), v = U.trim(cell.visible || '');
    return t.length >= v.length ? t : v;
  }
  function _isFill(cell) {
    var t = _ct(cell);
    if (t === '') return true;
    if (/^[＿_　 \t\r\n]{1,}$/.test(t)) return true;             // 只有底線／空格
    if (/[_＿]/.test(t) && t.length <= 20) return true;          // 底線作答格
    return false;
  }
  function _isHeader(row) {
    if (!row || row.length < 2) return false;
    return row.slice(1).every(function (c) {
      var t = _ct(c);
      return t.length > 0 && t.length <= 10 && !_isFill(c);
    });
  }
  function _mkInput(key, val, sub, opts, maxLen) {
    var inp = U.el('input.input.cell', { type: 'text' });
    inp.value = val || '';
    if (maxLen) {
      inp.setAttribute('maxlength', String(maxLen));
      inp.classList.add('boxinput');
      inp.style.width = Math.min(16, Math.max(4, maxLen * 2.2)) + 'em';
    }
    if (opts.disabled) inp.disabled = true;
    else inp.addEventListener('input', U.debounce(function () {
      sub[key] = inp.value;
      opts.onChange && opts.onChange({ sub: sub });
    }, 300));
    return inp;
  }
  function _mkSelect(key, val, options, sub, opts) {
    var sel = U.el('select.input');
    sel.appendChild(U.el('option', { value: '', text: '— 請選擇 —' }));
    (options || []).filter(Boolean).forEach(function (o) {
      sel.appendChild(U.el('option', { value: o, text: o }));
    });
    sel.value = val || '';
    if (opts.disabled) sel.disabled = true;
    else sel.addEventListener('change', function () {
      sub[key] = sel.value;
      opts.onChange && opts.onChange({ sub: sub });
    });
    return sel;
  }

  /* ---------- 「格內填空」：把文字中的空白／底線換成可輸入的小框 ---------- */
  var BLANK_RE = /( {2,}|\u3000+|[_＿]{2,})/;
  function _isBlankSeg(s) { return /^( {2,}|\u3000+|[_＿]{2,})$/.test(s); }
  function _hasBlank(t) { return BLANK_RE.test(String(t || '')); }
  function _isAllBlankText(t) { return !t || /^[ _\u3000＿]+$/.test(String(t)); }

  function _cellFrag(text, keyBase, sub, opts, firstKey) {
    var box = U.el('span.cellfill');
    var parts = String(text || '').split(BLANK_RE);
    var bi = 0;
    parts.forEach(function (p) {
      if (!p) return;
      if (_isBlankSeg(p)) {
        var key = (bi === 0 && firstKey) ? firstKey : (keyBase + '_b' + bi);
        bi++;
        var inp = U.el('input.input', { type: 'text', style: { width: '86px', display: 'inline-block', padding: '2px 6px', margin: '0 2px' } });
        inp.value = sub[key] || '';
        if (opts.disabled) inp.disabled = true;
        else inp.addEventListener('input', U.debounce(function () { sub[key] = inp.value; opts.onChange && opts.onChange({ sub: sub }); }, 300));
        box.appendChild(inp);
      } else {
        box.appendChild(U.el('span', { text: p }));
      }
    });
    return { node: box, blanks: bi };
  }

  /** 子題要顯示的文字：避免 label 與 prompt 重複（例如「(1)… / (1)　(1)…」） */
  function _pickSubText(s) {
    var lab = U.trim(s.label || ''), pr = U.trim(s.prompt || '');
    if (!pr) return lab;
    if (!lab || lab === pr) return pr;
    if (lab.indexOf(pr) >= 0) return pr;   // label 只是 prompt 加上位置標記 → 用 prompt
    if (pr.indexOf(lab) >= 0) return pr;
    var short = lab.split(' / ').pop();
    if (short && pr.indexOf(short) >= 0) return pr;
    if (short && short !== lab) return short + '　' + pr;
    return lab + '　' + pr;
  }

  function _radioCell(gname, opt, sub, opts, showText) {
    var td = U.el('td');
    var lab = U.el('label.optcell');
    var r = U.el('input', { type: 'radio', name: gname, value: opt });
    r.checked = (sub[gname] === opt);
    if (opts.disabled) r.disabled = true;
    else r.addEventListener('change', function () { sub[gname] = opt; opts.onChange && opts.onChange({ sub: sub }); });
    lab.appendChild(r);
    if (showText) lab.appendChild(U.el('span.optlbl', { text: opt }));
    td.appendChild(lab);
    return td;
  }

  /* 「選擇欄」判定：學生版會以空白或 ○ 呈現，教師版是紅色勾號。
     要看 visible（真正的文字），不能用 _ct —— 否則「(A) ____」這種
     帶底線的填充格會被誤判成選擇格。 */
  function _isChoiceCell(c) {
    if (c === undefined) return true;                 // 該列沒有這一欄 → 不影響判定
    var v = U.trim((c && c.visible) || '');
    if (v === '') return true;                        // 空白＝學生版還沒畫圈
    return /^[○●◯◎]+$/.test(v);
  }

  /* 表頭選項文字：去掉 ○／● 與底線，例：「A○」→「A」 */
  function _cleanOpt(t) {
    return U.trim(String(t || '').replace(/[○●◯◎◆◇]/g, '').replace(/[_＿]+/g, ''));
  }

  /* 儲存格內容（保留原卷粗體／底線；沒有 html 就用純文字） */
  function _cellInner(cell) {
    if (!cell) return '';
    if (cell.html) return String(cell.html).replace(/\n/g, '<br>');
    var t = _ct(cell);
    return t ? U.esc(t) : '';
  }

  /* 把一個儲存格畫進 td/th：填空→就地插入輸入框（保留「(A)」這類前後文字） */
  function _fillCell(td, cell, key, sub, opts, boxLen) {
    var t = _ct(cell);
    if (t && _hasBlank(t) && !_isAllBlankText(t)) {
      td.appendChild(_cellFrag(t, key, sub, opts, key).node);
    } else if (t === '' || _isFill(cell)) {
      td.appendChild(_mkInput(key, sub[key], sub, opts, boxLen));
    } else if (cell && cell.html) {
      td.innerHTML = _cellInner(cell);
    } else {
      td.innerHTML = U.esc(t);
    }
  }

  function _mkTextarea(key, sub, opts) {
    var ta = U.el('textarea.input', { rows: 2 });
    ta.value = sub[key] || '';
    if (opts.disabled) ta.disabled = true;
    else ta.addEventListener('input', U.debounce(function () {
      sub[key] = ta.value;
      opts.onChange && opts.onChange({ sub: sub });
    }, 300));
    return ta;
  }

  /* 子題列表（沒有原始表格，或子題對不回表格時的保底版面） */
  function _subList(q, subs, sub, opts, wrap) {
    var t = U.el('table.qtable');
    (subs || []).forEach(function (s) {
      var tr = U.el('tr');
      var labTd = U.el('td.qt-label');
      var disp = _pickSubText(s);
      if (_hasBlank(disp) && !_isAllBlankText(disp)) {
        /* 題目文字本身含填空位置（如「(1) 第　段」）→ 直接在文字中插入輸入框 */
        labTd.appendChild(_cellFrag(disp, s.id + '_p', sub, opts, s.id).node);
        labTd.setAttribute('colspan', '2');
        tr.appendChild(labTd);
      } else {
        labTd.innerHTML = U.nl2br(U.esc(disp));
        tr.appendChild(labTd);
        var td = U.el('td.qt-ans');
        if (s.kind === 'tick' && (s.choices || []).length) {
          td.appendChild(_mkSelect(s.id, sub[s.id], s.choices.filter(Boolean), sub, opts));
        } else {
          td.appendChild(_mkTextarea(s.id, sub, opts));
        }
        tr.appendChild(td);
      }
      t.appendChild(tr);
    });
    wrap.appendChild(t);
    return wrap;
  }

  /* 判斷題右欄：正確／錯誤／無從判斷 三個單選（橫向排列） */
  function _tfngRadios(key, options, sub, opts) {
    var box = U.el('span.tfng-opts');
    var name = 'tf_' + key;
    var list = (options && options.filter(Boolean).length) ? options.filter(Boolean) : ['正確', '錯誤', '無從判斷'];
    list.forEach(function (o) {
      var lab = U.el('label.tfng-opt');
      var r = U.el('input', { type: 'radio', name: name, value: o });
      r.checked = (sub[key] === o);
      if (opts.disabled) r.disabled = true;
      else r.addEventListener('change', function () { sub[key] = o; opts.onChange && opts.onChange({ sub: sub }); });
      lab.appendChild(r);
      lab.appendChild(U.el('span', { text: o }));
      box.appendChild(lab);
    });
    return box;
  }

  Forms.tableInput = function (q, ans, opts) {
    opts = opts || {};
    var sub = ans.sub || {};
    var wrap = U.el('div.qtable-wrap');
    var rows = (q.table && q.table.rows) || [];
    var subs = (q.subQuestions || []).slice();

    /* 字數限制格子：表頭寫「答案須是四個字」→ 輸入框限長＋窄版 */
    var boxLen = 0;
    var CND = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 };
    rows.slice(0, 2).forEach(function (row) {
      (row || []).forEach(function (c) {
        var m = _ct(c).match(/答案[須须]要?\s*是?\s*([一二三四五六七八九十\d]+)\s*個字/);
        if (m) boxLen = CND[m[1]] || parseInt(m[1], 10) || 0;
      });
    });

    /* 子題 → 原表格儲存格：子題 id 形如 q<題號>_<列>_<欄>（解析時產生），
       用它把輸入框放回原本那一格，表格版面才不會被壓成兩欄、內容才不會掉。 */
    var subAt = {}, used = {};
    subs.forEach(function (s) {
      var m = /^q\d+_(\d+)_(\d+)$/.exec(String(s.id || ''));
      if (m) subAt[m[1] + '_' + m[2]] = s;
    });

    /* 1) 正確／錯誤／無從判斷（T/F/NG）：左欄敘述、右欄三個選項 */
    if (q.tableType === 'tfng') {
      if (subs.length) {
        var t1 = U.el('table.qtable.tfng');
        subs.forEach(function (s) {
          var tr = U.el('tr');
          tr.appendChild(U.el('td.qt-stmt', { html: U.nl2br(s.prompt || s.label || '') }));
          var td = U.el('td.qt-ans');
          td.appendChild(_tfngRadios(s.id, s.choices || [], sub, opts));
          tr.appendChild(td);
          t1.appendChild(tr);
        });
        wrap.appendChild(t1);
        return wrap;
      }
      var hi = _isHeader(rows[0]) ? 0 : -1;
      var opts1 = hi >= 0 ? rows[hi].slice(1).map(_ct).filter(Boolean) : ['正確', '錯誤', '無從判斷'];
      var t2 = U.el('table.qtable.tfng');
      rows.slice(hi >= 0 ? hi + 1 : 0).forEach(function (row, bi) {
        var label = _ct(row[0]);
        if (!label) return;
        var tr = U.el('tr');
        tr.appendChild(U.el('td.qt-stmt', { text: label }));
        var td = U.el('td.qt-ans');
        td.appendChild(_tfngRadios(q.id + '_tf' + bi, opts1, sub, opts));
        tr.appendChild(td);
        t2.appendChild(tr);
      });
      wrap.appendChild(t2);
      return wrap;
    }

    /* 2) 沒有原始表格 → 退回子題列表（保底） */
    if (!rows.length) return _subList(q, subs, sub, opts, wrap);

    var dataRows = rows.slice(1);

    /* 表頭列：取第一個「整列短文字」且該列沒有對應子題的列
       （有些卷子的表頭不在第一列，例如第一列是 A/B/C/D 選項說明） */
    var headIdx = -1;
    rows.forEach(function (row, ri) {
      if (headIdx >= 0) return;
      if (!_isHeader(row)) return;
      var hasSub = row.some(function (c, ci) { return ci > 0 && subAt[ri + '_' + ci]; });
      if (!hasSub) headIdx = ri;
    });

    /* 選擇欄：某欄在「所有」資料列都是 ○／空白（學生版未畫圈）才算，
       否則一律照原表還原 —— 這樣才不會把填充表誤判成勾選表而吃掉內容。 */
    function rowGridW(row) {                       // 這一列佔幾個「欄」（合併格算多欄）
      var n = 0;
      (row || []).forEach(function (c) { if (!c || c.vmerge === 'continue') return; n += (c.span || 1); });
      return n;
    }
    var nCols = rows.reduce(function (m, r) { return Math.max(m, rowGridW(r)); }, 0);
    /* 有些原卷的列少畫了格子（作者按 Tab 不齊）→ 補空白格，欄位才對得齊表頭 */
    function padRow(tr, cols) {
      for (var k = nCols - cols; k > 0; k--) tr.appendChild(U.el('td.pad', { html: '&nbsp;' }));
    }
    var optCols = [];
    if (headIdx >= 0 && dataRows.length) {
      for (var ci = 1; ci < nCols; ci++) {
        var allChoice = dataRows.every(function (r) { return _isChoiceCell(r[ci]); });
        if (allChoice) optCols.push(ci);
      }
    }
    var tick = optCols.length >= 2;
    function optLabel(ci) {
      var t = headIdx >= 0 ? _ct(rows[headIdx][ci]) : '';
      return _cleanOpt(t) || String.fromCharCode(65 + Math.max(0, ci - 1));
    }

    var tbl = U.el('table.qtable' + (tick ? '.qtick' : ''));   /* 不可用 .grid：
       那是版面用的 display:grid，套在 table 上會破壞欄位對齊 */

    /* 表頭列 —— 第一格（表頭欄的標題，如「引文」「片段」「事物」）也要畫出來 */
    if (headIdx >= 0) {
      var htr = U.el('tr'), hUsed = 0;
      rows[headIdx].forEach(function (c, ci) {
        if (c && c.vmerge === 'continue') return;
        var th = U.el('th');
        if (tick && ci > 0) th.appendChild(U.el('span.optlbl', { text: optLabel(ci) }));
        else th.innerHTML = _cellInner(c) || '&nbsp;';
        if (c && (c.span || 1) > 1) th.setAttribute('colspan', String(c.span));
        hUsed += (c && c.span) || 1;
        htr.appendChild(th);
      });
      padRow(htr, hUsed);
      tbl.appendChild(htr);
    }

    /* 資料列：逐列逐格還原，不跳過任何一列（含表頭欄） */
    rows.forEach(function (row, ri) {
      if (ri === headIdx || !row.length) return;
      var rowSubs = row.map(function (c, ci) { return subAt[ri + '_' + ci]; }).filter(Boolean);
      var allEmpty = row.every(function (c) { return !_ct(c) && !(c && c.sym); });
      if (allEmpty && !rowSubs.length) return;

      /* 勾選列：整列共用一個選項群組；若該列對應到唯一子題，就用子題 id 當作答鍵，
         這樣學生選的欄位標題（＝答案名稱）會存進 ans.sub[子題]，對答案才對得上。 */
      var tickKey = null;
      if (tick) {
        tickKey = (rowSubs.length === 1) ? rowSubs[0].id : (q.id + '_tick_r' + ri);
      }
      if (tickKey && rowSubs.length === 1) used[rowSubs[0].id] = true;

      var tr = U.el('tr'), rUsed = 0;
      row.forEach(function (cell, ci) {
        if (cell && cell.vmerge === 'continue') return;
        rUsed += (cell && cell.span) || 1;
        var s = subAt[ri + '_' + ci];
        if (s) used[s.id] = true;

        /* ① 勾選欄 → 單選（選項名稱取表頭，如「肖像描寫」） */
        if (tick && optCols.indexOf(ci) >= 0 && ci > 0) {
          tr.appendChild(_radioCell(tickKey, optLabel(ci), sub, opts));
          return;
        }
        /* ② 子題是勾選（有 choices，但該表不是勾選格）→ 下拉選單 */
        if (s && s.kind === 'tick' && (s.choices || []).length) {
          var tdS = U.el('td');
          tdS.appendChild(_mkSelect(s.id, sub[s.id], s.choices.filter(Boolean), sub, opts));
          tr.appendChild(tdS);
          return;
        }
        /* ③ 一般格：第一欄且該列有作答 → 用 th 當表頭欄，表格結構才完整 */
        var isRowHead = ci === 0 && row.length > 1 && !s && !_isFill(cell) && _ct(cell).length <= 40;
        var td = U.el(isRowHead ? 'th' : 'td');
        if (cell && (cell.span || 1) > 1) td.setAttribute('colspan', String(cell.span));
        _fillCell(td, cell, s ? s.id : (q.id + '_r' + ri + 'c' + ci), sub, opts, boxLen);
        tr.appendChild(td);
      });
      padRow(tr, rUsed);
      tbl.appendChild(tr);
    });
    wrap.appendChild(tbl);

    /* 沒能對回原表格的子題 → 補在表格下方，確保一個都不漏 */
    var orphans = subs.filter(function (s) { return !used[s.id]; });
    if (orphans.length) wrap.appendChild(_subList(q, orphans, sub, opts, U.el('div')));
    return wrap;
  };

  /* ---------- 配對題：拖拽／點選作答 ---------- */
  Forms.matchingInput = function (q, ans, opts) {
    opts = opts || {};
    ans = ans || {};
    var sub = ans.sub || (ans.sub = {});
    var M = q.matching;
    var wrap = U.el('div.match');
    var sel = { key: '' };

    var itemsBox = U.el('div.match-items');
    var optsBox = U.el('div.match-opts',
      M.options && M.options.length ? [U.el('div.match-optstitle.tiny.muted', { text: '選項（點選或拖到左邊格子）' })] : []);

    function paintSel() {
      Object.keys(chips).forEach(function (k) {
        chips[k].classList[sel.key === k ? 'add' : 'remove']('sel');
      });
    }
    var chips = {};
    (M.options || []).forEach(function (o) {
      var chip = U.el('span.match-chip', { text: o.key + '. ' + o.text, draggable: opts.disabled ? null : 'true' });
      chip.addEventListener('click', function () {
        if (opts.disabled) return;
        sel.key = (sel.key === o.key) ? '' : o.key;
        paintSel();
      });
      chip.addEventListener('dragstart', function (e) {
        if (opts.disabled) { e.preventDefault(); return; }
        sel.key = o.key;
        paintSel();
        try { e.dataTransfer.setData('text/plain', o.key); } catch (err) { }
      });
      chips[o.key] = chip;
      optsBox.appendChild(chip);
    });

    (M.items || []).forEach(function (it) {
      var row = U.el('div.match-item');
      row.appendChild(U.el('div.match-label', { html: U.nl2br(U.esc(it.label || '')) }));
      var slot = U.el('span.match-slot' + (sub[it.id] ? '.filled' : ''), { text: sub[it.id] || '＿' });
      function assign(k) {
        if (k) sub[it.id] = k; else delete sub[it.id];
        slot.textContent = k || '＿';
        slot.classList[k ? 'add' : 'remove']('filled');
        opts.onChange && opts.onChange({ sub: sub });
        paintSel();
      }
      slot.addEventListener('click', function () {
        if (opts.disabled) return;
        if (sub[it.id]) { assign(''); return; }     /* 已填 → 點一下清除 */
        if (sel.key) assign(sel.key);
      });
      slot.addEventListener('dragover', function (e) {
        if (opts.disabled) return;
        e.preventDefault(); slot.classList.add('over');
      });
      slot.addEventListener('dragleave', function () { slot.classList.remove('over'); });
      slot.addEventListener('drop', function (e) {
        e.preventDefault(); slot.classList.remove('over');
        if (opts.disabled) return;
        var k = '';
        try { k = e.dataTransfer.getData('text/plain'); } catch (err) { }
        if (k) assign(k);
      });
      row.appendChild(slot);
      itemsBox.appendChild(row);
    });

    wrap.appendChild(U.el('div.match-grid', {}, [itemsBox, optsBox]));
    return wrap;
  };

  /* ---------- 摘要／筆記填充：原文中就地把空白換成輸入框 ---------- */
  Forms.fillinInput = function (q, ans, opts) {
    opts = opts || {};
    ans = ans || {};
    var sub = ans.sub || (ans.sub = {});
    var F = q.fillin || { text: '', blanks: [] };
    var box = U.el('div.fillin');
    var blanks = F.blanks || [];
    /* 依原文切開：(a) ______ 的位置插入輸入框，其餘照原文顯示 */
    var parts = String(F.text || '').split(/(\([a-z0-9]{1,3}\)[\s\u3000]*(?:_{2,}|＿{2,}|\.{3,}|—{2,}))/g);
    var bi = 0;
    parts.forEach(function (seg) {
      if (!seg) return;
      var m = /^\(([a-z0-9]{1,3})\)/.exec(seg);
      var b = (m && bi < blanks.length) ? blanks[bi++] : null;
      if (b) {
        box.appendChild(U.el('span.blk-lbl', { text: '(' + b.key + ')' }));
        var inp = U.el('input.input.boxinput', { type: 'text', placeholder: '答案' });
        inp.value = sub[b.id] || '';
        if (opts.disabled) inp.disabled = true;
        else inp.addEventListener('input', U.debounce(function () {
          sub[b.id] = inp.value;
          opts.onChange && opts.onChange({ sub: sub });
        }, 300));
        box.appendChild(inp);
      } else {
        box.appendChild(U.el('span', { text: seg }));
      }
    });
    var wrap = U.el('div.q-input');
    wrap.appendChild(box);
    return wrap;
  };

  Forms.quotesBlock = function (q) {
    if (!(q.quotes && q.quotes.length)) return null;
    var box = U.el('div.q-quotes');
    var hi = (q.quotesHtml && q.quotesHtml.length) ? q.quotesHtml : null;
    q.quotes.forEach(function (qt, i) {
      /* 有保留原卷樣式（粗體／底線）就用 html；否則純文字 */
      var inner = hi && hi[i] ? hi[i].replace(/\n/g, '<br>') : U.nl2br(U.esc(qt));
      box.appendChild(U.el('blockquote.q-quote', { html: inner }));
    });
    return box;
  };

  /** 自動批改：只有選擇題能自動 */
  Forms.autoScore = function (q, ans) {
    if (q.type === 'mcq') {
      if (!q.answerKeys || !q.answerKeys.length) return null;
      var v0 = (ans && Array.isArray(ans.value)) ? ans.value.slice().sort() : [];
      var k0 = q.answerKeys.slice().sort();
      if (v0.length !== k0.length) return 0;
      for (var i0 = 0; i0 < k0.length; i0++) if (v0[i0] !== k0[i0]) return 0;
      return q.marks || 0;
    }
    /* 摘要填空：逐格比對（忽略大小寫與多餘空白） */
    if (q.fillin && (q.fillin.blanks || []).length) {
      var bs = q.fillin.blanks.filter(function (b) { return U.trim(b.answer || ''); });
      if (!bs.length) return null;
      var ssub = (ans && ans.sub) || {};
      var okN = bs.filter(function (b) {
        return U.trim(ssub[b.id] || '').toLowerCase().replace(/[\s\u3000]/g, '') ===
          String(b.answer).toLowerCase().replace(/[\s\u3000]/g, '');
      }).length;
      return Math.round((q.marks || 0) * okN / bs.length * 10) / 10;
    }
    /* 配對題／判斷題：客觀題，逐格比對（老師仍可手動調分） */
    if ((q.type === 'matching' && q.matching) || (q.tableType === 'tfng' && (q.subQuestions || []).length)) {
      var pairs = q.type === 'matching'
        ? (q.matching.items || []).map(function (it) { return { id: it.id, a: q.matching.answers[it.id] }; })
        : (q.subQuestions || []).map(function (x) { return { id: x.id, a: x.answer }; });
      if (!pairs.length) return null;
      var answerable = pairs.filter(function (p) { return U.trim(p.a || ''); });
      if (!answerable.length) return null;                  // 沒有參考答案 → 留給老師批改
      var sub = (ans && ans.sub) || {};
      var correct = answerable.filter(function (p) {
        return U.trim(sub[p.id] || '').toUpperCase() === String(p.a).trim().toUpperCase();
      }).length;
      var got = (q.marks || 0) * correct / answerable.length;
      return Math.round(got * 10) / 10;
    }
    return null;
  };

  /** 顯示正確答案 */
  Forms.reveal = function (q, ans) {
    var box = U.el('div.reveal');
    var got = Forms.autoScore(q, ans);
    box.appendChild(U.el('div.k', {
      text: got === null ? '參考答案' : (got > 0 ? '✔ 答對（' + got + ' / ' + (q.marks || 0) + ' 分）' : '✘ 答錯')
    }));
    if (q.type === 'matching' && q.matching) {
      var M = q.matching;
      var mt = U.el('table.tbl');
      mt.innerHTML = '<thead><tr><th>題項</th><th>你的答案</th><th>正確答案</th></tr></thead>';
      var mtb = U.el('tbody');
      (M.items || []).forEach(function (it) {
        var my = U.trim((ans.sub || {})[it.id] || '');
        var correct = M.answers[it.id] || '';
        var oc = (M.options || []).filter(function (x) { return x.key === correct; })[0];
        var tr = U.el('tr');
        tr.appendChild(U.el('td', { html: U.esc(it.label) }));
        tr.appendChild(U.el('td', { html: my ? U.esc(my) : '—' }));
        tr.appendChild(U.el('td', {
          html: correct ? '<b>' + U.esc(correct) + '</b>' + (oc ? '. ' + U.esc(oc.text) : '') : '—'
        }));
        mtb.appendChild(tr);
      });
      mt.appendChild(mtb);
      box.appendChild(mt);
      return box;
    }
    if (q.type === 'mcq') {
      box.appendChild(U.el('div', {
        html: '正確選項：<b>' + U.esc((q.answerKeys || []).join('、') || '—') + '</b>' +
          (q.answer ? '　' + U.nl2br(q.answer) : '')
      }));
    } else if (q.type === 'table' && (q.subQuestions || []).length) {
      var sub = (ans && ans.sub) || {};
      var tbl = U.el('table.tbl');
      tbl.innerHTML = '<thead><tr><th>子題</th><th>你的作答</th><th>參考答案</th></tr></thead>';
      var tb = U.el('tbody');
      q.subQuestions.forEach(function (s) {
        var tr = U.el('tr');
        tr.appendChild(U.el('td', { html: U.esc(s.label || '') }));
        tr.appendChild(U.el('td', { html: U.nl2br(sub[s.id] || '—') }));
        tr.appendChild(U.el('td', { html: U.nl2br(s.answer || '—') }));
        tb.appendChild(tr);
      });
      tbl.appendChild(tb);
      box.appendChild(tbl);
      if (q.answer) box.appendChild(U.el('div', { html: U.nl2br(q.answer), class: 'mt1' }));
    } else if (q.type === 'table') {
      var sub2 = (ans && ans.sub) || {};
      var keys = Object.keys(sub2).filter(function (k) { return U.trim(sub2[k]); });
      box.appendChild(U.el('div', {
        html: '你的填答：<br>' + (keys.length ? U.nl2br(keys.map(function (k) { return U.esc(sub2[k]); }).join('\n')) : '（空白）')
      }));
      if (q.answer) box.appendChild(U.el('div', { html: U.nl2br(q.answer), class: 'mt1' }));
    } else {
      box.appendChild(U.el('div', { html: U.nl2br(q.answer || '（尚未提供答案）') }));
    }
    if (q.explanation) {
      box.appendChild(U.el('div.mt1.tiny', { html: '<b>解析：</b>' + U.nl2br(q.explanation) }));
    }
    return box;
  };

  RQ.forms = Forms;

  /* ============================================================
     學生端頁面
     ============================================================ */
  var Student = {};

  Student.login = function (view) {
    var set = Settings.get();
    var canRegister = !!set.allowSelfRegister || !!(set.hook && set.hook.postUrl);

    /* 上一次 Google 登入的結果（被擋掉／取消／失敗）——登入頁要自己說明白，
       因為使用者可能剛剛才從 Google 頁面被帶回來，沒看到任何 toast。 */
    function googleNotice() {
      var G = RQ.googleAuth;
      if (!G || !G.lastError) return null;
      var e = G.lastError;
      G.lastError = null;                       /* 只顯示一次 */
      if (e.code === 'rq/local-cancel') {
        return { kind: 'muted', text: '上次的 Google 登入沒有完成（你取消了）。可以再試一次，或改用帳號密碼。' };
      }
      return { kind: 'bad', text: e.text };
    }

    function draw(mode) {
      view.innerHTML = '';
      var card = U.el('div.card', { style: { maxWidth: '440px', margin: '26px auto' } });
      var notice = googleNotice();

      var tabs = U.el('div.row', { style: { gap: '6px', marginBottom: '14px' } }, [
        U.el('button.btn.sm' + (mode === 'login' ? '.primary' : ''), {
          text: '登入', onclick: function () { draw('login'); }
        })
      ]);
      if (canRegister) {
        tabs.appendChild(U.el('button.btn.sm' + (mode === 'reg' ? '.primary' : ''), {
          text: '第一次使用・註冊', onclick: function () { draw('reg'); }
        }));
      }
      card.appendChild(tabs);

      if (mode === 'login') {
        card.appendChild(U.el('h2', { text: '學生登入' }));
        if (notice) card.appendChild(noticeBox(notice));
        var un = U.el('input.input', { placeholder: '使用者帳號' });
        var pw = U.el('input.input', { type: 'password', placeholder: '密碼' });
        card.appendChild(field('帳號', un));
        card.appendChild(U.el('div', { style: { height: '8px' } }));
        card.appendChild(field('密碼', pw));
        var btn = U.el('button.btn.primary.block.mt2', {
          text: '登入', onclick: function () { doLogin(U.trim(un.value), pw.value); }
        });
        card.appendChild(btn);
        pw.addEventListener('keydown', function (e) { if (e.key === 'Enter') doLogin(U.trim(un.value), pw.value); });

        var gb = googleBlock(notice);
        if (gb) card.appendChild(gb);

        view.appendChild(card);
        un.focus();
        return;
      }

      /* ---- 註冊 ---- */
      card.appendChild(U.el('h2', { text: '註冊帳號' }));
      if (!set.allowSelfRegister) {
        card.appendChild(U.el('div.warnbox', {
          text: '老師尚未開啟自助註冊。若你已有老師給的帳號，請改用「登入」。'
        }));
        view.appendChild(card);
        return;
      }
      if (notice) card.appendChild(noticeBox(notice));
      var rName = U.el('input.input', { placeholder: '例如：陳小明' });
      var rClass = U.el('input.input', { placeholder: '例如：2A（可留空）' });
      var rUser = U.el('input.input', { placeholder: '英文或數字，例如 ming123' });
      var rPw = U.el('input.input', { type: 'password', placeholder: '至少 4 個字' });
      var rCode = U.el('input.input', { placeholder: '向老師索取' });
      var rMail = U.el('input.input', { type: 'email', placeholder: '你的 Google 電子郵件' });
      card.appendChild(field('姓名', rName));
      card.appendChild(field('班別（選填）', rClass));
      card.appendChild(field('自選帳號', rUser));
      card.appendChild(field('自訂密碼', rPw));
      card.appendChild(field('班級代碼', rCode));
      /* 先填好 email → 之後用 Google 登入會自動認出你，不必再綁定一次。
         沒填也能註冊，只是第一次用 Google 登入時要多做一次綁定。 */
      var mailField = field('Google 電子郵件（選填，但強烈建議）', rMail);
      card.appendChild(mailField);
      card.appendChild(U.el('div.tiny.faint', {
        text: '填了之後，以後按「使用 Google 登入」就會直接進站。',
        style: { marginTop: '-4px', marginBottom: '8px' }
      }));
      card.appendChild(U.el('button.btn.primary.block.mt2', {
        text: '註冊並登入', onclick: function () { doRegister(); }
      }));
      var gr = googleBlock(notice, { register: true, mail: rMail });
      if (gr) card.appendChild(gr);
      view.appendChild(card);

      function doRegister() {
        var u = U.trim(rUser.value), p = U.trim(rPw.value), n = U.trim(rName.value);
        var mail = U.trim(rMail.value).toLowerCase();
        if (!u || !p || !n) { U.toast('姓名、帳號、密碼都要填', 'bad'); return; }
        if (p.length < 4) { U.toast('密碼至少 4 個字', 'bad'); return; }
        if (/\s/.test(u)) { U.toast('帳號不能有空格', 'bad'); return; }
        if (mail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) { U.toast('電子郵件格式看起來不對', 'bad'); return; }
        Backend.getRoster().then(function (list) {
          if (list.some(function (s) { return String(s.username).toLowerCase() === u.toLowerCase(); })) {
            U.toast('這個帳號已經有人用了，換一個試試', 'bad');
            return null;
          }
          /* email 是「同一個 Email ＝同一位使用者」的依據，不能重複登記 */
          if (mail && list.some(function (s) { return String(s.email || '').toLowerCase() === mail; })) {
            U.toast('這個電子郵件已經有人用了，請確認是不是你自己的帳號', 'bad', 4200);
            return null;
          }
          return RQ.crypto.hashPassword(p).then(function (h) {
            var stu = {
              id: U.uid('stu'), username: u, name: n,
              className: U.trim(rClass.value), pass: h,
              classCode: U.trim(rCode.value),
              createdAt: U.nowISO(), selfRegistered: true
            };
            if (mail) stu.email = mail;
            return Backend.registerStudent(stu).then(function () { return stu; });
          });
        }).then(function (stu) {
          if (!stu) return;
          Settings.login({ role: 'student', id: stu.id, name: stu.name, username: stu.username, method: 'password' });
          U.toast('註冊成功，歡迎 ' + stu.name, 'ok');
          RQ.route();
        }).catch(function (e) { U.toast('註冊失敗：' + e.message, 'bad'); });
      }
    }

    function field(label, input) {
      var d = U.el('div');
      d.appendChild(U.el('label.tiny.muted', { text: label }));
      d.appendChild(input);
      return d;
    }

    function noticeBox(n) {
      return U.el('div' + (n.kind === 'bad' ? '.warnbox' : '.infobox'), { text: n.text });
    }

    /** 登入成功 → 導回「原本造訪的頁面」（沒有就回學生首頁） */
    function enterAsStudent(stu, method) {
      Settings.login({
        role: 'student', id: stu.id,
        name: stu.name || stu.username, username: stu.username,
        className: stu.className || '',
        method: method || 'password',
        email: String(stu.email || '')
      });
      U.toast('歡迎，' + (stu.name || stu.username), 'ok');
      var back = RQ.googleAuth ? RQ.googleAuth.takeReturn() : '';
      /* 只接受站內雜湊路徑，避免被塞進外部網址 */
      if (back && /^#\/[A-Za-z]/.test(back)) location.hash = back;
      else location.hash = '#/student';
      if (RQ.route) RQ.route();
    }

    function doLogin(name, pass) {
      if (!name || !pass) { U.toast('請輸入帳號與密碼', 'bad'); return; }
      U.toast('驗證中…', null, 1200);
      Backend.loadConfig().then(function () { return Backend.getRoster(); }).then(function (list) {
        var stu = list.filter(function (s) {
          return String(s.username).toLowerCase() === String(name).toLowerCase();
        })[0];
        if (!stu) { U.toast('找不到此帳號，請確認或改用註冊', 'bad', 3000); return; }
        return RQ.crypto.verifyPassword(pass, stu.pass).then(function (ok) {
          if (!ok) { U.toast('密碼不正確', 'bad'); return; }
          enterAsStudent(stu, 'password');
        });
      }).catch(function (e) { U.toast('登入失敗：' + e.message, 'bad'); });
    }

    /* ---------- Google 帳號登入 ---------- */

    /** 官方「G」標誌（四色），畫成 inline SVG，不依賴外部圖片 */
    function gIcon() {
      var NS = 'http://www.w3.org/2000/svg';
      var svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('viewBox', '0 0 48 48');
      svg.setAttribute('width', '18');
      svg.setAttribute('height', '18');
      svg.setAttribute('aria-hidden', 'true');
      [
        ['#EA4335', 'M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z'],
        ['#4285F4', 'M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z'],
        ['#FBBC05', 'M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z'],
        ['#34A853', 'M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z']
      ].forEach(function (p) {
        var el = document.createElementNS(NS, 'path');
        el.setAttribute('fill', p[0]);
        el.setAttribute('d', p[1]);
        svg.appendChild(el);
      });
      return svg;
    }

    /**
     * 「使用 Google 登入」按鈕。登入頁與註冊頁共用。
     * opts.register：在註冊頁使用時，若上面已經填了 email，就當作
     * 「我要用這個 Google 帳號」——登入後直接認領（同一 Email＝同一位使用者）。
     */
    function googleBlock(notice, opts) {
      opts = opts || {};
      var G = RQ.googleAuth;
      if (!G || !G.available()) return null;
      var box = U.el('div.mt3');
      box.appendChild(U.el('div.tiny.muted', { text: '或', style: { textAlign: 'center' } }));
      var hint = U.el('div.tiny.mt1');
      var gbtn = U.el('button.btn.block.mt1', {
        style: {
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
          background: '#fff', color: '#3A322A', border: '1.5px solid #ECE5D9'
        }
      });
      gbtn.appendChild(gIcon());
      gbtn.appendChild(document.createTextNode(opts.register ? '使用 Google 帳號登入／註冊' : '使用 Google 登入'));
      gbtn.addEventListener('click', function () {
        gbtn.disabled = true;
        hint.textContent = '';
        U.toast('正在開啟 Google 登入…', null, 2000);
        G.signIn().then(function (p) {
          if (p && p.redirect) return;                 /* 轉址中，本頁會被導走 */
          return afterGoogle(p, opts);
        }).catch(function (e) {
          gbtn.disabled = false;
          hint.innerHTML = '';
          hint.appendChild(U.el('span.bad', { text: G.errorText(e) }));
        });
      });
      box.appendChild(gbtn);
      box.appendChild(hint);
      box.appendChild(U.el('div.tiny.muted.mt1', {
        text: '第一次使用時，會請你把 Google 帳號連結到老師建立的名冊帳號。'
      }));
      return box;
    }

    /**
     * Google 登入成功後：
     *   ① 名冊上已經有這個 Google 帳號 → 直接進站
     *   ② 名冊上登記了同一個 email → 自動連結並進站（同一個 Email 視為同一位使用者）
     *   ③ 都沒有 → 進連結頁
     * ★ 不論走哪條路，最後的身分都是名冊的 stu.id（絕不用 Google UID）。
     */
    function afterGoogle(p, opts) {
      opts = opts || {};
      if (!p || !p.uid) {
        /* 走到這裡代表「沒有拿到帳號」——最常見的原因是使用者在 Google 視窗
           自己按了取消／返回。那不是故障，所以用中性提示、不要標成紅色錯誤，
           否則學生會以為網站壞了，反而去點第二次。真正的原因
           （rq/local-cancel 等）由 GoogleAuth.lastError 記著，下次開登入頁會說明。 */
        U.toast('已取消 Google 登入，尚未登入', null, 3000);
        return Promise.resolve(null);
      }
      /* 註冊頁：先用上面填的 email 認領，避免又多一次綁定 */
      var wantMail = String((opts.mail && opts.mail.value) || '').trim().toLowerCase();
      return Backend.resolveGoogleStudent(p).then(function (stu) {
        if (stu) return linkIfNeeded(stu, p);
        if (!wantMail) return null;
        return Backend.findByEmail(wantMail).then(function (byMail) {
          if (byMail) return linkIfNeeded(byMail, p);
          return null;
        });
      }).then(function (done) {
        if (done) return null;
        drawBind(p);
        return null;
      }).catch(function (e) {
        U.toast('讀取名冊失敗：' + ((e && e.message) || e), 'bad', 5000);
      });
    }

    /** 名冊上有這個 email／已綁同一個 UID → 直接進站；還沒綁就順便綁起來 */
    function linkIfNeeded(stu, p) {
      if (stu.googleUid === p.uid) {
        enterAsStudent(stu, 'google');
        return Promise.resolve(true);
      }
      return Backend.bindGoogle(stu.id, p).then(function (bound) {
        U.toast('已連結你的 Google 帳號', 'ok', 3200);
        enterAsStudent(bound, 'google');
        return true;
      }).catch(function (e) {
        /* 例如這個 email 已登記給別人：不要硬綁，走正常連結頁讓老師處理 */
        U.toast('無法自動連結：' + ((e && e.message) || e), 'bad', 6000);
        return false;
      });
    }

    /** 連結頁：把這個 Google 帳號接到名冊上的某一位學生 */
    function drawBind(p) {
      view.innerHTML = '';
      var card = U.el('div.card', { style: { maxWidth: '480px', margin: '26px auto' } });
      card.appendChild(U.el('h2', { text: '綁定你的帳號' }));
      card.appendChild(U.el('div.tiny.muted', {
        text: '已用 ' + (p.email || p.name) + ' 登入。請將它綁定到老師給你的帳號，之後就能一鍵登入。'
      }));
      if (p.email) {
        card.appendChild(U.el('div.infobox.mt2', {
          html: '名冊上還沒有登記 <b>' + U.esc(p.email) + '</b>。'
            + '若你的老師已經幫你填過這個電子郵件，請按「重新檢查一次」。'
        }));
        var reBtn = U.el('button.btn.sm.block', {
          text: '重新檢查一次', onclick: function () {
            reBtn.disabled = true;
            Backend.resolveGoogleStudent(p).then(function (stu) {
              if (!stu) { U.toast('名冊上還是沒有這個電子郵件，請改用下面的方式', 'bad', 4200); reBtn.disabled = false; return; }
              return linkIfNeeded(stu, p);
            }).catch(function () { reBtn.disabled = false; });
          }
        });
        card.appendChild(reBtn);
      }

      var labels = ['① 用老師給的帳密', '② 從名單選自己'];
      var mode = 0;
      var tabRow = U.el('div.row.mt3', { style: { gap: '6px' } });
      var body = U.el('div.mt2');
      labels.forEach(function (t, i) {
        tabRow.appendChild(U.el('button.btn.sm' + (i === 0 ? '.primary' : ''), {
          text: t, onclick: function () {
            mode = i;
            U.$$('button', tabRow).forEach(function (b, j) {
              b.className = 'btn sm' + (j === i ? ' primary' : '');
            });
            paint();
          }
        }));
      });
      card.appendChild(tabRow);
      card.appendChild(body);
      view.appendChild(card);
      paint();

      function paint() { if (mode === 0) paintPw(); else paintPick(); }

      function paintPw() {
        body.innerHTML = '';
        var un = U.el('input.input', { placeholder: '老師給你的帳號' });
        var pw = U.el('input.input', { type: 'password', placeholder: '密碼' });
        body.appendChild(field('帳號', un));
        body.appendChild(U.el('div', { style: { height: '8px' } }));
        body.appendChild(field('密碼', pw));
        body.appendChild(U.el('button.btn.primary.block.mt2', {
          text: '綁定並開始使用', onclick: function () {
            var name = U.trim(un.value), pass = pw.value;
            if (!name || !pass) { U.toast('請輸入帳號與密碼', 'bad'); return; }
            Backend.getRoster().then(function (list) {
              var stu = list.filter(function (s) {
                return String(s.username).toLowerCase() === name.toLowerCase();
              })[0];
              if (!stu) { U.toast('找不到此帳號，請確認或改用「從名單選自己」', 'bad', 4200); return null; }
              return RQ.crypto.verifyPassword(pass, stu.pass).then(function (ok) {
                if (!ok) { U.toast('密碼不正確', 'bad'); return null; }
                if (stu.googleUid && stu.googleUid !== p.uid) {
                  U.toast('這個帳號已經綁過其他 Google 帳號了', 'bad', 4500);
                  return null;
                }
                return Backend.bindGoogle(stu.id, p).then(function (bound) {
                  U.toast('綁定完成', 'ok');
                  enterAsStudent(bound, 'google');
                }).catch(function (e) {
                  U.toast('綁定失敗：' + ((e && e.message) || e), 'bad', 6000);
                  return null;
                });
              });
            }).catch(function (e) { U.toast('綁定失敗：' + ((e && e.message) || e), 'bad', 5500); });
          }
        }));
      }

      function paintPick() {
        body.innerHTML = '';
        body.appendChild(U.el('div.tiny.muted', { text: '載入名單中…' }));
        /* 班級代碼是「防止誤選」的門檻，不是真正的安全機制（名冊本來就是公開檔）。
           老師有設就要求輸入；沒設就直接顯示名單。 */
        var code = U.trim(Settings.get().classCode || '');
        var codeInp = null;
        var wrap = null;
        var list = [];

        Backend.getRoster().then(function (rows) {
          list = rows || [];
          body.innerHTML = '';
          if (code) {
            codeInp = U.el('input.input', { placeholder: '向老師索取' });
            body.appendChild(field('班級代碼', codeInp));
            codeInp.addEventListener('input', U.debounce(renderList, 250));
          }
          wrap = U.el('div.mt2', { style: { maxHeight: '260px', overflow: 'auto' } });
          body.appendChild(wrap);
          renderList();
        }).catch(function (e) {
          body.innerHTML = '';
          body.appendChild(U.el('div.warnbox', { text: '讀取名冊失敗：' + ((e && e.message) || e) }));
        });

        function renderList() {
          if (!wrap || !wrap.isConnected) return;
          wrap.innerHTML = '';
          if (code && (!codeInp || U.trim(codeInp.value) !== code)) {
            wrap.appendChild(U.el('div.tiny.muted', { text: '輸入班級代碼後會顯示可選的名單。' }));
            return;
          }
          if (!list.length) {
            wrap.appendChild(U.el('div.tiny.muted', { text: '名冊是空的，請老師先建立你的帳號。' }));
            return;
          }
          list.forEach(function (s) {
            var bound = !!s.googleUid;
            var own = bound && s.googleUid === p.uid;
            var btn = U.el('button.btn.sm.block', {
              style: { marginTop: '6px', textAlign: 'left' },
              text: (s.className ? '（' + s.className + '）' : '') + (s.name || s.username)
                + (own ? '　—　這是你' : (bound ? '　—　已綁定其他帳號' : ''))
            });
            btn.disabled = bound;
            btn.addEventListener('click', function () {
              U.confirm('確定你是「' + (s.name || s.username) + '」嗎？綁定後不能自行更改。', function () {
                Backend.bindGoogle(s.id, p).then(function (bound2) {
                  U.toast('綁定完成', 'ok');
                  enterAsStudent(bound2, 'google');
                }).catch(function (e) { U.toast('綁定失敗：' + ((e && e.message) || e), 'bad', 6000); });
              });
            });
            wrap.appendChild(btn);
          });
        }
      }
    }

    /* enterAsStudent 與導回原頁的邏輯統一定義在上面（兩個入口共用同一套） */

    /* 讓導覽列也能走同一條 Google 流程（RQ.student.loginGoogle） */
    Student._afterGoogle = afterGoogle;
    Student._drawBind = drawBind;
    Student._enterAsStudent = enterAsStudent;

    draw('login');

    /* 剛剛若是用「轉址」方式去 Google 登入，回到本頁時要把結果接回來 */
    if (RQ.googleAuth) {
      RQ.googleAuth.handleRedirect().then(function (p) { if (p) afterGoogle(p); })
        .catch(function () { });
    }
  };

  /**
   * 導覽列的 Google 登入入口：直接吃「已取得的 Google 帳號資料」。
   * 流程與學生登入頁完全一樣（同一個 afterGoogle），
   * 差別只在於：若需要綁定，會先把使用者帶到學生登入頁再顯示連結畫面。
   */
  Student.loginGoogle = function (p) {
    /* 沒有帳號資料＝使用者取消了（見 afterGoogle 的說明），中性處理 */
    if (!p || !p.uid) { RQ.util.toast('已取消 Google 登入，尚未登入', null, 3000); return Promise.resolve(null); }
    var view = document.getElementById('view');
    if (RQ.util.trim(location.hash) !== '#/student') {
      location.hash = '#/student';          /* 綁定畫面掛在學生登入頁底下 */
    }
    if (RQ.route) RQ.route();
    /* route() 之後 DOM 已重建，再交給共用的流程接手 */
    return RQ.backend.resolveGoogleStudent(p).then(function (stu) {
      if (stu) {
        if (stu.googleUid === p.uid) { Student._enterAsStudent(stu, 'google'); return null; }
        return RQ.backend.bindGoogle(stu.id, p).then(function (bound) {
          RQ.util.toast('已連結你的 Google 帳號', 'ok', 3200);
          Student._enterAsStudent(bound, 'google');
          return null;
        }).catch(function (e) {
          RQ.util.toast('無法自動連結：' + ((e && e.message) || e), 'bad', 6000);
          return null;
        });
      }
      /* 沒對上 → 顯示連結畫面（沿用學生登入頁那一套） */
      Student._drawBind(p);
      return null;
    }).catch(function (e) {
      RQ.util.toast('讀取名冊失敗：' + ((e && e.message) || e), 'bad', 5000);
      return null;
    });
  };

  Student.home = function (view) {
    var who = Settings.who();
    view.innerHTML = '';

    view.appendChild(U.el('div.hero.mb0', {}, [
      U.el('div.hero-body', {}, [U.el('h1', { text: '哈囉，' + (who.name || '同學') })])
    ]));

    var box = U.el('div.mt3');
    view.appendChild(box);

    Promise.all([
      Backend.listQuizzes(),
      Backend.mySubmissions(who.id).catch(function () { return Store.submission.ofStudent(who.id); }),
      Backend.myVocab(who.id).catch(function () { return []; }),
      Backend.getRoster().catch(function () { return []; })
    ]).then(function (r) {
      var quizzes = r[0].filter(function (q) { return q.published !== false || q._src === 'local'; });
      var mine = r[1] || [];
      var myVocab = r[2] || [];
      /* 班別可能被老師改過 → 以名冊的最新值為準，否則「依班別指派」的作業會看不到 */
      var fromRoster = (r[3] || []).filter(function (s) { return s && s.id === who.id; })[0] || {};
      var me = { id: who.id, className: U.trim(fromRoster.className || who.className || '') };
      if (me.className !== (who.className || '')) {
        Settings.set({ session: Object.assign({}, who, { className: me.className }) });
      }
      box.innerHTML = '';

      if (!quizzes.length) {
        box.appendChild(U.el('div.empty', {}, [
          U.el('div.big', { text: '📚' }),
          U.el('div', { text: '目前還沒有試卷' }),
          U.el('small', { text: '請老師先上傳並發佈試卷' })
        ]));
        return;
      }

      /* 年級排序用（小學 → 中學） */
      var GRADES = ['小一', '小二', '小三', '小四', '小五', '小六',
        '中一', '中二', '中三', '中四', '中五', '中六'];
      /* 與老師端共用同一套判定（含「依班別指派」），避免兩邊規則不一致 */
      function isAssigned(m) { return Backend.isAssigned(m, me); }
      function doneOf(m) { return mine.filter(function (s) { return s.quizId === m.id; }); }
      function quizCard(m, done, isHomework) {
        var card = U.el('div.card.mb0' + (isHomework && !done.length ? '.tinted' : ''));
        card.appendChild(U.el('div.row.between', {}, [
          U.el('h3.mb0', { html: U.esc(m.title) }),
          done.length ? U.el('span.tag.mint', { text: '已完成 ' + done.length + ' 次' }) : U.el('span.tag', { text: '未作答' })
        ]));
        card.appendChild(U.el('div.tiny.muted.mt1', {
          text: (m.level ? m.level + '・' : '') + (m.subject ? m.subject + '・' : '') +
            (m.questionCount || 0) + ' 題・' + (m.totalMarks || 0) + ' 分'
        }));
        if (m.assignment && (m.assignment.due || m.assignment.note)) {
          card.appendChild(U.el('div.tiny.mt1', {
            html: '<span class="tag.sun">作業</span> ' +
              (m.assignment.due ? '截止 ' + U.esc(m.assignment.due) : '') +
              (m.assignment.note ? '　' + U.esc(m.assignment.note) : '')
          }));
        }
        if (done.length) {
          var last = done[0];
          card.appendChild(U.el('div.tiny.mt1', {
            html: '上次得分：<b>' + (last.score ? last.score.total : 0) + '</b> / ' + (last.score ? last.score.max : 0) +
              '　（' + U.fmtDate(last.submittedAt, true) + '）'
          }));
        }
        var btns = U.el('div.row.mt2', {}, [
          U.el('a.btn.primary.sm', { href: '#/quiz/' + m.id, text: done.length ? '再作答一次' : '開始作答' })
        ]);
        if (done.length) {
          btns.appendChild(U.el('a.btn.sm', { href: '#/result/' + done[0].id, text: '查看上次結果' }));
        }
        card.appendChild(btns);
        return card;
      }

      var assignedList = quizzes.filter(isAssigned);
      /* 「指派後才看得到」：預設只顯示老師指派給我的試卷。
         老師若把 ⑤ 的開關關掉，才會一併列出其他已發佈試卷。 */
      var assignOnly = Settings.get().assignOnly !== false;
      var others = assignOnly ? [] : quizzes.filter(function (m) { return !isAssigned(m); });

      if (assignOnly && !assignedList.length) {
        box.appendChild(U.el('div.empty', {}, [
          U.el('div.big', { text: '📌' }),
          U.el('div', { text: '目前沒有老師指派的試卷' }),
          U.el('small', { text: '老師指派作業後，這裡就會出現，並顯示截止日期。' })
        ]));
        box.appendChild(U.el('h2.mt3', { text: '我的生詞本' }));
        box.appendChild(vocabBook(myVocab));
        return;
      }

      if (assignedList.length) {
        var todo = assignedList.filter(function (m) { return !doneOf(m).length; });
        var doneA = assignedList.filter(function (m) { return doneOf(m).length; });
        box.appendChild(U.el('h2.mt3', { text: '📌 老師指派的作業' }));
        if (todo.length) {
          var g0 = U.el('div.grid.g2');
          todo.forEach(function (m) { g0.appendChild(quizCard(m, doneOf(m), true)); });
          box.appendChild(g0);
        } else {
          box.appendChild(U.el('div.tiny.muted', { text: '指派的作業都完成了，太厲害了！🎉' }));
        }
        if (doneA.length) {
          box.appendChild(U.el('div.tiny.muted.mt1', {
            text: '已完成：' + doneA.map(function (m) { return m.title; }).join('、')
          }));
        }
      }

      if (others.length) {
        box.appendChild(U.el('h2.mt3', { text: assignedList.length ? '其他試卷' : '可作答的試卷' }));
        var map = {}, order = [];
        others.forEach(function (m) {
          var g = m.level || '其他';
          if (!map[g]) { map[g] = []; order.push(g); }
          map[g].push(m);
        });
        order.sort(function (a, b) {
          var ia = GRADES.indexOf(a), ib = GRADES.indexOf(b);
          if (ia < 0) ia = 99; if (ib < 0) ib = 99;
          return ia - ib;
        });
        order.forEach(function (g) {
          if (order.length > 1) box.appendChild(U.el('h3.mt2', { text: g }));
          var grid = U.el('div.grid.g2');
          map[g].forEach(function (m) { grid.appendChild(quizCard(m, doneOf(m), false)); });
          box.appendChild(grid);
        });
      }

      /* 生詞本（合併：已提交的作答 + 作答中的草稿；本機 + 雲端） */
      box.appendChild(U.el('h2.mt3', { text: '我的生詞本' }));
      box.appendChild(vocabBook(myVocab));
    });
  };

  /** vocab：生詞陣列 [{word, note, ts, ...}]（已由 Backend.myVocab 去重合併） */
  function vocabBook(vocab) {
    var words = (vocab || []).filter(function (v) { return v && U.trim(v.word || ''); });
    if (!words.length) {
      return U.el('div.empty', {}, [
        U.el('div.big', { text: '🔖' }),
        U.el('small', { text: '還沒有收集生詞。作答時選取不懂的詞語，按「加入生詞本」即可。' })
      ]);
    }
    var wrap = U.el('div.card');
    words.forEach(function (v) {
      wrap.appendChild(U.el('div.row.between', {
        style: { borderBottom: '1px dashed var(--line)', padding: '6px 0' }
      }, [
        U.el('b', { text: v.word }),
        U.el('span.tiny.muted', { text: v.note || '' })
      ]));
    });
    return wrap;
  }

  /* ============================================================
     作答頁
     ============================================================ */
  var _session = null;         // {quiz, submission, hls:[], startAt}
  var _unloadHandler = null;   // 離開頁面前把雲端草稿補送出去

  /* ---------- 分卷/分篇：把題目切成可分別提交的群組 ---------- */
  /* 實際要作答的題目（略過「段落劃分／概括題」等不適合線上作答者） */
  function activeQs(quiz) {
    return ((quiz && quiz.questions) || []).filter(function (q) { return !q.skip; });
  }
  function activeMarks(quiz) {
    return activeQs(quiz).reduce(function (a, q) { return a + (q.marks || 0); }, 0);
  }
  function groupQuestions(quiz) {
    var qs = activeQs(quiz);
    var hasSection = qs.some(function (q) { return q.section; });
    if (hasSection) {
      var map = {}, order = [];
      qs.forEach(function (q) {
        var k = q.section || '其他';
        if (!map[k]) { map[k] = []; order.push(k); }
        map[k].push(q);
      });
      return order.map(function (k) {
        return {
          key: 'sec:' + k, label: k, questions: map[k],
          marks: map[k].reduce(function (a, q) { return a + (q.marks || 0); }, 0)
        };
      });
    }
    var ps = (quiz && quiz.passages) || [];
    if (ps.length > 1) {
      var pm = {}, po = [];
      qs.forEach(function (q) {
        var k = q.passageId || (ps[0] && ps[0].id) || 'p1';
        if (!pm[k]) { pm[k] = []; po.push(k); }
        pm[k].push(q);
      });
      /* 只保留真的有題目的篇章，並依原順序編號 */
      var withQ = po.filter(function (k) { return pm[k].length; });
      return withQ.map(function (k, i) {
        var p = ps.filter(function (x) { return x.id === k; })[0];
        return {
          key: 'pass:' + k,
          label: '第 ' + (i + 1) + ' 篇' + (p && p.title ? '：' + p.title : ''),
          questions: pm[k],
          marks: pm[k].reduce(function (a, q) { return a + (q.marks || 0); }, 0)
        };
      });
    }
    return [{ key: 'all', label: '', questions: qs, marks: (quiz && quiz.totalMarks) || 0 }];
  }
  function scopeKey(s) { return (s && s.scope && s.scope.key) ? s.scope.key : null; }
  function isGroupSubmitted(past, key) {
    return (past || []).some(function (s) {
      if (!s.submittedAt) return false;
      var k = scopeKey(s);
      return k === null ? true : k === key;   // 無 scope 代表整份卷，涵蓋全部群組
    });
  }
  function groupSubmission(past, key) {
    return (past || []).filter(function (s) {
      return s.submittedAt && (scopeKey(s) === null || scopeKey(s) === key);
    })[0];
  }

  /** 真的找不到試卷時的說明（不要只丟一句「找不到」讓學生卡住） */
  function quizNotFound(view, quizId) {
    view.innerHTML = '';
    view.appendChild(U.el('div.card.center', {}, [
      U.el('div.big', { text: '🔍' }),
      U.el('h2', { text: '找不到這份試卷' }),
      U.el('p.muted', {
        html: '可能原因：<br>' +
          '① 老師尚未按「發佈到 GitHub」（草稿只有老師的裝置看得到）<br>' +
          '② 剛發佈，GitHub Pages 還在更新（通常 1 分鐘內）<br>' +
          '③ 這台裝置還沒有同步到雲端'
      }),
      U.el('div.tiny.faint', { text: '試卷編號：' + quizId }),
      U.el('div.row.mt2', { style: { justifyContent: 'center' } }, [
        U.el('button.btn.primary', {
          text: '重新載入', onclick: function () { Student.take(view, quizId); }
        }),
        U.el('a.btn', { href: '#/student', text: '回學生專區' })
      ])
    ]));
  }

  Student.take = function (view, quizId, _retried) {
    view.innerHTML = '<div class="empty">載入試卷中…</div>';
    var who = Settings.who();

    Promise.all([
      Backend.getQuiz(quizId),
      Backend.mySubmissions(who.id).catch(function () { return Store.submission.ofStudent(who.id); })
    ]).then(function (r) {
      var quiz = r[0];
      if (!quiz) {
        /* 剛發佈的試卷可能還沒同步到 CDN，稍等再試一次 */
        if (!_retried) {
          view.innerHTML = '<div class="empty">正在讀取試卷…</div>';
          setTimeout(function () { Student.take(view, quizId, true); }, 1800);
          return;
        }
        quizNotFound(view, quizId);
        return;
      }
      var past = (r[1] || []).filter(function (s) { return s.quizId === quizId; });
      var groups = groupQuestions(quiz);
      var grouped = groups.length > 1;
      var allDone = grouped
        ? groups.every(function (g) { return isGroupSubmitted(past, g.key); })
        : past.length > 0;
      if (allDone && !Settings.get().allowRetake) {
        view.innerHTML = '';
        var doneSubs = grouped
          ? groups.map(function (g) { return groupSubmission(past, g.key); }).filter(Boolean)
          : [past[0]];
        var links = U.el('div.row', { style: { justifyContent: 'center', flexWrap: 'wrap', gap: '6px' } });
        doneSubs.forEach(function (s) {
          links.appendChild(U.el('a.btn.sm', {
            href: '#/result/' + s.id,
            text: (s.scope && s.scope.label ? s.scope.label + '：' : '') + '查看結果'
          }));
        });
        view.appendChild(U.el('div.card.center', {}, [
          U.el('h2', { text: grouped ? '你已經作答過這份試卷' : '你已經作答過這份試卷' }),
          U.el('p.muted', { text: '如需重做，請先請老師開啟「允許重複作答」。' }),
          links,
          U.el('div.row.mt2', { style: { justifyContent: 'center' } }, [
            U.el('a.btn', { href: '#/student', text: '回學生專區' })
          ])
        ]));
        return;
      }
      startQuiz(view, quiz, who, past.length + 1, past);
    });
  };

  function startQuiz(view, quiz, who, attempt, past) {
    past = past || [];
    var sub = {
      id: U.uid('sub'),
      quizId: quiz.id,
      quizTitle: quiz.title,
      studentId: who.id,
      studentName: who.name,
      username: who.username,
      attempt: attempt,
      startedAt: U.nowISO(),
      submittedAt: null,
      answers: {},
      marks: [],
      vocab: [],
      notes: [],
      score: null
    };
    _session = { quiz: quiz, sub: sub, hls: [], startAt: Date.now(), view: view };

    view.innerHTML = '';

    /* 頂端列 */
    var bar = U.el('div.card.tinted', {});
    var timerEl = U.el('b', { text: '00:00' });
    bar.appendChild(U.el('div.row.between', {}, [
      U.el('div', {}, [
        U.el('h2.mb0', { html: U.esc(quiz.title) }),
        U.el('div.tiny.muted', { text: (quiz.level ? quiz.level + '・' : '') + activeQs(quiz).length + ' 題・共 ' + activeMarks(quiz) + ' 分' })
      ]),
      U.el('div.row', {}, [
        U.el('span.tiny.muted', { text: '已用時間 ' }), timerEl,
        U.el('span', { style: { width: '10px' } }), saveState
      ])
    ]));
    var prog = U.el('div.bar.mt1');
    var progFill = U.el('i', { style: { width: '0%' } });
    prog.appendChild(progFill);
    bar.appendChild(prog);
    var progTxt = U.el('div.tiny.faint', { text: '作答進度 0 / ' + activeQs(quiz).length });
    bar.appendChild(progTxt);
    view.appendChild(bar);

    var timer = setInterval(function () {
      var s = Math.floor((Date.now() - _session.startAt) / 1000);
      timerEl.textContent = Math.floor(s / 60) + ':' + (s % 60 < 10 ? '0' : '') + (s % 60);
    }, 1000);
    _session.timer = timer;

    /* 主體：左文章、右題目 */
    var grid = U.el('div.grid', { style: { gridTemplateColumns: 'minmax(0,1.05fr) minmax(0,1fr)' } });
    if (window.innerWidth < 900) grid.style.gridTemplateColumns = '1fr';

    var left = U.el('div');
    (quiz.passages || []).forEach(function (p) {
      var card = U.el('div.card.mb0', { style: { marginBottom: '14px' } });
      var holder = U.el('div.passage');
      card.appendChild(holder);
      var hl = new RQ.Highlighter({
        container: holder,
        passage: p,
        marks: sub.marks,
        vocab: sub.vocab,
        onChange: function (marks, vocab) {
          var grew = (vocab || []).length !== (sub.vocab || []).length;
          sub.marks = marks; sub.vocab = vocab;
          /* 生詞有變動就立刻存（含雲端），學生專區的生詞本才馬上看得到 */
          autosave(grew);
        }
      });
      _session.hls.push(hl);

      var noteBox = U.el('div.mt2');
      noteBox.appendChild(U.el('label.tiny.muted', { text: '這一篇文章的整體筆記' }));
      var nt = U.el('textarea.input', { rows: 2, placeholder: '例如：主旨是…' });
      nt.addEventListener('input', U.debounce(function () {
        sub.notes = sub.notes.filter(function (n) { return n.pid !== p.id; });
        if (U.trim(nt.value)) sub.notes.push({ id: U.uid('nt'), pid: p.id, text: U.trim(nt.value), ts: U.nowISO() });
        autosave();
      }, 400));
      noteBox.appendChild(nt);
      card.appendChild(noteBox);
      left.appendChild(card);
    });
    grid.appendChild(left);

    var right = U.el('div');
    var groups = groupQuestions(quiz);
    var grouped = groups.length > 1;
    right.appendChild(U.el('h3', { text: grouped ? '題目（可分段提交）' : '題目' }));
    if (grouped) {
      right.appendChild(U.el('div.tiny.muted.mb1', {
        text: '本卷分為 ' + groups.length + ' 個部分，你可以逐部分作答，並分別提交。'
      }));
    }
    groups.forEach(function (g) {
      var locked = grouped && isGroupSubmitted(past, g.key);
      var box = U.el('div');
      if (grouped) {
        box.appendChild(U.el('div.row.between.mt3', {}, [
          U.el('h3.mb0', { text: g.label + '（' + g.questions.length + ' 題・' + g.marks + ' 分）' }),
          locked ? U.el('span.tag.mint', { text: '✔ 已提交' }) : U.el('span.tag.gray', { text: '未提交' })
        ]));
      }
      g.questions.forEach(function (q, i) {
        box.appendChild(questionCard(quiz, q, i, sub, autosave, updateProgress, locked));
      });

      var foot = U.el('div.card.center.mt2');
      if (!grouped) {
        foot.appendChild(U.el('div.tiny.muted', { text: '提交後即可看到正確答案；老師會收到你的作答、標記與生詞。' }));
        foot.appendChild(U.el('div.row.mt2', { style: { justifyContent: 'center' } }, [
          U.el('button.btn.primary', { text: '提交作答', onclick: function () { submit(quiz, sub, view, null); } })
        ]));
      } else if (locked) {
        var gs = groupSubmission(past, g.key);
        foot.appendChild(U.el('div.tiny.muted', { text: '這部分已提交，無法再修改。' }));
        if (gs) {
          foot.appendChild(U.el('div.row.mt1', { style: { justifyContent: 'center' } }, [
            U.el('a.btn.sm', { href: '#/result/' + gs.id, text: '查看「' + g.label + '」結果' })
          ]));
        }
      } else {
        foot.appendChild(U.el('div.tiny.muted', { text: '提交後即可看到這部分的答案，其他部分不受影響。' }));
        foot.appendChild(U.el('div.row.mt2', { style: { justifyContent: 'center' } }, [
          U.el('button.btn.primary', { text: '提交「' + g.label + '」', onclick: function () { submit(quiz, sub, view, g); } })
        ]));
      }
      box.appendChild(foot);
      right.appendChild(box);
    });
    grid.appendChild(right);
    view.appendChild(grid);

    var saveState = U.el('span.tiny.faint', { text: '' });
    var _lastCloud = 0;

    function autosave(force) {
      sub.durationSec = Math.floor((Date.now() - _session.startAt) / 1000);
      sub.savedAt = U.nowISO();
      /* ① 本機：每次變動都存，離線也安全 */
      Store.kv.set('draft:' + sub.quizId + ':' + sub.studentId, sub);
      /* ② 雲端：節流（每 20 秒或強制），換裝置才能繼續 */
      var now = Date.now();
      if (Settings.get().cloudDraft !== false && (force || now - _lastCloud > 20000)) {
        _lastCloud = now;
        saveState.textContent = '儲存中…';
        Backend.saveDraft(sub).then(function () {
          saveState.textContent = '進度已儲存 ' + U.fmtDate(U.nowISO(), true).slice(11);
        }).catch(function () {
          saveState.textContent = '（雲端儲存失敗，進度已存在本機）';
        });
      } else {
        saveState.textContent = '進度已存在本機';
      }
      updateProgress();
    }
    function updateProgress() {
      var total = activeQs(quiz).length;
      var done = activeQs(quiz).filter(function (q) {
        var a = sub.answers[q.id];
        if (!a) return false;
        if (q.type === 'mcq') return (a.value || []).length > 0;
        if (q.type === 'table' && (q.subQuestions || []).length) {
          return Object.keys(a.sub || {}).some(function (k) { return U.trim(a.sub[k]); });
        }
        return U.trim(a.value || '') !== '';
      }).length;
      progFill.style.width = Math.round(done / total * 100) + '%';
      progTxt.textContent = '作答進度 ' + done + ' / ' + total;
    }
    _session.autosave = autosave;

    /* 還原草稿：自動接續，不再問「要不要繼續」 */
    Backend.getDraft(quiz.id, sub.studentId).then(function (d) {
      updateProgress();
      if (!d) return;
      var hasContent = Object.keys(d.answers || {}).length ||
        (d.marks || []).length || (d.vocab || []).length;
      if (!hasContent) return;

      sub.answers = d.answers || {};
      sub.marks = d.marks || [];
      sub.vocab = d.vocab || [];
      sub.notes = d.notes || [];

      _session.hls.forEach(function (h) { h.marks = sub.marks; h.vocab = sub.vocab; h.render(); });
      U.$$('[data-qid]', view).forEach(function (card) {
        if (card.getAttribute('data-locked')) return;   // 已提交的部分不還原為可編輯
        var qid = card.getAttribute('data-qid');
        var q = (quiz.questions || []).filter(function (x) { return x.id === qid; })[0];
        if (!q) return;
        var holder = card.querySelector('.q-input');
        if (!holder) return;
        holder.innerHTML = '';
        holder.appendChild(Forms.input(q, sub.answers[qid], {
          uid: sub.id,
          onChange: function (v) { sub.answers[qid] = Object.assign({}, sub.answers[qid], v); autosave(); }
        }));
      });
      updateProgress();

      var n = Object.keys(sub.answers).length;
      U.toast('已接續上次的進度（' + n + ' 題已作答' + (sub.marks.length ? '、' + sub.marks.length + ' 處標記' : '') + '）', 'ok', 3600);
    });

    /* 離開頁面前強制存一次（sendBeacon 在關閉分頁時仍會送出） */
    if (_unloadHandler) window.removeEventListener('beforeunload', _unloadHandler);
    _unloadHandler = function () {
      try {
        sub.durationSec = Math.floor((Date.now() - _session.startAt) / 1000);
        sub.savedAt = U.nowISO();
        Store.kv.set('draft:' + sub.quizId + ':' + sub.studentId, sub);
        if (Settings.get().cloudDraft === false) return;
        var driver = Backend.Cloud.driver();
        if (driver === 'firebase' && Backend.Firebase.ok()) {
          var st = Settings.get().fb;
          var body = JSON.stringify({
            type: 'draft',
            id: ('draft::' + sub.quizId + '::' + sub.studentId).replace(/[.#$\/\[\]?:]/g, '_'),
            quizId: sub.quizId, studentId: sub.studentId, studentName: sub.studentName || '',
            ts: U.nowISO(), key: '', payload: sub
          });
          var u = String(st.dbUrl).replace(/\/+$/, '') + '/rq/' +
            encodeURIComponent(String(st.classCode || 'default').replace(/[.#$\/\[\]?:]/g, '_')) +
            '/draft/' + encodeURIComponent(('draft::' + sub.quizId + '::' + sub.studentId).replace(/[.#$\/\[\]?:]/g, '_')) +
            '.json?auth=' + encodeURIComponent(st._token || '');
          navigator.sendBeacon && navigator.sendBeacon(u, new Blob([body], { type: 'text/plain' }));
        } else if (driver === 'appscript') {
          var url = Settings.get().hook.postUrl;
          var b2 = JSON.stringify({
            type: 'draft', id: 'draft::' + sub.quizId + '::' + sub.studentId,
            quizId: sub.quizId, studentId: sub.studentId, studentName: sub.studentName || '',
            ts: U.nowISO(), key: (Settings.get().hook || {}).key || '', payload: sub
          });
          navigator.sendBeacon && navigator.sendBeacon(url, new Blob([b2], { type: 'text/plain' }));
        }
      } catch (e) { /* 關閉分頁時盡力而為 */ }
    };
    window.addEventListener('beforeunload', _unloadHandler);
  }

  function questionCard(quiz, q, idx, sub, autosave, updateProgress, disabled) {
    var card = U.el('div.q', { dataset: { qid: q.id } });
    if (disabled) card.setAttribute('data-locked', '1');
    var head = U.el('div.q-head');
    head.appendChild(U.el('div.q-no', { text: String(q.no != null ? q.no : idx + 1) }));
    var stem = U.el('div.q-stem');
    stem.appendChild(U.el('div', { html: U.esc(q.stem) }));
    var meta = U.el('div.q-meta');
    if (q.marks) meta.appendChild(U.el('span.tag.sun', { text: q.marks + ' 分' }));
    (q.skills || []).forEach(function (s) { meta.appendChild(U.el('span.tag.lav', { text: s, style: { marginLeft: '4px' } })); });
    if (q.type === 'mcq') meta.appendChild(U.el('span.tag.sky', { text: '選擇題', style: { marginLeft: '4px' } }));
    if (q.type === 'table') meta.appendChild(U.el('span.tag.gray', { text: '填充／表格題', style: { marginLeft: '4px' } }));
    stem.appendChild(meta);
    head.appendChild(stem);
    card.appendChild(head);

    /* 老師附加的題目截圖（原文樣式也不夠清楚時使用） */
    if (q.image) {
      card.appendChild(U.el('div.q-image', {}, [
        U.el('img', { src: q.image, alt: '題目截圖', style: { maxWidth: '100%', borderRadius: '8px', border: '1.5px solid var(--line)' } })
      ]));
    }

    var qb = Forms.quotesBlock(q);
    if (qb) card.appendChild(qb);

    var holder = U.el('div.q-input');
    holder.appendChild(Forms.input(q, sub.answers[q.id], {
      uid: sub.id,
      disabled: !!disabled,
      onChange: function (v) {
        sub.answers[q.id] = Object.assign({}, sub.answers[q.id], v);
        autosave(); updateProgress();
      }
    }));
    card.appendChild(holder);
    return card;
  }

  function submit(quiz, sub, view, group) {
    var qs = group ? group.questions : activeQs(quiz);
    var total = qs.length;
    var answered = qs.filter(function (q) {
      var a = sub.answers[q.id];
      if (!a) return false;
      if (q.type === 'mcq') return (a.value || []).length > 0;
      if (q.type === 'table') {
        return Object.keys(a.sub || {}).some(function (k) { return U.trim(a.sub[k]); }) || U.trim(a.value || '') !== '';
      }
      return U.trim(a.value || '') !== '';
    }).length;

    U.modal({
      title: group ? ('確定提交「' + group.label + '」？') : '確定提交？',
      body: '<p>已作答 <b>' + answered + '</b> / ' + total + ' 題。</p>' +
        (answered < total ? '<p class="warnbox">還有 ' + (total - answered) + ' 題未作答，提交後就不能再修改囉。</p>' : '') +
        (group ? '<p class="tiny muted">其他部分不受影響，可稍後再提交。</p>' : ''),
      actions: [
        { label: '再檢查一下' },
        {
          label: '確定提交', kind: 'primary', onClick: function () {
            doSubmit(quiz, sub, view, group);
          }
        }
      ]
    });
  }

  function doSubmit(quiz, sub, view, group) {
    var qs = group ? group.questions : activeQs(quiz);
    if (_session.timer && !group) clearInterval(_session.timer);

    var auto = 0, autoMax = 0;
    qs.forEach(function (q) {
      var got = Forms.autoScore(q, sub.answers[q.id]);
      if (got !== null) { auto += got; autoMax += (q.marks || 0); }
    });

    var scopedAnswers = {};
    qs.forEach(function (q) { if (sub.answers[q.id]) scopedAnswers[q.id] = sub.answers[q.id]; });

    var out = {
      id: U.uid('sub'),
      quizId: quiz.id,
      quizTitle: quiz.title,
      studentId: sub.studentId,
      studentName: sub.studentName,
      username: sub.username,
      attempt: sub.attempt,
      scope: group ? {
        type: group.key.indexOf('sec:') === 0 ? 'section'
          : (group.key.indexOf('pass:') === 0 ? 'passage' : 'all'),
        key: group.key,
        label: group.label
      } : null,
      startedAt: sub.startedAt,
      submittedAt: U.nowISO(),
      durationSec: Math.floor((Date.now() - _session.startAt) / 1000),
      answers: group ? scopedAnswers : sub.answers,
      marks: sub.marks || [],
      vocab: sub.vocab || [],
      notes: sub.notes || [],
      score: {
        auto: auto, autoMax: autoMax,
        manual: 0, total: auto,
        max: group ? group.marks : (quiz.totalMarks || 0),
        graded: false
      }
    };

    Backend.saveSubmission(out).then(function (saved) {
      if (!group) {
        Store.kv.set('draft:' + sub.quizId + ':' + sub.studentId, null);
        U.toast('已提交，感謝作答！', 'ok');
        location.hash = '#/result/' + saved.id;
      } else {
        if (_session.timer) clearInterval(_session.timer);
        U.toast('已提交「' + group.label + '」！可繼續作答其他部分。', 'ok', 3600);
        /* 重新載入作答頁：已提交的部分會被鎖定，其餘仍可繼續 */
        Student.take(view, quiz.id);
      }
    }).catch(function (e) {
      U.toast('提交失敗：' + e.message, 'bad');
    });
  }

  /* ============================================================
     結果頁
     ============================================================ */
  Student.result = function (view, subId) {
    view.innerHTML = '<div class="empty">載入中…</div>';
    Store.submission.get(subId).then(function (sub) {
      if (sub) return sub;
      /* 本機沒有（換了裝置）→ 從雲端／其他來源找回這份作答 */
      var who = Settings.who();
      return Backend.mySubmissions(who.id).then(function (list) {
        return (list || []).filter(function (s) { return s.id === subId; })[0] || null;
      }).catch(function () { return null; });
    }).then(function (sub) {
      if (!sub) { view.innerHTML = '<div class="empty">找不到這份作答</div>'; return; }
      /* 合併雲端版本：老師可能已在別的裝置批改 → 學生才看得到分數與評語 */
      var p = (Backend.getSubmission)
        ? Backend.getSubmission(sub.quizId, sub.studentId).catch(function () { return sub; })
        : Promise.resolve(sub);
      return p.then(function (merged) {
        return Backend.getQuiz(sub.quizId).then(function (quiz) {
          renderResult(view, merged || sub, quiz);
        });
      });
    });
  };

  function renderResult(view, sub, quiz) {
    view.innerHTML = '';
    var s = sub.score || { total: 0, max: 0 };
    var pct = U.percent(s.total, s.max);

    /* 分段提交：只檢討這一份提交涵蓋的題目 */
    var qs = activeQs(quiz);
    if (sub.scope && sub.scope.key) {
      var g = groupQuestions(quiz).filter(function (x) { return x.key === sub.scope.key; })[0];
      if (g) qs = g.questions;
    }

    /* 發回制：老師「發回」之前，學生看不到參考答案、老師給分與評語，
       分數也只先顯示選擇題的自動計分（老師批改的部分等發回才揭曉）。 */
    var released = !!sub.released;
    var withAnswers = released && !!(sub.release ? sub.release.withAnswers !== false : true);
    var shownTotal = released ? (s.total || 0) : (s.auto || 0);
    var shownPct = U.percent(shownTotal, s.max || 0);

    var card = U.el('div.score-card');
    card.appendChild(U.el('h2.mb0', { html: U.esc(quiz.title) }));
    if (sub.scope && sub.scope.label) {
      card.appendChild(U.el('div.mt1', {}, [U.el('span.tag.sun', { text: sub.scope.label + '（分段提交）' })]));
    }
    card.appendChild(U.el('div.score-num.mt1', {
      html: shownTotal + '<small> / ' + (s.max || 0) + ' 分</small>'
    }));
    card.appendChild(U.el('div.bar.' + U.barClass(shownPct), {}, [U.el('i', { style: { width: shownPct + '%' } })]));
    card.appendChild(U.el('div.tiny.muted', {
      html: '正確率 <b>' + shownPct + '%</b>　用時 ' + U.fmtDur(sub.durationSec) +
        '　提交於 ' + U.fmtDate(sub.submittedAt, true)
    }));

    if (released) {
      card.appendChild(U.el('div.infobox.mt2', {
        html: '✔ <b>老師已於 ' + U.fmtDate(sub.releasedAt || sub.submittedAt, true) +
          ' 批改並發回</b>' + (withAnswers ? '　—— 下方每題可看到參考答案、老師給的分數與評語。' : '　—— 老師未附上參考答案。')
      }));
    } else if (s.graded) {
      card.appendChild(U.el('div.warnbox.mt2', {
        html: '老師已批改，<b>尚未發回</b>。等老師按下「發回」後，這裡才會出現分數、評語與參考答案。'
      }));
    } else {
      card.appendChild(U.el('div.warnbox.mt2', {
        html: '已提交，等待老師批改發回。<br><span class="tiny">目前的分數只是<b>選擇題自動計分</b>；' +
          '文字題分數、老師評語與參考答案，要等老師發回後才看得到。</span>'
      }));
    }
    view.appendChild(card);

    var row = U.el('div.row.mt2', {}, [
      U.el('a.btn', { href: '#/student', text: '回學生專區' })
    ]);
    if (sub.scope && sub.scope.key) {
      row.appendChild(U.el('a.btn.primary', { href: '#/quiz/' + quiz.id, text: '繼續作答其他部分' }));
    }
    view.appendChild(row);

    /* 逐題檢討 */
    qs.forEach(function (q, i) {
      var box = U.el('div.q');
      var head = U.el('div.q-head');
      head.appendChild(U.el('div.q-no', { text: String(q.no != null ? q.no : i + 1) }));
      var stem = U.el('div.q-stem');
      stem.appendChild(U.el('div', { html: U.esc(q.stem) }));
      head.appendChild(stem);
      box.appendChild(head);

      if (q.image) {
        box.appendChild(U.el('div.q-image', {}, [
          U.el('img', { src: q.image, alt: '題目截圖', style: { maxWidth: '100%', borderRadius: '8px', border: '1.5px solid var(--line)' } })
        ]));
      }
      var qb2 = Forms.quotesBlock(q);
      if (qb2) box.appendChild(qb2);

      var ans = sub.answers[q.id] || {};
      box.appendChild(U.el('div.ansbox.mt1', {}, [
        U.el('span.lbl', { text: '你的作答' }),
        U.el('div', { html: U.nl2br(Forms.answerText(q, ans)) })
      ]));
      if (released) {
        if (withAnswers) box.appendChild(Forms.reveal(q, ans));
        if (ans.manualScore != null) {
          box.appendChild(U.el('div.mt1', {}, [
            U.el('span.tag.mint', { text: '老師批閱：' + ans.manualScore + ' 分' })
          ]));
          if (ans.teacherComment) {
            box.appendChild(U.el('div.tiny.muted.mt1', { html: '老師評語：' + U.nl2br(ans.teacherComment) }));
          }
        }
      } else {
        box.appendChild(U.el('div.tiny.faint.mt1', {
          text: '（老師發回後，這裡會顯示參考答案與老師評語）'
        }));
      }
      view.appendChild(box);
    });

    /* 我的標記回顧 */
    if ((sub.marks || []).length || (sub.vocab || []).length) {
      var mcard = U.el('div.card.mt3');
      mcard.appendChild(U.el('h3', { text: '我在文章上做的標記' }));
      (sub.marks || []).forEach(function (m) {
        mcard.appendChild(U.el('div.row', { style: { gap: '8px', padding: '4px 0' } }, [
          U.el('span.hl.' + m.color, { text: m.text, style: { padding: '2px 8px', borderRadius: '6px' } }),
          U.el('span.tiny.muted', { text: m.note || '' })
        ]));
      });
      if ((sub.vocab || []).length) {
        mcard.appendChild(U.el('div.mt2', {}, [
          U.el('b.tiny', { text: '生詞本：' + sub.vocab.map(function (v) { return v.word; }).join('、') })
        ]));
      }
      view.appendChild(mcard);
    }
  }

  Student._internal = { groupQuestions: groupQuestions, isGroupSubmitted: isGroupSubmitted, scopeKey: scopeKey };
  RQ.student = Student;
})(window.RQ);
