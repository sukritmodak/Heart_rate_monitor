/* HeartSound Monitor
   ESP32 Web Serial PCG client.

   Packet format:
   A5 5A | 0x80 | flags | 128 samples | checksum
   Total: 133 bytes
   flags bit 0 = one-shot digital beat event
*/

"use strict";

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
const connectBtn = document.getElementById("connectBtn");
const demoBtn = document.getElementById("demoBtn");
const audioBtn = document.getElementById("audioBtn");
const recordBtn = document.getElementById("recordBtn");
const volumeEl = document.getElementById("volume");

const SAMPLE_RATE = 4000;
const PACKET_SAMPLES = 128;
const PACKET_SIZE = 4 + PACKET_SAMPLES + 1;
const HEADER_1 = 0xA5;
const HEADER_2 = 0x5A;

const samples = new Float32Array(800);
samples.fill(128);

let serialPort = null;
let serialReader = null;
let serialConnected = false;
let disconnecting = false;

let bpm = 0;
let lastBeatMs = 0;
let beatTimes = [];

let audioCtx = null;
let scriptNode = null;
let audioGain = null;
let audioDestination = null;
let audioQueue = [];
let audioReadPosition = 0;
let audioStarted = false;

let recording = false;
let recorder = null;
let recordChunks = [];

let demo = false;
let demoTimer = null;

function setStatus(text, ok = false) {
  statusEl.textContent = text;
  statusEl.style.color = ok ? "#48d7c2" : "";
}

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
    const remove = audioQueue.length - SAMPLE_RATE * 2;
    audioQueue.splice(0, remove);
    audioReadPosition = Math.max(0, audioReadPosition - remove);
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
      bpmEl.textContent = String(Math.round(bpm));
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
  // Rough educational detector only. It is not a clinical S1/S2 detector.
  const n = 220;
  let mean = 0;

  for (let i = samples.length - n; i < samples.length; i++) {
    mean += samples[i];
  }
  mean /= n;

  let energy = 0;
  for (let i = samples.length - n; i < samples.length; i++) {
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

  intensityEl.textContent = String(intensity);
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

function parsePackets(buffer) {
  while (buffer.length >= 3) {
    let start = -1;

    for (let i = 0; i < buffer.length - 2; i++) {
      if (
        buffer[i] === HEADER_1 &&
        buffer[i + 1] === HEADER_2 &&
        buffer[i + 2] === PACKET_SAMPLES
      ) {
        start = i;
        break;
      }
    }

    // Keep enough bytes to detect a split header on the next read.
    if (start < 0) {
      return buffer.slice(-2);
    }

    if (start > 0) {
      buffer = buffer.slice(start);
    }

    if (buffer.length < PACKET_SIZE) {
      return buffer;
    }

    const flags = buffer[3];
    const packetSamples = buffer.slice(4, 4 + PACKET_SAMPLES);
    const checksum = buffer[4 + PACKET_SAMPLES];

    let calculated = 0;
    for (const value of packetSamples) {
      calculated = (calculated + value) & 0xFF;
    }

    if (calculated === checksum) {
      pushPacket(packetSamples);

      // Bit 0 is an edge event, not a level.
      if (flags & 0x01) {
        triggerBeat("Digital beat detected");
      }

      detectAudioBeat();
    }

    buffer = buffer.slice(PACKET_SIZE);
  }

  return buffer;
}

async function connectSerial() {
  if (!window.isSecureContext) {
    alert("This page must be opened over HTTPS or localhost for Web Serial.");
    return;
  }

  if (!("serial" in navigator)) {
    alert(
      "Web Serial is not available. Use the latest Google Chrome or Microsoft Edge on a desktop/laptop."
    );
    return;
  }

  if (serialConnected) {
    await disconnectSerial();
    return;
  }

  try {
    connectBtn.disabled = true;
    setStatus("● Select ESP32 serial port…");
    beatLabel.textContent = "Waiting for serial permission";

    // requestPort() MUST run directly from the button click.
    serialPort = await navigator.serial.requestPort();

    setStatus("● Opening ESP32…");

    await serialPort.open({
      baudRate: 115200,
      dataBits: 8,
      stopBits: 1,
      parity: "none",
      flowControl: "none"
    });

    serialConnected = true;
    connectBtn.textContent = "Disconnect ESP32";
    setStatus("● ESP32 connected", true);
    beatLabel.textContent = "Receiving live PCG data";

    serialReader = serialPort.readable.getReader();
    let buffer = new Uint8Array(0);

    while (serialConnected && serialPort && serialPort.readable) {
      const { value, done } = await serialReader.read();

      if (done) break;
      if (!value || value.length === 0) continue;

      const combined = new Uint8Array(buffer.length + value.length);
      combined.set(buffer);
      combined.set(value, buffer.length);
      buffer = parsePackets(combined);
    }
  } catch (error) {
    console.error("ESP32 serial connection error:", error);

    let message = "Connection failed.";

    if (error && error.name === "NotFoundError") {
      message = "No serial port was selected.";
    } else if (error && error.name === "NetworkError") {
      message = "The serial port is busy. Close Arduino Serial Monitor/Plotter and try again.";
    } else if (error && error.name === "SecurityError") {
      message = "Browser permission blocked serial access. Use HTTPS Chrome/Edge.";
    } else if (error && error.message) {
      message = "Connection failed: " + error.message;
    }

    setStatus("● " + message);
    beatLabel.textContent = message;

    if (serialPort) {
      try { await serialPort.close(); } catch (_) {}
    }

    serialPort = null;
    serialConnected = false;
    connectBtn.textContent = "Connect ESP32";
  } finally {
    connectBtn.disabled = false;

    if (serialReader) {
      try { serialReader.releaseLock(); } catch (_) {}
      serialReader = null;
    }
  }
}

async function disconnectSerial() {
  if (disconnecting) return;

  disconnecting = true;
  serialConnected = false;

  try {
    if (serialReader) {
      try { await serialReader.cancel(); } catch (_) {}
    }

    if (serialPort) {
      try { await serialPort.close(); } catch (_) {}
    }
  } finally {
    serialReader = null;
    serialPort = null;
    connectBtn.textContent = "Connect ESP32";
    setStatus("● Standby");
    beatLabel.textContent = "Waiting for signal";
    disconnecting = false;
  }
}

async function ensureAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();

    audioGain = audioCtx.createGain();
    audioGain.gain.value = Number(volumeEl.value) * 0.65;

    audioDestination = audioCtx.createMediaStreamDestination();

    // Broad desktop compatibility.
    scriptNode = audioCtx.createScriptProcessor(1024, 1, 1);

    scriptNode.onaudioprocess = event => {
      const output = event.outputBuffer.getChannelData(0);
      const browserRate = audioCtx.sampleRate;
      const step = SAMPLE_RATE / browserRate;

      for (let i = 0; i < output.length; i++) {
        const index = Math.floor(audioReadPosition);
        const frac = audioReadPosition - index;

        if (index + 1 < audioQueue.length) {
          const a = audioQueue[index];
          const b = audioQueue[index + 1];
          output[i] = a + (b - a) * frac;
          audioReadPosition += step;
        } else {
          output[i] = 0;
        }
      }

      const remove = Math.min(
        Math.floor(audioReadPosition),
        Math.max(0, audioQueue.length - 2)
      );

      if (remove > 0) {
        audioQueue.splice(0, remove);
        audioReadPosition -= remove;
      }
    };

    scriptNode.connect(audioGain);
    audioGain.connect(audioCtx.destination);
    audioGain.connect(audioDestination);
  }

  if (audioCtx.state === "suspended") {
    await audioCtx.resume();
  }
}

