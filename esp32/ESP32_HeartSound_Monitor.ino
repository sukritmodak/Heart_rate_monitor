#include <Arduino.h>
#include "BluetoothSerial.h"

BluetoothSerial SerialBT;

#define ANALOG_PIN 34
#define DIGITAL_PIN 27
#define BEAT_STATE LOW

#define SAMPLE_RATE 4000
#define PACKET_SAMPLES 128
#define SERIAL_BAUD 115200

void sendAudioPacket() {
  uint8_t samples[PACKET_SAMPLES];
  uint8_t checksum = 0;

  for (int i = 0; i < PACKET_SAMPLES; i++) {
    uint16_t raw = analogRead(ANALOG_PIN);
    samples[i] = raw >> 4;
    checksum = (uint8_t)(checksum + samples[i]);
    delayMicroseconds(1000000UL / SAMPLE_RATE);
  }

  Serial.write(0xA5);
  Serial.write(0x5A);
  Serial.write(PACKET_SAMPLES);
  Serial.write(samples, PACKET_SAMPLES);
  Serial.write(checksum);
}

void setup() {
  Serial.begin(SERIAL_BAUD);
  pinMode(ANALOG_PIN, INPUT);
  pinMode(DIGITAL_PIN, INPUT_PULLUP);

  SerialBT.begin("HeartSound-ESP32");
}

void loop() {
  sendAudioPacket();

  static bool lastState = HIGH;
  bool state = digitalRead(DIGITAL_PIN);

  if (state != lastState) {
    if (state == BEAT_STATE) {
      SerialBT.println("Heartbeat detected");
    }
    lastState = state;
  }
}
