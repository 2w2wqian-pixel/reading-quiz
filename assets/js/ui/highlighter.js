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

  function offsetIn(root, node, offset) {
    if (!root) return null;
    if (node.nodeType === 3) {
      var n = 0;
      var w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null, false);
      while (w.nextNode()) {
        if (w.currentNode === node) return n + offset;
        n += w.currentNode.nodeValue.length;
      }
      return null;
    }
    // 元素是錨點：用子節點累積長度
    var acc = 0;
    var kids = node.childNodes;
    for (var i = 0; i < offset && i < kids.length; i++) acc += (kids[i].textContent || '').length;
    var probe = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null, false);
    var total = 0;
    while (probe.nextNode()) {
      if (probe.currentNode === node || node.contains && node.contains(probe.currentNode)) {
        // 元素本身不是文字節點，往前累積到它為止
        var w2 = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null, false);
        var t = 0;
        while (w2.nextNode()) {
          if (node.contains(w2.currentNode) || w2.currentNode === node) break;
          t += w2.currentNode.nodeValue.length;
        }
        return t + acc;
      }
      total += probe.currentNode.nodeValue.length;
    }
    return total;
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
    document.addEventListener('mousedown', function (e) {
      var menu = document.getElementById('sel-menu');
      if (!menu || menu.hidden) return;
      if (menu.contains(e.target)) return;
      menu.hidden = true;
    });
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

    var s = offsetIn(startInner, range.startContainer, range.startOffset);
    var e = offsetIn(endInner, range.endContainer, range.endOffset);
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
    var top = rect.bottom + window.scrollY + 8;
    var left = Math.max(8, Math.min(rect.left + window.scrollX, window.innerWidth - 250));
    menu.style.top = top + 'px';
    menu.style.left = left + 'px';
    U.$('#sel-preview', menu).textContent = segs.map(function (s) { return s.text; }).join('…').slice(0, 60);

    var self = this;
    var root = menu;

    U.$$('#sel-colors .sw', root).forEach(function (btn) {
      btn.onclick = function () {
        self._addMarks(btn.getAttribute('data-color'));
        menu.hidden = true;
      };
    });
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
            /* 在文章中也標起來（波浪線） */
            segs.forEach(function (sg) {
              var m = self.marks.filter(function (x) {
                return x.pidx === sg.pidx && x.start < sg.end && x.end > sg.start;
              })[0];
              if (!m) {
                m = {
                  id: U.uid('mk'), pid: sg.pid, pidx: sg.pidx,
                  start: sg.start, end: sg.end, text: sg.text,
                  color: 'pink', note: '', vocab: true
                };
                self.marks.push(m);
              } else m.vocab = true;
            });
            self.vocab.push({
              id: U.uid('vb'), word: w, pid: self.passage.id,
              pidx: segs[0].pidx, note: U.trim(note.value), ts: U.nowISO()
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
    this.marks = this.marks.filter(function (m) {
      return !segs.some(function (sg) {
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
            self.marks = self.marks.filter(function (x) { return x.id !== m.id; });
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