async function toggleAudio() {
  await ensureAudio();

  audioStarted = !audioStarted;

  if (!audioStarted) {
    audioQueue.length = 0;
    audioReadPosition = 0;
    audioBtn.textContent = "Hear Heart Sound";
    beatLabel.textContent = serialConnected ? "Receiving live PCG data" : "Audio stopped";
  } else {
    audioBtn.textContent = "Stop Heart Sound";
    beatLabel.textContent = serialConnected
      ? "Listening to live PCG"
      : "Start ESP32 first for live audio";
  }
}

function startDemo() {
  demo = !demo;

  if (demo) {
    demoBtn.textContent = "Stop Demo";
    setStatus("● Demo signal");
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

      const value = Math.max(
        0,
        Math.min(255, 128 + amp + (Math.random() - 0.5) * 10)
      );

      pushSample(value);

      if (phase < 18) {
        triggerBeat("Demo heartbeat");
      }
    }, 12);
  } else {
    clearInterval(demoTimer);
    demoTimer = null;
    demoBtn.textContent = "Demo Signal";
    setStatus(serialConnected ? "● ESP32 connected" : "● Standby", serialConnected);
    beatLabel.textContent = serialConnected
      ? "Receiving live PCG data"
      : "Waiting for signal";
  }
}

function startRecording() {
  if (!audioDestination) {
    alert("Click 'Hear Heart Sound' first, then press Record.");
    return;
  }

  if (!window.MediaRecorder) {
    alert("Recording is not supported by this browser.");
    return;
  }

  const stream = audioDestination.stream;
  const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
    ? "audio/webm;codecs=opus"
    : "audio/webm";

  try {
    recorder = new MediaRecorder(stream, { mimeType: mime });
  } catch (error) {
    alert("Could not start recording: " + error.message);
    return;
  }

  recordChunks = [];

  recorder.ondataavailable = event => {
    if (event.data.size) recordChunks.push(event.data);
  };

  recorder.onstop = () => {
    const blob = new Blob(recordChunks, { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");

    a.href = url;
    a.download = "heart-sound-recording.webm";
    document.body.appendChild(a);
    a.click();
    a.remove();

    setTimeout(() => URL.revokeObjectURL(url), 1000);
    beatLabel.textContent = "Recording saved";
  };

  recorder.start();
  recording = true;
  recordBtn.textContent = "Stop & Save";
  beatLabel.textContent = "Recording live heart sound";
}

function stopRecording() {
  if (recorder && recorder.state !== "inactive") {
    recorder.stop();
  }

  recording = false;
  recordBtn.textContent = "Record";
}

connectBtn.addEventListener("click", connectSerial);
demoBtn.addEventListener("click", startDemo);
audioBtn.addEventListener("click", toggleAudio);

recordBtn.addEventListener("click", () => {
  if (recording) stopRecording();
  else startRecording();
});

volumeEl.addEventListener("input", () => {
  if (audioGain) {
    audioGain.gain.value = Number(volumeEl.value) * 0.65;
  }
});

window.addEventListener("resize", resizeAll);

if ("serial" in navigator) {
  navigator.serial.addEventListener("disconnect", async event => {
    if (serialPort && event.target === serialPort) {
      await disconnectSerial();
      setStatus("● ESP32 disconnected");
    }
  });
}

draw();
