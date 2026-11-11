// AI-Thinker ESP32-CAM + OV2640. Captures JPEGs; decoding stays on the laptop.
#include <Arduino.h>
#include <WiFi.h>
#include <WebServer.h>
#include "esp_camera.h"
#include "esp_http_server.h"
#if __has_include("wifi_credentials.h")
#include "wifi_credentials.h"
#else
#include "wifi_credentials.example.h"
#endif

WebServer server(80);
bool cameraReady = false;
httpd_handle_t liveServer = nullptr;

esp_err_t liveStream(httpd_req_t* request) {
  httpd_resp_set_type(request, "multipart/x-mixed-replace;boundary=cartframe");
  httpd_resp_set_hdr(request, "Cache-Control", "no-store");
  Serial.printf("Live stream connected; Wi-Fi signal %d dBm\n", WiFi.RSSI());
  const char* boundary = "\r\n--cartframe\r\n";
  // Setting response headers does not transmit them. Send the opening boundary
  // immediately, before waiting for camera capture, so the HTTP client can connect.
  esp_err_t result = httpd_resp_send_chunk(request, boundary, strlen(boundary));
  if (result != ESP_OK) {
    Serial.printf("Live HTTP handshake FAILED: 0x%x\n", result);
    return result;
  }
  Serial.println("Live HTTP headers sent. Waiting for camera frame...");
  unsigned long frameNumber = 0;
  int64_t previousCaptureUs = 0;
  while (true) {
    const unsigned long captureStarted = millis();
    camera_fb_t* frame = esp_camera_fb_get();
    if (!frame) {
      Serial.printf("Live capture FAILED after %lu ms. Check power and camera ribbon.\n", millis() - captureStarted);
      return ESP_FAIL;
    }
    const unsigned long captureMs = millis() - captureStarted;
    const int64_t captureUs = int64_t(frame->timestamp.tv_sec) * 1000000LL + frame->timestamp.tv_usec;
    const long sourceIntervalMs = previousCaptureUs ? long((captureUs - previousCaptureUs) / 1000) : 0;
    previousCaptureUs = captureUs;
    const size_t jpegBytes = frame->len;
    ++frameNumber;
    if (frameNumber <= 3) Serial.printf("Live frame %lu ready: %u bytes, capture %lu ms. Sending...\n", frameNumber, unsigned(jpegBytes), captureMs);
    char header[96];
    int length = snprintf(header, sizeof(header), "Content-Type: image/jpeg\r\nContent-Length: %u\r\n\r\n", unsigned(jpegBytes));
    const unsigned long sendStarted = millis();
    result = httpd_resp_send_chunk(request, header, length);
    size_t sent = 0;
    while (result == ESP_OK && sent < jpegBytes) {
      const size_t count = min(size_t(4096), jpegBytes - sent);
      result = httpd_resp_send_chunk(request, reinterpret_cast<const char*>(frame->buf + sent), count);
      if (result == ESP_OK) sent += count;
      delay(0);
    }
    esp_camera_fb_return(frame);
    if (result == ESP_OK) result = httpd_resp_send_chunk(request, boundary, strlen(boundary));
    if (result != ESP_OK) {
      Serial.printf("Live transfer FAILED on frame %lu: sent %u/%u bytes in %lu ms, error 0x%x. Client may have disconnected.\n", frameNumber, unsigned(sent), unsigned(jpegBytes), millis() - sendStarted, result);
      return result;
    }
    if (frameNumber <= 3 || frameNumber % 30 == 0) Serial.printf("Live frame %lu sent: %u bytes, capture wait %lu ms, delivered-frame interval %ld ms, transfer %lu ms, Wi-Fi %d dBm\n", frameNumber, unsigned(jpegBytes), captureMs, sourceIntervalMs, millis() - sendStarted, WiFi.RSSI());
    vTaskDelay(pdMS_TO_TICKS(30));
  }
}

bool startLiveServer() {
  httpd_config_t config = HTTPD_DEFAULT_CONFIG();
  config.server_port = 81;
  config.ctrl_port = 32769;
  config.stack_size = 8192;
  config.send_wait_timeout = 5;
  config.lru_purge_enable = true;
  if (httpd_start(&liveServer, &config) != ESP_OK) return false;
  httpd_uri_t uri = {};
  uri.uri = "/stream";
  uri.method = HTTP_GET;
  uri.handler = liveStream;
  return httpd_register_uri_handler(liveServer, &uri) == ESP_OK;
}

