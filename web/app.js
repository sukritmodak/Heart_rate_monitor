/* HeartSound Monitor
   Continuous ESP32 PCG client.

   Packet format:
   A5 5A | 0x80 | flags | 128 x uint16 little-endian ADC values | checksum
   Total = 261 bytes
   ADC values: 0..4095
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

const samples = new Float32Array(1600);
samples.fill(2048);

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
const audioQueue = new Float32Array(SAMPLE_RATE * 3);
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

function pushSample(value) {
  if (adcValueEl) adcValueEl.textContent = Math.round(value);
  samples.copyWithin(0, 1);
  samples[samples.length - 1] = Math.max(0, Math.min(ADC_MAX, value));
}

function pushAudio(value) {
  if (!audioStarted) return;

  // Store centred, normalized ADC audio.
  const x = (value - 2048) / 2048;

  audioQueue[audioWrite] = x;
  audioWrite = (audioWrite + 1) % audioQueue.length;

  if (audioCount < audioQueue.length) {
    audioCount++;
  } else {
    audioRead = (audioRead + 1) % audioQueue.length;
  }
}

function pushPacket(packetSamples) {
  for (const value of packetSamples) {
    pushSample(value);
    pushAudio(value);
  }
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

function detectAudioBeat() {
  // Simple educational energy detector, not clinical S1/S2 detection.
  const n = 320;
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

  if (rms > 120 && performance.now() - lastBeatMs > 350) {
    triggerBeat("Heart sound detected");
  }
}

function calculateChecksum(values) {
  let checksum = 0;

  for (const value of values) {
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

      detectAudioBeat();
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
  wctx.strokeStyle = "#16303c";
  wctx.lineWidth = 1;

  for (let y = 0; y <= H; y += H / 4) {
    wctx.beginPath();
    wctx.moveTo(0, y);
    wctx.lineTo(W, y);
    wctx.stroke();
  }

  // Automatic vertical scaling around the current baseline.
  let min = ADC_MAX;
  let max = 0;

  for (const v of samples) {
    if (v < min) min = v;
    if (v > max) max = v;
  }

  const centre = (min + max) / 2;
  const span = Math.max(80, max - min);

  wctx.strokeStyle = "#48d7c2";
  wctx.lineWidth = 2;
  wctx.beginPath();

  for (let i = 0; i < samples.length; i++) {
    const x = (i / (samples.length - 1)) * W;
    const y = H / 2 - ((samples[i] - centre) / span) * H * 0.82;

    if (i === 0) wctx.moveTo(x, y);
    else wctx.lineTo(x, y);
  }

  wctx.stroke();

  // Continuous signal intensity.
  let sum = 0;
  for (const v of samples) {
    const x = v - centre;
    sum += x * x;
  }

  const rms = Math.sqrt(sum / samples.length);
  const intensity = Math.min(100, Math.round((rms / 700) * 100));

  intensityEl.textContent = intensity;
  meter.style.width = intensity + "%";

  // Energy bars.
  const EW = energyCanvas.clientWidth;
  const EH = energyCanvas.clientHeight;
  ectx.clearRect(0, 0, EW, EH);

  const bars = 50;

  for (let i = 0; i < bars; i++) {
    const a = Math.floor((i / bars) * samples.length);
    const b = Math.max(a + 1, Math.floor(((i + 1) / bars) * samples.length));
    let energy = 0;

    for (let j = a; j < b; j++) {
      energy += Math.abs(samples[j] - centre);
    }

    const average = energy / (b - a);
    const h = Math.min(EH * 0.9, average * 1.3);

    ectx.fillStyle = i % 2 ? "#48d7c2" : "#62a9ff";
    ectx.fillRect(i * (EW / bars) + 2, EH - h, EW / bars - 4, h);
  }

  // Connection watchdog.
  if (serialConnected && performance.now() - lastPacketTime > 1500) {
    setStatus("● ESP32 connected — waiting for data", false);
  } else if (serialConnected) {
    setStatus(
      "● ESP32 LIVE • " + packetsReceived + " packets",
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

    setStatus("● Opening USB serial at 115200…");

    await serialPort.open({
      baudRate: 115200,
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

function queueAvailable() {
  return audioCount;
}

async function ensureAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();

    audioGain = audioCtx.createGain();
    audioGain.gain.value = Number(volumeEl.value) * 0.55;

    audioDestination = audioCtx.createMediaStreamDestination();

    // ScriptProcessor is used for broad browser compatibility.
    scriptNode = audioCtx.createScriptProcessor(1024, 1, 1);

    scriptNode.onaudioprocess = event => {
      const output = event.outputBuffer.getChannelData(0);
      const browserRate = audioCtx.sampleRate;
      const inputStep = SAMPLE_RATE / browserRate;

      let sourcePosition = 0;

      for (let i = 0; i < output.length; i++) {
        if (queueAvailable() < 2) {
          output[i] = 0;
          continue;
        }

        const baseIndex = Math.floor(sourcePosition);
        const index = (audioRead + baseIndex) % audioQueue.length;
        const next = (index + 1) % audioQueue.length;

        const frac = sourcePosition - baseIndex;
        output[i] =
          audioQueue[index] +
          (audioQueue[next] - audioQueue[index]) * frac;

        sourcePosition += inputStep;

        const consumed = Math.floor(sourcePosition);

        if (consumed > 0) {
          audioRead = (audioRead + consumed) % audioQueue.length;
          audioCount -= consumed;
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
