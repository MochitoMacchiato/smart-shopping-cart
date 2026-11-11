"""Local Smart Shopping prototype. Run: python app.py"""
import json
import os
import re
import threading
import uuid
import ipaddress
from urllib.parse import urlsplit, parse_qs
from urllib.request import build_opener, ProxyHandler, HTTPRedirectHandler
from urllib.error import URLError
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from firestore_store import open_firestore, StorageUnavailable

ROOT = Path(__file__).resolve().parent


def format_ticket(value):
    if not isinstance(value, str) or not re.fullmatch(r'[0-9]{4}', value):
        raise ValueError('Enter exactly four ticket digits, for example 0013.')
    return 'TKT-' + value


def has_ticket(session):
    value = session.get('ticket_no') if session else None
    return isinstance(value, str) and bool(re.fullmatch(r'TKT-[0-9]{4}', value))


def configured_store(root=ROOT):
    config_path = root / 'database_config.json'
    if not config_path.exists():
        return CartStore(root / 'data')
    config = json.loads(config_path.read_text(encoding='utf-8'))
    if not isinstance(config, dict):
        raise ValueError('database_config.json must contain a JSON object.')
    if config.get('backend') == 'local':
        return CartStore(root / 'data')
    if config.get('backend') != 'firestore':
        raise ValueError('database_config.json backend must be local or firestore.')
    if config.get('credentialsPath'):
        config['credentialsPath'] = str((root / config['credentialsPath']).resolve())
    return open_firestore(config)


