/* ============================================================
   util.js — 通用工具
   全域命名空間：window.RQ
   ============================================================ */
window.RQ = window.RQ || {};

(function (RQ) {
  'use strict';

  var U = {};

  /* ---------- DOM ---------- */
  U.$  = function (sel, root) { return (root || document).querySelector(sel); };
  U.$$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  /** 建立元素：el('div.card',{html:'...'}) */
  U.el = function (spec, attrs, children) {
    var parts = String(spec).split('.');
    var tag = parts.shift() || 'div';
    var node = document.createElement(tag);
    if (parts.length) node.className = parts.join(' ');
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'html') { node.innerHTML = v; }
        else if (k === 'text') { node.textContent = v; }
        else if (k === 'style' && typeof v === 'object') { Object.assign(node.style, v); }
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') { node.addEventListener(k.slice(2).toLowerCase(), v); }
        else if (k === 'dataset') { Object.keys(v).forEach(function (d) { node.dataset[d] = v[d]; }); }
        else { node.setAttribute(k, v === true ? '' : v); }
      });
    }
    (children || []).forEach(function (c) {
      if (c == null) return;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  };

  U.esc = function (s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };

  /** 允許少量換行的文字轉 HTML */
  U.nl2br = function (s) { return U.esc(s).replace(/\n/g, '<br>'); };

  /* ---------- 字串 ---------- */
  U.trim = function (s) { return String(s == null ? '' : s).replace(/^[\s\u3000]+|[\s\u3000]+$/g, ''); };
  U.cjk  = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/;

  U.uid = function (prefix) {
    return (prefix || 'id') + '_' +
      Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  };

  U.slug = function (s) {
    return U.trim(s).toLowerCase()
      .replace(/[^\w\u4e00-\u9fff]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'quiz';
  };

  /** 擷取所有 （n分） / (n分) 並加總 */
  U.sumMarks = function (text) {
    var t = String(text || ''), total = 0, m;
    var re = /[（(]\s*(\d+(?:\.\d+)?)\s*分\s*[）)]/g;
    while ((m = re.exec(t))) total += parseFloat(m[1]);
    var re2 = /[（(]\s*(\d+(?:\.\d+)?)\s*marks?\s*[）)]/gi;
    while ((m = re2.exec(t))) total += parseFloat(m[1]);
    return total;
  };

  /** 移除 【整合】【引申】【評價】【解釋】 等能力標記，回傳 {text, skills} */
  U.stripSkills = function (text) {
    var skills = [];
    var out = String(text || '').replace(/[【\[]([^】\]]{1,8})[】\]]/g, function (all, inner) {
      if (/^(整合|引申|評價|解釋|複述|分析|鑑賞|創意|理解|應用)$/.test(inner)) { skills.push(inner); return ''; }
      return all;
    });
    return { text: U.trim(out), skills: skills };
  };

  /* ---------- 時間 ---------- */
  U.fmtDate = function (iso, withTime) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d)) return String(iso);
    var p = function (n) { return n < 10 ? '0' + n : '' + n; };
    var s = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    return withTime ? s + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) : s;
  };
  U.fmtDur = function (sec) {
    if (!sec && sec !== 0) return '—';
    var m = Math.floor(sec / 60), s = Math.floor(sec % 60);
    return m + ' 分 ' + (s < 10 ? '0' + s : s) + ' 秒';
  };
  U.nowISO = function () { return new Date().toISOString(); };

  /* ---------- Toast ---------- */
  U.toast = function (msg, kind, ms) {
    var root = document.getElementById('toast-root');
    if (!root) { alert(msg); return; }
    var t = U.el('div.toast' + (kind ? '.' + kind : ''), { text: msg });
    root.appendChild(t);
    setTimeout(function () {
      t.style.transition = 'opacity .25s'; t.style.opacity = '0';
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 260);
    }, ms || 2400);
  };

  /* ---------- Modal ---------- */
  /**
   * U.modal({title, body:Node|string, actions:[{label,kind,onClick,close}], width})
   */
  U.modal = function (opt) {
    var root = document.getElementById('modal-root');
    var mask = U.el('div.modal-mask');
    var box = U.el('div.modal');
    if (opt.width) box.style.maxWidth = opt.width + 'px';

    if (opt.title) box.appendChild(U.el('h3', { html: opt.title }));
    var body = U.el('div.modal-body');
    if (typeof opt.body === 'string') body.innerHTML = opt.body;
    else if (opt.body) body.appendChild(opt.body);
    box.appendChild(body);

    var acts = U.el('div.modal-actions');
    (opt.actions || [{ label: '關閉', close: true }]).forEach(function (a) {
      acts.appendChild(U.el('button.btn.sm' + (a.kind ? '.' + a.kind : ''), {
        text: a.label,
        onclick: function () {
          if (a.onClick) {
            var r = a.onClick(box);
            if (r === false) return;
          }
          if (a.close !== false) close();
        }
      }));
    });
    box.appendChild(acts);

    function close() { if (mask.parentNode) mask.parentNode.removeChild(mask); }
    mask.addEventListener('mousedown', function (e) { if (e.target === mask) close(); });
    mask.appendChild(box);
    root.appendChild(mask);
    return { close: close, box: box };
  };

  U.confirm = function (msg, onYes) {
    U.modal({
      title: '請確認',
      body: '<p>' + U.esc(msg) + '</p>',
      actions: [
        { label: '取消', close: true },
        { label: '確定', kind: 'primary', onClick: function () { onYes && onYes(); } }
      ]
    });
  };

  /* ---------- 檔案 ---------- */
  U.download = function (filename, content, mime) {
    var blob = (content instanceof Blob) ? content
      : new Blob([content], { type: mime || 'application/json;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = U.el('a', { href: url, download: filename });
    document.body.appendChild(a); a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 400);
  };

  U.pickFile = function (accept, cb) {
    var inp = U.el('input', { type: 'file', accept: accept || '', style: { display: 'none' } });
    inp.addEventListener('change', function () { if (inp.files && inp.files[0]) cb(inp.files[0]); });
    document.body.appendChild(inp); inp.click();
    setTimeout(function () { if (inp.parentNode) inp.parentNode.removeChild(inp); }, 1000);
  };

  U.readFileAsText = function (file) {
    return new Promise(function (res, rej) {
      var fr = new FileReader();
      fr.onload = function () { res(fr.result); };
      fr.onerror = function () { rej(fr.error || new Error('讀檔失敗')); };
      fr.readAsText(file, 'utf-8');
    });
  };

  U.readFileAsArrayBuffer = function (file) {
    return new Promise(function (res, rej) {
      var fr = new FileReader();
      fr.onload = function () { res(fr.result); };
      fr.onerror = function () { rej(fr.error || new Error('讀檔失敗')); };
      fr.readAsArrayBuffer(file);
    });
  };

  /* ---------- 其他 ---------- */
  U.clone = function (o) { return o == null ? o : JSON.parse(JSON.stringify(o)); };

  U.percent = function (a, b) {
    if (!b) return 0;
    return Math.round((a / b) * 1000) / 10;
  };

  /** 分數條顏色 */
  U.barClass = function (p) { return p >= 70 ? '' : (p >= 45 ? 'warn' : 'bad'); };

  /** CSV 解析（支援引號） */
  U.parseCSV = function (text) {
    var rows = [], row = [], cur = '', q = false;
    text = String(text || '').replace(/\r\n?/g, '\n');
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
        else cur += c;
      } else {
        if (c === '"') q = true;
        else if (c === ',') { row.push(cur); cur = ''; }
        else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
        else cur += c;
      }
    }
    if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
    return rows.filter(function (r) { return r.some(function (x) { return U.trim(x) !== ''; }); });
  };

  U.debounce = function (fn, ms) {
    var t; return function () {
      var a = arguments, self = this;
      clearTimeout(t); t = setTimeout(function () { fn.apply(self, a); }, ms || 250);
    };
  };

  RQ.util = U;
})(window.RQ);
