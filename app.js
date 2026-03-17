/**
 * NEXUS App Controller v3
 * 4-phase arc sweep: Download → Upload → Ping → Jitter
 * Each phase sweeps the arc 0→100% then briefly holds before the next.
 * Arc fraction and display number animate independently and smoothly.
 */
'use strict';

// ── Arc geometry ──────────────────────────────────────────────
const CX=145, CY=158, R=122, A0=215, A1=505, ASWEEP=290;

function polar(deg,r){
  const rad=(deg-90)*Math.PI/180;
  return {x:CX+r*Math.cos(rad), y:CY+r*Math.sin(rad)};
}
function arcD(s,e){
  const p1=polar(s,R), p2=polar(e,R);
  return `M ${p1.x.toFixed(2)} ${p1.y.toFixed(2)} A ${R} ${R} 0 ${(e-s)>180?1:0} 1 ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
}
function buildArc(){
  const light=document.documentElement.classList.contains('light');
  const track=document.getElementById('arc-track');
  const prog =document.getElementById('arc-prog');
  const full=arcD(A0,A1);
  track.setAttribute('d',full);
  track.setAttribute('stroke',light?'#ccc':'#1e1e1e');
  prog.setAttribute('d',full);
  const len=Math.PI*R*ASWEEP/180;
  prog.style.strokeDasharray=len;
  prog.style.strokeDashoffset=len;
  prog._len=len;
}
function setArcRaw(frac,color){
  const p=document.getElementById('arc-prog');
  p.style.strokeDashoffset=(p._len||1)*(1-Math.min(1,Math.max(0,frac)));
  if(color) p.style.stroke=color;
}
function cssVar(n){
  return getComputedStyle(document.documentElement).getPropertyValue(n).trim();
}
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

// ── Animation state ───────────────────────────────────────────
// Two independent channels animated in one RAF loop:
//   numTarget/numVal  → the big number display
//   arcTarget/arcVal  → arc fill fraction 0–1
let numTarget=0, numVal=0;
let arcTarget=0, arcVal=0;
let rafId=null, phase='idle';

function startLoop(){
  if(rafId) return;
  let last=performance.now();
  function tick(now){
    const dt=Math.min((now-last)/(1000/60),4); last=now;

    // Number channel — rises fast, falls slow
    const nd=numTarget-numVal;
    numVal+=nd*(1-Math.pow(1-(nd>0?.12:.05),dt));
    if(Math.abs(nd)<.001) numVal=numTarget;

    // Arc channel — constant smooth fill, always rises at same rate feel
    const ad=arcTarget-arcVal;
    arcVal+=ad*(1-Math.pow(1-(ad>0?.08:.15),dt));
    if(Math.abs(ad)<.0001) arcVal=arcTarget;

    // Render number
    const bn=document.getElementById('big-num');
    if(phase==='download'||phase==='upload'){
      bn.textContent=fmtMbps(numVal);
    } else if(phase==='ping'||phase==='jitter'){
      bn.textContent=numVal<.5?'—':numVal.toFixed(1);
    }

    // Render arc (color already set by setPhaseUI)
    setArcRaw(arcVal);

    rafId=requestAnimationFrame(tick);
  }
  rafId=requestAnimationFrame(tick);
}
function stopLoop(){ if(rafId){cancelAnimationFrame(rafId);rafId=null;} }

// Smoothly sweep arc from 0 to 1 over the measurement, driven by progress cb
// Returns a promise that resolves when arcVal reaches ~1
function sweepArc(color){
  arcTarget=0; arcVal=0;
  setArcRaw(0,color);
  document.getElementById('arc-prog').style.stroke=color;
}

// ── Formatters ────────────────────────────────────────────────
function fmtMbps(v){
  if(v==null||isNaN(v)) return '—';
  return v>=100?v.toFixed(0):v>=10?v.toFixed(1):v.toFixed(2);
}
function fmtMs(v){ return (v==null||isNaN(v))?'—':v.toFixed(1); }
function trunc(s,n){ return s&&s.length>n?s.slice(0,n-1)+'…':s||'—'; }

// ── UI helpers ────────────────────────────────────────────────
function flash(id,text,cls){
  const el=document.getElementById(id);
  el.textContent=text; el.className='sv'+(cls?' '+cls:'');
  el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
}

// Phase config: label text, color cssVar, unit label, number class
const PHASES={
  download:{ label:'DOWNLOAD', color:'--dl',  unit:'MBPS', cls:'dl'    },
  upload:  { label:'UPLOAD',   color:'--ul',  unit:'MBPS', cls:'ul'    },
  ping:    { label:'PING',     color:'--ping',unit:'MS',   cls:'ping'  },
  jitter:  { label:'JITTER',   color:'--ping',unit:'MS',   cls:'jitter'},
};

function setPhaseUI(p){
  phase=p;
  const cfg=PHASES[p]||{label:p.toUpperCase(),color:'--accent',unit:'',cls:''};
  const color=cssVar(cfg.color);
  document.getElementById('phase-lbl').className  =`phase-lbl ${cfg.cls}`;
  document.getElementById('phase-lbl').textContent=cfg.label;
  document.getElementById('big-num').className     =`big-num ${cfg.cls}`;
  document.getElementById('unit-lbl').className    =`unit-lbl ${cfg.cls}`;
  document.getElementById('unit-lbl').textContent  =cfg.unit;
  document.getElementById('arc-prog').style.stroke =color;
  return color;
}

function setProg(pct,label,cls){
  const fill=document.getElementById('prog-fill');
  fill.style.width=pct+'%';
  fill.className='prog-fill '+(cls||'');
  document.getElementById('prog-pct').textContent=Math.round(pct)+'%';
  if(label) document.getElementById('prog-lbl').textContent=label;
}
function setBadge(state){
  document.getElementById('status-badge').className='status-badge '+state;
  document.getElementById('sbdot').className='sbdot '+(state==='running'?'pulse':'');
  document.getElementById('status-lbl').textContent=
    state==='running'?'TESTING':state==='done'?'COMPLETE':'READY';
}
function setBtn(label,isRunning){
  const btn=document.getElementById('run-btn');
  btn.classList.toggle('running',isRunning);
  btn.innerHTML=`<span class="rdot ${isRunning?'on':''}" id="rdot"></span>${label}`;
}
function resetAll(){
  ['sv-dl','sv-ul','sv-ping','sv-jitter'].forEach(id=>{
    document.getElementById(id).textContent='—';
    document.getElementById(id).className='sv';
  });
  ['inf-isp','inf-org','inf-ip','inf-city','inf-country','inf-colo'].forEach(id=>{
    document.getElementById(id).textContent='—';
  });
  document.getElementById('big-num').textContent='—';
  document.getElementById('err-msg').textContent='';
  numTarget=0; numVal=0; arcTarget=0; arcVal=0;
}
function fillInfo(meta){
  if(!meta) return;
  // ipapi.co returns org as "AS1234 ISP Name" — strip the AS number for display
  const ispRaw = meta.isp || meta.org || '—';
  const ispClean = ispRaw.replace(/^AS\d+\s*/i, '');
  document.getElementById('inf-isp').textContent    = trunc(ispClean, 22);
  document.getElementById('inf-org').textContent    = trunc(ispRaw, 22);
  document.getElementById('inf-ip').textContent     = meta.ip      || '—';
  document.getElementById('inf-city').textContent   = meta.city    || '—';
  document.getElementById('inf-country').textContent= meta.country || '—';
  document.getElementById('inf-colo').textContent   = meta.colo    || '—';
}

// ── Wait until arc visually reaches target (for hold effect) ──
function waitArcSettle(target, timeoutMs=1800){
  return new Promise(resolve=>{
    const deadline=performance.now()+timeoutMs;
    function check(){
      if(Math.abs(arcVal-target)<.01||performance.now()>deadline) return resolve();
      requestAnimationFrame(check);
    }
    requestAnimationFrame(check);
  });
}

// ── Main test ─────────────────────────────────────────────────
let running=false, abortCtrl=null;
window.toggleTest=function(){ running?abortTest():startTest(); };

function abortTest(){
  abortCtrl&&abortCtrl.abort();
  running=false; stopLoop();
  phase='idle';
  document.getElementById('phase-lbl').className='phase-lbl';
  document.getElementById('phase-lbl').textContent='ABORTED';
  document.getElementById('big-num').className='big-num';
  arcTarget=0; arcVal=0; setArcRaw(0);
  setProg(0,'IDLE'); setBadge('idle'); setBtn('RUN TEST',false);
}

async function startTest(){
  running=true; abortCtrl=new AbortController();
  resetAll(); buildArc(); setBadge('running'); setBtn('STOP TEST',true);
  startLoop();
  NexusEngine.fetchMeta().then(meta=>fillInfo(meta));

  try{

    // ════════════════════════════════════════════════
    // PHASE 1 — DOWNLOAD
    // Arc sweeps 0→1 driven by measurement progress.
    // Number counts up with each sample.
    // ════════════════════════════════════════════════
    setPhaseUI('download');
    numTarget=0; numVal=0; arcTarget=0; arcVal=0;
    setProg(0,'DOWNLOAD','dl');

    const dlSamples=[];
    const DL_TOTAL=NexusEngine.DL_TOTAL; // rounds * sizes
    await NexusEngine.measureDownload(
      bps=>{
        dlSamples.push(bps);
        numTarget=bps/1e6;  // show live speed
        flash('sv-dl',fmtMbps(NexusEngine.trimmedMean(dlSamples)/1e6),'dl');
      },
      (done,total)=>{
        arcTarget=done/total;          // arc tracks completion 0→1
        setProg((done/total)*100,'DOWNLOAD','dl');
      },
      abortCtrl.signal
    );
    if(abortCtrl.signal.aborted) return cleanup();

    // Arc to exactly 1, number to final result, hold briefly
    const dlFinal=NexusEngine.trimmedMean(dlSamples)/1e6;
    arcTarget=1; numTarget=dlFinal;
    flash('sv-dl',fmtMbps(dlFinal),'dl');
    await waitArcSettle(1, 700);
    await sleep(400); // brief hold so user sees full arc

    // ════════════════════════════════════════════════
    // PHASE 2 — UPLOAD
    // ════════════════════════════════════════════════
    setPhaseUI('upload');
    arcTarget=0; arcVal=0; numTarget=0; numVal=0;
    setProg(0,'UPLOAD','ul');

    const ulSamples=[];
    await NexusEngine.measureUpload(
      bps=>{
        ulSamples.push(bps);
        numTarget=bps/1e6;
        flash('sv-ul',fmtMbps(NexusEngine.trimmedMean(ulSamples)/1e6),'ul');
      },
      (done,total)=>{
        arcTarget=done/total;
        setProg((done/total)*100,'UPLOAD','ul');
      },
      abortCtrl.signal
    );
    if(abortCtrl.signal.aborted) return cleanup();

    const ulFinal=NexusEngine.trimmedMean(ulSamples)/1e6;
    arcTarget=1; numTarget=ulFinal;
    flash('sv-ul',fmtMbps(ulFinal),'ul');
    await waitArcSettle(1, 700);
    await sleep(400);

    // ════════════════════════════════════════════════
    // PHASE 3 — PING
    // Arc sweeps 0→1 over 8 latency rounds.
    // Number shows current RTT.
    // ════════════════════════════════════════════════
    setPhaseUI('ping');
    arcTarget=0; arcVal=0; numTarget=0; numVal=0;
    setProg(0,'PING');

    const lat=await NexusEngine.measureLatency((done,total,last)=>{
      numTarget=last;
      arcTarget=done/total;
      setProg((done/total)*100,'PING');
      document.getElementById('sv-ping').textContent=fmtMs(last);
    });
    if(abortCtrl.signal.aborted) return cleanup();

    arcTarget=1; numTarget=lat.avg;
    flash('sv-ping',fmtMs(lat.avg));
    await waitArcSettle(1, 700);
    await sleep(400);

    // ════════════════════════════════════════════════
    // PHASE 4 — JITTER
    // We already have the jitter value from latency samples.
    // Animate the arc sweeping from 0→1 over 800ms while
    // the number counts up to the jitter value.
    // ════════════════════════════════════════════════
    setPhaseUI('jitter');
    arcTarget=0; arcVal=0; numTarget=0; numVal=0;
    setProg(0,'JITTER');

    // Animate jitter arc over ~1s in steps
    const jitterVal=lat.jitter;
    const JITTER_STEPS=20;
    for(let i=1; i<=JITTER_STEPS; i++){
      if(abortCtrl.signal.aborted) return cleanup();
      arcTarget=i/JITTER_STEPS;
      numTarget=jitterVal*(i/JITTER_STEPS);
      setProg((i/JITTER_STEPS)*100,'JITTER');
      await sleep(50);
    }
    arcTarget=1; numTarget=jitterVal;
    flash('sv-jitter',fmtMs(jitterVal));
    await waitArcSettle(1, 700);
    await sleep(400);

    // ════════════════════════════════════════════════
    // DONE — show download as final hero number
    // ════════════════════════════════════════════════
    stopLoop();
    running=false;
    setPhaseUI('download');
    arcTarget=Math.min(1,dlFinal/1000); arcVal=arcTarget;
    numTarget=dlFinal; numVal=dlFinal;
    setArcRaw(arcTarget, cssVar('--dl'));
    document.getElementById('big-num').textContent=fmtMbps(dlFinal);
    setProg(100,'DONE'); setBadge('done'); setBtn('RUN AGAIN',false);

    // Final flash all stats
    flash('sv-dl',    fmtMbps(dlFinal),'dl');
    flash('sv-ul',    fmtMbps(ulFinal),'ul');
    flash('sv-ping',  fmtMs(lat.avg));
    flash('sv-jitter',fmtMs(lat.jitter));

  }catch(e){
    if(e.name==='AbortError') return;
    document.getElementById('err-msg').textContent='TEST FAILED — CHECK CONNECTION';
    cleanup();
  }
}

function cleanup(){
  stopLoop(); running=false; setBadge('idle'); setBtn('RUN TEST',false);
}

// ── Theme ─────────────────────────────────────────────────────
window.toggleTheme=function(){
  const l=document.documentElement.classList.toggle('light');
  try{localStorage.setItem('nexus-theme',l?'light':'dark');}catch(e){}
  buildArc();
};

// ── Init ──────────────────────────────────────────────────────
(function(){
  try{
    if(localStorage.getItem('nexus-theme')==='light')
      document.documentElement.classList.add('light');
  }catch(e){}
  buildArc(); setArcRaw(0);
})();
