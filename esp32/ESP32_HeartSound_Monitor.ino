#include <Arduino.h>

// ============================================================
// ESP32 HEART SOUND MONITOR
// Continuous 12-bit analog PCG stream over USB Serial.
//
// USB packet:
// A5 5A | 0x80 | flags | 128 x uint16 ADC values | checksum
// Total packet size = 261 bytes.
//
// GPIO34 = analog PCG input
// GPIO27 = optional digital beat/comparator input
//
// IMPORTANT: USB Serial contains binary packets only.
// Do NOT add Serial.println() debugging text.
// ============================================================

#define ANALOG_PIN 34
#define DIGITAL_PIN 27
#define BEAT_STATE LOW

#define SAMPLE_RATE 4000UL
#define PACKET_SAMPLES 128
#define SERIAL_BAUD 921600UL

#define HEADER_1 0xA5
#define HEADER_2 0x5A

// Large sample FIFO decouples ADC sampling from USB transmission.
#define FIFO_SIZE 4096

volatile uint16_t sampleFifo[FIFO_SIZE];
volatile uint16_t fifoHead = 0;
volatile uint16_t fifoTail = 0;
volatile bool beatPending = false;

bool lastDigitalState = HIGH;

portMUX_TYPE fifoMux = portMUX_INITIALIZER_UNLOCKED;

bool fifoPush(uint16_t value) {
  bool ok = false;

  portENTER_CRITICAL(&fifoMux);

  const uint16_t next = (uint16_t)((fifoHead + 1) % FIFO_SIZE);

  if (next != fifoTail) {
    sampleFifo[fifoHead] = value;
    fifoHead = next;
    ok = true;
  }

  portEXIT_CRITICAL(&fifoMux);

  return ok;
}

bool fifoPop(uint16_t &value) {
  bool ok = false;

  portENTER_CRITICAL(&fifoMux);

  if (fifoTail != fifoHead) {
    value = sampleFifo[fifoTail];
    fifoTail = (uint16_t)((fifoTail + 1) % FIFO_SIZE);
    ok = true;
  }

  portEXIT_CRITICAL(&fifoMux);

  return ok;
}

void sampleTask(void *parameter) {
  const uint32_t periodUs = 1000000UL / SAMPLE_RATE;
  uint32_t nextSample = micros();

  while (true) {
    while ((int32_t)(micros() - nextSample) < 0) {
      // Keep the sampling clock independent from USB transmission.
    }

    nextSample += periodUs;

    const uint16_t raw = (uint16_t)(analogRead(ANALOG_PIN) & 0x0FFF);
    fifoPush(raw);

    const bool state = digitalRead(DIGITAL_PIN);

    // Store a single rising/falling edge event for the browser.
    if (lastDigitalState != BEAT_STATE && state == BEAT_STATE) {
      beatPending = true;
    }

    lastDigitalState = state;
  }
}

void sendPacket() {
  uint16_t samples[PACKET_SAMPLES];
  uint8_t checksum = 0;
  uint8_t flags = 0;

  for (uint16_t i = 0; i < PACKET_SAMPLES; i++) {
    uint16_t value;

    // Wait only if the FIFO temporarily has no sample.
    while (!fifoPop(value)) {
      taskYIELD();
    }

    samples[i] = value;

    checksum = (uint8_t)(
      checksum +
      (uint8_t)(value & 0xFF) +
      (uint8_t)((value >> 8) & 0xFF)
    );
  }

  if (beatPending) {
    flags |= 0x01;
    beatPending = false;
  }

  // Binary packet only.
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

void setup() {
  Serial.begin(SERIAL_BAUD);

  pinMode(ANALOG_PIN, INPUT);
  pinMode(DIGITAL_PIN, INPUT_PULLUP);

  analogReadResolution(12);
  analogSetPinAttenuation(ANALOG_PIN, ADC_11db);

  lastDigitalState = digitalRead(DIGITAL_PIN);

  // Sampling runs independently from the USB sender.
  xTaskCreatePinnedToCore(
    sampleTask,
    "ADC_Sampler",
    4096,
    nullptr,
    3,
    nullptr,
    0
  );
}

void loop() {
  // USB transmission is decoupled from the 4 kHz ADC sampler.
  sendPacket();
}
