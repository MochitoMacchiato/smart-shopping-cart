# Connect the cart to Cloud Firestore

Camera firmware and barcode decoding are unchanged. Python manages Firestore using a server identity;
the browser continues calling the same local cart API. The Python server still runs on your laptop.
Using a cloud database does not host the dashboard or make localhost reachable by other teams.

## 1. Create the database in your account

In Firebase Console create a project, then create a **Cloud Firestore Standard / Native mode** database.
Use the `(default)` database and production security mode. Choose the region carefully before creating it.
Analytics is not required. Copy the **Project ID** from Project settings, not the display name or API key.
Do not create Realtime Database instead; it has a different API and this integration targets Firestore.

## 2. Prepare a local server identity

If your institution provides Application Default Credentials, use those and omit `credentialsPath` below.
Otherwise, for this local student prototype:

1. In **Project settings > Service accounts > Firebase Admin SDK**, use **Generate new private key**
   if your account/policies allow it. Store the downloaded JSON locally as:
   `.secrets/firebase-service-account.json` inside this project folder.
2. The file must remain local. **Do not paste its contents into chat, commit it, or put it in the webpage/ESP32.**
3. The Python server identity requires Firestore data permissions (such as Cloud Datastore User), not
   project Owner. The default Firebase Admin identity can have broader privileges: prefer a dedicated
   appropriately scoped identity when collaborating with other teams.
4. `firestore.rules` intentionally denies browser/mobile access. Admin/server SDK requests use IAM and
   bypass these rules, so these rules do not restrict an overly privileged server identity.

If generating keys is blocked, do not weaken organization policies. Use the institution's approved
identity or install Google Cloud CLI yourself and configure Application Default Credentials instead.

## 3. Install the Python dependency

In PowerShell in this folder:

```powershell
python -m pip install -r requirements.txt
```

The assistant's environment may be unable to download packages; run this locally if needed.
Use the same Python interpreter for installation and `python app.py`.

## 4. Configure the project

Copy `database_config.example.json` to `database_config.json` in the main project folder.
Edit `projectId` to the actual Firebase Project ID. Keep `workspaceId` and `cartId` stable:

```json
{
  "backend": "firestore",
  "projectId": "your-actual-project-id",
  "databaseId": "(default)",
  "workspaceId": "shopping-cart-dev",
  "cartId": "CART-DEMO-01",
  "credentialsPath": ".secrets/firebase-service-account.json"
}
```

The config and secrets directory are ignored by Git. The configuration is not itself a private key,
but keeping each developer's machine configuration local prevents accidental project mix-ups.
The example remains tracked. Never rename a private key to the example filename or put secrets under `web/`.

## 5. Check access and copy products

```powershell
python tools/firestore_setup.py check
python tools/firestore_setup.py seed-products
```

The second command is a read-only preview. Confirm the Project ID and planned six demo products.
Then create the missing records:

```powershell
python tools/firestore_setup.py seed-products --apply
```

This first backs up the local catalog/session JSON to `backups/`. It creates missing product IDs,
rejects duplicate barcodes, and preserves any product ID already present in Firestore.
It does not import old shopping-session history or overwrite existing cloud products. Local JSON is
retained unchanged; new cloud sessions are separate. Ask for a dedicated history import if needed.

## 6. Run and verify

Restart `python app.py` and refresh the dashboard. Startup should print `Storage: Firestore`.
The footer shows `Cloud database · Firestore connected` after a successful read. While the tab is visible,
cloud status refreshes every 30 seconds (except while submitting/retrying). This lets checkout status changes
appear without restarting the scanner, but is polling rather than a realtime listener and incurs reads.
Start a new shopping session, add DEMO004 twice, remove one, and submit checkout. Verify the new
session and events in Firebase Console. Restart Python and confirm the same cloud session loads.
Retrying an action with the same event ID must not add a second unit. Use a new event ID for another scan.

Firestore mode is selected explicitly. If it cannot connect, the app returns a database error; it does
not silently switch to JSON and create two conflicting carts. Network failure can occur after a commit,
so retry the same request/event ID rather than inventing a replacement request.

## Data layout and checkout integration

All cart-owned data is isolated below:

```text
shoppingCartWorkspaces/shopping-cart-dev
  products/P001                 id, barcode, name, priceCentavos, active
  carts/CART-DEMO-01             cartId, currentSessionId, schemaVersion
  shoppingSessions/{sessionId}   id, cartId, ticket_no, status, revision, items[], totalCentavos,
                                createdAt, submittedAt?, schemaVersion
  events/{sha256(cartId,eventId)} cartId, eventId, request, sessionId, revision, schemaVersion
```

The session `items` array retains the existing item shape and integer centavo prices. Timestamps are
ISO UTC strings for compatibility with this app; do not mix timestamp types in the same field.
New sessions require four ticket digits in the API request's `ticket_no` field (for example `0013`).
The backend saves the canonical `ticket_no` string `TKT-0013` on the session and retains it at checkout.
The `ticket` action assigns a ticket only to an older active session that has none. Existing submitted
records are not backfilled. Parking ticket existence/ownership is not verified; this is a shared reference,
not authentication. No parking-owned collection is read or changed by this feature.
Each cloud action transaction reads its event, cart, current session, and product catalog before writing.
Event records are separate from sessions so sessions do not grow an unbounded event map.
The six-product catalog is read for each operation; this is a prototype approach, not a large-store index design.
The dashboard also queries the cart's session history on refresh, which incurs Firestore reads.

Share the Project ID, workspace path, data contract, and an authorized **separate identity** with checkout.
Repo access is optional for code collaboration; do not share your private key. If checkout is a browser
application, define Firebase Auth roles and tailored Security Rules before granting browser access.
With the current deny-all rules, checkout must use a trusted backend with IAM access or an agreed API.

`shopping` permits cart edits. `ready_for_checkout` locks cart edits and identifies the submitted revision.
Checkout owns order/payment processing and may transition a submitted session to an agreed status such
as `checkout_processing` or `completed`; retain the session's cart ID and items. Checkout must validate
catalog prices and calculate the final bill on its trusted backend. A cart submission is not a payment.
Do not deduct inventory on every scan; agree on one inventory owner and an idempotent finalized-order event.

Do not write an entire session from a stale cached copy: checkout and cart updates should use transactions
and check the expected status/revision. Admin SDK access bypasses Security Rules, so application checks matter.
Rules for payment handling, inventory updates, and checkout authorization are future integration work, not
implicitly provided by this migration.

## Local mode and limits

To resume the local demo, stop Python and set `"backend": "local"` in `database_config.json` (or rename
that file out of the way). This reopens the original JSON records; it does not download or merge cloud edits.
Never run two copies of the JSON backend against the same data folder.
Use a different cart ID for each physical cart and a shared workspace ID for shared product data.
Products, cart items, and event logs are small demo records; Firestore document/transaction limits and
usage billing still apply. Monitor Console usage before running repeated long demonstrations.

Cloud migration is complete only after the SDK is installed, project access succeeds, product seeding
is verified, and the live add/remove/checkout/restart checks above pass. Local unit tests cannot verify IAM,
network connectivity, or transaction behavior of a real Firestore deployment.
