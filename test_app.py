import json
import tempfile
import unittest
from pathlib import Path
from app import CartStore, ROOT


class CartTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        (self.directory / 'products.json').write_bytes((ROOT / 'data/products.json').read_bytes())
        self.store = CartStore(self.directory)
        self.store.apply('new', {'eventId': 'start', 'ticket_no': '0013'})
        self.sid = self.store.view()['session']['id']

    def event(self, action, eid, barcode='DEMO004'):
        return self.store.apply(action, {'eventId': eid, 'sessionId': self.sid, 'barcode': barcode})

    def test_quantities_totals_and_retry(self):
        self.event('add', 'one')
        self.event('add', 'one')
        self.event('add', 'two')
        self.assertEqual(self.store.view()['session']['totalCentavos'], 3100)
        self.event('remove', 'three')
        self.assertEqual(self.store.view()['session']['totalCentavos'], 1550)
        with self.assertRaises(ValueError):
            self.event('remove', 'one')

    def test_unknown_and_missing_item_leave_cart_unchanged(self):
        before = json.dumps(self.store.view())
        for action, barcode in [('add', 'UNKNOWN'), ('remove', 'DEMO001')]:
            with self.assertRaises(ValueError):
                self.event(action, action, barcode)
        self.assertEqual(json.dumps(self.store.view()), before)

    def test_checkout_lock_persistence_and_new_session(self):
        with self.assertRaises(ValueError):
            self.event('checkout', 'empty')
        self.event('add', 'one')
        self.event('checkout', 'done')
        self.event('checkout', 'done')
        with self.assertRaises(ValueError):
            self.event('add', 'two')
        restored = CartStore(self.directory)
        self.assertEqual(restored.view(), self.store.view())
        self.store.apply('new', {'eventId': 'second-start', 'ticket_no': '0013'})
        self.assertEqual(len(self.store.view()['checkouts']), 1)
        self.assertEqual(self.store.view()['session']['items'], [])

    def test_start_retry_and_leading_zero_barcode(self):
        self.store.apply('new', {'eventId': 'start', 'ticket_no': '0013'})
        self.assertEqual(self.store.view()['session']['id'], self.sid)
        products = self.store.products()
        products[0]['barcode'] = '001234'
        (self.directory / 'products.json').write_text(json.dumps(products), encoding='utf-8')
        self.event('add', 'zero', '001234')
        self.assertEqual(self.store.view()['session']['items'][0]['barcode'], '001234')


if __name__ == '__main__':
    unittest.main()
