/* Shared statistics choice. The remembered preference is not a visitor ID. */
(function (window,document) {
  'use strict';
  if(window.__vantaStatisticsConsentV2)return;
  window.__vantaStatisticsConsentV2=true;

  var KEY='vanta-statistics-consent:v2';
  var TTL=30*24*60*60*1000;
  var choice=null;
  var expiresAt=0;
  var sessionOnly=false;
  var persistenceBaseline=null;
  var analyticsLoading=false;
  var analyticsLoaded=false;
  var analyticsFailed=false;
  var heatmapLoading=false;
  var heatmapFailed=false;
  var expiryTimer=null;
  var describeChoice=false;
  var wasBlocked=privacyBlocked();
  var homepage=window.location.pathname==='/';

  function privacyBlocked(){
    return window.navigator.globalPrivacyControl===true||/^(1|yes)$/i.test(String(window.navigator.doNotTrack||window.doNotTrack||''));
  }
  function parseChoice(raw){
    try{
      var saved=JSON.parse(raw||'null');
      if(!saved||!['accepted','rejected'].includes(saved.value)||!Number.isFinite(saved.expiresAt))return null;
      if(saved.expiresAt<=Date.now()||saved.expiresAt>Date.now()+TTL+60000)return null;
      return saved;
    }catch(_){return null;}
  }
  function readChoice(){
    try{
      var raw=window.localStorage.getItem(KEY);
      var saved=parseChoice(raw);
      if(raw&&!saved)window.localStorage.removeItem(KEY);
      return saved;
    }catch(_){return null;}
  }
  function allowed(){
    if(choice!=='accepted'||Date.now()>=expiresAt||privacyBlocked())return false;
    try{
      var raw=window.localStorage.getItem(KEY);
      // A blocked/quota-limited write may leave the old preference unchanged.
      // The current explicit choice can then operate in this tab only. Any
      // subsequently changed stored choice still takes precedence immediately.
      if(sessionOnly&&raw===persistenceBaseline)return true;
      var saved=parseChoice(raw);
      return !!saved&&saved.value==='accepted';
    }catch(_){return true;}
  }

  // Register BEFORE injecting Vercel's script. The callback is deliberately
  // dynamic: withdrawal, expiry and privacy signals also stop future events
  // after the vendor script has loaded; no undocumented teardown is required.
  window.va=window.va||function(){(window.vaq=window.vaq||[]).push(arguments);};
  window.va('beforeSend',function(event){return allowed()?event:null;});

  if(!document.querySelector('link[href="/assets/heatmap-consent.css"]')){
    var stylesheet=document.createElement('link');
    stylesheet.rel='stylesheet';stylesheet.href='/assets/heatmap-consent.css';
    (document.head||document.body).appendChild(stylesheet);
  }
  if(!document.getElementById('hm-consent')){
    var controls=document.createElement('div');
    // Static markup only; no URL, storage value or visitor content is injected.
    controls.innerHTML='<section id="hm-consent" class="hm-consent" data-heatmap-ignore aria-labelledby="hm-consent-title" hidden>'+
      '<h2 id="hm-consent-title">Cookies og statistik</h2>'+
      '<p>Vi bruger cookies og lignende teknologier til statistik og til at forbedre hjemmesiden. Med din tilladelse måler Vercel besøg på hjemmesiden, mens Vanta Studio måler klik, musebevægelser, scroll og tid på forsiden. Du kan altid ændre dit valg i Cookieindstillinger.</p>'+
      '<a class="hm-privacy" href="/privacy-policy#heatmap">Læs mere</a>'+
      '<p id="hm-consent-status" class="hm-consent-status" aria-live="polite"></p>'+
      '<div class="hm-consent-actions"><button id="hm-reject" class="hm-choice" type="button">Tillad kun nødvendige</button>'+
      '<button id="hm-accept" class="hm-choice" type="button">Tillad alle</button></div></section>'+
      '<button id="hm-preferences" class="hm-preferences" type="button" data-heatmap-ignore aria-controls="hm-consent" aria-expanded="false">Cookieindstillinger</button>'+
      '<p id="hm-consent-announcement" class="hm-sr" data-heatmap-ignore role="status" aria-live="polite"></p>';
    document.body.appendChild(controls);
  }
  var panel=document.getElementById('hm-consent');
  var accept=document.getElementById('hm-accept');
  var reject=document.getElementById('hm-reject');
  var preferences=document.getElementById('hm-preferences');
  var status=document.getElementById('hm-consent-status');
  var announcement=document.getElementById('hm-consent-announcement');
  if(!panel||!accept||!reject||!preferences||!status)return;

  function stop(){
    if(window.VantaHeatmap)window.VantaHeatmap.revokeConsent();
  }
  function announce(message){if(announcement)announcement.textContent=message;}
  function render(){
    accept.disabled=privacyBlocked();
    if(privacyBlocked())status.textContent='Din browsers privatlivssignal holder valgfri statistik slået fra.';
    else if(choice==='accepted'&&(analyticsFailed||heatmapFailed))status.textContent='Noget af statistikken kunne ikke indlæses. Du kan prøve at tillade alle igen.';
    else if(describeChoice&&choice==='accepted')status.textContent='Dit valg: al statistik er tilladt.';
    else if(describeChoice&&choice==='rejected')status.textContent='Dit valg: kun nødvendige funktioner.';
    else status.textContent='';
  }
  function openPanel(focus,showChoice){
    describeChoice=!!showChoice;render();panel.hidden=false;preferences.setAttribute('aria-expanded','true');
    if(focus)reject.focus();
  }
  function closePanel(){panel.hidden=true;preferences.setAttribute('aria-expanded','false');}
  function clearChoice(message){
    choice=null;expiresAt=0;sessionOnly=false;describeChoice=false;
    stop();
    try{window.localStorage.removeItem(KEY);}catch(_){}
    scheduleExpiry();openPanel(false,false);
    if(message)announce(message);
  }
  function scheduleExpiry(){
    if(expiryTimer)window.clearTimeout(expiryTimer);
    expiryTimer=null;
    if(!choice||!expiresAt)return;
    expiryTimer=window.setTimeout(function(){
      if(Date.now()<expiresAt){scheduleExpiry();return;}
      clearChoice('Dit valg er udløbet. Valgfri statistik er slået fra.');
    },Math.max(1,Math.min(2147483647,expiresAt-Date.now())));
  }
  function remember(value){
    // Change memory first: beforeSend must deny during withdrawal itself,
    // including while storage access or heatmap cleanup is still running.
    choice=value;expiresAt=Date.now()+TTL;sessionOnly=false;
    try{persistenceBaseline=window.localStorage.getItem(KEY);}catch(_){persistenceBaseline=null;}
    try{window.localStorage.setItem(KEY,JSON.stringify({value:value,expiresAt:expiresAt}));}
    catch(_){sessionOnly=true;}
    scheduleExpiry();
  }
  function startAnalytics(){
    if(!allowed()||analyticsLoading||analyticsLoaded)return;
    analyticsLoading=true;analyticsFailed=false;
    var script=document.createElement('script');
    script.src='/_vercel/insights/script.js';script.defer=true;
    script.onload=function(){analyticsLoading=false;analyticsLoaded=true;render();};
    script.onerror=function(){analyticsLoading=false;analyticsFailed=true;render();};
    document.body.appendChild(script);
  }
  function startHeatmap(){
    if(!homepage||!allowed())return;
    if(window.VantaHeatmap){
      var current=window.VantaHeatmap.grantConsent();
      heatmapFailed=!current||!current.active;render();return;
    }
    if(heatmapLoading)return;
    heatmapLoading=true;heatmapFailed=false;
    var script=document.createElement('script');
    script.src='/assets/vanta-heatmap.js';script.defer=true;
    script.setAttribute('data-site','vh_147f00e02bb84d1e9104179eedaafcbe');
    script.setAttribute('data-endpoint','/api/heatmap');
    script.setAttribute('data-version','a');script.setAttribute('data-page','/');
    script.onload=function(){
      heatmapLoading=false;
      if(allowed()&&homepage&&window.VantaHeatmap){
        var current=window.VantaHeatmap.grantConsent();heatmapFailed=!current||!current.active;
      }else{stop();heatmapFailed=allowed()&&homepage;}
      render();
    };
    script.onerror=function(){heatmapLoading=false;heatmapFailed=true;stop();render();};
    document.body.appendChild(script);
  }
  function start(){
    if(!allowed()){stop();render();return;}
    startAnalytics();startHeatmap();render();
  }

  accept.addEventListener('click',function(){
    if(privacyBlocked()){stop();render();return;}
    remember('accepted');analyticsFailed=false;heatmapFailed=false;start();closePanel();
    preferences.focus();announce('Du har tilladt al statistik. Du kan ændre dit valg i Cookieindstillinger.');
  });
  reject.addEventListener('click',function(){
    choice='rejected';expiresAt=0;sessionOnly=false;
    stop();remember('rejected');analyticsFailed=false;heatmapFailed=false;render();closePanel();
    preferences.focus();announce('Kun nødvendige funktioner er tilladt. Nye statistikmålinger er stoppet.');
  });
  preferences.addEventListener('click',function(){if(panel.hidden)openPanel(true,true);else closePanel();});
  panel.addEventListener('keydown',function(event){if(event.key==='Escape'){closePanel();preferences.focus();}});
  window.addEventListener('storage',function(event){
    if(event.key!==KEY&&event.key!==null)return;
    var saved=readChoice();
    choice=saved?saved.value:null;expiresAt=saved?saved.expiresAt:0;sessionOnly=false;
    scheduleExpiry();
    if(choice==='accepted')start();else stop();
    render();if(!choice)openPanel(false,false);
  });
  window.setInterval(function(){
    var blocked=privacyBlocked();
    if(blocked&&!wasBlocked){stop();render();announce('Din browsers privatlivssignal har slået valgfri statistik fra.');}
    else if(!blocked&&wasBlocked){
      // Removing a privacy override never silently reactivates statistics.
      clearChoice('Vælg igen, hvis du vil tillade valgfri statistik.');
    }
    wasBlocked=blocked;
  },1000);

  var saved=readChoice();
  choice=saved?saved.value:null;expiresAt=saved?saved.expiresAt:0;
  // Old heatmap-only v1 acceptance is intentionally never promoted to all.
  scheduleExpiry();render();
  if(choice==='accepted')start();
  if(!choice)openPanel(false,false);
})(window,document);
