/* HeartSound Monitor
   IMPORTANT: this browser code matches the user's ESP32 code exactly.
   ESP32 USB packet:
   A5 5A | 80 | 128 x 8-bit ADC samples | checksum
   Packet size = 132 bytes.
   ESP32 baud = 115200.
*/

"use strict";

const waveCanvas = document.getElementById("waveCanvas");
const energyCanvas = document.getElementById("energyCanvas");
const wctx = waveCanvas.getContext("2d");
const ectx = energyCanvas.getContext("2d");

const heart = document.getElementById("heart");
const bpmEl = document.getElementById("bpm");
const intensityEl = document.getElementById("intensity");
const adcValueEl = document.getElementById("adcValue");
const meter = document.getElementById("meterFill");
const statusEl = document.getElementById("status");
const beatLabel = document.getElementById("beatLabel");
const connectBtn = document.getElementById("connectBtn");
const demoBtn = document.getElementById("demoBtn");
const audioBtn = document.getElementById("audioBtn");
const recordBtn = document.getElementById("recordBtn");
const volumeEl = document.getElementById("volume");

const BAUD = 115200;
const SAMPLE_RATE = 4000;
const BLOCK = 128;
const PACKET_SIZE = 2 + 1 + BLOCK + 1;
const H1 = 0xA5;
const H2 = 0x5A;

const GRAPH_SAMPLES = SAMPLE_RATE;
const graph = new Float32Array(GRAPH_SAMPLES);
graph.fill(2048);
let writeIndex = 0;
let graphCount = 0;

let port = null;
let reader = null;
let connected = false;
let bytesReceived = 0;
let packetsReceived = 0;
let badPackets = 0;
let lastPacketTime = 0;
let receiveBuffer = new Uint8Array(0);

let lastBeat = 0;
let bpm = 0;

const AUDIO_SECONDS = 4;
const audioRing = new Float32Array(SAMPLE_RATE * AUDIO_SECONDS);
let audioWrite = 0;
let audioRead = 0;
let audioCount = 0;

let audioContext = null;
let audioNode = null;
let audioGain = null;
let audioDestination = null;
let audioOn = false;
let audioPhase = 0;
let previousInput = 0;
let previousOutput = 0;

let recording = false;
let recorder = null;
let recordChunks = [];

let demo = false;
let demoTimer = null;

function status(text, good = false) {
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.style.color = good ? "#48d7c2" : "";
}

