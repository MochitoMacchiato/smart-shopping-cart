# Smart Shopping: laptop cart prototype

Runs locally using Python 3. Local JSON mode requires no Python packages, Firebase account, or cart hardware.
For online storage, follow [the Firestore setup guide](FIRESTORE_SETUP.md). Firestore mode requires the packages in `requirements.txt`.
Typed entry, samples, and the local multi-line Code 128 recovery decoder work offline.
Other formats use a compatible browser decoder or pinned ZXing 0.21.3 from jsDelivr, which needs internet to download.

## Run

Open PowerShell in this folder:

```powershell
python app.py
```

Open **http://127.0.0.1:8000** in your browser. Keep the terminal open. Press Ctrl+C to stop.
If port 8000 is occupied or blocked, use `python app.py --port 8080` and open
**http://127.0.0.1:8080** instead. Stop the other service only if you know it is safe to do so.

The dashboard uses a forest-green retail theme with scanning and cart review side by side on desktop.
Manual barcode entry, photo uploads, camera tuning/frame inspection, and CSV test logs are in expandable
sections below the scanner. Add/Remove applies to camera, manual, and photo actions. The sidebar links
jump to scanner, cart, catalog, and checkout sections; mobile layouts stack the panels.
After a UI update, use Ctrl+F5 to load the latest page. Firmware and saved session data are unaffected by styling changes.

## First demonstration

1. Enter a four-digit parking ticket (for example `0013`) and click **Start shopping**. The backend saves `ticket_no: "TKT-0013"` on the session.
2. Enter `DEMO004` and submit twice. Noodles should have quantity 2 and total ₱31.00.
3. Choose **Remove one item**, enter `DEMO004`, and submit. Total should be ₱15.50.
4. Try `UNKNOWN`. The error should leave the cart unchanged.
5. Add other products using the catalog buttons.
6. Click **Send to checkout**. The cart becomes locked; expand the checkout entry to inspect its JSON.
7. Restart the server and reload the browser. The saved cart and checkout remain.
8. Enter the next customer's ticket and click **Start shopping**. The previous checkout stays available.

Ticket entry is required before adding/removing items or submitting checkout, including direct API requests.
Use exactly four ASCII digits; leading zeros are preserved. A session's ticket cannot be changed once assigned.
An older active session without a ticket can receive one through the ticket form, preserving its existing items.
Historical submitted sessions are left unchanged. The ticket is a reference supplied by the customer: issuance,
ownership, expiry, and duplicate use are not checked against parking records yet. Checkout can join its parking
record using the session's `ticket_no` field. Multiple sessions may reference the same ticket.

To exercise a network retry, stop the server after loading a shopping session, submit a scan,
restart the server, and click **Retry the same request**. Do not refresh the page before retrying:
the pending request is held in browser memory. Successful events are recorded on the server,
so resending their event IDs does not change quantities twice.

## Local files

- `data/products.json`: editable sample catalog. Codes and prices are fictional.
- `data/sessions.json`: generated automatically; contains active sessions, submitted carts, and accepted events.
- `app.py`: HTTP API, product lookup, cart rules, atomic JSON file replacement.
- `web/index.html`: browser interface.
- `test_app.py`: isolated tests using temporary files; they do not modify your saved cart.

Stop the server before editing JSON files. Keep product IDs and barcode strings unique.
`priceCentavos` must be a nonnegative integer, `active` a Boolean, and `barcode` a string.
For example ₱25.50 is `2550`; a barcode starting with zero must retain that zero.
Cart items retain the price at first addition. Final price revalidation belongs in the future checkout integration.

## API for future scanner integration

`GET /api/state` returns products, the current session, and submitted checkouts.
`POST /api/new` starts a session with a unique `eventId`.
`POST /api/add` and `/api/remove` accept:

```json
{"sessionId":"returned-session-id","eventId":"unique-action-id","barcode":"DEMO001"}
```

`POST /api/checkout` accepts `sessionId` and `eventId`, saves the cart as `ready_for_checkout`,
and prevents further edits. Reuse the same event ID only when retrying the same request.
Use a new event ID when deliberately scanning another unit of the same product.
Successful responses return the updated state; rejected operations return HTTP 400 and an `error` message.

The service binds only to your laptop's loopback address. For the ESP32-CAM integration the laptop
connects outward to the camera, so you do not need to expose the Python service on your LAN.
Photo, webcam, and ESP32 video decoding run in your browser, not on the ESP32.

## Live ESP32-CAM scanning

