/* 檢查英文卷「Suggested Answers」區段的原始區塊，找出 MCQ 答案對應方式 */
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
var U={trim:function(s){return String(s==null?'':s).replace(/^[\s\u3000]+|[\s\u3000]+$/g,'');},esc:function(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');},cjk:/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/,sumMarks:function(t){var tt=String(t||''),tot=0,m,re=/[（(]\s*(\d+(?:\.\d+)?)\s*分\s*[）)]/g;while((m=re.exec(tt)))tot+=parseFloat(m[1]);var r2=/[（(]\s*(\d+(?:\.\d+)?)\s*marks?\s*[）)]/gi;while((m=r2.exec(tt)))tot+=parseFloat(m[1]);return tot;},stripSkills:function(t){var sk=[];var out=String(t||'').replace(/[【\[]([^】\]]{1,8})[】\]]/g,function(a,i){if(/^(整合|引申|評價|解釋|複述|分析|鑑賞|創意|理解|應用)$/.test(i)){sk.push(i);return'';}return a;});return{text:U.trim(out),skills:sk};}};
global.window.RQ={util:U};
const psrc=fs.readFileSync(path.join(ROOT,'assets/js/core/docx-parser.js'),'utf8');
vm.runInThisContext(psrc);
const Docx=global.window.RQ.docx;
const f='C:/Users/user/Downloads/2_Assessment_Task_reading_Obesity.docx';
const buf=fs.readFileSync(f);const ab=buf.buffer.slice(buf.byteOffset,buf.byteOffset+buf.byteLength);
Docx.parse(ab,{fileName:path.basename(f)}).then(function(r){
  console.log('questions:',r.questions.length);
  r.questions.forEach(function(q){
    if(q.type==='mcq'){
      console.log('#'+q.no,'mcq opts='+q.options.length,'keys='+JSON.stringify(q.answerKeys||[]),'ans='+JSON.stringify((q.answer||'').slice(0,20)));
    }
  });
}).catch(e=>console.log('ERR',e.message));