function resizeCanvas(canvas, ctx) {
  const r = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(r.width * dpr));
  canvas.height = Math.max(1, Math.round(r.height * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function resize() {
  resizeCanvas(waveCanvas, wctx);
  resizeCanvas(energyCanvas, ectx);
}

function pushSample(adc12) {
  const v = Math.max(0, Math.min(4095, adc12));
  graph[writeIndex] = v;
  writeIndex = (writeIndex + 1) % GRAPH_SAMPLES;
  graphCount = Math.min(GRAPH_SAMPLES, graphCount + 1);
  if (adcValueEl) adcValueEl.textContent = Math.round(v);
}

function pushAudio(adc12) {
  // The ESP32 sends 8-bit samples (0..255).
  // Convert them back to the approximate 12-bit ADC scale.
  const input = (adc12 - 2048) / 2048;

  // Simple high-pass filter to remove DC offset.
  const filtered = 0.985 * (previousOutput + input - previousInput);
  previousInput = input;
  previousOutput = filtered;

  audioRing[audioWrite] = Math.max(-1, Math.min(1, filtered * 3.5));
  audioWrite = (audioWrite + 1) % audioRing.length;

  if (audioCount < audioRing.length) {
    audioCount++;
  } else {
    audioRead = (audioRead + 1) % audioRing.length;
  }
}

function recent(n) {
  const count = Math.min(graphCount, n);
  const out = new Float32Array(count);
  const start = (writeIndex - count + GRAPH_SAMPLES) % GRAPH_SAMPLES;

  for (let i = 0; i < count; i++) {
    out[i] = graph[(start + i) % GRAPH_SAMPLES];
  }
  return out;
}

function beat(label) {
  const now = performance.now();
  if (now - lastBeat < 250) return;

  if (lastBeat > 0) {
    const rate = 60000 / (now - lastBeat);
    if (rate >= 35 && rate <= 220) {
      bpm = bpm ? bpm * 0.8 + rate * 0.2 : rate;
      bpmEl.textContent = Math.round(bpm);
    }
  }

  lastBeat = now;
  if (heart) {
    heart.classList.remove("beat");
    void heart.offsetWidth;
    heart.classList.add("beat");
  }
  if (beatLabel) beatLabel.textContent = label;
}

function checksum8(start) {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum = (sum + receiveBuffer[start + 3 + i]) & 0xFF;
  return sum;
}

function parse() {
  while (receiveBuffer.length >= 3) {
    let start = -1;

    for (let i = 0; i <= receiveBuffer.length - 3; i++) {
      if (
        receiveBuffer[i] === H1 &&
        receiveBuffer[i + 1] === H2 &&
        receiveBuffer[i + 2] === BLOCK
      ) {
        start = i;
        break;
      }
    }

    if (start < 0) {
      receiveBuffer = receiveBuffer.slice(Math.max(0, receiveBuffer.length - 2));
      return;
    }

    if (receiveBuffer.length - start < PACKET_SIZE) {
      receiveBuffer = receiveBuffer.slice(start);
      return;
    }

    const expected = checksum8(start);
    const received = receiveBuffer[start + 3 + BLOCK];

    if (expected === received) {
      for (let i = 0; i < BLOCK; i++) {
        // Exact conversion of the user's ESP32 byte:
        // ESP32: sample = analogRead() >> 4
        // Browser: recover approximate ADC value.
        const byteValue = receiveBuffer[start + 3 + i];
        const adc12 = byteValue * 16;

        pushSample(adc12);
        pushAudio(adc12);
      }

      packetsReceived++;
      lastPacketTime = performance.now();
    } else {
      badPackets++;
    }

    receiveBuffer = receiveBuffer.slice(start + PACKET_SIZE);
  }
}

function draw() {
  resizeIfNeeded();

  const W = waveCanvas.clientWidth;
  const H = waveCanvas.clientHeight;

  wctx.clearRect(0, 0, W, H);

  // Grid
  wctx.strokeStyle = "#16303c";
  wctx.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    const y = (H * i) / 4;
    wctx.beginPath();
    wctx.moveTo(0, y);
    wctx.lineTo(W, y);
    wctx.stroke();
  }

  const data = recent(GRAPH_SAMPLES);

  if (data.length > 1) {
    let min = 4095;
    let max = 0;
    let sum = 0;

    for (const v of data) {
      min = Math.min(min, v);
      max = Math.max(max, v);
      sum += v;
    }

    const mean = sum / data.length;
    const amplitude = Math.max(8, max - min);

    // Actual continuous ADC waveform.
    wctx.strokeStyle = "#48d7c2";
    wctx.lineWidth = 2;
    wctx.beginPath();

    for (let i = 0; i < data.length; i++) {
      const x = (i / (data.length - 1)) * W;
      const y = H / 2 - ((data[i] - mean) / amplitude) * H * 0.86;

      if (i === 0) wctx.moveTo(x, y);
      else wctx.lineTo(x, y);
    }

    wctx.stroke();

    let energy = 0;
    for (const v of data) {
      const d = v - mean;
      energy += d * d;
    }

    const rms = Math.sqrt(energy / data.length);
    const intensity = Math.min(100, Math.round(rms / 10));

    if (intensityEl) intensityEl.textContent = intensity;
    if (meter) meter.style.width = intensity + "%";

    // Energy bars
    const EW = energyCanvas.clientWidth;
    const EH = energyCanvas.clientHeight;
    ectx.clearRect(0, 0, EW, EH);

    const bars = 50;
    for (let b = 0; b < bars; b++) {
      const a = Math.floor((b / bars) * data.length);
      const z = Math.max(a + 1, Math.floor(((b + 1) / bars) * data.length));

      let e = 0;
      for (let j = a; j < z && j < data.length; j++) {
        e += Math.abs(data[j] - mean);
      }

      const avg = e / Math.max(1, z - a);
      const h = Math.min(EH * 0.9, avg * 2);

      ectx.fillStyle = b % 2 ? "#48d7c2" : "#62a9ff";
      ectx.fillRect(b * EW / bars + 2, EH - h, EW / bars - 4, h);
    }
  }

  if (connected) {
    if (performance.now() - lastPacketTime > 1500) {
      status("● ESP32 connected — no valid packets", false);
    } else {
      status(
        "● ESP32 LIVE • " +
        packetsReceived +
        " packets • " +
        Math.round(bytesReceived / 1024) +
        " KB",
        true
      );
    }
  }

  requestAnimationFrame(draw);
}

function resizeIfNeeded() {
  const dpr = window.devicePixelRatio || 1;
  const waveWidth = Math.round(waveCanvas.clientWidth * dpr);
  const waveHeight = Math.round(waveCanvas.clientHeight * dpr);

  if (waveCanvas.width !== waveWidth || waveCanvas.height !== waveHeight) {
    resize();
  }
}

async function connectSerial() {
  if (!window.isSecureContext) {
    alert("Please use the HTTPS GitHub Pages website.");
    return;
  }

  if (!("serial" in navigator)) {
    alert("Use current Chrome or Edge on a desktop/laptop.");
    return;
  }

  if (connected) {
    await disconnectSerial();
    return;
  }

  try {
    connectBtn.disabled = true;
    status("● Select ESP32 COM port…");
    port = await navigator.serial.requestPort();

    // EXACTLY matches your ESP32: Serial.begin(115200)
    await port.open({
      baudRate: BAUD,
      dataBits: 8,
      stopBits: 1,
      parity: "none",
      flowControl: "none",
      bufferSize: 4096
    });

    connected = true;
    bytesReceived = 0;
    packetsReceived = 0;
    badPackets = 0;
    receiveBuffer = new Uint8Array(0);
    lastPacketTime = performance.now();

    connectBtn.textContent = "Disconnect ESP32";
    status("● ESP32 LIVE — 115200 baud", true);
    beatLabel.textContent = "Receiving continuous analog data";

    reader = port.readable.getReader();

    while (connected) {
      const result = await reader.read();
      if (result.done) break;
      if (!result.value || result.value.length === 0) continue;

      bytesReceived += result.value.length;

      const merged = new Uint8Array(
        receiveBuffer.length + result.value.length
      );

      merged.set(receiveBuffer);
      merged.set(result.value, receiveBuffer.length);
      receiveBuffer = merged;

      parse();
    }
  } catch (err) {
    console.error(err);

    if (err.name === "NotFoundError") {
      status("● No COM port selected");
    } else if (err.name === "NetworkError") {
      status("● COM port busy — close Arduino Serial Monitor");
    } else {
      status("● " + (err.message || "Serial connection failed"));
    }

    connected = false;

    if (port) {
      try { await port.close(); } catch (_) {}
    }

    port = null;
  } finally {
    connectBtn.disabled = false;

    if (reader) {
      try { reader.releaseLock(); } catch (_) {}
      reader = null;
    }

    if (!connected) connectBtn.textContent = "Connect ESP32";
  }
}

async function disconnectSerial() {
  connected = false;

  if (reader) {
    try { await reader.cancel(); } catch (_) {}
  }

  if (port) {
    try { await port.close(); } catch (_) {}
  }

  reader = null;
  port = null;
  connectBtn.textContent = "Connect ESP32";
  status("● Standby");
  beatLabel.textContent = "Waiting for signal";
}

async function startAudio() {
  if (!audioContext) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();

    audioGain = audioContext.createGain();
    audioGain.gain.value = Number(volumeEl.value);

    audioDestination = audioContext.createMediaStreamDestination();

    audioNode = audioContext.createScriptProcessor(1024, 1, 1);

    audioNode.onaudioprocess = event => {
      const out = event.outputBuffer.getChannelData(0);

      if (!audioOn || audioCount < 2) {
        out.fill(0);
        return;
      }

      const step = SAMPLE_RATE / audioContext.sampleRate;

      for (let i = 0; i < out.length; i++) {
        if (audioCount < 2) {
          out[i] = 0;
          continue;
        }

        const base = Math.floor(audioPhase);
        const i0 = (audioRead + base) % audioRing.length;
        const i1 = (i0 + 1) % audioRing.length;
        const fraction = audioPhase - base;

        out[i] =
          audioRing[i0] +
          (audioRing[i1] - audioRing[i0]) * fraction;

        audioPhase += step;

        const consumed = Math.floor(audioPhase);
        if (consumed > 0) {
          audioRead = (audioRead + consumed) % audioRing.length;
          audioCount = Math.max(0, audioCount - consumed);
          audioPhase -= consumed;
        }
      }
    };

    audioNode.connect(audioGain);
    audioGain.connect(audioContext.destination);
    audioGain.connect(audioDestination);
  }

  if (audioContext.state === "suspended") {
    await audioContext.resume();
  }
}

