/* 表格「內容完整度」測試：把原卷表格每個儲存格的文字，與顯示層真正畫出來的文字比對，
   找出「有格但沒畫出來」的內容（header row / header column 漏掉就是這裡抓）。
   用法：node tools/_test_table_cells.js [file.docx ...]                       */
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = 'C:/Users/user/WorkBuddy/2026-09-16-21-14-08/reading-quiz';
global.JSZip = require(path.join(ROOT, 'assets/js/lib/jszip.min.js'));

/* ---- XML-DOM 樁 ---- */
function decode(s){return String(s==null?'':s).replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&#x([0-9a-fA-F]+);/g,function(_,h){return String.fromCodePoint(parseInt(h,16));}).replace(/&#(\d+);/g,function(_,d){return String.fromCodePoint(parseInt(d,10));}).replace(/&amp;/g,'&');}
function textContent(n){var s='';(n.childNodes||[]).forEach(function(c){if(c.nodeType===3)s+=c.nodeValue;else if(c.nodeType===1)s+=textContent(c);});return s;}
function gEBTN(n,na){var o=[];(n.childNodes||[]).forEach(function(c){if(c.nodeType===1){if(c.nodeName===na)o.push(c);o=o.concat(gEBTN(c,na));}});return o;}
function makeEl(tag){return{nodeType:1,nodeName:tag,childNodes:[],attributes:{},getAttribute:function(n){return this.attributes[n]!=null?this.attributes[n]:(n.indexOf(':')<0&&this.attributes['__l_'+n]!=null?this.attributes['__l_'+n]:null);},get textContent(){return textContent(this);},getElementsByTagName:function(n){return gEBTN(this,n);}};}
function parseXML(xml){xml=xml.replace(/<\?xml[^>]*\?>/g,'').replace(/<!DOCTYPE[^>]*>/g,'');var root={nodeType:9,nodeName:'#document',childNodes:[],attributes:{},getAttribute:function(){return null;},textContent:'',getElementsByTagName:function(n){return gEBTN(this,n);}};var stack=[root];var re=/<(\/?)([^\s>/]+)((?:\s+[^\s>/]+(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)(\/?)>|([^<]+)/g;var m;while((m=re.exec(xml))){if(m[5]!=null){var t=decode(m[5]);if(t){var p=stack[stack.length-1];p.childNodes.push({nodeType:3,nodeValue:t,parentNode:p});}}else{var closing=m[1],tag=m[2],attrsStr=m[3]||'',selfClose=m[4];if(closing){if(stack.length>1)stack.pop();continue;}var el=makeEl(tag);var ar=/\s+([^\s=]+)(?:=("([^"]*)"|'([^']*)'|([^\s>]+)))?/g,am;while((am=ar.exec(attrsStr))){var an=am[1],av=am[3]!==undefined?am[3]:(am[4]!==undefined?am[4]:(am[5]||''));av=decode(av);el.attributes[an]=av;var li=an.indexOf(':')>=0?an.slice(an.indexOf(':')+1):an;if(li!==an)el.attributes['__l_'+li]=av;}stack[stack.length-1].childNodes.push(el);if(!selfClose)stack.push(el);}}return root;}
global.DOMParser=function(){this.parseFromString=function(x){return parseXML(x);};};
global.window={};global.document={createTreeWalker:function(){return{nextNode:function(){return null;}};}};

/* ---- util 樁 ---- */
function FakeNode(tag){this.tagName=String(tag||'div').split('.')[0];this.classes=(String(tag||'').split('.')).slice(1);this.attrs={};this.children=[];this._html='';this._text='';this.listeners={};}
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
  $$:function(){return [];},debounce:function(fn){return fn;},uid:function(p){return (p||'')+(++uidc);},
  nowISO:function(){return new Date().toISOString();},fmtDate:function(){return '';},fmtDur:function(){return '';},
  percent:function(){return 0;},barClass:function(){return '';},toast:function(){},modal:function(){}
};
global.window.RQ={util:U};
global.window.RQ.store={};global.window.RQ.settings={};global.window.RQ.backend={};global.window.RQ.crypto={};

vm.runInThisContext(fs.readFileSync(path.join(ROOT,'assets/js/core/docx-parser.js'),'utf8'));
const Docx=global.window.RQ.docx;
vm.runInThisContext(fs.readFileSync(path.join(ROOT,'assets/js/student.js'),'utf8'));
const Forms=global.window.RQ.forms;

/* ---- 收集畫面上所有文字 ---- */
function stripTags(h){return String(h||'').replace(/<br\s*\/?>/gi,'\n').replace(/&nbsp;/g,' ').replace(/<[^>]*>/g,'');}
function collectText(n,out){
  if(!n||!n.tagName)return out;
  if(n._text)out.push(n._text);
  if(n._html)out.push(stripTags(n._html));
  if(n.attrs)['placeholder','value'].forEach(function(k){if(n.attrs[k])out.push(String(n.attrs[k]));});
  (n.children||[]).forEach(function(c){collectText(c,out);});
  return out;
}
function norm(s){return String(s==null?'':s).replace(/[\s\u3000\u00a0]+/g,'');}

/* 需要看原始列結構時：node tools/_test_table_cells.js <file> --dump 7,10,11 */
function dumpRows(q){
  var rows=q.table.rows||[];
  console.log('  --- Q'+q.no+' rows='+rows.length+' tableType='+(q.tableType||'-')
    +' subQuestions='+(q.subQuestions||[]).length+' ---');
  rows.forEach(function(row,ri){
    console.log('   row'+ri+':');
    row.forEach(function(c,ci){
      var t=(c&&(c.text||''))||'', v=(c&&(c.visible||''))||'';
      console.log('     c'+ci
        +' text='+JSON.stringify(t.slice(0,30))
        +' visible='+JSON.stringify(v.slice(0,30))
        +' sym='+((c&&c.sym)||0)
        +' span='+((c&&c.span)||1)
        +' vmerge='+((c&&c.vmerge)||'-')
        +' red='+((c&&c.red)?1:0));
    });
  });
  (q.subQuestions||[]).forEach(function(s,i){
    console.log('   sub'+i+' id='+s.id+' kind='+s.kind+' label='+JSON.stringify((s.label||'').slice(0,40))
      +' prompt='+JSON.stringify((s.prompt||'').slice(0,40))+' ans='+JSON.stringify((s.answer||'').slice(0,20))
      +' choices='+((s.choices||[]).length));
  });
}

(async function(){
  const args = process.argv.slice(2);
  const dumpIdx = args.indexOf('--dump');
  const dumpNos = dumpIdx >= 0 ? args.splice(dumpIdx, 2)[1].split(',').map(Number) : [];
  const showIdx = args.indexOf('--show');            // 印出實際畫出來的表格文字
  const showNos = showIdx >= 0 ? args.splice(showIdx, 2)[1].split(',').map(Number) : [];
  const files = args.length ? args
    : ['D:/打工人/中文補習/試卷/中六/DCL2E_MP_R141_6H_SB.docx',
       'D:/打工人/中文補習/試卷/中二/K5E_QB_F2_R_T01.docx',
       'C:/Users/user/Downloads/2_Assessment_Task_reading_Obesity.docx'];
  let totalMiss = 0;
  for(const f of files){
    if(!fs.existsSync(f)){console.log('SKIP (not found):',f);continue;}
    const buf=fs.readFileSync(f);const ab=buf.buffer.slice(buf.byteOffset,buf.byteOffset+buf.byteLength);
    const r=await Docx.parse(ab,{fileName:path.basename(f)});
    console.log('\n========',path.basename(f),'========');
    r.questions.forEach(function(q){
      if(q.type!=='table'||!q.table||!(q.table.rows||[]).length)return;
      if(dumpNos.length && dumpNos.indexOf(q.no)>=0) dumpRows(q);
      var rows=q.table.rows;
      var srcCells=[];
      rows.forEach(function(row,ri){
        row.forEach(function(c,ci){
          /* 填空記號（底線、○、空括號）在畫面上會變成輸入框／選項，
             比對時要先去掉，否則會誤報「沒畫出來」。 */
          var t=norm((c&&(c.text&&c.text.length>=(c.visible||'').length?c.text:c.visible))||'');
          t=t.replace(/[_＿]+/g,'').replace(/[○●◯◎]/g,'').replace(/[（(]\s*[)）]/g,'');
          t=norm(t);
          if(t)srcCells.push({ri:ri,ci:ci,t:t});
        });
      });
      var wrap;
      try{ wrap=Forms.tableInput(q,{},{onChange:function(){}}); }
      catch(e){ console.log('  Q'+q.no+' RENDER ERROR '+e.message); return; }
      var rendered=norm(collectText(wrap,[]).join(''));
      if(showNos.indexOf(q.no)>=0){
        console.log('  >>> Q'+q.no+' 畫面文字:');
        (wrap.children||[]).forEach(function(sec){
          (sec.children||[]).forEach(function(tr){
            var cells=(tr.children||[]).map(function(td){
              var isIn=(td.children||[]).some(function(c){return c.tagName==='input'||c.tagName==='textarea'||c.tagName==='select';});
              return (isIn?'[輸入]':'')+norm(collectText(td,[]).join(''));
            });
            console.log('       ['+tr.tagName+'] '+cells.join(' | '));
          });
        });
      }
      var miss=srcCells.filter(function(s){return rendered.indexOf(s.t)<0;});
      var uniq={}; miss=miss.filter(function(m){if(uniq[m.t])return false;uniq[m.t]=1;return true;});
      console.log('  Q'+q.no+' tt='+(q.tableType||'-')+' rows='+rows.length
        +' cells='+srcCells.length+' 未畫出='+miss.length
        +' sub='+((q.subQuestions||[]).length));
      if(showNos.indexOf(q.no)>=0){
        var names={};
        (function walk(n){(n.children||[]).forEach(function(c){if(c.tagName==='input'&&c.attrs&&c.attrs.type==='radio'){names[c.attrs.name]=1;}walk(c);});})(wrap);
        var sample=[];
        (function walk2(n){(n.children||[]).forEach(function(c){if(c.tagName==='input'&&c.attrs&&c.attrs.type==='radio'&&sample.length<2){sample.push(JSON.stringify(c.attrs));}walk2(c);});})(wrap);
        console.log('      [radio 群組] '+JSON.stringify(Object.keys(names)));
        console.log('      [radio attrs] '+sample.join(' / '));
        var subKeys=(q.subQuestions||[]).map(function(x){return x.id+'='+x.answer;});
        if(subKeys.length)console.log('      [子題答案]   '+subKeys.join(', '));
      }
      if(miss.length){
        totalMiss+=miss.length;
        if(showNos.indexOf(q.no)>=0){ console.log('      [dbg] src=',JSON.stringify(miss[0].t)); console.log('      [dbg] rendered=',JSON.stringify(rendered.slice(0,400))); }
        miss.slice(0,12).forEach(function(m){
          console.log('      r'+m.ri+'c'+m.ci+' "'+m.t.slice(0,34)+'"');
        });
      }
    });
  }
  console.log('\nTOTAL MISSING CELL TEXTS:',totalMiss);
  console.log('TABLE CELL TEST DONE');
})().catch(function(e){console.log('FATAL',e.stack);});
