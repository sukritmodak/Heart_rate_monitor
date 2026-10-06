# HeartSound Monitor

A browser-based phonocardiogram (PCG) monitor for an ESP32 heart-sound sensor.

## Features

- Animated heart visualization
- Live heart-sound waveform
- Relative sound-intensity meter
- S1/S2 event display
- BPM display
- Demo mode for testing without hardware
- Web Serial support for the ESP32 USB serial stream
- Responsive biomedical-style interface

## Repository structure

```
Heart_rate_monitor/
├── README.md
├── esp32/
│   └── ESP32_HeartSound_Monitor.ino
└── web/
    ├── index.html
    ├── style.css
    └── app.js
```

## ESP32 serial protocol

The web application expects 115200 baud and binary packets:

```
A5 5A 80 [128 samples] [checksum]
```

Each sample is the ESP32 ADC value reduced to 8 bits. The checksum is the sum of the 128 sample bytes modulo 256.

## Run the web application

Open `web/index.html` in Chrome or Edge.

For live ESP32 serial access, use a desktop browser that supports Web Serial and select the ESP32 serial port.

Click **Demo Signal** to test the visualization without hardware.

## Important

This project is an engineering/educational monitoring interface. It is not a medical diagnostic device and should not be used to diagnose or treat a patient.
