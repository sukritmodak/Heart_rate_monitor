/* HeartSound Monitor — browser client for ESP32 PCG packets
   Packet format:
   A5 5A | 0x80 | flags | 128 x 8-bit samples | checksum
   Total = 133 bytes. flags bit 0 = digital beat state.
*/

const waveCanvas = document.getElementById("waveCanvas");
const energyCanvas = document.getElementById("energyCanvas");
const wctx = waveCanvas.getContext("2d");
const ectx = energyCanvas.getContext("2d");

const heart = document.getElementById("heart");
const bpmEl = document.getElementById("bpm");
const intensityEl = document.getElementById("intensity");
const meter = document.getElementById("meterFill");
const statusEl = document.getElementById("status");
const beatLabel = document.getElementById("beatLabel");
const s1El = document.getElementById("s1");
const s2El = document.getElementById("s2");
const gapEl = document.getElementById("gap");
const audioBtn = document.getElementById("audioBtn");
const recordBtn = document.getElementById("recordBtn");
const volumeEl = document.getElementById("volume");

const SAMPLE_RATE = 4000;
const PACKET_SAMPLES = 128;
const PACKET_SIZE = 133;
const HEADER_1 = 0xA5;
const HEADER_2 = 0x5A;

const samples = new Float32Array(800);
let demo = false;
let demoTimer = null;
let serialPort = null;
let serialReader = null;
let bpm = 0;
let lastBeatMs = 0;
let beatTimes = [];
let audioCtx = null;
let scriptNode = null;
let audioGain = null;
let audioDestination = null;
let audioQueue = [];
let audioStarted = false;
let recording = false;
let recorder = null;
let recordChunks = [];

