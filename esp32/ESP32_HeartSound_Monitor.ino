#include <Arduino.h>
#include "BluetoothSerial.h"

BluetoothSerial SerialBT;

// ============================================================
// ESP32 HEART SOUND MONITOR
// Continuous 12-bit PCG stream over USB Serial.
//
// Packet:
// A5 5A | 0x80 | flags | 128 x uint16 ADC values | checksum
// Total = 261 bytes
//
// Each ADC value is little-endian, range 0..4095.
// Checksum = sum of all 256 ADC data bytes modulo 256.
// flags bit 0 = one-shot digital beat edge.
// ============================================================

#define ANALOG_PIN 34
#define DIGITAL_PIN 27
#define BEAT_STATE LOW

#define SAMPLE_RATE 4000UL
#define PACKET_SAMPLES 128
#define SERIAL_BAUD 115200

#define HEADER_1 0xA5
#define HEADER_2 0x5A

bool lastDigitalState = HIGH;

void setup() {
  Serial.begin(SERIAL_BAUD);

  pinMode(ANALOG_PIN, INPUT);
  pinMode(DIGITAL_PIN, INPUT_PULLUP);

  // Bluetooth is retained for future native-app use.
  // Browser uses USB Serial.
  SerialBT.begin("HeartSound-ESP32");

  analogReadResolution(12);
  analogSetPinAttenuation(ANALOG_PIN, ADC_11db);

  lastDigitalState = digitalRead(DIGITAL_PIN);
}

void sendAudioPacket() {
  uint16_t samples[PACKET_SAMPLES];
  uint8_t checksum = 0;
  uint8_t flags = 0;

  const uint32_t samplePeriodUs = 1000000UL / SAMPLE_RATE;
  uint32_t nextSample = micros();

  for (uint16_t i = 0; i < PACKET_SAMPLES; i++) {
    while ((int32_t)(micros() - nextSample) < 0) {
      // Exact 4 kHz sample pacing.
    }

    const uint16_t raw = analogRead(ANALOG_PIN) & 0x0FFF;
    samples[i] = raw;

    // Checksum covers both bytes of every 12-bit sample.
    checksum = (uint8_t)(checksum + (raw & 0xFF));
    checksum = (uint8_t)(checksum + ((raw >> 8) & 0xFF));

    // One event for a HIGH -> LOW transition.
    const bool state = digitalRead(DIGITAL_PIN);

    if (lastDigitalState != BEAT_STATE && state == BEAT_STATE) {
      flags |= 0x01;
    }

    lastDigitalState = state;
    nextSample += samplePeriodUs;
  }

  // Binary USB packet only. Never print text to Serial.
  Serial.write(HEADER_1);
  Serial.write(HEADER_2);
  Serial.write((uint8_t)PACKET_SAMPLES);
  Serial.write(flags);

  for (uint16_t i = 0; i < PACKET_SAMPLES; i++) {
    Serial.write((uint8_t)(samples[i] & 0xFF));
    Serial.write((uint8_t)((samples[i] >> 8) & 0x0F));
  }

  Serial.write(checksum);
}

void loop() {
  sendAudioPacket();

  // Optional Bluetooth feedback only.
  static bool lastBtState = HIGH;
  const bool state = digitalRead(DIGITAL_PIN);

  if (state != lastBtState) {
    if (state == BEAT_STATE) {
      SerialBT.println("Heartbeat detected");
    }
    lastBtState = state;
  }
}
