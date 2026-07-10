const DB_NAME = 'ProdMemoDB';
const DB_VERSION = 2;

let dbPromise = null;

function openDatabase() {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains('alphas')) {
                db.createObjectStore('alphas', { keyPath: 'id' });
            }

            if (db.objectStoreNames.contains('pnls')) {
                const pnlStore = request.transaction.objectStore('pnls');
                if (pnlStore.keyPath !== 'alphaId') {
                    db.deleteObjectStore('pnls');
                    db.createObjectStore('pnls', { keyPath: 'alphaId' });
                }
            } else {
                db.createObjectStore('pnls', { keyPath: 'alphaId' });
            }
        };

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => {
            dbPromise = null;
            reject(request.error);
        };
    });

    return dbPromise;
}

function transactionDone(transaction) {
    return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted'));
    });
}

function requestResult(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function saveAlphaBatch(alphas) {
    const submitted = alphas.filter(alpha => alpha?.id && alpha.dateSubmitted && alpha.status !== 'UNSUBMITTED');
    if (submitted.length === 0) return { saved: 0 };

    const db = await openDatabase();
    const transaction = db.transaction('alphas', 'readwrite');
    const store = transaction.objectStore('alphas');
    submitted.forEach(alpha => store.put(alpha));
    await transactionDone(transaction);
    return { saved: submitted.length };
}

async function savePnl(alphaId, data) {
    if (!alphaId || !data || !Array.isArray(data.records)) {
        throw new Error('Invalid PnL payload');
    }

    const db = await openDatabase();
    const transaction = db.transaction('pnls', 'readwrite');
    transaction.objectStore('pnls').put({ ...data, alphaId });
    await transactionDone(transaction);
    return { saved: data.records.length };
}

async function reconcileAlphas(alphaIds) {
    const keepIds = new Set(alphaIds);
    const db = await openDatabase();
    const readTransaction = db.transaction('alphas', 'readonly');
    const existingIds = await requestResult(readTransaction.objectStore('alphas').getAllKeys());
    const transaction = db.transaction(['alphas', 'pnls'], 'readwrite');
    const alphaStore = transaction.objectStore('alphas');
    const pnlStore = transaction.objectStore('pnls');

    let deleted = 0;
    for (const alphaId of existingIds) {
        if (!keepIds.has(alphaId)) {
            alphaStore.delete(alphaId);
            pnlStore.delete(alphaId);
            deleted++;
        }
    }

    await transactionDone(transaction);
    return { deleted };
}

async function getStats() {
    const db = await openDatabase();
    const transaction = db.transaction(['alphas', 'pnls'], 'readonly');
    const alphaCountRequest = transaction.objectStore('alphas').count();
    const pnlCountRequest = transaction.objectStore('pnls').count();
    const [alphaCount, pnlCount] = await Promise.all([
        requestResult(alphaCountRequest),
        requestResult(pnlCountRequest)
    ]);
    return { alphaCount, pnlCount };
}

async function clearIndexedDb() {
    const db = await openDatabase();
    const transaction = db.transaction(['alphas', 'pnls'], 'readwrite');
    transaction.objectStore('alphas').clear();
    transaction.objectStore('pnls').clear();
    await transactionDone(transaction);
    return { cleared: true };
}

async function getMissingPnlIds(alphaIds) {
    const db = await openDatabase();
    const transaction = db.transaction('pnls', 'readonly');
    const storedIds = new Set(await requestResult(transaction.objectStore('pnls').getAllKeys()));
    return { missingIds: alphaIds.filter(alphaId => !storedIds.has(alphaId)) };
}

async function getIncrementalSyncState() {
    const db = await openDatabase();
    const transaction = db.transaction(['alphas', 'pnls'], 'readonly');
    const alphaIdsRequest = transaction.objectStore('alphas').getAllKeys();
    const pnlIdsRequest = transaction.objectStore('pnls').getAllKeys();
    const [alphaIds, pnlIdList] = await Promise.all([
        requestResult(alphaIdsRequest),
        requestResult(pnlIdsRequest)
    ]);
    const pnlIds = new Set(pnlIdList);
    return {
        alphaIds,
        missingPnlIds: alphaIds.filter(alphaId => !pnlIds.has(alphaId))
    };
}

async function handleDatabaseAction(action, payload = {}) {
    switch (action) {
        case 'SAVE_ALPHA_BATCH':
            return saveAlphaBatch(payload.alphas || []);
        case 'SAVE_PNL':
            return savePnl(payload.alphaId, payload.data);
        case 'RECONCILE_ALPHAS':
            return reconcileAlphas(payload.alphaIds || []);
        case 'GET_STATS':
            return getStats();
        case 'CLEAR_INDEXED_DB':
            return clearIndexedDb();
        case 'GET_MISSING_PNL_IDS':
            return getMissingPnlIds(payload.alphaIds || []);
        case 'GET_INCREMENTAL_SYNC_STATE':
            return getIncrementalSyncState();
        default:
            throw new Error(`Unknown database action: ${action}`);
    }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== 'PROD_MEMO_DB') return false;

    handleDatabaseAction(message.action, message.payload)
        .then(result => sendResponse({ ok: true, result }))
        .catch(error => {
            console.error('[ProdMemo] IndexedDB action failed:', error);
            sendResponse({ ok: false, error: error.message || String(error) });
        });

    return true;
});
