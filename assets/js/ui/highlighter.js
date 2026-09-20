/* ============================================================
   highlighter.js — 文章螢光筆／筆記／生詞本
   標記資料模型：
     mark = {id, pid, pidx, start, end, text, color, note}
     vocab= {id, word, pid, pidx, note, ts}
   錨點採「第幾段 + 段內字元位移」，重新渲染時可精準還原。
   ============================================================ */
(function (RQ) {
  'use strict';

  var U = RQ.util;
  var COLORS = ['yellow', 'green', 'blue', 'pink', 'orange'];

  /** 是否為觸控裝置（手機／平板）——決定選單要用浮動或固定在底部 */
  function isCoarse() {
    return !!(window.matchMedia && window.matchMedia('(pointer:coarse)').matches);
  }

  /** 複製文字：優先用 Clipboard API，失敗才退回 execCommand */
  function legacyCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, text.length);
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e) { return false; }
  }

  function copyText(text) {
    function done() { U.toast('已複製', 'ok'); }
    if (!text) { U.toast('沒有可複製的內容', 'bad'); return; }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(function () {
        if (legacyCopy(text)) done(); else U.toast('複製失敗', 'bad');
      });
    } else if (legacyCopy(text)) {
      done();
    } else {
      U.toast('複製失敗', 'bad');
    }
  }

  /** 收合選取：可同時讓系統原生選取選單消失（iOS／Android 用） */
  function collapseSelection() {
    try {
      var s = window.getSelection();
      if (s && !s.isCollapsed) s.removeAllRanges();
    } catch (e) { }
  }


  /**
   * 計算 node/offset 在容器 root（.ptext）內的字元位移。
   * 用 Range 量「從頭到選取端點」的文字長度，對文字節點或元素節點都精準，
   * 不受既有螢光標籤（巢狀 <span>）影響 —— 解決「選兩個字卻只高亮一個」的偏移誤差。
   */
  function charOffset(root, node, offset) {
    if (!root || !node) return null;
    try {
      var pre = document.createRange();
      pre.selectNodeContents(root);
      pre.setEnd(node, offset);
      return (pre.toString() || '').length;
    } catch (e) {
      return null;
    }
  }

  function paragraphEl(node, container) {
    var n = node;
    while (n && n !== container) {
      if (n.nodeType === 1 && n.getAttribute && n.getAttribute('data-pidx') !== null) return n;
      n = n.parentNode;
    }
    return null;
  }

  /**
   * opts: {container, passage, marks, vocab, readonly, onChange}
   */
  function Highlighter(opts) {
    this.container = opts.container;
    this.passage = opts.passage;
    this.marks = opts.marks || [];
    this.vocab = opts.vocab || [];
    this.readonly = !!opts.readonly;
    this.onChange = opts.onChange || function () { };
    this._pending = null;
    this._bound = [];
    this.render();
    if (!this.readonly) this._bind();
  }

  Highlighter.prototype.render = function () {
    var self = this;
    var box = this.container;
    box.innerHTML = '';

    var title = U.el('div.p-title', {
      html: '<span>' + U.esc(this.passage.title || '文章') + '</span>' +
        (this.readonly ? '' : '<small class="faint" style="margin-left:auto">選取文字即可標示</small>')
    });
    box.appendChild(title);

    (this.passage.paragraphs || []).forEach(function (text, pidx) {
      var p = U.el('p', { dataset: { pidx: pidx } });
      var num = U.el('span.p-num', { text: String(pidx + 1) });
      p.appendChild(num);
      var inner = U.el('span.ptext');
      p.appendChild(inner);
      box.appendChild(p);
      self._paint(inner, text, pidx);
    });

    if ((this.passage.notes || []).length) {
      var nd = U.el('div.notes');
      nd.appendChild(U.el('b', { text: '注釋' }));
      this.passage.notes.forEach(function (n) {
        nd.appendChild(U.el('div', { html: U.esc(n) }));
      });
      box.appendChild(nd);
    }
  };

  Highlighter.prototype._paint = function (inner, text, pidx) {
    var self = this;
    inner.innerHTML = '';
    var mine = this.marks.filter(function (m) { return m.pidx === pidx; })
      .sort(function (a, b) { return a.start - b.start; });
    var pos = 0;
    mine.forEach(function (m) {
      if (m.start < pos || m.end > text.length) return;   // 重疊或越界，略過
      if (m.start > pos) inner.appendChild(document.createTextNode(text.slice(pos, m.start)));
      var cls = 'hl ' + (m.color || 'yellow') + (m.vocab ? ' vocab' : '') + (m.note ? ' hasnote' : '');
      var span = U.el('span', {
        class: cls, text: text.slice(m.start, m.end),
        dataset: { mark: m.id },
        title: m.note || ''
      });
      if (m.note) {
        span.appendChild(U.el('span.hl-badge', { text: '✎' }));
      }
      if (!self.readonly) {
        span.addEventListener('click', function (e) {
          e.stopPropagation();
          self._editMark(m);
        });
      }
      inner.appendChild(span);
      pos = m.end;
    });
    if (pos < text.length) inner.appendChild(document.createTextNode(text.slice(pos)));
  };

  /* ---------- 選取 → 快顯選單 ---------- */
  Highlighter.prototype._bind = function () {
    var self = this;
    var onUp = function () { setTimeout(function () { self._onSelect(); }, 10); };
    this.container.addEventListener('mouseup', onUp);
    this.container.addEventListener('touchend', onUp);

    var hideTimer = null;

    function hideIfOutside(e) {
      var menu = document.getElementById('sel-menu');
      if (!menu || menu.hidden) return;
      if (menu.contains(e.target)) return;      /* 點自己的按鈕不關 */
      menu.hidden = true;
    }
    document.addEventListener('mousedown', hideIfOutside);
    document.addEventListener('touchstart', hideIfOutside, { passive: true });

    /* 選取消失就關閉選單。觸控時延遲一下再關：
       在 iOS 上點按鈕會先讓選取收合，若立刻 display:none，click 會收不到。 */
    document.addEventListener('selectionchange', function () {
      var menu = document.getElementById('sel-menu');
      if (!menu || menu.hidden) return;
      var s = window.getSelection();
      if (!s || s.isCollapsed) {
        clearTimeout(hideTimer);
        hideTimer = setTimeout(function () { menu.hidden = true; }, isCoarse() ? 280 : 0);
      }
    });

    /* 捲動時浮動選單會跟選取位置脫節 → 收起（固定在底部的話不需處理） */
    window.addEventListener('scroll', function () {
      var menu = document.getElementById('sel-menu');
      if (!menu || menu.hidden) return;
      if (!menu.classList.contains('dock')) menu.hidden = true;
    }, true);
  };

  Highlighter.prototype._onSelect = function () {
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    var range = sel.getRangeAt(0);
    var box = this.container;
    if (!box.contains(range.commonAncestorContainer)) return;

    var startP = paragraphEl(range.startContainer, box);
    var endP = paragraphEl(range.endContainer, box);
    if (!startP || !endP) return;

    var pid = this.passage.id;
    var segs = [];
    var spIdx = parseInt(startP.getAttribute('data-pidx'), 10);
    var epIdx = parseInt(endP.getAttribute('data-pidx'), 10);
    var startInner = startP.querySelector('.ptext') || startP;
    var endInner = endP.querySelector('.ptext') || endP;

    var s = charOffset(startInner, range.startContainer, range.startOffset);
    var e = charOffset(endInner, range.endContainer, range.endOffset);
    if (s === null || e === null) return;

    if (spIdx === epIdx) {
      if (e - s < 1) return;
      segs.push({ pid: pid, pidx: spIdx, start: Math.min(s, e), end: Math.max(s, e) });
    } else {
      for (var i = spIdx; i <= epIdx; i++) {
        var full = (this.passage.paragraphs[i] || '').length;
        var a = (i === spIdx) ? s : 0;
        var b = (i === epIdx) ? e : full;
        if (b - a > 0) segs.push({ pid: pid, pidx: i, start: a, end: b });
      }
    }
    if (!segs.length) return;

    segs.forEach(function (sg) {
      sg.text = (this.passage.paragraphs[sg.pidx] || '').slice(sg.start, sg.end);
    }, this);

    this._pending = segs;
    this._showMenu(range, segs);
  };

  Highlighter.prototype._showMenu = function (range, segs) {
    var menu = document.getElementById('sel-menu');
    if (!menu) return;
    var rect = range.getBoundingClientRect();
    menu.hidden = false;

    /* 選單定位策略
       ─ 觸控裝置：固定貼齊畫面底部。系統原生的選取選單（拷貝／全選／查詢）
         只會出現在「選取處附近」，而它是瀏覽器／系統層的 UI，**z-index 再高
         也蓋不過它**。把它移離選取處才是最可靠的做法。
       ─ 桌面：維持貼近選取處，但加上翻轉與邊界夾制，避免超出畫面被裁掉。 */
    if (isCoarse()) {
      menu.classList.add('dock');
      menu.style.top = '';
      menu.style.left = '';
    } else {
      menu.classList.remove('dock');
      var vw = window.innerWidth, vh = window.innerHeight;
      var mw = menu.offsetWidth || menu.getBoundingClientRect().width || 230;
      var mh = menu.offsetHeight || menu.getBoundingClientRect().height || 0;

      /* 先試選取處下方；放不下就翻到上方；再放不下就夾在畫面內。
         夾制要在「所有情況」都做，否則選取落在畫面下緣時仍會超出。 */
      function placeTop(h) {
        var t = rect.bottom + 8;
        if (t + h > vh - 8) {
          var above = rect.top - 8 - h;
          t = (above > 8) ? above : (vh - h - 8);
        }
        return Math.max(8, Math.min(t, Math.max(8, vh - h - 8)));
      }
      menu.style.top = (placeTop(mh) + window.scrollY) + 'px';
      menu.style.left = Math.max(8, Math.min(rect.left + window.scrollX, vw - mw - 8)) + 'px';

      /* 剛從 hidden 切換成顯示時，某些瀏覽器第一次量到的高度是 0（還沒排版）。
         下一個 frame 再校正一次，確保一定不會超出畫面。 */
      if (!mh) {
        window.requestAnimationFrame(function () {
          if (menu.hidden || menu.classList.contains('dock')) return;
          menu.style.top = (placeTop(menu.offsetHeight) + window.scrollY) + 'px';
        });
      }
    }
    U.$('#sel-preview', menu).textContent = segs.map(function (s) { return s.text; }).join('…').slice(0, 60);

    var self = this;
    var root = menu;

    U.$$('#sel-colors .sw', root).forEach(function (btn) {
      btn.onclick = function () {
        self._addMarks(btn.getAttribute('data-color'));
        menu.hidden = true;
        if (isCoarse()) setTimeout(collapseSelection, 0);
      };
    });

    /* 自有「複製」按鈕：因為觸控裝置上我們抑制了系統選單，複製要在這裡提供 */
    var copyBtn = U.$('#sel-copy', root);
    if (copyBtn) {
      copyBtn.onclick = function () {
        copyText(segs.map(function (s2) { return s2.text; }).join('\n'));
        menu.hidden = true;
        if (isCoarse()) setTimeout(collapseSelection, 0);
      };
    }
    U.$('#sel-note', root).onclick = function () {
      menu.hidden = true;
      self._askNote();
    };
    U.$('#sel-vocab', root).onclick = function () {
      menu.hidden = true;
      self._addVocab();
    };
    U.$('#sel-clear', root).onclick = function () {
      menu.hidden = true;
      self._clearRange();
    };
  };

  Highlighter.prototype._fire = function () { this.onChange(this.marks, this.vocab); };

  /**
   * 移除指定的標示，**並同步移除它們在生詞本裡的對應項目**。
   *
   * 為什麼一定要綁在一起：marks 與 vocab 是兩個平行陣列，
   * 而畫面上的標示（m.vocab===true）就是那個生詞的可見痕跡。
   * 若只從 marks 移除、vocab 留著，`_fire()` 傳出去的 vocab 仍是舊的，
   * 學生主頁的生詞本就會一直顯示「已經在文章裡刪掉」的詞。
   * 依「同一段落且位置重疊」配對，兩邊一起刪，才不會留下孤兒生詞。
   */
  Highlighter.prototype._removeMarks = function (pred) {
    var self = this;
    var gone = this.marks.filter(pred);
    this.marks = this.marks.filter(function (m) { return !pred(m); });
    if (!gone.length || !this.vocab.length) return gone;

    this.vocab = this.vocab.filter(function (v) {
      return !gone.some(function (m) {
        if (!m.vocab) return false;                       // 該標示本來就不是生詞
        if (v.id && v.id === m.id) return true;           // 直接對應
        /* 舊資料沒有共用 id → 用「同一段落且位置落在標示內」判斷 */
        var sameP = (v.pidx != null && m.pidx != null)
          ? Number(v.pidx) === Number(m.pidx)
          : (v.pid === m.pid);
        if (!sameP) return false;
        if (v.start != null && m.start != null) {
          return Number(v.start) < Number(m.end) && Number(v.end) > Number(m.start);
        }
        /* 連位置都沒有（極舊資料）→ 同段落且詞語相同才移除 */
        return !!v.word && self._markText(m) === U.trim(v.word);
      });
    });
    return gone;
  };

  /** 取得標示的字面文字（新版有存 text，舊版沒有則從文章切出來） */
  Highlighter.prototype._markText = function (m) {
    if (m.text) return m.text;
    var paras = (this.passage && this.passage.paragraphs) || [];
    var t = paras[m.pidx];
    if (typeof t !== 'string') return '';
    return t.slice(m.start, m.end);
  };

  Highlighter.prototype._addMarks = function (color) {
    var segs = this._pending;
    if (!segs) return;
    var self = this;
    segs.forEach(function (sg) {
      var exist = self.marks.filter(function (m) {
        return m.pidx === sg.pidx && m.start < sg.end && m.end > sg.start;
      });
      if (exist.length) {
        exist.forEach(function (m) { m.color = color; });
        return;
      }
      self.marks.push({
        id: U.uid('mk'), pid: sg.pid, pidx: sg.pidx,
        start: sg.start, end: sg.end, text: sg.text,
        color: color, note: '', vocab: false
      });
    });
    this.render();
    this._fire();
    U.toast('已標示', 'ok', 1200);
  };

  Highlighter.prototype._askNote = function () {
    var segs = this._pending;
    if (!segs) return;
    var self = this;
    var ta = U.el('textarea.input', { rows: 4, placeholder: '例如：這句是肖像描寫，用來突出胖姐的體型' });
    U.modal({
      title: '為這段文字加筆記',
      body: (function () {
        var d = U.el('div');
        d.appendChild(U.el('div', {
          class: 'pill-input', style: { marginBottom: '8px' },
          html: '「' + U.esc(segs.map(function (s) { return s.text; }).join('…')) + '」'
        }));
        d.appendChild(ta);
        return d;
      })(),
      actions: [
        { label: '取消' },
        {
          label: '儲存筆記', kind: 'primary', onClick: function () {
            var note = U.trim(ta.value);
            segs.forEach(function (sg) {
              var m = self.marks.filter(function (x) {
                return x.pidx === sg.pidx && x.start < sg.end && x.end > sg.start;
              })[0];
              if (!m) {
                m = {
                  id: U.uid('mk'), pid: sg.pid, pidx: sg.pidx,
                  start: sg.start, end: sg.end, text: sg.text,
                  color: 'yellow', note: '', vocab: false
                };
                self.marks.push(m);
              }
              m.note = (m.note ? m.note + '\n' : '') + note;
            });
            self.render(); self._fire();
            U.toast('筆記已儲存', 'ok');
          }
        }
      ]
    });
  };

  Highlighter.prototype._addVocab = function () {
    var segs = this._pending;
    if (!segs) return;
    var self = this;
    var word = segs.map(function (s) { return s.text; }).join('');
    var inp = U.el('input.input', { value: U.trim(word) });
    var note = U.el('input.input', { placeholder: '為什麼不懂？（可留空）' });

    var d = U.el('div');
    d.appendChild(U.el('label.tiny.muted', { text: '詞語' })); d.appendChild(inp);
    d.appendChild(U.el('div', { style: { height: '8px' } }));
    d.appendChild(U.el('label.tiny.muted', { text: '備註' })); d.appendChild(note);

    U.modal({
      title: '加入生詞本',
      body: d,
      actions: [
        { label: '取消' },
        {
          label: '加入', kind: 'primary', onClick: function () {
            var w = U.trim(inp.value);
            if (!w) return false;
            /* 生詞項目與它在文章中的標示共用同一個 id →
               日後在文章裡刪掉標示時，才能精準地把生詞本那一筆一起移除。 */
            var vid = U.uid('vb');
            segs.forEach(function (sg) {
              var m = self.marks.filter(function (x) {
                return x.pidx === sg.pidx && x.start < sg.end && x.end > sg.start;
              })[0];
              if (!m) {
                m = {
                  id: vid, pid: sg.pid, pidx: sg.pidx,
                  start: sg.start, end: sg.end, text: sg.text,
                  color: 'pink', note: '', vocab: true, vocabId: vid
                };
                self.marks.push(m);
              } else {
                m.vocab = true;
                m.vocabId = vid;
              }
            });
            self.vocab.push({
              id: vid, word: w, pid: self.passage.id,
              pidx: segs[0].pidx, start: segs[0].start, end: segs[0].end,
              note: U.trim(note.value), ts: U.nowISO(),
              /* 預設「未學會」；完成默寫後才移入已學會 */
              learned: false
            });
            self.render(); self._fire();
            U.toast('已加入生詞本：' + w, 'ok');
          }
        }
      ]
    });
  };

  Highlighter.prototype._clearRange = function () {
    var segs = this._pending;
    if (!segs) return;
    var self = this;
    /* 用 _removeMarks → 生詞本裡的對應項目也會一起消失，兩邊即時一致 */
    this._removeMarks(function (m) {
      return segs.some(function (sg) {
        return sg.pidx === m.pidx && m.start < sg.end && m.end > sg.start;
      });
    });
    void self;
    this.render(); this._fire();
    U.toast('已清除標示');
  };

  Highlighter.prototype._editMark = function (m) {
    var self = this;
    var ta = U.el('textarea.input', { rows: 3 });
    ta.value = m.note || '';
    var colorRow = U.el('div.row', { style: { marginBottom: '8px' } });
    COLORS.forEach(function (c) {
      var b = U.el('button.sw.sw-' + c.charAt(0), {
        class: 'sw sw-' + ({ yellow: 'y', green: 'g', blue: 'b', pink: 'p', orange: 'o' })[c],
        onclick: function () { m.color = c; self.render(); self._fire(); U.modal.close; }
      });
      colorRow.appendChild(b);
    });

    var d = U.el('div');
    d.appendChild(U.el('div', { class: 'pill-input', style: { marginBottom: '8px' }, html: '「' + U.esc(m.text) + '」' }));
    d.appendChild(U.el('label.tiny.muted', { text: '顏色' }));
    d.appendChild(colorRow);
    d.appendChild(U.el('label.tiny.muted', { text: '筆記' }));
    d.appendChild(ta);

    U.modal({
      title: '編輯標示',
      body: d,
      actions: [
        { label: '刪除標示', kind: 'danger', onClick: function () {
            self._removeMarks(function (x) { return x.id === m.id; });
            self.render(); self._fire();
          } },
        { label: '取消' },
        { label: '儲存', kind: 'primary', onClick: function () {
            m.note = U.trim(ta.value);
            self.render(); self._fire();
          } }
      ]
    });
  };

  /** 供老師端唯讀顯示學生的標記 */
  Highlighter.readonly = function (container, passage, marks) {
    return new Highlighter({ container: container, passage: passage, marks: marks, readonly: true });
  };

  RQ.Highlighter = Highlighter;
  RQ.hlColors = COLORS;
})(window.RQ);
