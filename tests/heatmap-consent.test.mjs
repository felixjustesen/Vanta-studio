import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const source=readFileSync(new URL('../assets/heatmap-consent.js',import.meta.url),'utf8');
const KEY='vanta-heatmap-consent:v1';
const TTL=30*24*60*60*1000;

function setup(options={}){
 let now=1_000_000_000;
 let nextTimer=0;
 const storage=new Map();
 const timers=new Map();
 const intervals=new Map();
 const scripts=[];
 const calls={grant:0,revoke:0,get:0,set:0,remove:0};
 let active=false;
 if(options.stored)storage.set(KEY,JSON.stringify(options.stored(now)));
 const nodes=new Map();
 function eventTarget(value={}){
  const listeners=new Map();
  value.addEventListener=(name,fn)=>{
   if(!listeners.has(name))listeners.set(name,[]);
   listeners.get(name).push(fn);
  };
  value.fire=(name,event={})=>{
   for(const fn of [...(listeners.get(name)||[])])fn(event);
  };
  return value;
 }
 const document={
  activeElement:null,
  body:{appendChild:script=>scripts.push(script)},
  createElement:tag=>({tagName:tag.toUpperCase(),attrs:{},setAttribute(name,value){this.attrs[name]=value;}}),
  getElementById:id=>nodes.get(id)||null,
 };
 for(const id of ['hm-consent','hm-accept','hm-reject','hm-preferences','hm-consent-status','hm-consent-announcement']){
  const node=eventTarget({id,hidden:id==='hm-consent',disabled:false,textContent:'',attrs:{},setAttribute(name,value){this.attrs[name]=value;},focus(){document.activeElement=this;}});
  node.click=()=>{if(!node.disabled)node.fire('click');};
  nodes.set(id,node);
 }
 const window=eventTarget({
  navigator:{globalPrivacyControl:!!options.gpc,doNotTrack:options.dnt||null},
  localStorage:{
   getItem(key){calls.get++;if(options.storageBlocked)throw new Error('blocked');return storage.get(key)||null;},
   setItem(key,value){calls.set++;if(options.storageBlocked)throw new Error('blocked');storage.set(key,value);},
   removeItem(key){calls.remove++;storage.delete(key);},
  },
  setTimeout(fn,delay){const id=++nextTimer;timers.set(id,{fn,delay});return id;},
  clearTimeout:id=>timers.delete(id),
  setInterval(fn,delay){const id=++nextTimer;intervals.set(id,{fn,delay});return id;},
 });
 class FakeDate extends Date{static now(){return now;}}
 const api={
  grantConsent(){calls.grant++;active=true;return{active:true};},
  revokeConsent(){calls.revoke++;active=false;return{active:false};},
 };
 vm.runInContext(source,vm.createContext({window,document,Date:FakeDate,JSON,Number,String,Math}));
 return {window,document,nodes,scripts,calls,storage,timers,
  node:id=>nodes.get(id),
  get active(){return active;},
  load(){window.VantaHeatmap=api;scripts.at(-1).onload();},
  advance(ms){now+=ms;},
  tick(){for(const {fn} of intervals.values())fn();},
  expire(){for(const [id,{fn}] of [...timers]){timers.delete(id);fn();}},
 };
}

test('first visit shows choices and loads no tracker or tracking API',()=>{
 const h=setup();
 assert.equal(h.scripts.length,0);assert.equal(h.calls.grant,0);
 assert.equal(h.node('hm-consent').hidden,false);
 assert.equal(h.node('hm-accept').disabled,false);
 assert.equal(h.node('hm-reject').disabled,false);
 assert.equal(h.calls.set,0);assert.equal(h.calls.remove,0);
});

test('reject stores only a bounded preference and never loads the tracker',()=>{
 const h=setup();h.node('hm-reject').click();
 assert.equal(h.scripts.length,0);assert.equal(h.node('hm-consent').hidden,true);
 const stored=JSON.parse(h.storage.get(KEY));
 assert.deepEqual(Object.keys(stored).sort(),['expiresAt','value']);
 assert.equal(stored.value,'rejected');assert.equal(stored.expiresAt,1_000_000_000+TTL);
 h.node('hm-preferences').click();
 assert.equal(h.node('hm-consent').hidden,false);
 assert.equal(h.document.activeElement.id,'hm-reject');
});

test('accept loads configured same-origin tracker, then grants only after load',()=>{
 const h=setup();h.node('hm-accept').click();
 assert.equal(h.calls.grant,0);assert.equal(h.scripts.length,1);
 const script=h.scripts[0];
 assert.equal(script.src,'/assets/vanta-heatmap.js');
 assert.equal(script.attrs['data-endpoint'],'/api/heatmap');
 assert.equal(script.attrs['data-site'],'vh_147f00e02bb84d1e9104179eedaafcbe');
 assert.equal(script.attrs['data-page'],'/');assert.equal(script.attrs['data-version'],'a');
 h.load();assert.equal(h.calls.grant,1);assert.equal(h.active,true);
});

