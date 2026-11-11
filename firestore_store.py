"""Firestore persistence for the existing cart interface. SDK loaded only in cloud mode."""
import copy
import hashlib
import json
import re
import threading
from pathlib import Path


class StorageUnavailable(RuntimeError):
    pass


def document_id(value, name):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', value):
        raise ValueError(f'{name} must contain 1–100 letters, digits, underscores, or hyphens.')
    return value


def validate_products(products):
    if not isinstance(products, list):
        raise ValueError('Product catalog must be a list.')
    ids, barcodes = set(), set()
    for product in products:
        pid = document_id(product.get('id'), 'Product ID')
        barcode = product.get('barcode')
        if not isinstance(barcode, str) or not 1 <= len(barcode) <= 200:
            raise ValueError('Each product needs a barcode string of 1–200 characters.')
        if pid in ids or barcode in barcodes:
            raise ValueError('Product IDs and barcodes must be unique.')
        if not isinstance(product.get('name'), str) or not product['name'].strip():
            raise ValueError('Each product needs a name.')
        if type(product.get('priceCentavos')) is not int or product['priceCentavos'] < 0:
            raise ValueError('Prices must be nonnegative integer centavos.')
        if type(product.get('active')) is not bool:
            raise ValueError('Product active must be true or false.')
        ids.add(pid)
        barcodes.add(barcode)
    return products


def event_key(cart_id, event_id):
    return hashlib.sha256((cart_id + '\0' + event_id).encode()).hexdigest()


class FirestoreStore:
    def __init__(self, client, workspace_id, cart_id, transaction_runner, filter_factory=None):
        self.client = client
        self.workspace_id = document_id(workspace_id, 'Workspace ID')
        self.cart_id = document_id(cart_id, 'Cart ID')
        self.root = client.collection('shoppingCartWorkspaces').document(workspace_id)
        self.lock = threading.RLock()
        self.transaction_runner = transaction_runner
        self.filter_factory = filter_factory

    def products(self, transaction=None):
        try:
            rows = self.root.collection('products').stream(transaction=transaction, timeout=10)
            products = []
            for row in rows:
                product = row.to_dict()
                if product.get('id') != row.id:
                    raise ValueError('Cloud product ID must match its document ID.')
                products.append(product)
            return sorted(validate_products(products), key=lambda p: p['id'])
        except ValueError:
            raise
        except Exception as exc:
            raise StorageUnavailable('Cannot read Firestore products. Check internet access, credentials, and the selected project/database.') from exc

    def view(self):
        try:
            products = self.products()
            cart = self.root.collection('carts').document(self.cart_id).get(timeout=10).to_dict() or {}
            current_id = cart.get('currentSessionId')
            session = None
            if current_id:
                session = self.root.collection('shoppingSessions').document(current_id).get(timeout=10).to_dict()
            # Small prototype: inspect recent sessions and filter locally to avoid
            # requiring a compound index just to open the dashboard.
            collection = self.root.collection('shoppingSessions')
            query = collection.where(filter=self.filter_factory('cartId', '==', self.cart_id)) if self.filter_factory else collection.where('cartId', '==', self.cart_id)
            checkouts = [row.to_dict() for row in query.stream(timeout=10)]
            checkouts = [row for row in checkouts if row.get('status') != 'shopping']
            checkouts.sort(key=lambda row: row.get('submittedAt', row.get('createdAt', '')))
            return {'products': products, 'session': session, 'checkouts': checkouts,
                    'storage': {'backend': 'firestore', 'projectId': self.client.project,
                                'workspaceId': self.workspace_id, 'cartId': self.cart_id}}
        except (ValueError, StorageUnavailable):
            raise
        except Exception as exc:
            raise StorageUnavailable('Cannot read Firestore cart. Check internet access and database permissions.') from exc

    def apply(self, action, payload):
        # Importing here avoids a circular import and reuses the proven cart rules.
        # Transaction state is staged in memory, never saved over local JSON files.
        from app import CartStore, format_ticket
        eid = payload.get('eventId')
        if not isinstance(eid, str) or not 1 <= len(eid) <= 100:
            raise ValueError('A unique eventId is required.')
        if action not in ('new', 'ticket', 'add', 'remove', 'checkout'):
            raise ValueError('Unknown action.')
        request = {'action': action, 'sessionId': None if action == 'new' else payload.get('sessionId'),
                   'barcode': payload.get('barcode') if action in ('add', 'remove') else None}
        if action in ('new', 'ticket'):
            request['ticket_no'] = format_ticket(payload.get('ticket_no'))
        cart_ref = self.root.collection('carts').document(self.cart_id)
        event_ref = self.root.collection('events').document(event_key(self.cart_id, eid))

        def operation(transaction):
            event = event_ref.get(transaction=transaction).to_dict()
            if event:
                if event.get('request') != request:
                    raise ValueError('This eventId was already used for a different action.')
                return
            cart = cart_ref.get(transaction=transaction).to_dict() or {}
            current = cart.get('currentSessionId')
            old = self.root.collection('shoppingSessions').document(current).get(transaction=transaction).to_dict() if current else None
            if old:
                old['events'] = {}
            products = self.products(transaction=transaction)
            staged = {'current': current, 'sessions': {current: copy.deepcopy(old)} if old else {}, 'startEvents': {}}
            # Adapt the existing storage class to a transaction-local unit of work.
            local = CartStore.__new__(CartStore)
            local.lock = threading.Lock()
            local.state = staged
            local.products = lambda: copy.deepcopy(products)
            local.save = lambda: None
            local.apply(action, payload)
            result_id = staged['current']
            session = staged['sessions'][result_id]
            session['cartId'] = self.cart_id
            # Event history has its own documents, avoiding unbounded session maps.
            session.pop('events', None)
            session['schemaVersion'] = 1
            transaction.set(self.root.collection('shoppingSessions').document(result_id), session)
            transaction.set(cart_ref, {'cartId': self.cart_id, 'currentSessionId': result_id, 'schemaVersion': 1})
            transaction.set(event_ref, {'cartId': self.cart_id, 'eventId': eid, 'request': request,
                                        'sessionId': result_id, 'revision': session['revision'], 'schemaVersion': 1})

        try:
            self.transaction_runner(operation)
        except (ValueError, StorageUnavailable):
            raise
        except Exception as exc:
            raise StorageUnavailable('Firestore update could not be confirmed. Retry the same request; its event ID prevents duplicate items.') from exc
        return self.view()