function resizeCanvas(canvas, ctx) {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(rect.width * dpr));
  canvas.height = Math.max(1, Math.floor(rect.height * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function resizeAll() {
  resizeCanvas(waveCanvas, wctx);
  resizeCanvas(energyCanvas, ectx);
}

function pushSample(value) {
  const v = Math.max(0, Math.min(255, value));
  samples.copyWithin(0, 1);
  samples[samples.length - 1] = v;
}

function pushPacket(packetSamples) {
  for (const value of packetSamples) {
    pushSample(value);
    if (audioStarted) audioQueue.push((value - 128) / 128);
  }
  if (audioQueue.length > SAMPLE_RATE * 3) {
    audioQueue.splice(0, audioQueue.length - SAMPLE_RATE * 2);
  }
}

function triggerBeat(label = "Heartbeat") {
  const now = performance.now();
  if (now - lastBeatMs < 300) return;

  if (lastBeatMs > 0) {
    const interval = now - lastBeatMs;
    const instant = 60000 / interval;
    if (instant >= 35 && instant <= 220) {
      bpm = bpm ? (bpm * 0.75 + instant * 0.25) : instant;
      bpmEl.textContent = Math.round(bpm);
    }
  }

  lastBeatMs = now;
  beatTimes.push(now);
  beatTimes = beatTimes.filter(t => now - t < 10000);

  heart.classList.remove("beat");
  void heart.offsetWidth;
  heart.classList.add("beat");
  beatLabel.textContent = label;
}

function detectAudioBeat() {
  const n = 220;
  const start = samples.length - n;
  if (start < 0) return;

  let mean = 0;
  for (let i = start; i < samples.length; i++) mean += samples[i];
  mean /= n;

  let energy = 0;
  for (let i = start; i < samples.length; i++) {
    const x = samples[i] - mean;
    energy += x * x;
  }
  const rms = Math.sqrt(energy / n);

  if (rms > 28 && performance.now() - lastBeatMs > 350) {
    triggerBeat("Heart sound detected");
  }
}

function draw() {
  resizeAll();

  const W = waveCanvas.clientWidth;
  const H = waveCanvas.clientHeight;

  wctx.clearRect(0, 0, W, H);
  wctx.strokeStyle = "#16303c";
  wctx.lineWidth = 1;

  for (let y = 0; y <= H; y += H / 4) {
    wctx.beginPath();
    wctx.moveTo(0, y);
    wctx.lineTo(W, y);
    wctx.stroke();
  }

  wctx.strokeStyle = "#48d7c2";
  wctx.lineWidth = 2;
  wctx.beginPath();

  for (let i = 0; i < samples.length; i++) {
    const x = (i / (samples.length - 1)) * W;
    const y = H / 2 - ((samples[i] - 128) / 128) * (H * 0.42);
    if (i === 0) wctx.moveTo(x, y);
    else wctx.lineTo(x, y);
  }
  wctx.stroke();

  const recent = samples.slice(-200);
  let sum = 0;
  for (const v of recent) {
    const x = v - 128;
    sum += x * x;
  }

  const rms = Math.sqrt(sum / recent.length);
  const intensity = Math.min(100, Math.round((rms / 70) * 100));
  intensityEl.textContent = intensity;
  meter.style.width = intensity + "%";

  const EW = energyCanvas.clientWidth;
  const EH = energyCanvas.clientHeight;
  ectx.clearRect(0, 0, EW, EH);

  for (let i = 0; i < 40; i++) {
    const a = Math.floor((i / 40) * recent.length);
    const b = Math.max(a + 1, Math.floor(((i + 1) / 40) * recent.length));
    let energy = 0;

    for (let j = a; j < b; j++) {
      energy += Math.abs(recent[j] - 128);
    }

    const h = Math.min(EH * 0.85, (energy / (b - a)) * 2.4);
    ectx.fillStyle = i % 2 ? "#48d7c2" : "#62a9ff";
    ectx.fillRect(i * (EW / 40) + 2, EH - h, EW / 40 - 4, h);
  }

  requestAnimationFrame(draw);
}

function updateEventsFromFlag(flags) {
  if (flags & 1) {
    triggerBeat("Digital beat detected");
  }
}

function parsePackets(buffer) {
  while (buffer.length >= PACKET_SIZE) {
    let start = -1;

    for (let i = 0; i <= buffer.length - PACKET_SIZE; i++) {
      if (
        buffer[i] === HEADER_1 &&
        buffer[i + 1] === HEADER_2 &&
        buffer[i + 2] === PACKET_SAMPLES
      ) {
        start = i;
        break;
      }
    }

    if (start < 0) return buffer.slice(-2);
    if (start > 0) buffer = buffer.slice(start);
    if (buffer.length < PACKET_SIZE) return buffer;

    const flags = buffer[3];
    const packetSamples = buffer.slice(4, 4 + PACKET_SAMPLES);
    const checksum = buffer[132];

    let calculated = 0;
    for (const value of packetSamples) calculated = (calculated + value) & 0xFF;

    if (calculated === checksum) {
      pushPacket(packetSamples);
      updateEventsFromFlag(flags);
      detectAudioBeat();
    }

    buffer = buffer.slice(PACKET_SIZE);
  }

  return buffer;
}

async function connectSerial() {
  if (!("serial" in navigator)) {
    alert("Web Serial is not available here. Open this website in Chrome or Edge on a desktop/laptop using HTTPS or localhost.");
    return;
  }

  try {
    serialPort = await navigator.serial.requestPort();
    await serialPort.open({ baudRate: 115200 });

    statusEl.textContent = "● ESP32 connected";
    statusEl.style.color = "#48d7c2";
    beatLabel.textContent = "Receiving live PCG data";

    serialReader = serialPort.readable.getReader();
    let buffer = new Uint8Array(0);

    while (true) {
      const { value, done } = await serialReader.read();
      if (done) break;

      if (value && value.length) {
        const combined = new Uint8Array(buffer.length + value.length);
        combined.set(buffer);
        combined.set(value, buffer.length);
        buffer = parsePackets(combined);
      }
    }
  } catch (error) {
    console.error(error);
    statusEl.textContent = "● Connection failed";
    statusEl.style.color = "#ff7187";
  } finally {
    if (serialReader) {
      try { serialReader.releaseLock(); } catch (_) {}
      serialReader = null;
    }
  }
}

async function disconnectSerial() {
  try {
    if (serialReader) await serialReader.cancel();
    if (serialPort) await serialPort.close();
  } catch (_) {}

  serialReader = null;
  serialPort = null;
  statusEl.textContent = "● Standby";
  statusEl.style.color = "";
  beatLabel.textContent = "Waiting for signal";
}

async function ensureAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: SAMPLE_RATE
    });

    audioGain = audioCtx.createGain();
    audioGain.gain.value = Number(volumeEl.value) * 0.65;

    audioDestination = audioCtx.createMediaStreamDestination();

    // ScriptProcessor is used for broad desktop-browser compatibility.
    scriptNode = audioCtx.createScriptProcessor(1024, 1, 1);

    scriptNode.onaudioprocess = event => {
      const output = event.outputBuffer.getChannelData(0);

      for (let i = 0; i < output.length; i++) {
        output[i] = audioQueue.length ? audioQueue.shift() : 0;
      }
    };

    scriptNode.connect(audioGain);
    audioGain.connect(audioCtx.destination);
    audioGain.connect(audioDestination);
  }

  if (audioCtx.state === "suspended") await audioCtx.resume();
}

