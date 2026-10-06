# HeartSound Monitor

ESP32 + browser continuous analog phonocardiogram (PCG) monitoring prototype.

## Main function

The website continuously receives the **real analog ADC samples from ESP32 GPIO 34** and draws them as a live scrolling waveform.

Data path:

`Heart-sound sensor → ESP32 ADC GPIO34 → USB Serial → Browser → continuous waveform`

The graph does not wait for heartbeat detection. Every valid ADC sample is inserted into a circular recording buffer.

## Hardware

- ESP32
- Analog heart-sound / stethoscope / PCG sensor
- Analog sensor output → **GPIO 34**
- Optional digital comparator/beat output → **GPIO 27**
- USB data cable → computer

## ESP32 stream

- ADC resolution: 12-bit
- ADC range: 0–4095
- Sample rate: 4000 samples/second
- USB baud rate: 921600
- Packet: 261 bytes
- Packet format:

`A5 5A | 0x80 | flags | 128 × uint16 ADC samples | checksum`

The USB Serial stream contains **binary data only**. Do not add `Serial.println()` debugging text to the firmware because it would corrupt the waveform packets.

## Website

Use current desktop Chrome or Edge.

GitHub Pages provides HTTPS. For local testing:

```bash
cd web
python -m http.server 8000
```

Then open `http://localhost:8000`.

## Connection procedure

1. Upload `esp32/ESP32_HeartSound_Monitor.ino`.
2. Connect the ESP32 using a **data-capable USB cable**.
3. Close Arduino Serial Monitor and Serial Plotter.
4. Open the website in Chrome/Edge.
5. Click **Connect ESP32**.
6. Select the ESP32 COM port.
7. The **ADC value should continuously change** when the sensor signal changes.
8. The green PCG waveform should continuously scroll.
9. Click **Hear Heart Sound** for live audio.
10. Click **Record** to save the audio stream.

## Troubleshooting

### Graph is connected but does not move

Look at:

`ADC: xxxx / 4095 | 4 kHz`

- If the number changes continuously, the ESP32-to-browser data path is working and the graph should move.
- If the number stays exactly the same, the problem is before the graph: sensor output, wiring, power, ADC pin, or the sensor itself.
- GPIO 34 is input-only and is used as the analog input in this project.

### No COM port

- Use a USB **data** cable.
- Check Windows Device Manager.
- Install the correct USB-UART driver if required.
- Close Arduino Serial Monitor/Plotter and other serial programs.

### Browser cannot connect

Use desktop Chrome/Edge and an HTTPS GitHub Pages address or localhost. Web Serial is not provided by normal mobile browsers.

## Important

The live graph is an engineering visualization of the ADC signal. BPM/S1/S2 detection in this prototype is not clinically validated.

This project is **not a medical diagnostic device**.
