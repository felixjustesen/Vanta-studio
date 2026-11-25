/* Vanta homepage: a remembered preference is not a visitor identifier. */
(function (window,document) {
  'use strict';
  var panel=document.getElementById('hm-consent');
  var accept=document.getElementById('hm-accept');
  var reject=document.getElementById('hm-reject');
  var preferences=document.getElementById('hm-preferences');
  var status=document.getElementById('hm-consent-status');
  var announcement=document.getElementById('hm-consent-announcement');
  if(!panel||!accept||!reject||!preferences||!status)return;

  var KEY='vanta-heatmap-consent:v1';
  var TTL=30*24*60*60*1000;
  var choice=null;
  var expiresAt=0;
  var loading=false;
  var loadFailed=false;
  var expiryTimer=null;
  var wasBlocked=privacyBlocked();

  function privacyBlocked(){
    return window.navigator.globalPrivacyControl===true||/^(1|yes)$/i.test(String(window.navigator.doNotTrack||window.doNotTrack||''));
  }
  function stop(){
    if(window.VantaHeatmap)window.VantaHeatmap.revokeConsent();
  }
  function announce(message){
    if(announcement)announcement.textContent=message;
  }
  function render(){
    var blocked=privacyBlocked();
    accept.disabled=blocked;
    if(blocked)status.textContent='Din browsers privatlivssignal holder heatmap slået fra.';
    else if(loadFailed)status.textContent='Heatmap kunne ikke indlæses og er ikke aktivt.';
    else if(choice==='accepted')status.textContent=loading?'Dit valg: heatmap er tilladt. Indlæser målingen.':'Dit valg: heatmap er tilladt.';
    else if(choice==='rejected')status.textContent='Dit valg: heatmap er slået fra.';
    else status.textContent='Heatmap er slået fra, indtil du giver tilladelse.';
  }
  function openPanel(focus){
    render();panel.hidden=false;preferences.setAttribute('aria-expanded','true');
    if(focus)reject.focus();
  }
  function closePanel(){
    panel.hidden=true;preferences.setAttribute('aria-expanded','false');
  }
  function scheduleExpiry(){
    if(expiryTimer)window.clearTimeout(expiryTimer);
    expiryTimer=null;
    if(!choice||!expiresAt)return;
    expiryTimer=window.setTimeout(function(){
      if(Date.now()<expiresAt){scheduleExpiry();return;}
      choice=null;expiresAt=0;stop();
      try{window.localStorage.removeItem(KEY);}catch(_){}
      openPanel(false);
      announce('Dit heatmapvalg er udløbet. Heatmap er slået fra.');
    },Math.max(1,Math.min(2147483647,expiresAt-Date.now())));
  }
  function readChoice(){
    try{
      var stored=JSON.parse(window.localStorage.getItem(KEY)||'null');
      if(!stored||!['accepted','rejected'].includes(stored.value)||!Number.isFinite(stored.expiresAt))return null;
      if(stored.expiresAt<=Date.now()||stored.expiresAt>Date.now()+TTL+60000){window.localStorage.removeItem(KEY);return null;}
      return stored;
    }catch(_){return null;}
  }
  function remember(value){
    choice=value;expiresAt=Date.now()+TTL;
    try{window.localStorage.setItem(KEY,JSON.stringify({value:value,expiresAt:expiresAt}));}catch(_){}
    scheduleExpiry();
  }
  function start(){
    if(choice!=='accepted'||Date.now()>=expiresAt||privacyBlocked()){stop();render();return;}
    if(window.VantaHeatmap){
      var current=window.VantaHeatmap.grantConsent();
      loadFailed=!current||!current.active;
      render();return;
    }
    if(loading)return;
    loading=true;loadFailed=false;
    var script=document.createElement('script');
    script.src='/assets/vanta-heatmap.js';
    script.defer=true;
    script.setAttribute('data-site','vh_147f00e02bb84d1e9104179eedaafcbe');
    script.setAttribute('data-endpoint','/api/heatmap');
    script.setAttribute('data-version','a');
    script.setAttribute('data-page','/');
    script.onload=function(){
      loading=false;
      if(choice==='accepted'&&Date.now()<expiresAt&&!privacyBlocked()&&window.VantaHeatmap){
        var current=window.VantaHeatmap.grantConsent();
        loadFailed=!current||!current.active;
      }else{
        stop();
        loadFailed=choice==='accepted'&&!privacyBlocked();
      }
      render();
    };
    script.onerror=function(){loading=false;loadFailed=true;stop();render();};
    document.body.appendChild(script);
    render();
  }

  accept.addEventListener('click',function(){
    if(privacyBlocked()){stop();render();return;}
    remember('accepted');loadFailed=false;start();closePanel();
    preferences.focus();announce('Heatmap er tilladt. Du kan ændre dit valg via Analysvalg.');
  });
  reject.addEventListener('click',function(){
    // Stop immediately, before attempting to persist a preference.
    stop();remember('rejected');loadFailed=false;render();closePanel();
    preferences.focus();announce('Heatmap er slået fra. Nye heatmapmålinger er stoppet.');
  });
  preferences.addEventListener('click',function(){
    if(panel.hidden)openPanel(true);else closePanel();
  });
  panel.addEventListener('keydown',function(event){
    if(event.key==='Escape'){closePanel();preferences.focus();}
  });
  window.addEventListener('storage',function(event){
    if(event.key!==KEY&&event.key!==null)return;
    var stored=readChoice();
    choice=stored?stored.value:null;expiresAt=stored?stored.expiresAt:0;
    scheduleExpiry();
    if(choice==='accepted')start();else stop();
    render();
    if(!choice)openPanel(false);
  });
  // Browsers do not expose a standard GPC/DNT-change event. Recheck promptly.
  window.setInterval(function(){
    var blocked=privacyBlocked();
    if(blocked&&!wasBlocked){stop();render();announce('Din browsers privatlivssignal har slået heatmap fra.');}
    else if(!blocked&&wasBlocked){
      // A privacy override never silently reactivates a previously stopped tracker.
      choice=null;expiresAt=0;stop();
      try{window.localStorage.removeItem(KEY);}catch(_){}
      scheduleExpiry();openPanel(false);
    }
    wasBlocked=blocked;
  },1000);

  var stored=readChoice();
  choice=stored?stored.value:null;expiresAt=stored?stored.expiresAt:0;
  scheduleExpiry();render();
  if(choice==='accepted')start();
  if(!choice)openPanel(false);
})(window,document);
