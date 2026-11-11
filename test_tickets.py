import copy
import json
import tempfile
import unittest
from pathlib import Path

from app import ROOT, CartStore
from firestore_store import FirestoreStore
from test_firestore_store import Client


class TicketTests(unittest.TestCase):
    def stores(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        folder = Path(temporary.name)
        products = (ROOT / 'data/products.json').read_bytes()
        (folder / 'products.json').write_bytes(products)
        local = CartStore(folder)
        client = Client()
        cloud = FirestoreStore(client, 'ticket-tests', 'CART-01', client.run)
        for product in json.loads(products):
            client.documents[cloud.root.collection('products').document(product['id']).path] = product
        return [('local', local), ('cloud', cloud)]

    def test_exact_four_ascii_digits_required_without_writes(self):
        for name, store in self.stores():
            for value in (None, 13, '', '13', '12345', '12a3', ' 0013', 'TKT-0013', '\u0660\u0660\u0661\u0663'):
                with self.subTest(backend=name, value=value):
                    before = copy.deepcopy(store.view())
                    with self.assertRaises(ValueError):
                        store.apply('new', {'eventId': 'invalid', 'ticket_no': value})
                    self.assertEqual(store.view(), before)

    def test_ticket_survives_checkout_and_retry_and_is_per_session(self):
        for name, store in self.stores():
            with self.subTest(backend=name):
                start = {'eventId': 'start', 'ticket_no': '0013'}
                sid = store.apply('new', start)['session']['id']
                self.assertEqual(store.apply('new', start)['session']['id'], sid)
                with self.assertRaises(ValueError):
                    store.apply('new', {**start, 'ticket_no': '0014'})
                store.apply('add', {'eventId': 'add', 'sessionId': sid, 'barcode': 'DEMO004'})
                request = {'eventId': 'checkout', 'sessionId': sid}
                store.apply('checkout', request)
                result = store.apply('checkout', request)
                self.assertEqual(result['checkouts'][0]['ticket_no'], 'TKT-0013')
                new = store.apply('new', {'eventId': 'next', 'ticket_no': '0002'})
                self.assertEqual(new['session']['ticket_no'], 'TKT-0002')
                self.assertEqual(new['checkouts'][0]['ticket_no'], 'TKT-0013')

    def test_legacy_session_requires_ticket_and_assignment_is_immutable(self):
        for name, store in self.stores():
            with self.subTest(backend=name):
                sid = store.apply('new', {'eventId': 'start', 'ticket_no': '0013'})['session']['id']
                if name == 'local':
                    session = store.state['sessions'][sid]
                else:
                    session = store.client.documents[store.root.collection('shoppingSessions').document(sid).path]
                session.pop('ticket_no')
                for action in ('add', 'remove', 'checkout'):
                    with self.assertRaises(ValueError):
                        store.apply(action, {'eventId': action, 'sessionId': sid, 'barcode': 'DEMO004'})
                request = {'eventId': 'ticket', 'sessionId': sid, 'ticket_no': '0007'}
                self.assertEqual(store.apply('ticket', request)['session']['ticket_no'], 'TKT-0007')
                self.assertEqual(store.apply('ticket', request)['session']['ticket_no'], 'TKT-0007')
                with self.assertRaises(ValueError):
                    store.apply('ticket', {**request, 'ticket_no': '0008'})
                with self.assertRaises(ValueError):
                    store.apply('ticket', {**request, 'eventId': 'different'})
                store.apply('add', {'eventId': 'valid-add', 'sessionId': sid, 'barcode': 'DEMO004'})
                self.assertEqual(store.view()['session']['items'][0]['quantity'], 1)

    def test_uncertain_cloud_ticket_commit_can_be_retried(self):
        store = self.stores()[1][1]
        request = {'eventId': 'start', 'ticket_no': '0001'}
        def disconnected(operation):
            store.client.run(operation)
            raise OSError('lost response')
        store.transaction_runner = disconnected
        from firestore_store import StorageUnavailable
        with self.assertRaises(StorageUnavailable):
            store.apply('new', request)
        store.transaction_runner = store.client.run
        result = store.apply('new', request)
        self.assertEqual(result['session']['ticket_no'], 'TKT-0001')
        sessions = [key for key in store.client.documents if '/shoppingSessions/' in key]
        self.assertEqual(len(sessions), 1)


if __name__ == '__main__':
    unittest.main()