def camera_host(value):
    """Limit this local proxy to explicit RFC1918 camera addresses."""
    address = ipaddress.IPv4Address(value)
    if not any(address in ipaddress.ip_network(net) for net in ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16')):
        raise ValueError('Enter the camera local IPv4 address, for example 192.168.3.58.')
    return str(address)


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class CartStore:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.lock = threading.Lock()
        self.path = self.directory / 'sessions.json'
        self.state = json.loads(self.path.read_text(encoding='utf-8')) if self.path.exists() else {'current': None, 'sessions': {}}

    def products(self):
        return json.loads((self.directory / 'products.json').read_text(encoding='utf-8'))

    def save(self):
        temporary = self.path.with_suffix('.tmp')
        temporary.write_text(json.dumps(self.state, indent=2, ensure_ascii=False), encoding='utf-8')
        os.replace(temporary, self.path)

    def view(self):
        session = self.state['sessions'].get(self.state['current'])
        return {'products': self.products(), 'session': session,
                'checkouts': [s for s in self.state['sessions'].values() if s['status'] == 'ready_for_checkout']}

    def apply(self, action, payload):
        with self.lock:
            event_id = payload.get('eventId')
            if not isinstance(event_id, str) or not 1 <= len(event_id) <= 100:
                raise ValueError('A unique eventId is required.')
            if action == 'new':
                ticket = format_ticket(payload.get('ticket_no'))
                starts = self.state.setdefault('startEvents', {})
                if event_id in starts:
                    if self.state['sessions'][starts[event_id]].get('ticket_no') != ticket:
                        raise ValueError('This eventId was already used with a different ticket.')
                    return self.view()
                current = self.state['sessions'].get(self.state['current'])
                if current and current['status'] == 'shopping':
                    raise ValueError('Finish the current session before starting another.')
                sid = str(uuid.uuid4())
                self.state['current'] = sid
                starts[event_id] = sid
                self.state['sessions'][sid] = {'id': sid, 'cartId': 'CART-DEMO-01', 'ticket_no': ticket, 'status': 'shopping',
                    'revision': 0, 'items': [], 'totalCentavos': 0, 'events': {},
                    'createdAt': datetime.now(timezone.utc).isoformat()}
            else:
                sid = payload.get('sessionId')
                session = self.state['sessions'].get(sid)
                if session is None or sid != self.state['current']:
                    raise ValueError('Select the current shopping session.')
                event_id = payload.get('eventId')
                if not isinstance(event_id, str) or not 1 <= len(event_id) <= 100:
                    raise ValueError('A unique eventId is required.')
                event = {'action': action, 'barcode': payload.get('barcode')}
                if action == 'ticket':
                    event['ticket_no'] = format_ticket(payload.get('ticket_no'))
                if event_id in session['events']:
                    if session['events'][event_id] != event:
                        raise ValueError('This eventId was already used for a different action.')
                    return self.view()
                if session['status'] != 'shopping':
                    raise ValueError('This cart is locked for checkout. Start a new session.')
                if action == 'ticket':
                    if has_ticket(session):
                        raise ValueError('This session already has a ticket. It cannot be changed.')
                    session['ticket_no'] = event['ticket_no']
                elif not has_ticket(session):
                    raise ValueError('Enter your four-digit parking ticket before changing or checking out this cart.')
                elif action in ('add', 'remove'):
                    barcode = payload.get('barcode')
                    if not isinstance(barcode, str):
                        raise ValueError('Barcode must be a string.')
                    product = next((p for p in self.products() if p['barcode'] == barcode and p['active']), None)
                    item = next((i for i in session['items'] if i['barcode'] == barcode), None)
                    if action == 'add':
                        if product is None:
                            raise ValueError('Unknown or inactive product. Cart unchanged.')
                        if item:
                            item['quantity'] += 1
                        else:
                            session['items'].append({**product, 'quantity': 1})
                    else:
                        if item is None:
                            raise ValueError('That product is not in the cart.')
                        item['quantity'] -= 1
                        if item['quantity'] == 0:
                            session['items'].remove(item)
                elif action == 'checkout':
                    if not session['items']:
                        raise ValueError('Add a product before checkout.')
                    session['status'] = 'ready_for_checkout'
                    session['submittedAt'] = datetime.now(timezone.utc).isoformat()
                else:
                    raise ValueError('Unknown action.')
                session['events'][event_id] = event
                session['revision'] += 1
                session['totalCentavos'] = sum(i['priceCentavos'] * i['quantity'] for i in session['items'])
            self.save()
            return self.view()


class Handler(BaseHTTPRequestHandler):
    def camera_profile(self, payload):
        host = camera_host(payload.get('host', ''))
        profile = payload.get('profile')
        if profile not in ('auto', 'fast'):
            raise ValueError('Select auto or fast exposure.')
        try:
            opener = build_opener(ProxyHandler({}), NoRedirect())
            with opener.open(f'http://{host}/control?profile={profile}', timeout=5) as response:
                data = response.read(4096)
                result = json.loads(data)
            return self.reply(200, result)
        except (URLError, OSError, ValueError):
            return self.reply(502, {'error': 'Cannot apply camera exposure. Upload the updated firmware and check camera connectivity.'})

    def camera_stream(self):
        try:
            host = camera_host(parse_qs(urlsplit(self.path).query).get('host', [''])[0])
        except ValueError:
            return self.reply(400, {'error': 'Enter a private IPv4 camera address, without http:// or a port.'})
        opener = build_opener(ProxyHandler({}), NoRedirect())
        try:
            upstream = opener.open(f'http://{host}:81/stream', timeout=8)
        except (URLError, OSError) as exc:
            if isinstance(exc, TimeoutError) or isinstance(getattr(exc, 'reason', None), TimeoutError):
                return self.reply(504, {'error': 'Timed out waiting for the camera HTTP response. Check Serial Monitor for Live HTTP headers sent and Live frame messages. Close other camera tabs before reconnecting.'})
            return self.reply(502, {'error': 'Cannot reach ESP32-CAM live stream. Upload the live firmware and check Wi-Fi. ' + str(exc)})
        with upstream:
            content_type = upstream.headers.get('Content-Type', '')
            if not content_type.lower().startswith('multipart/x-mixed-replace') or 'boundary=' not in content_type.lower():
                return self.reply(502, {'error': 'Camera did not return an MJPEG stream. Upload the live firmware.'})
            self.close_connection = True
            forwarded = 0
            try:
                self.send_response(200)
                self.send_header('Content-Type', content_type)
                self.send_header('Cache-Control', 'no-store')
                self.send_header('Connection', 'close')
                self.end_headers()
                while True:
                    chunk = upstream.read1(16384)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    self.wfile.flush()
                    forwarded += len(chunk)
            except (OSError, ValueError) as exc:
                self.log_message('Camera stream ended after forwarding %d bytes: %s', forwarded, exc)

    def reply(self, status, data, content_type='application/json; charset=utf-8'):
        body = json.dumps(data, ensure_ascii=False).encode() if isinstance(data, dict) else data
        try:
            self.send_response(status)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(body)
        except ConnectionError:
            # Browser Stop, refresh, or request timeout can close the connection
            # before our response arrives. This is a client disconnect, not a
            # second application failure; do not attempt another error response.
            self.close_connection = True
            self.log_message('Client disconnected before HTTP %d response completed', status)

    def do_GET(self):
        path = self.path.split('?', 1)[0]
        if path == '/api/esp32/stream':
            return self.camera_stream()
        assets = {'/': ('web/index.html', 'text/html; charset=utf-8'),
                  '/scanner.js': ('web/scanner.js', 'text/javascript; charset=utf-8'),
                  '/mjpeg.js': ('web/mjpeg.js', 'text/javascript; charset=utf-8'),
                  '/camera-decoder.js': ('web/camera-decoder.js', 'text/javascript; charset=utf-8'),
                  '/barcode-1d.js': ('web/barcode-1d.js', 'text/javascript; charset=utf-8'),
                  '/barcode-gray.js': ('web/barcode-gray.js', 'text/javascript; charset=utf-8'),
                  '/samples': ('samples/barcode-samples.html', 'text/html; charset=utf-8')}
        if path in assets:
            filename, content_type = assets[path]
            self.reply(200, (ROOT / filename).read_bytes(), content_type)
        elif path.startswith('/samples/') and path.rsplit('/', 1)[-1] in {p.name for p in (ROOT / 'samples').glob('*.png')}:
            self.reply(200, (ROOT / 'samples' / path.rsplit('/', 1)[-1]).read_bytes(), 'image/png')
        elif self.path == '/api/state':
            try:
                with self.server.store.lock:
                    self.reply(200, self.server.store.view())
            except (StorageUnavailable, ValueError) as exc:
                self.reply(503, {'error': str(exc)})
        else:
            self.reply(404, {'error': 'Not found'})

    def do_POST(self):
        if self.path not in ('/api/new', '/api/ticket', '/api/add', '/api/remove', '/api/checkout', '/api/esp32/profile'):
            return self.reply(404, {'error': 'Not found'})
        # Only this local interface should issue browser requests to the service.
        if self.headers.get('Origin') not in (None, 'http://' + self.headers.get('Host', '')):
            return self.reply(403, {'error': 'Origin rejected'})
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 8192:
                raise ValueError('Invalid request length.')
            payload = json.loads(self.rfile.read(length))
            if not isinstance(payload, dict):
                raise ValueError('Expected a JSON object.')
            if self.path == '/api/esp32/profile':
                return self.camera_profile(payload)
            result = self.server.store.apply(self.path.rsplit('/', 1)[1], payload)
            self.reply(200, result)
        except (ValueError, TypeError) as exc:
            self.reply(400, {'error': str(exc)})
        except StorageUnavailable as exc:
            self.reply(503, {'error': str(exc)})


if __name__ == '__main__':
    try:
        store = configured_store()
    except (ValueError, StorageUnavailable, OSError) as exc:
        raise SystemExit('Database setup error: ' + str(exc))
    server = ThreadingHTTPServer(('127.0.0.1', 8000), Handler)
    server.store = store
    print('Smart Shopping: http://127.0.0.1:8000 (Ctrl+C to stop)', flush=True)
    print('Storage: ' + ('Firestore' if not isinstance(store, CartStore) else 'local JSON'), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
