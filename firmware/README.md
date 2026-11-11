# First ESP32-CAM upload

This firmware targets a conventional **AI-Thinker ESP32-CAM with OV2640**. The NodeMCU is
only the USB-to-serial bridge, so select the **camera board**, not NodeMCU, in Arduino IDE.
If the camera board has another model/pin layout, confirm its model before uploading this sketch.

1. Open `ShoppingCartCamera/ShoppingCartCamera.ino` in Arduino IDE.
2. Copy `wifi_credentials.example.h` to `wifi_credentials.h` in the same sketch folder.
   Enter your local Wi-Fi name and password in the copy. Do not share that file.
   Laptop and camera must be on the same accessible network; ESP32 requires 2.4 GHz Wi-Fi.
3. Select **Tools > Board > esp32 > AI Thinker ESP32-CAM**. Your installed Espressif package is 3.3.4.
   Set **Upload Speed: 115200**. Retain the board profile defaults for other settings.
4. Connect the NodeMCU using a USB data cable and select its COM port under **Tools > Port**.
5. Keep donor NodeMCU **EN connected to its own GND**. Connect its RX0 to camera U0R,
   TX0 to camera U0T, and GND to camera GND. This same-label serial wiring applies to a
   conventional ESP32 NodeMCU whose USB bridge is wired to UART0.
6. With power disconnected, connect **ESP32-CAM IO0 to GND** and check the power wiring.
   Use the camera's **5V** input with an appropriate supply. Only use donor USB 5V/VIN if
   its USB power path has been verified; do not connect competing 5 V sources together.
7. Apply power, click **Upload**, and press the **ESP32-CAM reset button** when the IDE
   displays `Connecting...`. Do not press the donor NodeMCU reset button instead.
8. After upload completes, disconnect power, remove **camera IO0-to-GND**, then reconnect power.
   Leave donor EN grounded while borrowing its USB bridge.
9. Open **Serial Monitor**, set **115200 baud**, and press the **camera's reset button**.
10. Serial Monitor should print `Live stream ready: http://192.168...:81/stream`.
    The actual IP comes from your network. The port-80 page now displays live video too.

## First barcode test

1. Close any direct camera-page or `:81/stream` browser tabs. Use one stream viewer at a time.
2. Restart the Python server (`Ctrl+C`, then `python app.py`) and refresh the dashboard with Ctrl+F5.
3. Under **Camera source**, select **ESP32-CAM over Wi-Fi**.
4. Enter the IP printed by Serial Monitor (initial default: `192.168.3.58`), without a port or `http://`.
5. Click **Start camera**. The dashboard shows a live MJPEG preview through the local Python proxy.
6. Start a shopping session if needed. Select Add/Remove, then click **Scan one item**.
7. Hold one phone-displayed barcode steadily in view. One successful read updates the cart once.
8. The preview keeps running. Click Scan one item again to add/remove another unit, or Stop camera to disconnect.

Optional: choose **Fixed exposure for well-lit barcodes** and click **Apply exposure** in the dashboard.
It uses sensor exposure setting 300 (not milliseconds), automatic gain, and disables automatic exposure.
Use diffuse lighting; switch back to **Automatic** if images are too dark. Port 80 provides
`/control?profile=auto` or `/control?profile=fast`; the Python service calls it for the dashboard.
This option can test whether auto-exposure contributes to downward-facing slowdown, but cannot fix slow Wi-Fi.
Serial timing logs now include JPEG byte counts and delivered-frame timestamp intervals alongside send times.

No manual photo saving/uploading is needed. The ESP32 captures/transmits video; the laptop decodes
barcodes and manages cart data. The existing `/capture` endpoint remains available for diagnostics.
The ESP32 does not appear as a USB webcam. No payment or Firebase access runs on the firmware.

## Troubleshooting

- **No COM port:** use a data cable, connect directly to the laptop, and check Windows Device Manager.
  The USB-to-serial chip may require its vendor's driver (commonly CP210x or CH340).
- **Failed to connect:** check donor EN-to-GND, camera IO0-to-GND, serial wiring, and reset the camera
  while the uploader displays `Connecting...`. Close Serial Monitor before uploading.
- **`waiting for download` after upload:** remove camera IO0-to-GND and reset the camera.
- **Brownout/reset loop:** check cable and stable power. Do not disable brownout detection to conceal the issue.
- **Camera initialization failed:** check board model and ribbon seating with power disconnected.
- **Wi-Fi timeout:** check credentials, 2.4 GHz availability, and network client isolation.
- **No live preview:** confirm the new firmware printed `Live stream ready`, verify the IP,
  restart Python after updating the server code, and check that Wi-Fi allows devices to reach each other.
  Close other camera tabs, stop/restart the dashboard camera, and check stable power.
- **Slow/choppy preview:** stream speed depends on Wi-Fi, power, light/exposure, and resolution.
  The firmware uses VGA (640x480), JPEG quality 12, and two frame buffers when PSRAM is present.
  Streaming does not bypass hardware/network problems that also made snapshots slow.
- **Connected then disconnected/timeouts:** HTTP headers are now sent before capturing the first frame.
  Serial Monitor prints `Live HTTP headers sent`, first-frame capture size/time, and transfer size/time.
  `Waiting for camera frame` without a ready frame points to camera capture; `frame ready` followed by a
  transfer failure points to network/client interruption. Send the full sequence when troubleshooting.

The local HTTP camera page has no authentication. Use a trusted local development network;
do not expose it through router port forwarding.