async function toggleAudio() {
  await startAudio();

  audioOn = !audioOn;

  if (audioOn) {
    // Start with the newest available data.
    const keep = Math.min(audioCount, SAMPLE_RATE);
    audioRead = (audioWrite - keep + audioRing.length) % audioRing.length;
    audioCount = keep;
    audioPhase = 0;

    audioBtn.textContent = "Stop Heart Sound";
    beatLabel.textContent = "Listening to live analog signal";
  } else {
    audioBtn.textContent = "Hear Heart Sound";
    beatLabel.textContent = "Live analog graph continues";
  }
}

function startDemo() {
  // Demo is kept only as a diagnostic option; it never runs automatically.
  demo = !demo;

  if (!demo) {
    clearInterval(demoTimer);
    demoTimer = null;
    demoBtn.textContent = "Demo Signal";
    return;
  }

  demoBtn.textContent = "Stop Demo";
  let phase = 0;

  demoTimer = setInterval(() => {
    phase = (phase + 12) % 900;
    let pulse = 0;

    if (phase < 70) pulse = 900 * Math.sin(Math.PI * phase / 70);
    else if (phase > 160 && phase < 220) {
      pulse = 600 * Math.sin(Math.PI * (phase - 160) / 60);
    }

    const v = 2048 + pulse + (Math.random() - 0.5) * 60;
    pushSample(v);
    pushAudio(v);
  }, 12);
}

function startRecording() {
  if (!audioDestination) {
    alert("Click Hear Heart Sound first.");
    return;
  }

  const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
    ? "audio/webm;codecs=opus"
    : "audio/webm";

  recorder = new MediaRecorder(audioDestination.stream, { mimeType: mime });
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
}

function stopRecording() {
  if (recorder && recorder.state !== "inactive") recorder.stop();
  recording = false;
  recordBtn.textContent = "Record";
}

connectBtn.addEventListener("click", connectSerial);
audioBtn.addEventListener("click", toggleAudio);
demoBtn.addEventListener("click", startDemo);
recordBtn.addEventListener("click", () => {
  if (recording) stopRecording();
  else startRecording();
});

volumeEl.addEventListener("input", () => {
  if (audioGain) audioGain.gain.value = Number(volumeEl.value);
});

window.addEventListener("resize", resize);

resize();
draw();
