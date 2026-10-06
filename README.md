# HeartSound Monitor

ESP32 + browser phonocardiogram (PCG) monitoring prototype.

## What it does

- Live ESP32 ADC waveform in the browser
- Heart-sound intensity meter
- Animated heart and browser BPM estimate
- Live heart-sound audio from the ESP32 samples
- Recording to a WebM audio file
- Demo PCG signal when hardware is not connected
- USB serial communication at 115200 baud
- Browser dashboard designed for desktop Chrome/Edge

## Hardware

- ESP32
- Heart-sound / stethoscope microphone or analog PCG sensor connected to **GPIO 34**
- Optional digital beat/comparator output connected to **GPIO 27**
- USB cable to the computer

## Run the website

The website files are in `web/`.

### Option 1 — GitHub Pages

This repository includes a GitHub Actions workflow at:

`.github/workflows/pages.yml`

In GitHub, open **Settings → Pages** and select **GitHub Actions** as the deployment source. After the workflow completes, GitHub will show the published Pages address.

### Option 2 — Local computer

From the repository folder:

```bash
cd web
python -m http.server 8000
```

Then open `http://localhost:8000` in Chrome or Edge.

Do not simply double-click `index.html` when testing Web Serial; use HTTPS or localhost.

## Connect the ESP32

1. Upload `esp32/ESP32_HeartSound_Monitor.ino` using Arduino IDE.
2. Select the correct ESP32 board and COM port.
3. Open the website in Chrome or Edge on a desktop/laptop.
4. Click **Connect ESP32**.
5. Select the ESP32 USB serial port.
6. Click **Hear Heart Sound**.
7. You should see the live PCG waveform and hear the incoming ADC signal.
8. Click **Record** to save the browser audio.

The firmware sends binary packets:

`A5 5A | 128 | flags | 128 samples | checksum`

- Sample rate: 4 kHz
- ADC: 12-bit internally, transmitted as 8-bit samples
- Packet size: 133 bytes
- Baud rate: 115200
- Flags bit 0: digital beat state

## Important

The browser cannot directly access ESP32 Bluetooth Classic SPP through normal Web Bluetooth. The current reliable website connection is **USB Web Serial**.

The audio is the actual ADC stream received from the ESP32; it is no longer a synthetic oscillator.

S1/S2 event labels are intentionally not claimed as clinical measurements. Reliable S1/S2 separation requires validated signal processing and sensor calibration.

This is an educational engineering prototype and **not a medical diagnostic device**.