test('withdrawal stops synchronously and delayed script load cannot reactivate',()=>{
 const h=setup();h.node('hm-accept').click();
 h.node('hm-preferences').click();h.node('hm-reject').click();h.load();
 assert.equal(h.calls.grant,0);assert.equal(h.active,false);assert.ok(h.calls.revoke>0);
 assert.equal(JSON.parse(h.storage.get(KEY)).value,'rejected');
});

test('rejecting active tracking stops immediately and later acceptance reuses API',()=>{
 const h=setup();h.node('hm-accept').click();h.load();
 h.node('hm-preferences').click();h.node('hm-reject').click();
 assert.equal(h.active,false);assert.ok(h.calls.revoke>0);
 h.node('hm-preferences').click();h.node('hm-accept').click();
 assert.equal(h.active,true);assert.equal(h.scripts.length,1);assert.equal(h.calls.grant,2);
});

test('valid accepted preference resumes; rejected and expired choices do not load',()=>{
 const accepted=setup({stored:now=>({value:'accepted',expiresAt:now+1000})});
 assert.equal(accepted.scripts.length,1);accepted.load();assert.equal(accepted.active,true);
 const rejected=setup({stored:now=>({value:'rejected',expiresAt:now+1000})});
 assert.equal(rejected.scripts.length,0);assert.equal(rejected.node('hm-consent').hidden,true);
 const expired=setup({stored:now=>({value:'accepted',expiresAt:now-1})});
 assert.equal(expired.scripts.length,0);assert.equal(expired.node('hm-consent').hidden,false);
 assert.equal(expired.storage.has(KEY),false);
});

test('GPC and DNT prevent tracker loading even with stored acceptance',()=>{
 for(const privacy of [{gpc:true},{dnt:'1'},{dnt:'yes'}]){
  const h=setup({...privacy,stored:now=>({value:'accepted',expiresAt:now+TTL})});
  assert.equal(h.scripts.length,0);assert.equal(h.node('hm-accept').disabled,true);
  h.node('hm-accept').fire('click');assert.equal(h.scripts.length,0);
 }
});

test('a new browser privacy signal revokes tracking and cannot silently restart',()=>{
 const h=setup();h.node('hm-accept').click();h.load();assert.equal(h.active,true);
 h.window.navigator.globalPrivacyControl=true;h.tick();assert.equal(h.active,false);
 h.window.navigator.globalPrivacyControl=false;h.tick();
 assert.equal(h.active,false);assert.equal(h.calls.grant,1);
 assert.equal(h.node('hm-consent').hidden,false);assert.equal(h.storage.has(KEY),false);
});

test('preference expiry revokes tracking and asks for a new choice',()=>{
 const h=setup();h.node('hm-accept').click();h.load();
 assert.ok([...h.timers.values()].every(timer=>timer.delay<=2147483647));
 h.advance(TTL+1);h.expire();
 assert.equal(h.active,false);assert.equal(h.node('hm-consent').hidden,false);
 assert.equal(h.storage.has(KEY),false);
});

test('cross-tab revocation stops already active tracking',()=>{
 const h=setup();h.node('hm-accept').click();h.load();
 h.storage.set(KEY,JSON.stringify({value:'rejected',expiresAt:1_000_000_000+TTL}));
 h.window.fire('storage',{key:KEY});
 assert.equal(h.active,false);
});

test('storage restrictions do not turn rejection into tracking',()=>{
 const h=setup({storageBlocked:true});
 h.node('hm-reject').click();assert.equal(h.scripts.length,0);assert.equal(h.calls.grant,0);
});

test('tracker failures remain inactive and visible in preference status',()=>{
 const h=setup();h.node('hm-accept').click();h.scripts[0].onerror();
 assert.equal(h.active,false);assert.match(h.node('hm-consent-status').textContent,/ikke aktivt/);
});

test('homepage marks the full contact form and controls outside tracking',()=>{
 const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
 assert.match(html,/<form[^>]*class="hej-form"[^>]*data-heatmap-ignore/);
 assert.match(html,/<section[^>]*id="hm-consent"[^>]*data-heatmap-ignore/);
 assert.match(html,/<button[^>]*id="hm-preferences"[^>]*data-heatmap-ignore/);
 for(const name of ['hero','ydelser','vision','kontakt'])assert.ok(html.includes(`data-heatmap-section="${name}"`));
 assert.equal(html.includes('<script defer src="/_vercel/insights/script.js"></script>'),true);
});
