#include <Arduino.h>
#include "BluetoothSerial.h"

BluetoothSerial SerialBT;

// ============================================================
// ESP32 HEART SOUND MONITOR
// USB Serial -> browser Web Serial
//
// Packet:
// A5 5A | 0x80 | flags | 128 samples | checksum
// Total = 133 bytes
//
// flags bit 0 = ONE-SHOT digital beat event.
// ============================================================

// -------------------------
// PINS
// -------------------------
#define ANALOG_PIN 34
#define DIGITAL_PIN 27
#define BEAT_STATE LOW

// -------------------------
// SERIAL / ACQUISITION
// -------------------------
#define SAMPLE_RATE 4000UL
#define PACKET_SAMPLES 128
#define SERIAL_BAUD 115200

#define HEADER_1 0xA5
#define HEADER_2 0x5A

// -------------------------
// DIGITAL BEAT EDGE STATE
// -------------------------
bool lastDigitalState = HIGH;

// -------------------------
// SETUP
// -------------------------
void setup() {
  Serial.begin(SERIAL_BAUD);

  pinMode(ANALOG_PIN, INPUT);
  pinMode(DIGITAL_PIN, INPUT_PULLUP);

  // Kept for future/native Bluetooth applications.
  // The browser connects through USB Serial, not Bluetooth Classic.
  SerialBT.begin("HeartSound-ESP32");

  analogReadResolution(12);
  analogSetPinAttenuation(ANALOG_PIN, ADC_11db);

  lastDigitalState = digitalRead(DIGITAL_PIN);
}

// -------------------------
// SEND ONE 128-SAMPLE PACKET
// -------------------------
void sendAudioPacket() {
  uint8_t samples[PACKET_SAMPLES];
  uint8_t checksum = 0;
  uint8_t flags = 0;

  const uint32_t samplePeriodUs = 1000000UL / SAMPLE_RATE;
  uint32_t nextSample = micros();

  for (uint16_t i = 0; i < PACKET_SAMPLES; i++) {
    while ((int32_t)(micros() - nextSample) < 0) {
      // Wait for the exact sample time.
    }

    const uint16_t raw = analogRead(ANALOG_PIN);
    const uint8_t sample = (uint8_t)(raw >> 4);

    samples[i] = sample;
    checksum = (uint8_t)(checksum + sample);

    // Detect a HIGH->BEAT_STATE transition only.
    // This prevents one long digital pulse from generating
    // dozens of heartbeat events.
    const bool state = digitalRead(DIGITAL_PIN);

    if (lastDigitalState != BEAT_STATE && state == BEAT_STATE) {
      flags |= 0x01;
    }

    lastDigitalState = state;
    nextSample += samplePeriodUs;
  }

  // Send only binary packet data to USB Serial.
  // Do NOT use Serial.println() here because it would corrupt
  // the browser packet stream.
  Serial.write(HEADER_1);
  Serial.write(HEADER_2);
  Serial.write((uint8_t)PACKET_SAMPLES);
  Serial.write(flags);
  Serial.write(samples, PACKET_SAMPLES);
  Serial.write(checksum);
}

// -------------------------
// LOOP
// -------------------------
void loop() {
  sendAudioPacket();

  // Optional Bluetooth text feedback.
  // This does not affect the USB packet stream.
  static bool lastBtState = HIGH;
  const bool state = digitalRead(DIGITAL_PIN);

  if (state != lastBtState) {
    if (state == BEAT_STATE) {
      SerialBT.println("Heartbeat detected");
    }
    lastBtState = state;
  }
}
