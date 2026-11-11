# Smart Shopping: Shopping Cart subsystem

Reference date: 2026-11-11. This describes the current local implementation and configured cloud
destination. It does not imply that the parking or checkout team's repository has been integrated.

## Purpose and scope

The subsystem builds a customer's digital shopping cart. A customer enters the four digits from a
parking ticket, scans product barcodes, reviews quantities and totals, and submits the cart to checkout.
The resulting Firestore session is a handoff record for the checkout subsystem.

The implementation consists of an ESP32-CAM image source, a browser dashboard, a Python API running
on a laptop, and Firestore persistence. The camera does not decode barcodes or access Firestore.
The laptop is currently required for both barcode decoding and the application server.

## Architecture

```text
Battery pack -> buck converter -> ESP32-CAM + OV2640
                                      |
                            JPEG frames over local Wi-Fi
                                      |
                         Laptop Python camera proxy
                                      |
Browser dashboard + barcode decoder <--+
              |
       Local JSON HTTP API
              |
Python cart rules + Firestore adapter
              |
     Internet / authenticated Admin SDK
              |
mart-parking-fdd6b / (default)
shoppingCartWorkspaces/shopping-cart
              |
 Submitted session available to an authorized checkout backend
```

## Hardware

- **AI-Thinker ESP32-CAM with OV2640:** captures JPEG frames and hosts an HTTP MJPEG stream.
  The stream is `http://<camera-ip>:81/stream`; port 80 serves the camera page, `/capture` snapshot,
  and exposure controls. Current firmware configures VGA (640 x 480), JPEG quality 12, and two frame
  buffers when PSRAM is detected. These settings do not guarantee a fixed FPS.
- **NodeMCU ESP32:** used as the USB-to-serial programming bridge; not a second barcode processor.
  The discussed soldered arrangement retains it with its processor held disabled using EN-to-GND.
  Exact pin wiring must be checked against the physical board variant. It is not required for normal
  camera operation if removed and disconnected correctly.
- **Power:** the reported assembly is soldered, with a lithium-ion series pack and HCW-P715 buck
  converter planned for battery operation. Converter output supplies the camera's 5V input and GND.
  If retaining a powered NodeMCU, use its verified 5V input and common ground. The battery's cell count,
  protection, converter variant, actual voltages, and performance require physical verification.
  The commonly listed fixed-output HCW-P715 is rated for 9–36 V input and approximately 5.2 V output;
  do not assume a 2S pack meets that input requirement or that the module is adjustable.
- **Normal boot:** camera GPIO0 must not remain grounded as it is during firmware uploading.
  Avoid simultaneously applying laptop USB power and external power to interconnected boards without
  a verified power-isolation design.
- **Network:** camera and laptop use the same reachable 2.4 GHz Wi-Fi/hotspot network. The camera
  uses credentials compiled into firmware and receives its IP from DHCP. Battery power does not
  change this. Hotspot client isolation or an IP change can prevent access.

Image sharpness, focus distance, lighting, barcode size, glare, power stability, and wireless throughput
all affect scanning. Moving the camera is not required by the decoder; a stationary sharp barcode is valid.

## Software responsibilities and files

| File | Responsibility |
| --- | --- |
| `firmware/ShoppingCartCamera/ShoppingCartCamera.ino` | Capture images, Wi-Fi connection, streaming and camera controls |
| `web/index.html` | Ticket form, cart/catalog display, checkout history, API requests and retries |
| `web/scanner.js` | Camera/photo input, scanning lifecycle, Add/Remove mode, decoder coordination |
| `web/mjpeg.js` | Parse streamed JPEG frames |
| `web/camera-decoder.js` | Barcode work in a browser worker |
| `web/barcode-1d.js`, `web/barcode-gray.js` | Local 1D/Code 128 recovery, including blurry-frame processing |
| `app.py` | HTTP endpoints, ticket validation, cart business rules, local JSON store, camera proxy |
| `firestore_store.py` | Firestore reads, transactional writes, event deduplication |
| `database_config.json` | Local choice of backend, project, database, workspace, cart and credential path |
| `tools/firestore_setup.py` | Original catalog seeding/check utility |
| `tools/migrate_catalog.py` | Guarded live-catalog migration into the reserved destination workspace |

The dashboard also supports a laptop webcam, barcode photos, manual barcode entry, and catalog Add
buttons. These routes use the same cart API. Camera scanning applies one unit per explicit scan action;
it does not continuously add a product just because its barcode remains visible. Photo decoding requires
confirmation before applying an item. Other barcode formats depend on available native/browser or ZXing
decoders; not every symbology or printed image is guaranteed to decode.

## Customer workflow and ticket reference

1. Open the local dashboard at `http://127.0.0.1:8000` after starting `python app.py`.
2. Enter exactly four ASCII digits, for example `0013`, and select Start shopping.
3. The backend formats and saves `ticket_no: "TKT-0013"` on a new session.
4. Add or remove units by scanning or manual input. The backend calculates the total.
5. Submit a nonempty cart. Its status changes to `ready_for_checkout`, and further cart edits are locked.
6. Enter the next customer's ticket to start a separate session; the old submission remains available.

Ticket entry is enforced in the backend as well as the GUI. A ticket cannot be changed once assigned.
An existing active legacy session without a ticket can receive one through `/api/ticket`, retaining its
items. Old submitted records are not automatically backfilled.

`ticket_no` is currently a string reference, not a Firestore DocumentReference, foreign-key constraint,
login, or verified parking credential. The code does not yet query parking records, check issuance or
ownership, enforce expiry, or prevent the same ticket from being used in multiple sessions.
The exact parking collection and API contract must be inspected before adding such validation.