async function toggleAudio() {
  await ensureAudio();

  audioStarted = !audioStarted;

  if (!audioStarted) {
    audioQueue.length = 0;
    audioBtn.textContent = "Hear Heart Sound";
    beatLabel.textContent = "Audio stopped";
  } else {
    audioBtn.textContent = "Stop Heart Sound";
    beatLabel.textContent = "Listening to live PCG";
  }
}

function startDemo() {
  demo = !demo;

  if (demo) {
    statusEl.textContent = "● Demo signal";
    statusEl.style.color = "#62a9ff";
    beatLabel.textContent = "Simulated phonocardiogram";

    let t = 0;
    demoTimer = setInterval(() => {
      t += 12;

      const phase = t % 900;
      let amp = 0;

      if (phase < 70) {
        amp = 105 * Math.sin(Math.PI * phase / 70);
      } else if (phase > 160 && phase < 220) {
        amp = 70 * Math.sin(Math.PI * (phase - 160) / 60);
      }

      const noise = (Math.random() - 0.5) * 10;
      pushPacket([Math.max(0, Math.min(255, 128 + amp + noise))]);

      if (phase < 18) triggerBeat("Demo heartbeat");
    }, 12);
  } else {
    clearInterval(demoTimer);
    demoTimer = null;
    statusEl.textContent = "● Standby";
    statusEl.style.color = "";
  }
}

function startRecording() {
  if (!audioDestination) {
    alert("Start 'Hear Heart Sound' first, then press Record.");
    return;
  }

  const stream = audioDestination.stream;
  const mime =
    MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : "audio/webm";

  recorder = new MediaRecorder(stream, { mimeType: mime });
  recordChunks = [];

  recorder.ondataavailable = e => {
    if (e.data.size) recordChunks.push(e.data);
  };

  recorder.onstop = () => {
    const blob = new Blob(recordChunks, { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "heart-sound-recording.webm";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  recorder.start();
  recording = true;
  recordBtn.textContent = "Stop & Save";
  beatLabel.textContent = "Recording live heart sound";
}

function stopRecording() {
  if (recorder && recorder.state !== "inactive") recorder.stop();
  recording = false;
  recordBtn.textContent = "Record";
  beatLabel.textContent = "Recording saved";
}

document.getElementById("connectBtn").addEventListener("click", async () => {
  if (serialPort) await disconnectSerial();
  else await connectSerial();
});

document.getElementById("demoBtn").addEventListener("click", startDemo);
audioBtn.addEventListener("click", toggleAudio);

recordBtn.addEventListener("click", () => {
  if (recording) stopRecording();
  else startRecording();
});

volumeEl.addEventListener("input", () => {
  if (audioGain) audioGain.gain.value = Number(volumeEl.value) * 0.65;
});

window.addEventListener("resize", resizeAll);

if ("serial" in navigator) {
  navigator.serial.addEventListener("disconnect", disconnectSerial);
}

draw();