Upload the updated `firmware/ShoppingCartCamera/ShoppingCartCamera.ino` using the steps in
`firmware/README.md`. Keep your existing `wifi_credentials.h`; no Wi-Fi changes are required.
After uploading, remove camera IO0-to-GND and reset it for normal operation.
Confirm Serial Monitor prints `Live stream ready: http://<camera-IP>:81/stream`.

Restart `python app.py`, refresh the dashboard with Ctrl+F5, and select **Camera source > ESP32-CAM over Wi-Fi**.
Enter the IP from Serial Monitor (default field: `192.168.3.58`), then click **Start camera**.
Start a shopping session and click **Scan one item** in the chosen Add/Remove mode.
The video stays live between deliberate scans, and each click accepts only one barcode.
No photo download/upload is needed. Stop camera before changing sources.
The ESP32 preview reports complete frames received, approximate FPS, resolution, and the age of the
last frame. The scanner checks each newly received frame once per scan attempt and avoids frames
older than five seconds. A stationary scene should still increase the received-frame count.
Use **Download current frame for inspection** to check actual camera sharpness or share a diagnostic
JPEG. This download is optional and is not part of the normal live scanning workflow.
Live and photo scanning first run `web/barcode-1d.js`: multiple horizontal/slanted rows and threshold
levels, blur-width compensation, forward/reverse reading, start/stop/quiet-margin checks, and the
Code 128 checksum. A recovered value needs agreement from two distinct rows. Values are decoded
from image pixels; the catalog is never used to guess a barcode. General/native decoders remain fallbacks.
`esp32-live-frame.jpg` is an actual regression image: the local decoder reads `DEMO002`.
For blurred printed packaging, `web/barcode-gray.js` is a second local fallback. It fits Gaussian-blurred
Code 128 symbol profiles directly to grayscale rows, permits small position/scale changes for perspective,
keeps a bounded set of alternative symbol paths, and accepts only a checksum-valid result supported by
two different rows. It rejects close competing values rather than guessing from catalog entries.
Both `esp32-live-frame (1).jpg` and `esp32-live-frame (2).jpg` are regression cases decoding as `DEMO002`.
Recovery runs in the existing live decoder worker (up to 900 ms for this fallback); the preview continues.
It also runs for photo uploads. Very blurred, cropped, reflective, or undersampled images can still fail;
the algorithm cannot guarantee recovery when the bar pattern is no longer distinguishable.

**Hold current frame for scanning** preserves a copy for the next scan while the preview continues.
Click **Resume scanning live frames** to release it. Held images are explicitly exempt from the live-frame
age limit; use this for inspection and release it before presenting another product.

The optional **Camera exposure** control requires uploading the updated firmware. **Fixed exposure for
well-lit barcodes** disables automatic exposure and sets the sensor exposure value to 300 (not milliseconds),
while retaining automatic gain. It may produce dark/noisy images without sufficient light. **Automatic**
restores automatic exposure/gain. This is a diagnostic option, not a guarantee of higher FPS.
Downward slowdown can reflect scene brightness/exposure, JPEG size, antenna orientation, or transfer stalls;
compare bytes, capture waits, delivered-frame intervals, and transfer times in Serial Monitor.
Delivered-frame intervals include frames skipped while sending and do not measure exposure time directly.

The Python endpoint `/api/esp32/stream?host=<camera-IP>` relays the MJPEG stream from port 81
to the browser on the same origin, so decoded canvas pixels remain accessible without camera CORS changes.
Only literal RFC1918 IPv4 addresses are accepted, redirects are disabled, and system HTTP proxies are bypassed.
The proxy has an 8-second upstream inactivity timeout; the browser allows 12 seconds for the initial preview.
The dashboard reads the multipart response and displays complete JPEG frames explicitly. It shows the
Python proxy's actual error message when connecting fails, including an outdated-server hint for HTTP 404.
The endpoint is local development tooling and does not provide authentication for a shared deployment.

Use a single stream viewer: close the camera's own page and direct stream tabs before starting the dashboard.
Camera/laptop need network connectivity to each other; guest Wi-Fi isolation can prevent this.
Live video still depends on camera capture and Wi-Fi speed: it does not repair weak power or a poor connection.
Firmware compilation/upload and actual hardware frame rate must be verified in Arduino IDE/on your board.

## Photo and webcam scanning

1. Restart `python app.py` after updating these files, refresh the dashboard, and start a shopping session.
2. Under **Camera & photo scanner**, choose `samples/DEMO004.png` as a photo.
3. Verify decoded value `DEMO004`, format Code 128, and catalog match Instant noodles.
4. Click **Use decoded code in cart**. Photo decoding alone does not change quantities.
5. Click **Start camera** and grant permission. Select a camera before starting; stop it to change cameras.
6. Display a sample PNG on your phone. Click **Scan one item** and hold the phone toward your laptop webcam.
7. One decoded barcode is submitted in the currently selected Add/Remove mode, captured when you start the scan.
8. Keep the code in view: no further units should be added until you click Scan one item again.