## Firestore structure and data contract

Current configuration:

```text
Project: mart-parking-fdd6b
Database: (default)
Workspace: shoppingCartWorkspaces/shopping-cart
Cart: CART-DEMO-01

shoppingCartWorkspaces/shopping-cart
  products/{productId}
  carts/{cartId}
  shoppingSessions/{sessionId}
  events/{eventHash}
```

Only this workspace is written by the cart adapter. The other teams' collections are not read or
modified by the current ticket-entry feature. The migrated catalog contains six initial products;
actual cloud values can change. Historical sessions from the original project were not migrated.

Product fields: `id`, `barcode`, `name`, `priceCentavos`, `active`. Product IDs must match document
IDs, barcodes are unique strings, and prices are nonnegative integer centavos.

The `carts` document contains `cartId`, `currentSessionId`, and `schemaVersion`.
A checkout remains in `shoppingSessions`; there is no separate `checkouts` collection.

Illustrative submitted session (IDs/timestamps shortened for readability):

```json
{
  "id": "generated-session-uuid",
  "cartId": "CART-DEMO-01",
  "ticket_no": "TKT-0013",
  "status": "ready_for_checkout",
  "revision": 2,
  "items": [
    {
      "id": "P001",
      "barcode": "DEMO001",
      "name": "Rice",
      "priceCentavos": 6500,
      "active": true,
      "quantity": 1
    }
  ],
  "totalCentavos": 6500,
  "createdAt": "2026-11-11T08:00:00+00:00",
  "submittedAt": "2026-11-11T08:02:00+00:00",
  "schemaVersion": 1
}
```

Money is stored in integer centavos: 6500 means PHP 65.00. Total is the sum of item unit price times
quantity. New item lines capture product details when added; later catalog changes do not rewrite
existing item lines. Timestamps are UTC ISO strings, not native Firestore Timestamp fields.

## API and reliability

| Endpoint | Purpose |
| --- | --- |
| `GET /api/state` | Catalog, current session, submitted history and storage metadata |
| `POST /api/new` | Start session; requires raw four-digit `ticket_no` and `eventId` |
| `POST /api/ticket` | Assign ticket to an active legacy session; requires `sessionId`, digits, event ID |
| `POST /api/add`, `/api/remove` | Modify one unit; requires `sessionId`, `barcode`, `eventId` |
| `POST /api/checkout` | Lock and submit nonempty session; requires `sessionId`, `eventId` |
| `GET /api/esp32/stream?host=<private-ip>` | Proxy camera MJPEG to the browser |
| `POST /api/esp32/profile` | Apply supported camera exposure profile |

Firestore actions read the event, current cart/session and catalog, reuse the cart calculations in memory,
then atomically write session, cart pointer and event. Event document IDs hash the cart ID and event ID.
A repeated event with identical details is not applied again; reuse with conflicting details is rejected.
After an uncertain network failure, the dashboard retains the exact request for Retry the same request.
That pending browser request is lost on page refresh; it is not a durable offline queue.

Unknown/inactive products, invalid tickets, empty checkout and edits to locked carts are rejected.
The cloud dashboard polls while visible every 30 seconds, skipping pending/busy actions; this is not a
Firestore realtime listener. Catalog/history reads are prototype-scale and incur database reads.

## Security, deployment and offline limits

Python authenticates through the Firebase Admin SDK using a local service-account key or configured
Application Default Credentials. No private key belongs in the ESP32, browser, repository or shared
documentation. The Firebase web app config is not sufficient authorization for the Python server.
Admin/server access uses IAM and bypasses browser Security Rules. Cloud Datastore User can be broader
than a collection, so code-level namespacing alone is not an enforced collection permission boundary.

The supplied `firestore.rules` denies browser access if deployed. Do not deploy it over the other team's
existing rules. Sharing a project does not automatically authorize their browser or backend.

The HTTP server binds to laptop loopback only. It is not a deployed public API and has no complete
multi-user authentication design. Other teams should use their authorized backend to access the shared
Firestore records, or agree on a future authenticated API rather than exposing this server unchanged.

The camera's local stream needs no internet, but Firestore does. Explicit local JSON mode remains
available through `backend: "local"`, using `data/products.json` and `data/sessions.json`. These are a
separate dataset. There is no automatic cloud fallback, offline/cloud merge, or synchronization.

## Integration ownership and next steps

| Subsystem | Agreed boundary / future work |
| --- | --- |
| Parking | Supplies ticket; future read-only lookup can verify `ticket_no` after schema agreement |
| Cart | Owns scan input, session items, quantities, provisional totals and submission |
| Product/shelf team | Agree catalog authority, stable product IDs/barcodes, units and price update rules |
| Checkout | Read `ready_for_checkout` sessions, validate final prices, atomically claim and process each session once |
| Inventory/warehouse | Agree one stock owner and when finalized orders change stock; scanning currently does not deduct stock |

Checkout can join the parking record using `ticket_no` once its format and uniqueness scope are agreed.
Use the cart session ID as the processing/idempotency key; ticket numbers alone may be reused.
The checkout owner should implement guarded transitions such as `ready_for_checkout` to
`checkout_processing` to `completed`, plus failure/cancellation handling. These transitions are a proposed
contract, not a payment workflow implemented by this cart. Payment confirmation, taxes, discounts,
receipts, inventory reservation, ticket uniqueness and customer authorization remain integration work.

Before changing shared data, verify ownership, back up source records, preview destination paths and
review broad triggers/extensions. Preserve existing collections/rules/indexes and use create-only guarded
imports where appropriate. Never treat successful barcode decoding as proof of payment or stock availability.
