const waveCanvas=document.getElementById("waveCanvas"), energyCanvas=document.getElementById("energyCanvas");
const wctx=waveCanvas.getContext("2d"), ectx=energyCanvas.getContext("2d");
const heart=document.getElementById("heart"), bpmEl=document.getElementById("bpm"), intensityEl=document.getElementById("intensity"), meter=document.getElementById("meterFill");
const statusEl=document.getElementById("status"), beatLabel=document.getElementById("beatLabel");
const samples=new Array(700).fill(128); let demo=false, demoTimer=null, lastBeat=0, bpm=0, audioCtx=null, osc=null, recording=false, recorder=null, recChunks=[];

function resize(c){const r=c.getBoundingClientRect(),d=devicePixelRatio||1;c.width=r.width*d;c.height=r.height*d;c.getContext("2d").setTransform(d,0,0,d,0,0)}
function draw(){
  resize(waveCanvas); resize(energyCanvas);
  const W=waveCanvas.clientWidth,H=waveCanvas.clientHeight;
  wctx.clearRect(0,0,W,H); wctx.strokeStyle="#16303c";wctx.lineWidth=1;
  for(let y=0;y<H;y+=H/4){wctx.beginPath();wctx.moveTo(0,y);wctx.lineTo(W,y);wctx.stroke()}
  wctx.strokeStyle="#48d7c2";wctx.lineWidth=2;wctx.beginPath();
  samples.forEach((v,i)=>{const x=i/(samples.length-1)*W,y=H/2-(v-128)/128*(H*.42);i?wctx.lineTo(x,y):wctx.moveTo(x,y)});wctx.stroke();
  const recent=samples.slice(-160); let sum=0;recent.forEach(v=>sum+=(v-128)*(v-128));const rms=Math.sqrt(sum/recent.length);
  const intensity=Math.min(100,Math.round(rms/80*100));intensityEl.textContent=intensity;meter.style.width=intensity+"%";
  const EW=energyCanvas.clientWidth,EH=energyCanvas.clientHeight;ectx.clearRect(0,0,EW,EH);
  for(let i=0;i<36;i++){let start=Math.floor(i/recent.length*recent.length),end=Math.max(start+1,Math.floor((i+1)/36*recent.length));let s=0;for(let j=start;j<end;j++)s+=Math.abs(recent[j]-128);let h=Math.min(EH*.85,(s/(end-start))*2.8);ectx.fillStyle=i%3===0?"#62a9ff":"#48d7c2";ectx.fillRect(i*(EW/36)+2,EH-h,EW/36-4,h)}
  requestAnimationFrame(draw)
}
function pushSample(v){samples.push(v);samples.shift()}
function triggerBeat(label="Heartbeat"){const now=performance.now();if(now-lastBeat>280){if(lastBeat){const interval=now-lastBeat;const value=Math.round(60000/interval);if(value>35&&value<220){bpm=bpm?Math.round(bpm*.7+value*.3):value;bpmEl.textContent=bpm}}lastBeat=now;heart.classList.remove("beat");void heart.offsetWidth;heart.classList.add("beat");beatLabel.textContent=label}}
function demoPulse(){const t=performance.now();const phase=(t%900);let amp=0;if(phase<65)amp=105*Math.sin(Math.PI*phase/65);else if(phase>150&&phase<205)amp=65*Math.sin(Math.PI*(phase-150)/55);const noise=(Math.random()-.5)*12;const v=Math.max(0,Math.min(255,128+amp+noise));pushSample(v);if(phase<18)triggerBeat("S1 / S2 pattern");}
function startDemo(){demo=!demo;if(demo){statusEl.textContent="● Demo signal";statusEl.style.color="#62a9ff";demoTimer=setInterval(demoPulse,12)}else{clearInterval(demoTimer);statusEl.textContent="● Standby";statusEl.style.color="";}}
async function connectSerial(){
  if(!("serial" in navigator)){alert("Web Serial is not supported. Use Chrome or Edge on desktop.");return}
  try{
    const port=await navigator.serial.requestPort();await port.open({baudRate:115200});statusEl.textContent="● ESP32 connected";statusEl.style.color="#48d7c2";
    const reader=port.readable.getReader();let buf=new Uint8Array(0);
    while(true){const {value,done}=await reader.read();if(done)break;if(value){const n=new Uint8Array(buf.length+value.length);n.set(buf);n.set(value,buf.length);buf=n;while(buf.length>=132){let k=-1;for(let i=0;i<=buf.length-132;i++){if(buf[i]===0xA5&&buf[i+1]===0x5A&&buf[i+2]===128){k=i;break}}if(k<0){buf=buf.slice(-2);break}if(k>0)buf=buf.slice(k);if(buf.length<132)break;let sum=0;for(let i=0;i<128;i++)sum=(sum+buf[3+i])&255;if(sum===buf[131]){for(let i=0;i<128;i++)pushSample(buf[3+i]);}buf=buf.slice(132)}}}
    reader.releaseLock()
  }catch(e){statusEl.textContent="● Connection cancelled";console.warn(e)}
}
function audioToggle(){
  if(!audioCtx){audioCtx=new (window.AudioContext||window.webkitAudioContext)();osc=audioCtx.createOscillator();const gain=audioCtx.createGain();osc.type="sine";osc.frequency.value=70;gain.gain.value=0;osc.connect(gain).connect(audioCtx.destination);osc.start();document.getElementById("audioBtn").textContent="Stop Sound";window._heartGain=gain}
  else if(audioCtx.state==="running"){audioCtx.suspend();document.getElementById("audioBtn").textContent="Hear Heart Sound"}else{audioCtx.resume();document.getElementById("audioBtn").textContent="Stop Sound"}
}
function audioTick(){if(window._heartGain&&audioCtx&&audioCtx.state==="running"){const g=window._heartGain;const now=audioCtx.currentTime;const amp=Math.min(.08,Number(document.getElementById("volume").value)*.18);g.gain.cancelScheduledValues(now);g.gain.setValueAtTime(0,now);g.gain.linearRampToValueAtTime(amp,now+.015);g.gain.exponentialRampToValueAtTime(.001,now+.12)}}
setInterval(()=>{if(demo)audioTick()},450);
document.getElementById("demoBtn").onclick=startDemo;document.getElementById("connectBtn").onclick=connectSerial;document.getElementById("audioBtn").onclick=audioToggle;
document.getElementById("recordBtn").onclick=()=>{recording=!recording;document.getElementById("recordBtn").textContent=recording?"Stop Recording":"Record";beatLabel.textContent=recording?"Recording signal":"Waiting for signal"};
window.addEventListener("resize",()=>{resize(waveCanvas);resize(energyCanvas)});draw();
