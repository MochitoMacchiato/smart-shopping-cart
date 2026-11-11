"""Contract tests with a staged in-memory Firestore stand-in, not a cloud/emulator test."""
import copy
import unittest
from app import ROOT
from firestore_store import FirestoreStore, StorageUnavailable, validate_products
import json


class Snapshot:
    def __init__(self, reference, data):
        self.id, self.reference, self.data = reference.id, reference, copy.deepcopy(data)
    def to_dict(self):
        return copy.deepcopy(self.data)


class Reference:
    def __init__(self, client, path):
        self.client, self.path = client, path
        self.id = path.rsplit('/', 1)[-1]
    def collection(self, name):
        return Collection(self.client, self.path + '/' + name)
    def get(self, transaction=None, timeout=None):
        if transaction:
            transaction.read()
        return Snapshot(self, self.client.documents.get(self.path))


class Collection:
    def __init__(self, client, path, criterion=None):
        self.client, self.path, self.criterion = client, path, criterion
    def document(self, name):
        return Reference(self.client, self.path + '/' + name)
    def where(self, field, operator, value):
        assert operator == '=='
        return Collection(self.client, self.path, (field, value))
    def stream(self, transaction=None, timeout=None):
        if transaction:
            transaction.read()
        result = []
        for path, data in self.client.documents.items():
            if path.rsplit('/', 1)[0] != self.path:
                continue
            if self.criterion and data.get(self.criterion[0]) != self.criterion[1]:
                continue
            result.append(Snapshot(Reference(self.client, path), data))
        return iter(result)


class Transaction:
    def __init__(self):
        self.writes = []
    def read(self):
        if self.writes:
            raise AssertionError('Firestore requires all reads before writes.')
    def set(self, reference, data, merge=False):
        self.writes.append((reference, copy.deepcopy(data), merge))


class Client:
    project = 'test-project'
    def __init__(self):
        self.documents = {}
    def collection(self, name):
        return Collection(self, name)
    def run(self, operation):
        tx = Transaction()
        result = operation(tx)
        updated = copy.deepcopy(self.documents)
        for ref, data, merge in tx.writes:
            updated[ref.path] = {**updated.get(ref.path, {}), **data} if merge else data
        self.documents = updated
        return result


class CloudCartTests(unittest.TestCase):
    def setUp(self):
        self.client = Client()
        self.store = FirestoreStore(self.client, 'test-workspace', 'CART-01', self.client.run)
        products = json.loads((ROOT / 'data/products.json').read_text(encoding='utf-8'))
        for product in products:
            self.client.documents[self.store.root.collection('products').document(product['id']).path] = product
        state = self.store.apply('new', {'eventId': 'start', 'ticket_no': '0013'})
        self.sid = state['session']['id']

    def action(self, action, event, barcode='DEMO004'):
        return self.store.apply(action, {'eventId': event, 'sessionId': self.sid, 'barcode': barcode})

    def test_scan_quantity_remove_and_duplicate_protection(self):
        self.action('add', 'one')
        self.action('add', 'one')
        state = self.action('add', 'two')
        self.assertEqual(state['session']['totalCentavos'], 3100)
        state = self.action('remove', 'three')
        self.assertEqual(state['session']['totalCentavos'], 1550)
        self.assertNotIn('events', state['session'])
        with self.assertRaises(ValueError):
            self.action('remove', 'one')

    def test_unknown_product_and_empty_checkout_are_atomic(self):
        before = copy.deepcopy(self.client.documents)
        for action, barcode in [('add', 'UNKNOWN'), ('checkout', None)]:
            with self.assertRaises(ValueError):
                self.action(action, action, barcode)
        self.assertEqual(before, self.client.documents)

    def test_checkout_survives_reopening_and_locks_edits(self):
        self.action('add', 'one')
        self.action('checkout', 'done')
        self.action('checkout', 'done')
        with self.assertRaises(ValueError):
            self.action('add', 'late')
        restored = FirestoreStore(self.client, 'test-workspace', 'CART-01', self.client.run)
        self.assertEqual(restored.view(), self.store.view())
        self.assertEqual(len(restored.view()['checkouts']), 1)
        self.store.apply('new', {'eventId': 'new-session', 'ticket_no': '0013'})
        self.assertEqual(self.store.view()['session']['items'], [])

    def test_uncertain_commit_can_be_retried_without_adding_twice(self):
        def commit_then_disconnect(operation):
            self.client.run(operation)
            raise OSError('connection lost after commit')
        self.store.transaction_runner = commit_then_disconnect
        with self.assertRaises(StorageUnavailable):
            self.action('add', 'uncertain')
        self.store.transaction_runner = self.client.run
        state = self.action('add', 'uncertain')
        self.assertEqual(state['session']['items'][0]['quantity'], 1)

    def test_start_retry_conflict_and_separate_carts(self):
        self.store.apply('new', {'eventId': 'start', 'ticket_no': '0013'})
        self.assertEqual(self.store.view()['session']['id'], self.sid)
        with self.assertRaises(ValueError):
            self.action('add', 'start')
        other = FirestoreStore(self.client, 'test-workspace', 'CART-02', self.client.run)
        self.assertIsNone(other.view()['session'])
        other.apply('new', {'eventId': 'start', 'ticket_no': '0013'})
        self.assertNotEqual(other.view()['session']['id'], self.sid)

    def test_external_checkout_status_is_visible(self):
        self.action('add', 'one')
        self.action('checkout', 'done')
        path = self.store.root.collection('shoppingSessions').document(self.sid).path
        self.client.documents[path]['status'] = 'completed'
        self.assertEqual(self.store.view()['session']['status'], 'completed')


class CatalogTests(unittest.TestCase):
    def test_invalid_prices_and_duplicate_barcodes_are_rejected(self):
        products = json.loads((ROOT / 'data/products.json').read_text(encoding='utf-8'))
        for invalid in (True, -10, 15.5):
            changed = copy.deepcopy(products)
            changed[0]['priceCentavos'] = invalid
            with self.assertRaises(ValueError):
                validate_products(changed)
        changed = copy.deepcopy(products)
        changed[1]['barcode'] = changed[0]['barcode']
        with self.assertRaises(ValueError):
            validate_products(changed)


if __name__ == '__main__':
    unittest.main()
