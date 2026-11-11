"""Copy the live catalog into a new cart workspace; never overwrite destination data."""
import argparse
import copy
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from firestore_store import open_firestore, validate_products

TARGET_PROJECT = 'mart-parking-fdd6b'
TARGET_WORKSPACE = 'shopping-cart'
TARGET_KEY = '.secrets/mart-parking-cart-service-account.json'
STAGE = 'local configuration'
WRITE_ATTEMPTED = False


def stage(message):
    global STAGE
    STAGE = message
    print('Checking: ' + message, flush=True)


def describe_failure(exc):
    causes = []
    details = []
    current = exc
    while current is not None and len(causes) < 5:
        causes.append(type(current).__name__)
        # Google API status text identifies disabled APIs and denied permissions;
        # never print credential objects, request payloads, or raw gRPC metadata.
        if type(current).__name__ == 'PermissionDenied':
            message = getattr(current, 'message', '')
            if message:
                details.append('Google permission error: ' + str(message)[:1500])
            reason = getattr(current, 'reason', None)
            if reason:
                details.append('Google error reason: ' + str(reason))
        current = current.__cause__
    categories = ' / '.join(causes)
    hints = {
        'PermissionDenied': 'Check Cloud Datastore permissions for the service account on the project named in the failed step; also confirm the Firestore API is enabled.',
        'Unauthenticated': 'Check that the service-account key is valid and has not been revoked.',
        'RefreshError': 'Credential token refresh failed. Check internet/proxy access, key validity, and your laptop clock.',
        'NotFound': 'Confirm the project has a Cloud Firestore (default) database.',
        'ServiceUnavailable': 'Cannot reach the cloud service. Check internet, DNS, firewall, or proxy settings.',
        'DeadlineExceeded': 'The cloud request timed out. Check network connectivity.',
        'AlreadyExists': 'Destination records already exist. Do not overwrite or delete them; inspect the previous attempt.',
        'TransportError': 'Cannot reach Google authentication services. Check network/proxy access.',
    }
    hint = next((text for name, text in hints.items() if name in causes),
                'Share these error types and the failed step for diagnosis; do not share credential contents.')
    outcome = ('A write was attempted; its outcome must be checked before retrying.' if WRITE_ATTEMPTED
               else 'No cloud writes were attempted. Active configuration is unchanged.')
    detail_text = '\n'.join(details)
    return f'Failed step: {STAGE}\nError types: {categories}\n{detail_text}\n{hint}\n{outcome}'


def connect(config):
    resolved = copy.deepcopy(config)
    resolved['credentialsPath'] = str((ROOT / config['credentialsPath']).resolve())
    return open_firestore(resolved)


def read_catalog(store):
    rows = store.root.collection('products').stream(timeout=10, retry=None)
    products = []
    for row in rows:
        product = row.to_dict()
        if product.get('id') != row.id:
            raise ValueError('Product ID differs from its document ID.')
        products.append(product)
    return sorted(validate_products(products), key=lambda product: product['id'])


def require_empty(root):
    stage('read destination workspace document: ' + TARGET_PROJECT)
    if root.get(timeout=10, retry=None).exists:
        raise ValueError('Destination workspace exists; refusing to modify it.')
    stage('list destination workspace subcollections: ' + TARGET_PROJECT)
    if list(root.collections(timeout=10, retry=None)):
        raise ValueError('Destination has subcollections; refusing to modify it.')


def main():
    global WRITE_ATTEMPTED
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--triggers-reviewed', action='store_true',
                        help='Owner confirmed creation will not cause unwanted trigger/extension effects.')
    args = parser.parse_args()
    if args.apply and not args.triggers_reviewed:
        raise ValueError('Owner must review database-wide triggers/extensions before --apply.')
    config_path = ROOT / 'database_config.json'
    original_text = config_path.read_text(encoding='utf-8')
    source_config = json.loads(original_text)
    if source_config.get('backend') != 'firestore':
        raise ValueError('Source must be the currently configured Firestore database.')
    if source_config.get('projectId') != 'smart-shopping-cart-33ab9':
        raise ValueError('Source is no longer the original cart project; refusing migration.')
    key_path = ROOT / TARGET_KEY
    if not key_path.is_file():
        raise ValueError('Save the new service-account key as ' + TARGET_KEY)
    # Inspect identity metadata only; never print credentials or private key material.
    key_project = json.loads(key_path.read_text(encoding='utf-8')).get('project_id')
    if key_project != TARGET_PROJECT:
        raise ValueError('The new credential file belongs to a different project.')
    target_config = {**source_config, 'projectId': TARGET_PROJECT,
                     'databaseId': '(default)', 'workspaceId': TARGET_WORKSPACE,
                     'credentialsPath': TARGET_KEY}
    stage('initialize source client: ' + source_config['projectId'])
    source = connect(source_config)
    stage('initialize destination client: ' + TARGET_PROJECT)
    target = connect(target_config)
    stage('read source catalog: ' + source_config['projectId'])
    products = read_catalog(source)
    if not products or len(products) > 400:
        raise ValueError('Expected 1–400 products for this single-batch migration.')
    stage('read destination workspace and subcollections: ' + TARGET_PROJECT)
    require_empty(target.root)
    print('Source:', source_config['projectId'], source_config['workspaceId'])
    print('Destination:', TARGET_PROJECT, 'shoppingCartWorkspaces/' + TARGET_WORKSPACE)
    print('Products:', len(products), '(live Firestore catalog; no session history)')
    if not args.apply:
        print('Read-only preview passed. No records or configuration changed.')
        return
    backup = ROOT / 'backups' / datetime.now(timezone.utc).strftime('catalog-migration-%Y%m%dT%H%M%S%fZ')
    backup.mkdir(parents=True)
    (backup / 'source-config.json').write_text(original_text, encoding='utf-8')
    (backup / 'products.json').write_text(json.dumps(products, indent=2, ensure_ascii=False), encoding='utf-8')
    if read_catalog(source) != products:
        raise ValueError('Source catalog changed during preparation. Retry during a quiet period.')
    require_empty(target.root)
    # create(), unlike set(), fails if any document already exists. The batch is atomic.
    batch = target.client.batch()
    batch.create(target.root, {'schemaVersion': 1, 'name': 'Smart Shopping Cart',
                              'migrationSource': source_config['projectId']})
    for product in products:
        batch.create(target.root.collection('products').document(product['id']), product)
    stage('create destination catalog: ' + TARGET_PROJECT)
    WRITE_ATTEMPTED = True
    batch.commit(timeout=15, retry=None)
    stage('verify copied catalog: ' + TARGET_PROJECT)
    if read_catalog(target) != products:
        raise ValueError('Copy could not be verified. Source config remains active; inspect destination before retrying.')
    if config_path.read_text(encoding='utf-8') != original_text:
        raise ValueError('Config changed during migration; verified copy exists but config was not switched.')
    temporary = ROOT / '.secrets' / 'migration-config.tmp'
    temporary.write_text(json.dumps(target_config, indent=2) + '\n', encoding='utf-8')
    os.replace(temporary, config_path)
    print('Catalog verified. Configuration switched; restart Python and start a new session.')
    print('Backup:', backup)
    print('Original database retained. No security rules or existing collections were changed by this script.')


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        # Suppress SDK exception details, which may contain sensitive request metadata.
        if isinstance(exc, (ValueError, FileNotFoundError)):
            raise SystemExit(str(exc))
        raise SystemExit(describe_failure(exc))
