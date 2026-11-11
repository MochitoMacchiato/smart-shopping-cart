"""Check Firestore access and copy the local catalog without overwriting cloud products."""
import argparse
import json
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from app import configured_store
from firestore_store import FirestoreStore, validate_products


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['check', 'seed-products'])
    parser.add_argument('--apply', action='store_true', help='Actually create missing products; default is a read-only preview.')
    args = parser.parse_args()
    store = configured_store()
    if not isinstance(store, FirestoreStore):
        raise SystemExit('First create database_config.json using database_config.example.json and configure Firestore.')
    existing = {p['id']: p for p in store.products()}
    print(f'Project: {store.client.project}; workspace: {store.workspace_id}; cart: {store.cart_id}')
    print(f'Firestore read access OK. Existing products: {len(existing)}')
    if args.command == 'check':
        print('This check did not write anything. Write access is exercised when seeding or creating a cart session.')
        return
    products = validate_products(json.loads((ROOT / 'data/products.json').read_text(encoding='utf-8')))
    planned = [p for p in products if p['id'] not in existing]
    validate_products([*existing.values(), *planned])
    print(f'Create {len(planned)} products; preserve {len(products) - len(planned)} existing product IDs.')
    for product in planned:
        print(f"  {product['id']}: {product['barcode']} / {product['name']}")
    if not args.apply:
        print('Preview only. Run again with --apply to create the missing products.')
        return
    backup = ROOT / 'backups' / datetime.now(timezone.utc).strftime('before-firestore-%Y%m%dT%H%M%S%fZ')
    backup.mkdir(parents=True)
    for filename in ('products.json', 'sessions.json'):
        source = ROOT / 'data' / filename
        if source.exists():
            shutil.copy2(source, backup / filename)

    def seed(transaction):
        cloud = {p['id']: p for p in store.products(transaction=transaction)}
        missing = [p for p in products if p['id'] not in cloud]
        validate_products([*cloud.values(), *missing])
        for product in missing:
            transaction.set(store.root.collection('products').document(product['id']), product)
        transaction.set(store.root, {'schemaVersion': 1, 'name': 'Smart Shopping Cart'}, merge=True)
        return len(missing)

    count = store.transaction_runner(seed)
    print(f'Created {count} products. Local backup: {backup}')
    print('Existing local session history remains in JSON; new cloud sessions start separately.')


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        raise SystemExit('Firestore setup failed: ' + str(exc))