void capture() {
  const unsigned long requestStarted = millis();
  Serial.printf("Capture requested. Wi-Fi signal: %d dBm\n", WiFi.RSSI());
  if (!cameraReady) {
    server.send(503, "text/plain", "Camera is not initialized. Check Serial Monitor.");
    return;
  }
  camera_fb_t* frame = esp_camera_fb_get();
  if (!frame) {
    Serial.printf("Capture FAILED after %lu ms\n", millis() - requestStarted);
    server.send(503, "text/plain", "Capture failed. Check power and camera cable.");
    return;
  }
  Serial.printf("JPEG ready: %u bytes in %lu ms. Sending...\n", unsigned(frame->len), millis() - requestStarted);
  server.sendHeader("Cache-Control", "no-store");
  server.setContentLength(frame->len);
  server.send(200, "image/jpeg", "");
  WiFiClient client = server.client();
  size_t offset = 0;
  unsigned long started = millis();
  while (offset < frame->len && client.connected() && millis() - started < 5000) {
    size_t count = client.write(frame->buf + offset, min(size_t(4096), frame->len - offset));
    if (!count) break;
    offset += count;
    delay(0);
  }
  if (offset != frame->len) client.stop();
  Serial.printf("Capture %s: sent %u/%u bytes; total %lu ms\n", offset == frame->len ? "complete" : "INCOMPLETE", unsigned(offset), unsigned(frame->len), millis() - requestStarted);
  esp_camera_fb_return(frame);
}

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("\nShopping Cart Camera / AI-Thinker OV2640");
  pinMode(4, OUTPUT);
  digitalWrite(4, LOW);  // Leave the bright flash off during initial testing.

  camera_config_t config = {};
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer = LEDC_TIMER_0;
  // Pin assignments from Espressif's AI-Thinker CameraWebServer example.
  config.pin_d0 = 5;
  config.pin_d1 = 18;
  config.pin_d2 = 19;
  config.pin_d3 = 21;
  config.pin_d4 = 36;
  config.pin_d5 = 39;
  config.pin_d6 = 34;
  config.pin_d7 = 35;
  config.pin_xclk = 0;
  config.pin_pclk = 22;
  config.pin_vsync = 25;
  config.pin_href = 23;
  config.pin_sccb_sda = 26;
  config.pin_sccb_scl = 27;
  config.pin_pwdn = 32;
  config.pin_reset = -1;
  config.xclk_freq_hz = 20000000;
  config.pixel_format = PIXFORMAT_JPEG;
  config.frame_size = FRAMESIZE_VGA;  // 640x480 baseline: reduce live transfer load.
  config.jpeg_quality = 12;
  config.fb_count = psramFound() ? 2 : 1;
  config.fb_location = psramFound() ? CAMERA_FB_IN_PSRAM : CAMERA_FB_IN_DRAM;
  config.grab_mode = psramFound() ? CAMERA_GRAB_LATEST : CAMERA_GRAB_WHEN_EMPTY;
  esp_err_t result = esp_camera_init(&config);
  if (result != ESP_OK) {
    Serial.printf("Camera initialization FAILED: 0x%x. Check board model, ribbon, and power.\n", result);
    return;
  }
  cameraReady = true;
  Serial.printf("Camera initialized. PSRAM: %s\n", psramFound() ? "detected" : "not detected");

  if (String(WIFI_SSID) == "YOUR_WIFI_NAME") {
    Serial.println("Create wifi_credentials.h from the example and fill in your Wi-Fi credentials, then upload again.");
    return;
  }
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("Connecting to 2.4 GHz Wi-Fi");
  unsigned long started = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - started < 30000) {
    delay(500);
    Serial.print('.');
  }
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("\nWi-Fi connection failed. Check credentials and 2.4 GHz support, then reset the camera board.");
    return;
  }
  server.on("/capture", HTTP_GET, capture);
  server.on("/control", HTTP_GET, []() {
    sensor_t* sensor = esp_camera_sensor_get();
    String profile = server.arg("profile");
    if (!sensor || (profile != "auto" && profile != "fast")) {
      server.send(400, "application/json", "{\"error\":\"Select auto or fast exposure.\"}");
      return;
    }
    int result = 0;
    if (profile == "fast") {
      result |= sensor->set_aec2(sensor, 0);
      result |= sensor->set_exposure_ctrl(sensor, 0);
      result |= sensor->set_aec_value(sensor, 300); // Sensor setting, not milliseconds.
      result |= sensor->set_gain_ctrl(sensor, 1);
    } else {
      result |= sensor->set_exposure_ctrl(sensor, 1);
      result |= sensor->set_gain_ctrl(sensor, 1);
    }
    if (result != 0) {
      server.send(500, "application/json", "{\"error\":\"Sensor rejected exposure setting.\"}");
      return;
    }
    Serial.printf("Camera exposure profile: %s\n", profile.c_str());
    server.send(200, "application/json", profile == "fast" ? "{\"message\":\"Fixed exposure applied. Add light if the barcode looks dark.\"}" : "{\"message\":\"Automatic exposure restored.\"}");
  });
  server.on("/", HTTP_GET, []() {
    server.sendHeader("Cache-Control", "no-store");
    server.send(200, "text/html", R"HTML(<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Shopping Cart Live Camera</title><style>body{font:18px system-ui;max-width:900px;margin:24px auto;padding:16px}img{max-width:100%;height:auto}</style><h1>ESP32-CAM live video</h1><p>Use the laptop shopping-cart dashboard to scan barcodes from this stream. Close this tab before starting the dashboard camera: use one stream viewer at a time.</p><img id="live" alt="ESP32 live camera"><p id="status">Connecting to live stream?</p><script>
const image=document.getElementById('live');
image.onload=()=>document.getElementById('status').textContent='Live stream connected.';
image.onerror=()=>document.getElementById('status').textContent='Stream unavailable. Check power and network, then refresh.';
image.src='http://'+location.hostname+':81/stream';
</script></html>)HTML");
  });
  server.begin();
  if (startLiveServer()) {
    Serial.print("Live stream ready: http://");
    Serial.print(WiFi.localIP());
    Serial.println(":81/stream");
  } else {
    Serial.println("Live stream server failed to start. Reset and check power/memory.");
  }
  Serial.print("\nCamera ready. Open http://");
  Serial.println(WiFi.localIP());
  Serial.println("Snapshot endpoint: /capture");
}

void loop() {
  server.handleClient();
  delay(2);
}