def open_firestore(config):
    try:
        import firebase_admin
        from firebase_admin import credentials, firestore
        from google.cloud.firestore_v1.base_query import FieldFilter
    except ImportError as exc:
        raise StorageUnavailable('Firestore mode needs Firebase dependencies. Run python -m pip install -r requirements.txt first.') from exc
    project = config.get('projectId', '')
    if not project or project == 'YOUR_FIREBASE_PROJECT_ID':
        raise ValueError('Set projectId in database_config.json to your actual Firebase Project ID.')
    try:
        name = 'shopping-cart-' + hashlib.sha256(json.dumps(config, sort_keys=True).encode()).hexdigest()[:16]
        try:
            app = firebase_admin.get_app(name)
        except ValueError:
            credential_path = config.get('credentialsPath')
            credential = credentials.Certificate(str(Path(credential_path).resolve())) if credential_path else credentials.ApplicationDefault()
            app = firebase_admin.initialize_app(credential, {'projectId': project}, name=name)
        client = firestore.client(app=app, database_id=config.get('databaseId', '(default)'))

        def run(operation):
            @firestore.transactional
            def wrapped(transaction):
                return operation(transaction)
            return wrapped(client.transaction(max_attempts=3))

        return FirestoreStore(client, config.get('workspaceId', 'shopping-cart-dev'), config.get('cartId', 'CART-DEMO-01'), run, FieldFilter)
    except (ValueError, StorageUnavailable):
        raise
    except Exception as exc:
        raise StorageUnavailable('Cannot initialize Firestore. Check the local credentials file, Project ID, and database creation.') from exc
