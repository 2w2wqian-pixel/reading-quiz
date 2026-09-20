/* 用極簡 XML-DOM shim + 專案內 jszip 真實執行 docx-parser，針對兩份樣本卷做端到端驗證 */
const path = require('path');
const fs = require('fs');
const vm = require('vm');

const ROOT = 'C:/Users/user/WorkBuddy/2026-09-16-21-14-08/reading-quiz';
const JSZip = require(path.join(ROOT, 'assets/js/lib/jszip.min.js'));
global.JSZip = JSZip;

/* ---------- 極簡 XML → DOM shim（只實作 parser 用到的 API） ---------- */
function decode(s) {
  return String(s == null ? '' : s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#x([0-9a-fA-F]+);/g, function (_, h) { return String.fromCodePoint(parseInt(h, 16)); })
    .replace(/&#(\d+);/g, function (_, d) { return String.fromCodePoint(parseInt(d, 10)); })
    .replace(/&amp;/g, '&');
}
function textContent(node) {
  var s = '';
  (node.childNodes || []).forEach(function (c) {
    if (c.nodeType === 3) s += c.nodeValue;
    else if (c.nodeType === 1) s += textContent(c);
  });
  return s;
}
function getElementsByTagName(node, name) {
  var out = [];
  (node.childNodes || []).forEach(function (c) {
    if (c.nodeType === 1) {
      if (c.nodeName === name) out.push(c);
      out = out.concat(getElementsByTagName(c, name));
    }
  });
  return out;
}
function makeEl(tag) {
  return {
    nodeType: 1, nodeName: tag, childNodes: [], attributes: {},
    getAttribute: function (n) {
      if (this.attributes[n] != null) return this.attributes[n];
      if (n.indexOf(':') < 0 && this.attributes['__l_' + n] != null) return this.attributes['__l_' + n];
      return null;
    },
    get textContent() { return textContent(this); },
    getElementsByTagName: function (n) { return getElementsByTagName(this, n); }
  };
}
function parseXML(xml) {
  xml = xml.replace(/<\?xml[^>]*\?>/g, '').replace(/<!DOCTYPE[^>]*>/g, '');
  var root = { nodeType: 9, nodeName: '#document', childNodes: [], attributes: {},
    getAttribute: function () { return null; }, textContent: '', getElementsByTagName: function (n) { return getElementsByTagName(this, n); } };
  var stack = [root];
  var re = /<(\/?)([^\s>/]+)((?:\s+[^\s>/]+(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)(\/?)>|([^<]+)/g;
  var m;
  while ((m = re.exec(xml))) {
    if (m[5] != null) {
      var txt = decode(m[5]);
      if (txt) {
        var parent = stack[stack.length - 1];
        parent.childNodes.push({ nodeType: 3, nodeValue: txt, parentNode: parent });
      }
    } else {
      var closing = m[1], tag = m[2], attrsStr = m[3] || '', selfClose = m[4];
      if (closing) { if (stack.length > 1) stack.pop(); continue; }
      var el = makeEl(tag);
      var ar = /\s+([^\s=]+)(?:=("([^"]*)"|'([^']*)'|([^\s>]+)))?/g, am;
      while ((am = ar.exec(attrsStr))) {
        var an = am[1], av = am[3] !== undefined ? am[3] : (am[4] !== undefined ? am[4] : (am[5] || ''));
        av = decode(av);
        el.attributes[an] = av;
        var li = an.indexOf(':') >= 0 ? an.slice(an.indexOf(':') + 1) : an;
        if (li !== an) el.attributes['__l_' + li] = av;
      }
      stack[stack.length - 1].childNodes.push(el);
      if (!selfClose) stack.push(el);
    }
  }
  return root;
}
global.DOMParser = function () {
  this.parseFromString = function (xml) { return parseXML(xml); };
};
global.window = {};
global.document = { createTreeWalker: function () { return { nextNode: function () { return null; } }; } };

/* ---------- util 複製 ---------- */
const U = {
  trim: function (s) { return String(s == null ? '' : s).replace(/^[\s\u3000]+|[\s\u3000]+$/g, ''); },
  cjk: /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/,
  sumMarks: function (text) {
    var t = String(text || ''), total = 0, m;
    var re = /[（(]\s*(\d+(?:\.\d+)?)\s*分\s*[）)]/g;
    while ((m = re.exec(t))) total += parseFloat(m[1]);
    return total;
  },
  esc: function (s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); },
  nl2br: function (s) { return String(s == null ? '' : s).replace(/\n/g,'<br>'); },
  stripSkills: function (text) {
    var skills = [];
    var out = String(text || '').replace(/[【\[]([^】\]]{1,8})[】\]]/g, function (all, inner) {
      if (/^(整合|引申|評價|解釋|複述|分析|鑑賞|創意|理解|應用)$/.test(inner)) { skills.push(inner); return ''; }
      return all;
    });
    return { text: U.trim(out), skills: skills };
  }
};
global.window.RQ = { util: U };

const src = fs.readFileSync(path.join(ROOT, 'assets/js/core/docx-parser.js'), 'utf8');
vm.runInThisContext(src);
const Docx = global.window.RQ.docx;

function run(file) {
  const buf = fs.readFileSync(file);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return Docx.parse(ab, { fileName: path.basename(file) }).then(function (r) {
    console.log('\n================ ' + path.basename(file) + ' ================');
    console.log('title   :', r.title);
    console.log('lang    :', r.lang, ' level:', r.level, ' totalMarks:', r.totalMarks);
    console.log('passages:', r.passages.length, r.passages.map(function (p) { return p.id + '(' + p.paragraphs.length + '段)'; }));
    console.log('questions:', r.questions.length,
      ' mcq:', r.questions.filter(function (q) { return q.type === 'mcq'; }).length,
      ' table:', r.questions.filter(function (q) { return q.type === 'table'; }).length);
    const secs = {};
    r.questions.forEach(function (q) { var k = q.section || '(none)'; secs[k] = (secs[k] || 0) + 1; });
    console.log('sections:', JSON.stringify(secs));
    const withQ = r.questions.filter(function (q) { return (q.quotes || []).length; });
    console.log('questions w/ quotes:', withQ.length);
    console.log('--- sample (first 4) ---');
    r.questions.slice(0, 4).forEach(function (q) {
      console.log('#' + q.no, '[' + (q.section || '') + ']', q.type,
        'mk=' + q.marks,
        'opts=' + (q.options || []).length,
        'keys=' + JSON.stringify(q.answerKeys || []),
        'tt=' + (q.tableType || ''));
      console.log('   stem:', q.stem.slice(0, 64));
      if (q.quotes && q.quotes.length) console.log('   quotes:', q.quotes.slice(0, 2).map(function (x) { return x.slice(0, 28); }));
      if (q.subQuestions && q.subQuestions.length) console.log('   subs:', q.subQuestions.slice(0, 3).map(function (s) { return s.kind + ':' + (s.answer || '').slice(0, 8); }));
    });
    console.log('warnings:', r.warnings.slice(0, 6));
    // dump full structure for a few representative questions
    [1, 8, 9, 10].forEach(function (n) {
      var q = r.questions.filter(function (x) { return x.no === n; })[0];
      if (q) { console.log('### FULL Q' + n + ':'); console.log(JSON.stringify(q, null, 1)); }
    });
    if (r.lang === 'en') {
      [2, 4, 21, 22].forEach(function (n) {
        var q = r.questions.filter(function (x) { return x.no === n; })[0];
        if (q) { console.log('### EN Q' + n + ':'); console.log(JSON.stringify({no:q.no,type:q.type,tt:q.tableType,stem:q.stem,opts:q.options,keys:q.answerKeys,answer:q.answer,subs:q.subQuestions,table:q.table}, null, 1)); }
      });
    }
  }).catch(function (e) { console.log('PARSE ERROR:', e.message, e.stack); });
}

(async function () {
  await run('D:/打工人/中文補習/試卷/中六/DCL2E_MP_R141_6H_SB.docx');
  await run('C:/Users/user/Downloads/2_Assessment_Task_reading_Obesity.docx');
})();