Use **Cancel scan** or **Stop camera** to cancel; an unread scan times out after 15 seconds.
Live scanner v2 copies camera frames at up to 960 pixels wide into a dedicated decoding worker.
Each deliberate scan uses a fresh worker; finishing, cancelling, or timing out discards it while leaving
the camera stream running. The frame count and countdown show whether decoding is advancing.
Decoder preparation has a separate 20-second limit. Native detection is used in a worker when compatible;
otherwise the worker loads pinned ZXing from the CDN. Its normal 1D-first search is used for live frames.
After updating from an earlier version, restart `python app.py` (the worker has a new server route),
then press Ctrl+F5. You should see **Live scanner v2** below the camera buttons.
Camera scans submit one code automatically. **Use decoded code in cart** is enabled only for an unconfirmed photo result.
Photo selection stays visible with a preview and a result message directly below the file picker.
Use **Decode selected photo again** to retry the same file. A photo attempt times out after 25 seconds;
an unreadable photo clears the previous decoded result and cannot change the cart.
Photos that fail at original resolution are retried at smaller sizes (1280, 960, and 640 pixels
on the longest side), where applicable. This can reduce screen-pixel noise in photos of displays;
it cannot restore missing bars or guarantee a read from blurred images.
Checkout locking and unknown-product rejection still apply. Check the main cart message for acceptance;
successful barcode decoding alone does not mean an item was added.

Browser compatibility varies. If the decoder cannot load, connect to the internet and retry; typed entry stays usable.
Camera permission may be blocked by browser/Windows privacy settings or another app using the webcam.
Use the dashboard on `http://127.0.0.1:8000`; opening HTML directly does not run the cart service.

## Samples for your phone

- Open **http://127.0.0.1:8000/samples** on the laptop to inspect/download samples.
- Send any PNG from `samples/` to your phone using your usual file-transfer method, then open it full-screen.
- Alternatively send `samples/barcode-samples.html`: the standalone sheet embeds all seven images and works offline
  in a browser that supports opening local HTML. If your phone's file viewer does not support it, use the PNGs.
- Your phone cannot reach the laptop's `127.0.0.1` address. Transferring the files avoids opening the server to the network.
- Use high screen brightness, avoid glare, preserve white margins, and move slowly until the webcam focuses.
  A phone screenshot of the standalone sheet also works as an image to display, provided the code remains sharp.

Codes `DEMO001`–`DEMO005` are Code 128 and match the original five products.
`2000000000015` is a valid EAN-13 test label mapped to a sixth demo product (₱25.00).
`UNKNOWN999` intentionally has no catalog record and should leave the cart unchanged.
All labels/prices are synthetic. Code 128 accepts the letters in DEMO004; EAN-13 requires numeric data and a checksum.
Regenerate the PNGs and sheet after changing the catalog with `python tools/generate_samples.py`.

## Scan testing

Try ten presentations each of the five DEMO labels. Record distance, lighting, glare, correct reads,
wrong reads, and timeouts. Expand **Scan test log** and download CSV before closing the tab.
The log records decoding attempts and elapsed time, not cart acceptance. Conditions/expected values need your own notes.
Test `UNKNOWN999`, Remove mode, holding a code in view, cancel, permission denial, and scanning after checkout.
Uploaded photos are decoded once; camera scans retry frames for up to 15 seconds.
Laptop webcam results do not establish ESP32-CAM performance. Test OV2640 images through the same photo input later.

## Integration agreement to discuss with the other groups

The parking group's records do not supply the product catalog. Before connecting Firebase, agree on:

- A product catalog owner and actual barcode formats/samples.
- Firestore versus Realtime Database and development access.
- Shared product IDs, cart IDs, shopping session IDs, and optional parking-session references.
- Checkout ownership of price validation, payment, receipts, and inventory deductions.
- Shelf observations versus completed purchases, so inventory is not deducted twice.

The checkout JSON is a proposal for that discussion, not an agreed production interface.
No payment, inventory adjustment, Firebase access, or physical item detection occurs here.
This is a single-cart, single-server prototype; use one browser tab to avoid stale displays.
Local files contain demo data and have no user authentication. Run only one server process per data directory.

## Checks

```powershell
python -m unittest -v
node --test test_barcode_1d.cjs test_barcode_gray.cjs test_scanner.cjs test_mjpeg.cjs
```
