/* HeartSound Monitor — continuous ESP32 analog stream
   USB Web Serial protocol:
   A5 5A | 0x80 | flags | 128 x uint16 ADC | checksum
   261 bytes/packet, 4000 samples/second, 12-bit ADC.
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

const SAMPLE_RATE = 4000;
const PACKET_SAMPLES = 128;
const HEADER_SIZE = 4;
const DATA_SIZE = PACKET_SAMPLES * 2;
const PACKET_SIZE = HEADER_SIZE + DATA_SIZE + 1;
const HEADER_1 = 0xA5;
const HEADER_2 = 0x5A;
const ADC_MAX = 4095;

// 2 seconds of real incoming ADC data.
// This is a circular buffer: samples are never shifted/copied per sample.
const WAVEFORM_SAMPLES = SAMPLE_RATE * 2;
const samples = new Float32Array(WAVEFORM_SAMPLES);
samples.fill(2048);
let sampleWrite = 0;
let sampleCount = 0;

let serialPort = null;
let serialReader = null;
let serialConnected = false;
let disconnecting = false;
let bytesReceived = 0;
let packetsReceived = 0;
let badPackets = 0;
let lastPacketTime = 0;

let bpm = 0;
let lastBeatMs = 0;

let audioCtx = null;
let scriptNode = null;
let audioGain = null;
let audioDestination = null;
const AUDIO_BUFFER = SAMPLE_RATE * 3;
const audioQueue = new Float32Array(AUDIO_BUFFER);
let audioWrite = 0;
let audioRead = 0;
let audioCount = 0;
let audioStarted = false;

let recording = false;
let recorder = null;
let recordChunks = [];

let demo = false;
let demoTimer = null;
let canvasReady = false;

function setStatus(text, ok = false) {
  statusEl.textContent = text;
  statusEl.style.color = ok ? "#48d7c2" : "";
}

function resizeCanvas(canvas, ctx) {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.floor(rect.width * dpr));
  const height = Math.max(1, Math.floor(rect.height * dpr));

  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
}

function resizeAll() {
  resizeCanvas(waveCanvas, wctx);
  resizeCanvas(energyCanvas, ectx);
  canvasReady = true;
}

// Write ONE ADC sample without shifting the entire array.
function pushSample(value) {
  const v = Math.max(0, Math.min(ADC_MAX, value));

  samples[sampleWrite] = v;
  sampleWrite = (sampleWrite + 1) % WAVEFORM_SAMPLES;
  if (sampleCount < WAVEFORM_SAMPLES) sampleCount++;

  if (adcValueEl) adcValueEl.textContent = Math.round(v);
}

function pushAudio(value) {
  if (!audioStarted) return;

  // Remove DC offset and normalize the 12-bit ADC value.
  const x = (value - 2048) / 2048;

  audioQueue[audioWrite] = x;
  audioWrite = (audioWrite + 1) % AUDIO_BUFFER;

  if (audioCount < AUDIO_BUFFER) {
    audioCount++;
  } else {
    audioRead = (audioRead + 1) % AUDIO_BUFFER;
  }
}

function pushPacket(packetSamples) {
  // Process every ADC sample in the packet.
  for (let i = 0; i < packetSamples.length; i++) {
    const value = packetSamples[i];
    pushSample(value);
    pushAudio(value);
  }
}

function getRecentSamples(maxSamples = WAVEFORM_SAMPLES) {
  const n = Math.min(sampleCount, maxSamples);
  const out = new Float32Array(n);

  const start = (sampleWrite - n + WAVEFORM_SAMPLES) % WAVEFORM_SAMPLES;

  for (let i = 0; i < n; i++) {
    out[i] = samples[(start + i) % WAVEFORM_SAMPLES];
  }

  return out;
}

function triggerBeat(label) {
  const now = performance.now();

  if (now - lastBeatMs < 300) return;

  if (lastBeatMs > 0) {
    const interval = now - lastBeatMs;
    const instant = 60000 / interval;

    if (instant >= 35 && instant <= 220) {
      bpm = bpm ? bpm * 0.75 + instant * 0.25 : instant;
      bpmEl.textContent = Math.round(bpm);
    }
  }

  lastBeatMs = now;
  heart.classList.remove("beat");
  void heart.offsetWidth;
  heart.classList.add("beat");
  beatLabel.textContent = label;
}

function detectAudioBeat(recent) {
  // Educational energy detector only.
  if (recent.length < 320) return;

  const n = 320;
  const start = recent.length - n;

  let mean = 0;
  for (let i = start; i < recent.length; i++) mean += recent[i];
  mean /= n;

  let energy = 0;
  for (let i = start; i < recent.length; i++) {
    const x = recent[i] - mean;
    energy += x * x;
  }

  const rms = Math.sqrt(energy / n);

  if (rms > 120 && performance.now() - lastBeatMs > 350) {
    triggerBeat("Heart sound detected");
  }
}

function calculateChecksum(values) {
  let checksum = 0;

  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    checksum = (checksum + (value & 0xFF) + ((value >> 8) & 0xFF)) & 0xFF;
  }

  return checksum;
}

function parsePackets(buffer) {
  let offset = 0;

  while (buffer.length - offset >= 3) {
    let start = -1;

    for (let i = offset; i <= buffer.length - 3; i++) {
      if (
        buffer[i] === HEADER_1 &&
        buffer[i + 1] === HEADER_2 &&
        buffer[i + 2] === PACKET_SAMPLES
      ) {
        start = i;
        break;
      }
    }

    if (start < 0) {
      // Keep only a possible partial header.
      return buffer.slice(Math.max(0, buffer.length - 2));
    }

    if (buffer.length - start < PACKET_SIZE) {
      return buffer.slice(start);
    }

    const flags = buffer[start + 3];
    const values = new Uint16Array(PACKET_SAMPLES);

    for (let i = 0; i < PACKET_SAMPLES; i++) {
      const p = start + HEADER_SIZE + i * 2;
      values[i] = buffer[p] | (buffer[p + 1] << 8);
    }

    const checksumPosition = start + HEADER_SIZE + DATA_SIZE;
    const receivedChecksum = buffer[checksumPosition];
    const calculatedChecksum = calculateChecksum(values);

    if (receivedChecksum === calculatedChecksum) {
      pushPacket(values);
      packetsReceived++;
      lastPacketTime = performance.now();

      if (flags & 0x01) {
        triggerBeat("Digital beat detected");
      }

      // Use the newest samples for the educational sound detector.
      detectAudioBeat(getRecentSamples(320));
    } else {
      badPackets++;
    }

    offset = start + PACKET_SIZE;
  }

  return buffer.slice(offset);
}

function draw() {
  if (!canvasReady) resizeAll();

  const W = waveCanvas.clientWidth;
  const H = waveCanvas.clientHeight;

  wctx.clearRect(0, 0, W, H);

  // Grid
  wctx.strokeStyle = "#16303c";
  wctx.lineWidth = 1;

  for (let y = 0; y <= H; y += H / 4) {
    wctx.beginPath();
    wctx.moveTo(0, y);
    wctx.lineTo(W, y);
    wctx.stroke();
  }

  const recent = getRecentSamples();

  let min = ADC_MAX;
  let max = 0;

  for (let i = 0; i < recent.length; i++) {
    const v = recent[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }

  // Keep a visible waveform even when the sensor is almost flat.
  const centre = (min + max) / 2;
  const span = Math.max(80, max - min);

  wctx.strokeStyle = "#48d7c2";
  wctx.lineWidth = 2;
  wctx.beginPath();

  if (recent.length > 1) {
    for (let i = 0; i < recent.length; i++) {
      const x = (i / (recent.length - 1)) * W;
      const y = H / 2 - ((recent[i] - centre) / span) * H * 0.82;

      if (i === 0) wctx.moveTo(x, y);
      else wctx.lineTo(x, y);
    }
  }

  wctx.stroke();

  // Continuous RMS/intensity from the actual incoming ADC signal.
  let sum = 0;

  for (let i = 0; i < recent.length; i++) {
    const x = recent[i] - centre;
    sum += x * x;
  }

  const rms = recent.length ? Math.sqrt(sum / recent.length) : 0;
  const intensity = Math.min(100, Math.round((rms / 700) * 100));

  intensityEl.textContent = intensity;
  meter.style.width = intensity + "%";

  // Energy bars from the same real ADC data.
  const EW = energyCanvas.clientWidth;
  const EH = energyCanvas.clientHeight;

  ectx.clearRect(0, 0, EW, EH);

  const bars = 50;

  for (let i = 0; i < bars; i++) {
    const a = Math.floor((i / bars) * recent.length);
    const b = Math.max(a + 1, Math.floor(((i + 1) / bars) * recent.length));
    let energy = 0;

    for (let j = a; j < b && j < recent.length; j++) {
      energy += Math.abs(recent[j] - centre);
    }

    const average = energy / Math.max(1, b - a);
    const h = Math.min(EH * 0.9, average * 1.3);

    ectx.fillStyle = i % 2 ? "#48d7c2" : "#62a9ff";
    ectx.fillRect(i * (EW / bars) + 2, EH - h, EW / bars - 4, h);
  }

  // Continuous status.
  if (serialConnected && performance.now() - lastPacketTime > 1500) {
    setStatus("● ESP32 connected — waiting for data", false);
  } else if (serialConnected) {
    setStatus(
      "● ESP32 LIVE • " +
      packetsReceived +
      " packets • " +
      bytesReceived +
      " bytes",
      true
    );
  }

  requestAnimationFrame(draw);
}

async function connectSerial() {
  if (!window.isSecureContext) {
    alert("Open the GitHub Pages HTTPS address or http://localhost. Web Serial cannot run on an insecure page.");
    return;
  }

  if (!("serial" in navigator)) {
    alert("Web Serial requires current Chrome or Edge on a desktop/laptop.");
    return;
  }

  if (serialConnected) {
    await disconnectSerial();
    return;
  }

  try {
    connectBtn.disabled = true;
    setStatus("● Select the ESP32 COM port…");
    beatLabel.textContent = "Choose the USB serial port";

    serialPort = await navigator.serial.requestPort();

    setStatus("● Opening USB serial at 921600…");

    await serialPort.open({
      baudRate: 921600,
      dataBits: 8,
      stopBits: 1,
      parity: "none",
      flowControl: "none",
      bufferSize: 4096
    });

    serialConnected = true;
    bytesReceived = 0;
    packetsReceived = 0;
    badPackets = 0;
    lastPacketTime = performance.now();

    connectBtn.textContent = "Disconnect ESP32";
    setStatus("● ESP32 LIVE — receiving data", true);
    beatLabel.textContent = "Continuous PCG data";

    serialReader = serialPort.readable.getReader();

    let buffer = new Uint8Array(0);

    while (serialConnected) {
      const result = await serialReader.read();

      if (result.done) break;
      if (!result.value || result.value.length === 0) continue;

      bytesReceived += result.value.length;

      const combined = new Uint8Array(buffer.length + result.value.length);
      combined.set(buffer);
      combined.set(result.value, buffer.length);

      buffer = parsePackets(combined);
    }
  } catch (error) {
    console.error(error);

    let message = "Connection failed.";

    if (error?.name === "NotFoundError") {
      message = "No COM port selected.";
    } else if (error?.name === "NetworkError") {
      message = "COM port is busy. Close Arduino Serial Monitor/Plotter.";
    } else if (error?.name === "InvalidStateError") {
      message = "Serial port is already open. Close other serial software.";
    } else if (error?.message) {
      message = error.message;
    }

    setStatus("● " + message);
    beatLabel.textContent = message;

    serialConnected = false;
    connectBtn.textContent = "Connect ESP32";

    if (serialPort) {
      try { await serialPort.close(); } catch (_) {}
    }

    serialPort = null;
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
    audioGain.gain.value = Number(volumeEl.value) * 0.55;

    audioDestination = audioCtx.createMediaStreamDestination();

    // Broad desktop-browser compatibility.
    scriptNode = audioCtx.createScriptProcessor(1024, 1, 1);

    scriptNode.onaudioprocess = event => {
      const output = event.outputBuffer.getChannelData(0);
      const browserRate = audioCtx.sampleRate;

      // Persistent resampling state is not needed for the graph; audio is
      // continuously drained from the ring buffer at the browser sample rate.
      let sourcePosition = 0;
      const inputStep = SAMPLE_RATE / browserRate;

      for (let i = 0; i < output.length; i++) {
        if (audioCount < 2) {
          output[i] = 0;
          continue;
        }

        const base = Math.floor(sourcePosition);
        const index = (audioRead + base) % AUDIO_BUFFER;
        const next = (index + 1) % AUDIO_BUFFER;
        const frac = sourcePosition - base;

        output[i] =
          audioQueue[index] +
          (audioQueue[next] - audioQueue[index]) * frac;

        sourcePosition += inputStep;

        const consumed = Math.floor(sourcePosition);

        if (consumed > 0) {
          audioRead = (audioRead + consumed) % AUDIO_BUFFER;
          audioCount = Math.max(0, audioCount - consumed);
          sourcePosition -= consumed;
        }
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
    audioCount = 0;
    audioRead = 0;
    audioWrite = 0;
    audioBtn.textContent = "Hear Heart Sound";
    beatLabel.textContent = serialConnected
      ? "Receiving continuous PCG data"
      : "Audio stopped";
  } else {
    audioBtn.textContent = "Stop Heart Sound";
    beatLabel.textContent = serialConnected
      ? "Listening to continuous live PCG"
      : "Connect ESP32 for live sound";
  }
}

function startDemo() {
  demo = !demo;

  if (demo) {
    demoBtn.textContent = "Stop Demo";
    setStatus("● Demo signal");
    beatLabel.textContent = "Simulated continuous PCG";

    let phase = 0;

    demoTimer = setInterval(() => {
      phase = (phase + 12) % 900;

      let pulse = 0;

      if (phase < 70) {
        pulse = 900 * Math.sin(Math.PI * phase / 70);
      } else if (phase > 160 && phase < 220) {
        pulse = 600 * Math.sin(Math.PI * (phase - 160) / 60);
      }

      pushSample(2048 + pulse + (Math.random() - 0.5) * 60);

      if (phase < 15) triggerBeat("Demo heartbeat");
    }, 12);
  } else {
    clearInterval(demoTimer);
    demoTimer = null;
    demoBtn.textContent = "Demo Signal";
    setStatus(serialConnected ? "● ESP32 LIVE" : "● Standby", serialConnected);
    beatLabel.textContent = serialConnected
      ? "Continuous PCG data"
      : "Waiting for signal";
  }
}

function startRecording() {
  if (!audioDestination) {
    alert("Click 'Hear Heart Sound' first.");
    return;
  }

  if (!window.MediaRecorder) {
    alert("Recording is not supported by this browser.");
    return;
  }

  const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
    ? "audio/webm;codecs=opus"
    : "audio/webm";

  try {
    recorder = new MediaRecorder(audioDestination.stream, { mimeType: mime });
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
    a.click();

    setTimeout(() => URL.revokeObjectURL(url), 1000);
    beatLabel.textContent = "Recording saved";
  };

  recorder.start();
  recording = true;
  recordBtn.textContent = "Stop & Save";
  beatLabel.textContent = "Recording continuous live PCG";
}

function stopRecording() {
  if (recorder && recorder.state !== "inactive") recorder.stop();

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
  if (audioGain) audioGain.gain.value = Number(volumeEl.value) * 0.55;
});

window.addEventListener("resize", resizeAll);

if ("serial" in navigator) {
  navigator.serial.addEventListener("disconnect", event => {
    if (serialPort && event.target === serialPort) {
      disconnectSerial();
    }
  });
}

resizeAll();
draw();
