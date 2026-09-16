/* 用極簡 DOM 樁 + 真實 docx-parser 輸出，演練 student.js 的顯示層邏輯，
   確認各種題型（mcq / 填充表格 / tfng / 組合選擇格 / 引文）都不會丟錯。 */
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = 'C:/Users/user/WorkBuddy/2026-09-16-21-14-08/reading-quiz';
const JSZip = require(path.join(ROOT, 'assets/js/lib/jszip.min.js'));
global.JSZip = JSZip;

/* ---- 極簡 XML-DOM 樁（與 _test_parse 同款，僅供 parser 使用）---- */
function decode(s){return String(s==null?'':s).replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&#x([0-9a-fA-F]+);/g,function(_,h){return String.fromCodePoint(parseInt(h,16));}).replace(/&#(\d+);/g,function(_,d){return String.fromCodePoint(parseInt(d,10));}).replace(/&amp;/g,'&');}
function textContent(n){var s='';(n.childNodes||[]).forEach(function(c){if(c.nodeType===3)s+=c.nodeValue;else if(c.nodeType===1)s+=textContent(c);});return s;}
function gEBTN(n,na){var o=[];(n.childNodes||[]).forEach(function(c){if(c.nodeType===1){if(c.nodeName===na)o.push(c);o=o.concat(gEBTN(c,na));}});return o;}
function makeEl(tag){return{nodeType:1,nodeName:tag,childNodes:[],attributes:{},getAttribute:function(n){return this.attributes[n]!=null?this.attributes[n]:(n.indexOf(':')<0&&this.attributes['__l_'+n]!=null?this.attributes['__l_'+n]:null);},get textContent(){return textContent(this);},getElementsByTagName:function(n){return gEBTN(this,n);}};}
function parseXML(xml){xml=xml.replace(/<\?xml[^>]*\?>/g,'').replace(/<!DOCTYPE[^>]*>/g,'');var root={nodeType:9,nodeName:'#document',childNodes:[],attributes:{},getAttribute:function(){return null;},textContent:'',getElementsByTagName:function(n){return gEBTN(this,n);}};var stack=[root];var re=/<(\/?)([^\s>/]+)((?:\s+[^\s>/]+(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)(\/?)>|([^<]+)/g;var m;while((m=re.exec(xml))){if(m[5]!=null){var t=decode(m[5]);if(t){var p=stack[stack.length-1];p.childNodes.push({nodeType:3,nodeValue:t,parentNode:p});}}else{var closing=m[1],tag=m[2],attrsStr=m[3]||'',selfClose=m[4];if(closing){if(stack.length>1)stack.pop();continue;}var el=makeEl(tag);var ar=/\s+([^\s=]+)(?:=("([^"]*)"|'([^']*)'|([^\s>]+)))?/g,am;while((am=ar.exec(attrsStr))){var an=am[1],av=am[3]!==undefined?am[3]:(am[4]!==undefined?am[4]:(am[5]||''));av=decode(av);el.attributes[an]=av;var li=an.indexOf(':')>=0?an.slice(an.indexOf(':')+1):an;if(li!==an)el.attributes['__l_'+li]=av;}stack[stack.length-1].childNodes.push(el);if(!selfClose)stack.push(el);}}return root;}
global.DOMParser=function(){this.parseFromString=function(x){return parseXML(x);};};
global.window={};global.document={createTreeWalker:function(){return{nextNode:function(){return null;}};}};

/* ---- util 樁（含真實會用到的 el/esc/nl2br/trim/debounce）---- */
function FakeNode(tag){
  this.tagName=String(tag||'div').split('.')[0];
  this.classes=(String(tag||'').split('.')).slice(1);
  this.attrs={};this.children=[];this._html='';this._text='';this.listeners={};
}
FakeNode.prototype.appendChild=function(c){this.children.push(c);return c;};
FakeNode.prototype.appendChild=function(c){this.children.push(c);return c;};
FakeNode.prototype.addEventListener=function(ev,fn){(this.listeners[ev]=this.listeners[ev]||[]).push(fn);};
FakeNode.prototype.setAttribute=function(k,v){this.attrs[k]=v;};
FakeNode.prototype.getAttribute=function(k){return this.attrs[k];};
FakeNode.prototype.querySelector=function(){return null;};
Object.defineProperty(FakeNode.prototype,'innerHTML',{get:function(){return this._html;},set:function(v){this._html=v;}});
Object.defineProperty(FakeNode.prototype,'textContent',{get:function(){return this._text;},set:function(v){this._text=v;}});
FakeNode.prototype.classList={add:function(){},remove:function(){},toggle:function(){}};
var uidc=0;
var U={
  trim:function(s){return String(s==null?'':s).replace(/^[\s\u3000]+|[\s\u3000]+$/g,'');},
  cjk:/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/,
  sumMarks:function(t){var tt=String(t||''),tot=0,m,re=/[（(]\s*(\d+(?:\.\d+)?)\s*分\s*[）)]/g;while((m=re.exec(tt)))tot+=parseFloat(m[1]);var r2=/[（(]\s*(\d+(?:\.\d+)?)\s*marks?\s*[）)]/gi;while((m=r2.exec(tt)))tot+=parseFloat(m[1]);return tot;},
  stripSkills:function(t){var sk=[];var out=String(t||'').replace(/[【\[]([^】\]]{1,8})[】\]]/g,function(a,i){if(/^(整合|引申|評價|解釋|複述|分析|鑑賞|創意|理解|應用)$/.test(i)){sk.push(i);return'';}return a;});return{text:U.trim(out),skills:sk};},
  esc:function(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');},
  nl2br:function(s){return String(s==null?'':s).replace(/\n/g,'<br>');},
  el:function(tag,attrs,children){var n=new FakeNode(tag);if(attrs)Object.keys(attrs).forEach(function(k){if(k==='html')n._html=attrs[k];else if(k==='text')n._text=attrs[k];else if(k==='class')n.classes=(n.classes||[]).concat(String(attrs[k]).split(' '));else if(typeof attrs[k]==='function'&&/^on/.test(k))n.listeners[k.slice(2)]=attrs[k];else n.attrs[k]=attrs[k];});if(children){(Array.isArray(children)?children:[children]).forEach(function(c){n.appendChild(c);});}return n;},
  $$:function(){return [];},
  debounce:function(fn){return fn;},
  uid:function(p){return (p||'')+(++uidc);},
  nowISO:function(){return new Date().toISOString();},
  fmtDate:function(){return '';},
  fmtDur:function(){return '';},
  percent:function(){return 0;},
  barClass:function(){return '';},
  toast:function(){},modal:function(){},readFileAsArrayBuffer:function(){return Promise.resolve();}
};
global.window.RQ={util:U};
// 其它依賴先放空桩，Forms 不直接用到
global.window.RQ.store={};global.window.RQ.settings={};global.window.RQ.backend={};global.window.RQ.crypto={};

/* ---- 載入 docx-parser（提供解析結果）---- */
const psrc=fs.readFileSync(path.join(ROOT,'assets/js/core/docx-parser.js'),'utf8');
vm.runInThisContext(psrc);
const Docx=global.window.RQ.docx;

/* ---- 載入 student.js 的 Forms ---- */
const ssrc=fs.readFileSync(path.join(ROOT,'assets/js/student.js'),'utf8');
vm.runInThisContext(ssrc);
const Forms=global.window.RQ.forms;

function countNodes(n,tag){var c=(n.tagName===tag?1:0);(n.children||[]).forEach(function(ch){if(ch&&ch.tagName)c+=countNodes(ch,tag);});return c;}

(async function(){
  const files=['D:/打工人/中文補習/試卷/中六/DCL2E_MP_R141_6H_SB.docx','C:/Users/user/Downloads/2_Assessment_Task_reading_Obesity.docx'];
  for(const f of files){
    const buf=fs.readFileSync(f);const ab=buf.buffer.slice(buf.byteOffset,buf.byteOffset+buf.byteLength);
    const r=await Docx.parse(ab,{fileName:path.basename(f)});
    console.log('\n========',path.basename(f),'========');
    console.log('questions:',r.questions.length,'mcq:',r.questions.filter(q=>q.type==='mcq').length,'table:',r.questions.filter(q=>q.type==='table').length);
    r.questions.forEach(function(q){
      if (q.no===2 || q.no===11){
        console.log('\n--- DUMP Q'+q.no+' (type='+q.type+', tt='+(q.tableType||'')+') ---');
        console.log('stem:', q.stem);
        console.log('quotes('+q.quotes.length+'):', JSON.stringify(q.quotes).slice(0,300));
        console.log('table rows:', (q.table&&q.table.rows||[]).length);
        (q.table&&q.table.rows||[]).forEach(function(row,ri){
          console.log('  row'+ri+':', row.map(function(c){return '['+ (c.visible||c.text||'').slice(0,14) + (c.sym?'*sym':'') +']';}).join(' '));
        });
        console.log('options:', JSON.stringify(q.options));
      }
      try{
        var wrap=Forms.input(q,{},{onChange:function(){}});
        var inputs=countNodes(wrap,'input'), selects=countNodes(wrap,'select'), textareas=countNodes(wrap,'textarea'), tables=countNodes(wrap,'table');
        var qb=Forms.quotesBlock(q);
        var at=Forms.answerText(q,{});
        var rev=Forms.reveal(q,{});
        console.log('#'+q.no,'['+q.section+']',q.type,'tt='+(q.tableType||''),
          '| inputs='+inputs,'selects='+selects,'ta='+textareas,'tables='+tables,
          'quotes='+(qb?qb.children.length:0));
      }catch(e){console.log('#'+q.no,'ERROR',e.message,'\n',e.stack.split('\n').slice(0,3).join('\n'));}
    });
  }
  console.log('\nDISPLAY SMOKE TEST DONE');
})().catch(function(e){console.log('FATAL',e.stack);});
