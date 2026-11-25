/* Vanta Heatmap: explicit-consent, aggregate interaction tracker. No cookies. */
(function (window, document) {
  'use strict';
  if (window.VantaHeatmap) return;

  var script = document.currentScript;
  var config = {
    siteId: script && script.getAttribute('data-site') || '',
    version: safeId(script && script.getAttribute('data-version')) || 'a',
    page: script && script.getAttribute('data-page') || '',
    local: !!(script && script.getAttribute('data-local') === 'true'),
    endpoint: script && script.getAttribute('data-endpoint') || ''
  };
  try {
    if (!config.endpoint) config.endpoint = new URL('/api/collect', script && script.src || window.location.href).href;
    var endpointURL = new URL(config.endpoint, window.location.href);
    // Production collection must use TLS; loopback is permitted for development.
    if (endpointURL.protocol !== 'https:' && !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(endpointURL.hostname)) config.endpoint = '';
    else config.endpoint = endpointURL.href;
  } catch (_) { config.endpoint = ''; }

  var consent = false;
  var session = null;
  var observers = [];
  var listeners = [];
  var intervals = [];
  var pending = [];
  var lastClick = null;
  var visibleSections = new Map();
  var lastPointer = null;
  var lastActivity = 0;
  var lastTick = 0;
  var sessionTimer = null;
  var resizeTimer = null;
  var dirty = false;
  var generation = 0;
  var aborted = null;
  var inFlight = null;
  var outbox = new Map();
  var droppedSessions = 0;
  var lastError = null;
  var LOCAL_KEY = 'vanta_heatmap_test_sessions';
  var MAX_EVENTS = 2000;
  var SESSION_MS = 30 * 60 * 1000;
  var IDLE_MS = 30000;

  function safeId(value) {
    return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(value) ? value : '';
  }
  function privacyBlocked() {
    return window.navigator.globalPrivacyControl === true || /^(1|yes)$/i.test(String(window.navigator.doNotTrack || window.doNotTrack || ''));
  }
  function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
  function dimensions() {
    var root = document.documentElement;
    var body = document.body;
    return {
      width: Math.max(1, root.clientWidth || window.innerWidth || 1),
      height: Math.max(1, window.innerHeight || root.clientHeight || 1),
      pageWidth: Math.max(1, root.scrollWidth || 0, root.clientWidth || 0, window.innerWidth || 1),
      pageHeight: Math.max(1, root.scrollHeight || 0, body && body.scrollHeight || 0, window.innerHeight || 1)
    };
  }
  function pageName() {
    if (config.page && /^\/[A-Za-z0-9_./:-]{0,180}$/.test(config.page)) return config.page;
    // Suppress common sensitive route segments, email-like and token-like values.
    return (window.location.pathname || '/').split('/').map(function (part) {
      if (part.length > 48 || /@|%40|\d{6,}|^[a-f0-9]{16,}$/i.test(part)) return ':redacted';
      return part;
    }).join('/').slice(0,180);
  }
  function uuid() {
    return window.crypto && typeof window.crypto.randomUUID === 'function' ? window.crypto.randomUUID() : 's-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2,14);
  }
  function excluded(node) {
    return !node || !node.closest || !!node.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[data-heatmap-ignore]');
  }
  function targetName(node) {
    var named = node.closest('[data-heatmap-id]');
    var id = named && safeId(named.getAttribute('data-heatmap-id'));
    if (id) return id;
    var interactive = node.closest('a,button,[role="button"],[role="link"]') || node;
    var tag = String(interactive.tagName || 'element').toLowerCase();
    var role = interactive.getAttribute && interactive.getAttribute('role');
    return tag + (/^(button|link|tab|menuitem|checkbox|switch)$/.test(role || '') ? ':' + role : '');
  }
  function record(type, event, node) {
    if (!consent || !session || privacyBlocked() || excluded(node) || resizeTimer) return null;
    if (Date.now() - session.startedAt >= SESSION_MS || session.events.length >= MAX_EVENTS) rotateSession();
    var size = dimensions();
    var x = (Number(event.clientX) || 0) + (window.scrollX || 0);
    var y = (Number(event.clientY) || 0) + (window.scrollY || 0);
    var point = {type:type, x:clamp(x / size.pageWidth,0,1), y:clamp(y / size.pageHeight,0,1), t:Date.now() - session.startedAt, target:targetName(node)};
    var named = node.closest('[data-heatmap-id]');
    if (named && safeId(named.getAttribute('data-heatmap-id'))) {
      var rect = named.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        point.rx = clamp(((Number(event.clientX) || 0) - rect.left) / rect.width,0,1);
        point.ry = clamp(((Number(event.clientY) || 0) - rect.top) / rect.height,0,1);
      }
    }
    var section = node.closest('[data-heatmap-section]');
    if (section) point.section = safeId(section.getAttribute('data-heatmap-section')) || undefined;
    session.pageHeight = size.pageHeight;
    session.events.push(point);
    dirty = true;
    return point;
  }
  function listen(target, name, fn, options) {
    target.addEventListener(name,fn,options);
    listeners.push(function () { target.removeEventListener(name,fn,options); });
  }
  function foreground() { return document.visibilityState !== 'hidden' && (!document.hasFocus || document.hasFocus()); }
  function activity() {
    if (privacyBlocked()) { revokeConsent(); return false; }
    lastActivity = Date.now();
    return true;
  }
  function updateScroll() {
    if (!consent || !session || resizeTimer || !foreground()) return;
    var size = dimensions();
    var depth = clamp(((window.scrollY || 0) + size.height) / size.pageHeight,0,1);
    session.maxScroll = Math.max(session.maxScroll,depth);
    session.pageHeight = size.pageHeight;
    dirty = true;
  }
  function tick() {
    if (!consent || !session) return;
    if (privacyBlocked()) { revokeConsent(); return; }
    var now = Date.now();
    prunePending();
    var elapsed = Math.min(1000,Math.max(0,now - lastTick));
    lastTick = now;
    if (resizeTimer || !foreground() || now - lastActivity >= IDLE_MS) return;
    visibleSections.forEach(function (entry, element) {
      if (entry.visible && !excluded(element)) { entry.metric.visibleMs += elapsed; dirty = true; }
    });
  }
  function refreshSections() {
    if (!session || !consent) return;
    var size = dimensions();
    visibleSections.forEach(function (entry, element) {
      var rect = element.getBoundingClientRect();
      entry.metric.top = clamp((rect.top + (window.scrollY || 0)) / size.pageHeight,0,1);
      entry.metric.bottom = clamp((rect.bottom + (window.scrollY || 0)) / size.pageHeight,0,1);
    });
  }
  function discoverSections() {
    var nodes = document.querySelectorAll('[data-heatmap-section]');
    var io = typeof window.IntersectionObserver === 'function' ? new window.IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        var section = visibleSections.get(entry.target);
        if (section) section.visible = entry.isIntersecting && entry.intersectionRatio > 0;
      });
    },{threshold:[0,0.1,0.5]}) : null;
    if (io) observers.push(io);
    Array.prototype.forEach.call(nodes,function (element, index) {
      if (excluded(element) || index > 99) return;
      var id = safeId(element.getAttribute('data-heatmap-section')) || 'section-' + index;
      var metric = {id:id,label:id,top:0,bottom:0,visibleMs:0};
      session.sections.push(metric);
      visibleSections.set(element,{metric:metric,visible:false});
      if (io) io.observe(element);
    });
    refreshSections();
  }
  function acknowledge(entry) {
    entry.responded = true;
    if (entry.timer) window.clearTimeout(entry.timer);
    if (entry.dead && session) {
      var index = session.events.indexOf(entry.dead);
      if (index >= 0) { session.events.splice(index,1); dirty = true; }
    }
  }
  function prunePending() {
    var now = Date.now();
    var retained = pending.filter(function (entry) { return !entry.responded && now - entry.createdAt <= 10000; });
    pending.forEach(function (entry) { if (retained.indexOf(entry) < 0 && entry.timer) window.clearTimeout(entry.timer); });
    pending = retained;
    if (lastClick && now - lastClick.createdAt > 10000) lastClick = null;
  }
  function acknowledgeNavigation() {
    prunePending();
    var latest = lastClick && pending.indexOf(lastClick) >= 0 ? lastClick : null;
    if (latest && Date.now() - latest.createdAt <= 1800) acknowledge(latest);
    prunePending();
  }
  function markResponse(element) {
    prunePending();
    var latest = lastClick && pending.indexOf(lastClick) >= 0 ? lastClick : null;
    pending.forEach(function (entry) {
      if ((!element && entry === latest) || element && (element === entry.node || element.contains && element.contains(entry.node) || entry.node.contains && entry.node.contains(element))) acknowledge(entry);
    });
    prunePending();
  }
  function usefulMutation(mutation, entry) {
    var node = mutation.target;
    if (!node || excluded(node.nodeType === 1 ? node : node.parentElement)) return false;
    var parent = entry.node.parentElement;
    var local = entry.node === node || entry.node.contains && entry.node.contains(node) || parent && parent === node;
    var dialog = node.nodeType === 1 && node.closest && node.closest('[role="dialog"],[role="alert"],[aria-live],dialog');
    if (!local && (!dialog || entry !== lastClick)) return false;
    if (mutation.type === 'attributes') return /^(aria-expanded|aria-selected|aria-checked|open|hidden|disabled|aria-busy)$/.test(mutation.attributeName || '');
    return mutation.type === 'childList' && (mutation.addedNodes.length > 0 || mutation.removedNodes.length > 0) || mutation.type === 'characterData';
  }
  function onClick(event) {
    if (!activity() || excluded(event.target)) return;
    var point = record('click',event,event.target);
    if (!point) return;
    var node = event.target.closest('[data-heatmap-id],a,button,[role="button"],[role="link"],summary') || event.target;
    var entry = {node:node,point:point,createdAt:Date.now(),responded:false,timer:null,dead:null};
    lastClick = entry;
    pending.push(entry);
    // Unprevented native navigation, details toggles, downloads and form submits are responses.
    entry.timer = window.setTimeout(function () {
      if (!consent || !session || entry.responded) return;
      var link = node.closest && node.closest('a[href]');
      var href = link && link.getAttribute('href');
      var buttonType = String(node.getAttribute && node.getAttribute('type') || '').toLowerCase();
      var nativeResponse = !event.defaultPrevented && ((href && href !== '#' && !/^javascript:/i.test(href)) || node.tagName === 'SUMMARY' || node.tagName === 'BUTTON' && node.closest('form') && buttonType !== 'button');
      if (nativeResponse) { acknowledge(entry); return; }
      if (session.events.length < MAX_EVENTS) {
        entry.dead = Object.assign({},point,{type:'dead'});
        session.events.push(entry.dead);
        dirty = true;
      }
    },900);
    // Keep a small recent window so async integrations can retract a suspected dead click.
    var retained = pending.filter(function (item) { return !item.responded && point.t - item.point.t < 10000; }).slice(-20);
    pending.forEach(function (item) { if (retained.indexOf(item) < 0 && item.timer) window.clearTimeout(item.timer); });
    pending = retained;
  }
  function onMove(event) {
    if (!activity() || excluded(event.target) || event.pointerType === 'touch') return;
    var now = Date.now();
    if (lastPointer && (now - lastPointer.t < 125 || Math.hypot(event.clientX - lastPointer.x,event.clientY - lastPointer.y) < 6)) return;
    lastPointer = {x:event.clientX,y:event.clientY,t:now};
    record('move',event,event.target);
  }
  function flush() {
    if (!consent || !session || privacyBlocked() || !config.local && (!config.siteId || !config.endpoint)) return Promise.resolve({sent:false,reason:privacyBlocked() ? 'privacy-preference' : 'nothing-to-send'});
    tick(); refreshSections(); updateScroll();
    if (!dirty) return config.local ? Promise.resolve({sent:false,reason:'nothing-to-send'}) : sendQueued();
    // A newer snapshot may retract a suspected dead click, so event count is not
    // a valid ordering key. Retries retain this same monotonically increasing revision.
    session.revision = (session.revision || 0) + 1;
    var body = JSON.stringify({siteId:config.siteId,consent:true,session:session});
    dirty = false;
    if (config.local) {
      try {
        var stored = JSON.parse(window.localStorage.getItem(LOCAL_KEY) || '[]');
        if (!Array.isArray(stored)) stored = [];
        var snapshot = JSON.parse(JSON.stringify(session));
        stored = stored.filter(function (item) { return item && item.id !== snapshot.id; });
        stored.push(snapshot);
        // Local test data is intentionally bounded and never sent to a server.
        window.localStorage.setItem(LOCAL_KEY,JSON.stringify(stored.slice(-100)));
        window.dispatchEvent(new window.CustomEvent('vantaheatmap:session',{detail:snapshot}));
        lastError = null;
        return Promise.resolve({sent:true,local:true});
      } catch (_) {
        dirty = true; lastError = 'storage-unavailable';
        return Promise.resolve({sent:false,reason:'storage-unavailable'});
      }
    }
    // Queue immutable bodies before checking in-flight transport. Rotation can
    // then begin a new session without losing the previous session's final batch.
    outbox.set(session.id,{id:session.id,body:body});
    while (outbox.size > 8) {
      outbox.delete(outbox.keys().next().value);
      droppedSessions += 1;
    }
    return sendQueued();
  }
  function sendQueued() {
    if (!consent || privacyBlocked()) return Promise.resolve({sent:false,reason:'revoked'});
    if (inFlight) return inFlight;
    var entry = outbox.values().next().value;
    if (!entry) return Promise.resolve({sent:false,reason:'nothing-to-send'});
    var revision = generation;
    aborted = typeof window.AbortController === 'function' ? new window.AbortController() : null;
    var signal = aborted && aborted.signal;
    // text/plain is a CORS safelisted request; credentials are never sent.
    inFlight = Promise.resolve().then(function () {
      if (revision !== generation || !consent || privacyBlocked()) { var error = new Error('Consent revoked'); error.name = 'AbortError'; throw error; }
      return window.fetch(config.endpoint,{method:'POST',mode:'cors',credentials:'omit',keepalive:entry.body.length < 60000,headers:{'Content-Type':'text/plain'},body:entry.body,signal:signal});
    }).then(function (response) {
      if (!response.ok) throw new Error('Collection returned HTTP ' + response.status);
      if (revision === generation) {
        lastError = null;
        // A newer cumulative snapshot may have replaced this exact queued body.
        if (outbox.get(entry.id) === entry) outbox.delete(entry.id);
      }
      return {sent:true};
    }).catch(function (error) {
      if (revision === generation) lastError = error.name === 'AbortError' ? null : 'collection-unavailable';
      return {sent:false,reason:error.name === 'AbortError' ? 'revoked' : 'collection-unavailable'};
    }).then(function (result) {
      if (revision === generation) {
        inFlight = null; aborted = null;
        if (result.sent && outbox.size && consent && !privacyBlocked()) return sendQueued();
      }
      return result;
    });
    return inFlight;
  }
  function clearResources() {
    listeners.forEach(function (remove) { remove(); }); listeners = [];
    observers.forEach(function (observer) { observer.disconnect(); }); observers = [];
    intervals.forEach(function (id) { window.clearInterval(id); }); intervals = [];
    pending.forEach(function (entry) { if (entry.timer) window.clearTimeout(entry.timer); }); pending = [];
    lastClick = null;
    if (sessionTimer) window.clearTimeout(sessionTimer);
    sessionTimer = null;
    if (resizeTimer) window.clearTimeout(resizeTimer);
    resizeTimer = null;
    visibleSections.clear();
    lastPointer = null;
  }
  function beginSession() {
    var size = dimensions();
    var now = Date.now();
    session = {id:uuid(),revision:0,version:config.version,device:size.width < 768 ? 'mobile' : 'desktop',page:pageName(),startedAt:now,width:size.width,height:size.height,pageHeight:size.pageHeight,maxScroll:0,events:[],sections:[]};
    lastActivity = now; lastTick = now; dirty = true;
    discoverSections(); updateScroll();
    listen(document,'click',onClick,true);
    listen(document,'pointermove',onMove,{passive:true,capture:true});
    listen(window,'scroll',function () { if (activity()) updateScroll(); },{passive:true});
    listen(window,'resize',function () {
      if (!consent) return;
      // Pause geometry collection while a resize settles. Even a small width
      // change can reflow a headline; do not mix it into an exact-width cohort.
      var newSize = dimensions();
      if (resizeTimer) window.clearTimeout(resizeTimer);
      resizeTimer = null;
      if (Math.abs(newSize.width - session.width) > 1) {
        resizeTimer = window.setTimeout(function () {
          resizeTimer = null;
          if (!consent || !session) return;
          if (Math.abs(dimensions().width - session.width) > 1) rotateSession();
          else refreshSections();
        },300);
      } else refreshSections();
    },{passive:true});
    // Hiding a tab is not evidence that a previous control responded.
    listen(document,'visibilitychange',function () { tick(); if (document.visibilityState === 'hidden') flush(); else lastTick = Date.now(); });
    listen(window,'pagehide',function () { tick(); acknowledgeNavigation(); flush(); });
    listen(window,'hashchange',acknowledgeNavigation);
    listen(window,'popstate',function () { acknowledgeNavigation(); rotateSession(); });
    listen(document,'change',function (event) { if (!excluded(event.target)) markResponse(event.target); },true);
    listen(document,'focusin',function (event) {
      prunePending();
      var latest = lastClick && pending.indexOf(lastClick) >= 0 ? lastClick : null;
      // Ordinary focus on the next clicked button does not prove the previous
      // control worked. Opening/focusing a field or dialog is a meaningful signal.
      var responseField = event.target && event.target.closest && event.target.closest('input,textarea,select,[contenteditable],dialog,[role="dialog"]');
      if (latest && responseField && Date.now() - latest.createdAt <= 1800 && event.target !== latest.node && !(latest.node.contains && latest.node.contains(event.target))) acknowledge(latest);
    },true);
    if (typeof window.MutationObserver === 'function') {
      var mutationObserver = new window.MutationObserver(function (mutations) {
        prunePending();
        pending.forEach(function (entry) { if (!entry.responded && Date.now() - entry.createdAt <= 1800 && mutations.some(function (mutation) { return usefulMutation(mutation,entry); })) acknowledge(entry); });
      });
      mutationObserver.observe(document.body || document.documentElement,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['aria-expanded','aria-selected','aria-checked','open','hidden','disabled','aria-busy']});
      observers.push(mutationObserver);
    }
    intervals.push(window.setInterval(tick,1000));
    intervals.push(window.setInterval(flush,10000));
    sessionTimer = window.setTimeout(rotateSession,SESSION_MS);
  }
  function rotateSession() {
    if (!consent) return;
    tick(); flush(); clearResources();
    // Payload body is serialized before rotation; the next timer sends the next session.
    beginSession();
  }
  function grantConsent() {
    if (privacyBlocked()) return {active:false,reason:'privacy-preference'};
    if (consent) return getStatus();
    if (!config.local && (!config.siteId || !config.endpoint)) return {active:false,reason:'missing-configuration'};
    consent = true; generation += 1; lastError = null; droppedSessions = 0;
    beginSession();
    return getStatus();
  }
  function revokeConsent() {
    var revokedSessionId = session && session.id;
    // Only a session already stored after consent may be removed. Earlier consented
    // sessions remain under the user's separate delete-data controls.
    if (consent && config.local && revokedSessionId) {
      try {
        var stored = JSON.parse(window.localStorage.getItem(LOCAL_KEY) || '[]');
        if (Array.isArray(stored)) window.localStorage.setItem(LOCAL_KEY,JSON.stringify(stored.filter(function (item) { return item && item.id !== revokedSessionId; })));
        window.dispatchEvent(new window.CustomEvent('vantaheatmap:session',{detail:null}));
      } catch (_) { /* Storage may be disabled by the browser. */ }
    }
    consent = false; generation += 1;
    clearResources();
    if (aborted) aborted.abort();
    aborted = null; inFlight = null; outbox.clear(); session = null; dirty = false; lastError = null;
    return getStatus();
  }
  function getStatus() {
    return {active:consent && !privacyBlocked(),consent:consent,privacyBlocked:privacyBlocked(),sessionId:session && session.id || null,eventCount:session && session.events.length || 0,lastError:lastError,queuedSessions:outbox.size,droppedSessions:droppedSessions,mode:config.local ? 'local' : 'network',storage:config.local ? 'localStorage-after-consent' : 'memory-only',deadClickDetection:'heuristic'};
  }
  window.VantaHeatmap = Object.freeze({grantConsent:grantConsent,revokeConsent:revokeConsent,getStatus:getStatus,flush:flush,markResponse:markResponse});
  window.dispatchEvent(new window.CustomEvent('vantaheatmap:ready'));
})(window, document);
