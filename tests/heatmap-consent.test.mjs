import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const source=readFileSync(new URL('../assets/heatmap-consent.js',import.meta.url),'utf8');
const KEY='vanta-statistics-consent:v2';
const OLD_KEY='vanta-heatmap-consent:v1';
const TTL=30*24*60*60*1000;
const NOW=1_000_000_000_000;

function setup(options={}){
 let now=NOW,nextTimer=0,active=false,filter=null;
 const storage=new Map(),timers=new Map(),intervals=new Map(),nodes=new Map();
 const scripts=[],links=[],wrappers=[],sent=[];
 const calls={grant:0,revoke:0,get:0,set:0,remove:0,revokeFilter:[],order:[]};
 if(options.stored)storage.set(KEY,JSON.stringify(options.stored(now)));
 if(options.oldStored)storage.set(OLD_KEY,JSON.stringify(options.oldStored(now)));
 function eventTarget(value={}){
  const listeners=new Map();
  value.addEventListener=(name,fn)=>{if(!listeners.has(name))listeners.set(name,[]);listeners.get(name).push(fn);};
  value.fire=(name,event={})=>{for(const fn of [...(listeners.get(name)||[])])fn(event);};
  return value;
 }
 const document={activeElement:null,getElementById:id=>nodes.get(id)||null,querySelector:selector=>selector==='link[href="/assets/heatmap-consent.css"]'?links.find(link=>link.href==='/assets/heatmap-consent.css')||null:null};
 function element(tag,id){
  const node=eventTarget({tagName:tag.toUpperCase(),id:id||'',hidden:id==='hm-consent',disabled:false,textContent:'',attrs:{},setAttribute(name,value){this.attrs[name]=value;},focus(){document.activeElement=this;}});
  node.click=()=>{if(!node.disabled)node.fire('click');};
  Object.defineProperty(node,'innerHTML',{set(value){node.markup=value;for(const match of value.matchAll(/<([a-z]+)([^>]*\bid="([^"]+)"[^>]*)>([^<]*)/g)){const child=element(match[1],match[3]);child.textContent=match[4];child.hidden=/\bhidden\b/.test(match[2]);nodes.set(child.id,child);}},get(){return node.markup||'';}});
  if(id)nodes.set(id,node);
  return node;
 }
 function append(node){if(node.tagName==='SCRIPT')scripts.push(node);else if(node.tagName==='LINK')links.push(node);else wrappers.push(node);return node;}
 document.body={appendChild:append};document.head={appendChild:append};document.createElement=tag=>element(tag);
 if(!options.missingDOM)for(const id of ['hm-consent','hm-accept','hm-reject','hm-preferences','hm-consent-status','hm-consent-announcement'])element(id.startsWith('hm-consent')?'section':'button',id);
 if(!options.noStyle)links.push({tagName:'LINK',href:'/assets/heatmap-consent.css'});
 const window=eventTarget({location:{pathname:options.path||'/'},navigator:{globalPrivacyControl:!!options.gpc,doNotTrack:options.dnt||null},
  localStorage:{getItem(key){calls.get++;if(options.storageBlocked)throw Error('blocked');return storage.get(key)||null;},setItem(key,value){calls.set++;calls.order.push('persist');if(options.storageBlocked||options.writeBlocked)throw Error('blocked');storage.set(key,value);},removeItem(key){calls.remove++;if(options.storageBlocked)throw Error('blocked');storage.delete(key);}},
  setTimeout(fn,delay){const id=++nextTimer;timers.set(id,{fn,delay});return id;},clearTimeout:id=>timers.delete(id),setInterval(fn,delay){const id=++nextTimer;intervals.set(id,{fn,delay});return id;},
 });
 function currentFilter(){return filter||(window.vaq||[]).find(args=>args[0]==='beforeSend')?.[1];}
 function emit(event={type:'pageview',url:'https://www.vantastudio.dk/'}){const callback=currentFilter();const result=callback?callback(event):event;if(result!==null)sent.push(result);return result;}
 class FakeDate extends Date{static now(){return now;}}
 const api={grantConsent(){calls.grant++;active=true;return{active:true};},revokeConsent(){calls.revoke++;calls.order.push('revoke');calls.revokeFilter.push(currentFilter()?.({type:'pageview'}));active=false;return{active:false};}};
 const context=vm.createContext({window,document,Date:FakeDate,JSON,Number,String,Math});
 vm.runInContext(source,context);
 return {window,document,nodes,scripts,links,wrappers,calls,storage,timers,sent,emit,
  node:id=>nodes.get(id),get active(){return active;},
  loadHeatmap(){const script=scripts.find(s=>s.src==='/assets/vanta-heatmap.js');assert.ok(script);window.VantaHeatmap=api;script.onload();},
  loadAnalytics(){const script=scripts.find(s=>s.src==='/_vercel/insights/script.js');assert.ok(script);const queue=window.vaq||[];window.va=(name,fn)=>{if(name==='beforeSend')filter=fn;};for(const args of queue)window.va(...args);window.vaq=[];const initial=emit();script.onload();return initial;},
  advance(ms){now+=ms;},tick(){for(const {fn} of intervals.values())fn();},expire(){for(const [id,{fn}] of [...timers]){timers.delete(id);fn();}},rerun(){vm.runInContext(source,context);},
 };
}
const analytics=h=>h.scripts.filter(s=>s.src==='/_vercel/insights/script.js');
const heatmaps=h=>h.scripts.filter(s=>s.src==='/assets/vanta-heatmap.js');

test('first visit defaults deny for both statistics types, with no routine status clutter',()=>{
 const h=setup();assert.equal(h.scripts.length,0);assert.equal(h.emit(),null);assert.equal(h.calls.grant,0);
 assert.equal(h.node('hm-consent').hidden,false);assert.equal(h.node('hm-consent-status').textContent,'');
 assert.equal(h.calls.set,0);assert.equal(h.calls.remove,0);assert.equal(h.sent.length,0);
});

test('necessary-only remembers a bounded preference and loads no analytics or heatmap',()=>{
 const h=setup();h.node('hm-reject').click();assert.equal(h.scripts.length,0);assert.equal(h.emit(),null);
 const stored=JSON.parse(h.storage.get(KEY));assert.deepEqual(Object.keys(stored).sort(),['expiresAt','value']);assert.equal(stored.value,'rejected');assert.equal(stored.expiresAt,NOW+TTL);
 h.node('hm-preferences').click();assert.match(h.node('hm-consent-status').textContent,/kun nødvendige/);assert.equal(h.document.activeElement.id,'hm-reject');
});

test('allow all registers beforeSend before loading both configured same-origin scripts',()=>{
 const h=setup();h.node('hm-accept').click();assert.equal(analytics(h).length,1);assert.equal(heatmaps(h).length,1);assert.equal(h.calls.grant,0);
 const script=heatmaps(h)[0];assert.equal(script.attrs['data-endpoint'],'/api/heatmap');assert.equal(script.attrs['data-site'],'vh_147f00e02bb84d1e9104179eedaafcbe');assert.equal(script.attrs['data-page'],'/');assert.equal(script.attrs['data-version'],'a');
 assert.ok(h.loadAnalytics());h.loadHeatmap();assert.equal(h.active,true);assert.equal(h.calls.grant,1);
});

test('withdrawal blocks the analytics callback before heatmap cleanup and persistence completes',()=>{
 const h=setup();h.node('hm-accept').click();h.loadAnalytics();h.loadHeatmap();
 h.calls.order.length=0;
 h.node('hm-preferences').click();h.node('hm-reject').click();
 assert.equal(h.active,false);assert.equal(h.emit(),null);assert.equal(h.calls.revokeFilter.at(-1),null);assert.equal(JSON.parse(h.storage.get(KEY)).value,'rejected');
 assert.deepEqual(h.calls.order.slice(0,2),['revoke','persist']);
});

test('a delayed analytics or tracker download cannot reactivate after withdrawal',()=>{
 const h=setup();h.node('hm-accept').click();h.node('hm-preferences').click();h.node('hm-reject').click();
 assert.equal(h.loadAnalytics(),null);h.loadHeatmap();assert.equal(h.calls.grant,0);assert.equal(h.active,false);assert.equal(h.sent.length,0);
});

test('valid accepted preference resumes, rejected or expired preferences never load statistics',()=>{
 const accepted=setup({stored:now=>({value:'accepted',expiresAt:now+1000})});assert.equal(accepted.scripts.length,2);accepted.loadAnalytics();accepted.loadHeatmap();assert.equal(accepted.active,true);
 const rejected=setup({stored:now=>({value:'rejected',expiresAt:now+1000})});assert.equal(rejected.scripts.length,0);assert.equal(rejected.node('hm-consent').hidden,true);
 const expired=setup({stored:now=>({value:'accepted',expiresAt:now-1})});assert.equal(expired.scripts.length,0);assert.equal(expired.emit(),null);assert.equal(expired.node('hm-consent').hidden,false);
});

test('old heatmap-only consent is never promoted to all-statistics permission',()=>{
 const h=setup({oldStored:now=>({value:'accepted',expiresAt:now+TTL})});assert.equal(h.scripts.length,0);assert.equal(h.emit(),null);assert.equal(h.node('hm-consent').hidden,false);assert.equal(h.storage.has(KEY),false);
});

test('GPC and DNT block all statistics even with a saved accepted preference',()=>{
 for(const privacy of [{gpc:true},{dnt:'1'},{dnt:'yes'}]){const h=setup({...privacy,stored:now=>({value:'accepted',expiresAt:now+TTL})});assert.equal(h.scripts.length,0);assert.equal(h.emit(),null);assert.equal(h.node('hm-accept').disabled,true);h.node('hm-accept').fire('click');assert.equal(h.scripts.length,0);}
});

test('new privacy signal blocks analytics immediately and later removal requires a fresh choice',()=>{
 const h=setup();h.node('hm-accept').click();h.loadAnalytics();h.loadHeatmap();
 h.window.navigator.globalPrivacyControl=true;assert.equal(h.emit(),null);h.tick();assert.equal(h.active,false);
 h.window.navigator.globalPrivacyControl=false;h.tick();assert.equal(h.emit(),null);assert.equal(h.active,false);assert.equal(h.node('hm-consent').hidden,false);assert.equal(h.storage.has(KEY),false);
});

test('expiry blocks analytics before a delayed timer runs, then stops heatmap and asks again',()=>{
 const h=setup();h.node('hm-accept').click();h.loadAnalytics();h.loadHeatmap();assert.ok([...h.timers.values()].every(t=>t.delay<=2147483647));
 h.advance(TTL+1);assert.equal(h.emit(),null);h.expire();assert.equal(h.active,false);assert.equal(h.node('hm-consent').hidden,false);assert.equal(h.storage.has(KEY),false);
});

test('cross-tab rejection blocks before the storage event; that event also stops heatmap',()=>{
 const h=setup();h.node('hm-accept').click();h.loadAnalytics();h.loadHeatmap();
 h.storage.set(KEY,JSON.stringify({value:'rejected',expiresAt:NOW+TTL}));assert.equal(h.emit(),null);
 h.window.fire('storage',{key:KEY});assert.equal(h.active,false);assert.equal(h.emit(),null);
});

test('cross-tab clearing the choice denies statistics and reopens preferences',()=>{
 const h=setup();h.node('hm-accept').click();h.loadAnalytics();h.loadHeatmap();h.storage.clear();assert.equal(h.emit(),null);
 h.window.fire('storage',{key:null});assert.equal(h.active,false);assert.equal(h.node('hm-consent').hidden,false);
});

test('storage restrictions allow explicit session-only acceptance but never bypass rejection',()=>{
 const h=setup({storageBlocked:true});h.node('hm-accept').click();assert.equal(h.scripts.length,2);h.loadAnalytics();h.loadHeatmap();assert.equal(h.active,true);
 h.node('hm-preferences').click();h.node('hm-reject').click();assert.equal(h.emit(),null);assert.equal(h.active,false);assert.equal(h.storage.has(KEY),false);
});

test('quota-blocked persistence permits only this tab choice while a later changed record wins',()=>{
 const h=setup({writeBlocked:true,stored:now=>({value:'rejected',expiresAt:now+1000})});h.node('hm-preferences').click();h.node('hm-accept').click();assert.equal(h.scripts.length,2);assert.ok(h.emit());
 h.storage.set(KEY,JSON.stringify({value:'rejected',expiresAt:NOW+2000}));assert.equal(h.emit(),null);
});

test('accepted subpages build missing controls and styles, run analytics and never load heatmap',()=>{
 const h=setup({path:'/ydelser/hjemmesider',missingDOM:true,noStyle:true});assert.equal(h.wrappers.length,1);assert.equal(h.links.length,1);assert.equal(h.scripts.length,0);
 assert.match(h.wrappers[0].markup,/Cookies og statistik/);assert.match(h.wrappers[0].markup,/Tillad kun nødvendige/);assert.match(h.wrappers[0].markup,/Tillad alle/);assert.match(h.wrappers[0].markup,/Cookieindstillinger/);
 h.node('hm-accept').click();assert.equal(analytics(h).length,1);assert.equal(heatmaps(h).length,0);h.loadAnalytics();assert.equal(h.calls.grant,0);
 h.node('hm-preferences').click();h.node('hm-reject').click();assert.equal(h.emit(),null);
});

test('re-acceptance reuses the loaded vendor and tracker rather than adding duplicate scripts',()=>{
 const h=setup();h.node('hm-accept').click();h.loadAnalytics();h.loadHeatmap();h.node('hm-preferences').click();h.node('hm-reject').click();h.node('hm-preferences').click();h.node('hm-accept').click();assert.equal(h.scripts.length,2);assert.equal(h.calls.grant,2);assert.ok(h.emit());
 h.rerun();assert.equal(h.scripts.length,2);assert.equal(h.wrappers.length,0);
});

test('load errors stay explicit in settings and do not enable the heatmap',()=>{
 const h=setup();h.node('hm-accept').click();heatmaps(h)[0].onerror();analytics(h)[0].onerror();assert.equal(h.active,false);assert.match(h.node('hm-consent-status').textContent,/ikke indlæses/);
});

test('homepage excludes the complete contact form and consent UI and has no unconditional analytics tag',()=>{
 const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
 assert.match(html,/<form[^>]*class="hej-form"[^>]*data-heatmap-ignore/);
 assert.match(html,/<section[^>]*id="hm-consent"[^>]*data-heatmap-ignore/);
 assert.match(html,/<button[^>]*id="hm-preferences"[^>]*data-heatmap-ignore/);
 for(const section of ['hero','ydelser','vision','kontakt'])assert.ok(html.includes(`data-heatmap-section="${section}"`));
 assert.equal(html.includes('src="/_vercel/insights/script.js"'),false);
 assert.equal((html.match(/src="\/assets\/heatmap-consent\.js"/g)||[]).length,1);
});
