#include <Arduino.h>
#include "BluetoothSerial.h"

BluetoothSerial SerialBT;

// =========================
// ESP32 PINS
// =========================
#define ANALOG_PIN 34
#define DIGITAL_PIN 27
#define BEAT_STATE LOW

// =========================
// ACQUISITION
// =========================
#define SAMPLE_RATE 4000
#define PACKET_SAMPLES 128
#define SERIAL_BAUD 115200

// Browser packet:
// A5 5A | length(128) | flags | 128 samples | checksum
// Total = 133 bytes
#define PACKET_SIZE 133

void setup() {
  Serial.begin(SERIAL_BAUD);

  pinMode(ANALOG_PIN, INPUT);
  pinMode(DIGITAL_PIN, INPUT_PULLUP);

  // Bluetooth Classic is kept for future/native-app use.
  SerialBT.begin("HeartSound-ESP32");

  analogReadResolution(12);  // 0-4095
}

void sendAudioPacket() {
  uint8_t samples[PACKET_SAMPLES];
  uint8_t checksum = 0;
  uint8_t flags = 0;

  const uint32_t samplePeriodUs = 1000000UL / SAMPLE_RATE;
  uint32_t nextSample = micros();

  for (int i = 0; i < PACKET_SAMPLES; i++) {
    while ((int32_t)(micros() - nextSample) < 0) {
      // precise 4 kHz pacing
    }

    uint16_t raw = analogRead(ANALOG_PIN);

    // Convert 12-bit ADC to 8-bit PCG sample.
    samples[i] = (uint8_t)(raw >> 4);
    checksum = (uint8_t)(checksum + samples[i]);

    // Digital comparator/beat input.
    if (digitalRead(DIGITAL_PIN) == BEAT_STATE) {
      flags |= 0x01;
    }

    nextSample += samplePeriodUs;
  }

  Serial.write(0xA5);
  Serial.write(0x5A);
  Serial.write(PACKET_SAMPLES);
  Serial.write(flags);
  Serial.write(samples, PACKET_SAMPLES);
  Serial.write(checksum);
}

void loop() {
  sendAudioPacket();

  // Optional Bluetooth text feedback.
  static bool lastState = HIGH;
  bool state = digitalRead(DIGITAL_PIN);

  if (state != lastState) {
    if (state == BEAT_STATE) {
      SerialBT.println("Heartbeat detected");
    }
    lastState = state;
  }
}
