/* 測 groupQuestions / isGroupSubmitted：分卷（甲/乙）與分篇（第一篇/第二篇）切分是否正確 */
const fs=require('fs'),path=require('path'),vm=require('vm');
const ROOT='C:/Users/user/WorkBuddy/2026-09-16-21-14-08/reading-quiz';
global.JSZip=require(path.join(ROOT,'assets/js/lib/jszip.min.js'));
function decode(s){return String(s==null?'':s).replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&#x([0-9a-fA-F]+);/g,function(_,h){return String.fromCodePoint(parseInt(h,16));}).replace(/&#(\d+);/g,function(_,d){return String.fromCodePoint(parseInt(d,10));}).replace(/&amp;/g,'&');}
function textContent(n){var s='';(n.childNodes||[]).forEach(function(c){if(c.nodeType===3)s+=c.nodeValue;else if(c.nodeType===1)s+=textContent(c);});return s;}
function gEBTN(n,na){var o=[];(n.childNodes||[]).forEach(function(c){if(c.nodeType===1){if(c.nodeName===na)o.push(c);o=o.concat(gEBTN(c,na));}});return o;}
function makeEl(tag){return{nodeType:1,nodeName:tag,childNodes:[],attributes:{},getAttribute:function(n){return this.attributes[n]!=null?this.attributes[n]:(n.indexOf(':')<0&&this.attributes['__l_'+n]!=null?this.attributes['__l_'+n]:null);},get textContent(){return textContent(this);},getElementsByTagName:function(n){return gEBTN(this,n);}};}
function parseXML(xml){xml=xml.replace(/<\?xml[^>]*\?>/g,'').replace(/<!DOCTYPE[^>]*>/g,'');var root={nodeType:9,nodeName:'#document',childNodes:[],attributes:{},getAttribute:function(){return null;},textContent:'',getElementsByTagName:function(n){return gEBTN(this,n);}};var stack=[root];var re=/<(\/?)([^\s>/]+)((?:\s+[^\s>/]+(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)(\/?)>|([^<]+)/g;var m;while((m=re.exec(xml))){if(m[5]!=null){var t=decode(m[5]);if(t){var p=stack[stack.length-1];p.childNodes.push({nodeType:3,nodeValue:t,parentNode:p});}}else{var closing=m[1],tag=m[2],attrsStr=m[3]||'',selfClose=m[4];if(closing){if(stack.length>1)stack.pop();continue;}var el=makeEl(tag);var ar=/\s+([^\s=]+)(?:=("([^"]*)"|'([^']*)'|([^\s>]+)))?/g,am;while((am=ar.exec(attrsStr))){var an=am[1],av=am[3]!==undefined?am[3]:(am[4]!==undefined?am[4]:(am[5]||''));av=decode(av);el.attributes[an]=av;var li=an.indexOf(':')>=0?an.slice(an.indexOf(':')+1):an;if(li!==an)el.attributes['__l_'+li]=av;}stack[stack.length-1].childNodes.push(el);if(!selfClose)stack.push(el);}}return root;}
global.DOMParser=function(){this.parseFromString=function(x){return parseXML(x);};};
global.window={};global.document={createTreeWalker:function(){return{nextNode:function(){return null;}};}};
var uidc=0;
function FakeNode(tag){this.tagName=String(tag||'div').split('.')[0];this.classes=(String(tag||'').split('.')).slice(1);this.attrs={};this.children=[];this._html='';this._text='';this.listeners={};}
FakeNode.prototype.appendChild=function(c){this.children.push(c);return c;};
FakeNode.prototype.addEventListener=function(e,f){(this.listeners[e]=this.listeners[e]||[]).push(f);};
FakeNode.prototype.setAttribute=function(k,v){this.attrs[k]=v;};
FakeNode.prototype.getAttribute=function(k){return this.attrs[k];};
FakeNode.prototype.querySelector=function(){return null;};
Object.defineProperty(FakeNode.prototype,'innerHTML',{get:function(){return this._html;},set:function(v){this._html=v;}});
Object.defineProperty(FakeNode.prototype,'textContent',{get:function(){return this._text;},set:function(v){this._text=v;}});
FakeNode.prototype.classList={add:function(){},remove:function(){},toggle:function(){}};
var U={trim:function(s){return String(s==null?'':s).replace(/^[\s\u3000]+|[\s\u3000]+$/g,'');},cjk:/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/,sumMarks:function(t){var tt=String(t||''),tot=0,m,re=/[（(]\s*(\d+(?:\.\d+)?)\s*分\s*[）)]/g;while((m=re.exec(tt)))tot+=parseFloat(m[1]);var r2=/[（(]\s*(\d+(?:\.\d+)?)\s*marks?\s*[）)]/gi;while((m=r2.exec(tt)))tot+=parseFloat(m[1]);return tot;},stripSkills:function(t){var sk=[];var out=String(t||'').replace(/[【\[]([^】\]]{1,8})[】\]]/g,function(a,i){if(/^(整合|引申|評價|解釋|複述|分析|鑑賞|創意|理解|應用)$/.test(i)){sk.push(i);return'';}return a;});return{text:U.trim(out),skills:sk};},esc:function(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');},nl2br:function(s){return String(s==null?'':s).replace(/\n/g,'<br>');},el:function(tag,attrs,children){var n=new FakeNode(tag);if(attrs)Object.keys(attrs).forEach(function(k){if(k==='html')n._html=attrs[k];else if(k==='text')n._text=attrs[k];else if(k==='class')n.classes=(n.classes||[]).concat(String(attrs[k]).split(' '));else if(typeof attrs[k]==='function'&&/^on/.test(k))n.listeners[k.slice(2)]=attrs[k];else n.attrs[k]=attrs[k];});if(children){(Array.isArray(children)?children:[children]).forEach(function(c){n.appendChild(c);});}return n;}};
U['$$']=function(){return [];};U.debounce=function(fn){return fn;};U.uid=function(p){return (p||'')+(++uidc);};U.nowISO=function(){return new Date().toISOString();};U.fmtDate=function(){return '';};U.fmtDur=function(){return '';};U.percent=function(){return 0;};U.barClass=function(){return '';};U.toast=function(){};U.modal=function(){};U.readFileAsArrayBuffer=function(){return Promise.resolve();};
global.window.RQ={util:U,store:{},settings:{},backend:{},crypto:{}};
vm.runInThisContext(fs.readFileSync(path.join(ROOT,'assets/js/core/docx-parser.js'),'utf8'));
vm.runInThisContext(fs.readFileSync(path.join(ROOT,'assets/js/student.js'),'utf8'));
const Docx=global.window.RQ.docx, Stu=global.window.RQ.student;
const G=Stu._internal.groupQuestions, isSub=Stu._internal.isGroupSubmitted;

(async function(){
  const f='D:/打工人/中文補習/試卷/中六/DCL2E_MP_R141_6H_SB.docx';
  const buf=fs.readFileSync(f);const ab=buf.buffer.slice(buf.byteOffset,buf.byteOffset+buf.byteLength);
  const r=await Docx.parse(ab,{fileName:path.basename(f)});
  const quiz={title:r.title,questions:r.questions,passages:r.passages,totalMarks:r.totalMarks};
  const groups=G(quiz);
  console.log('groups:',groups.length);
  groups.forEach(function(g){console.log('  ',g.key,'|',g.label,'| 題數='+g.questions.length,'| 分='+g.marks);});

  // 模擬：提交甲部
  const past=[{submittedAt:'2026-01-01',scope:{type:'section',key:'sec:甲部',label:'甲部'}}];
  console.log('甲部已提交?', isSub(past,'sec:甲部'), ' 乙部已提交?', isSub(past,'sec:乙部'));
  console.log('（無 scope 的整份提交 涵蓋甲部?）', isSub([{submittedAt:'x',scope:null}],'sec:甲部'));

  // 只有閱讀理解（無分卷）→ 應以篇章分組
  const quiz2={title:'x',passages:[{id:'p1',title:'第一篇'},{id:'p2',title:'第二篇'}],
    questions:[{id:'q1',no:1,passageId:'p1',marks:2},{id:'q2',no:2,passageId:'p2',marks:3},{id:'q3',no:3,passageId:'p2',marks:1}]};
  const g2=G(quiz2);
  console.log('passage groups:',g2.length, g2.map(function(g){return g.key+':'+g.questions.length;}));

  // 單篇 → 單一 group
  const quiz3={title:'y',passages:[{id:'p1',title:'A'}],questions:[{id:'q1',no:1,passageId:'p1',marks:2}],totalMarks:2};
  console.log('single group:',G(quiz3).length);
  console.log('GROUPING TEST DONE');
})().catch(e=>console.log('FATAL',e.stack));
