importScripts('corrWorker.js');

const DB_NAME = 'ProdMemoDB';
const DB_VERSION = 4;
const PROD_MIGRATION_KEY = 'prod_corr_indexeddb_migration_v2';

let dbPromise = null;
let prodMigrationPromise = null;

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

            if (!db.objectStoreNames.contains('corrResults')) {
                db.createObjectStore('corrResults', { keyPath: ['alphaId', 'corrType'] });
            }
            if (!db.objectStoreNames.contains('prodCorrelations')) {
                db.createObjectStore('prodCorrelations', { keyPath: 'alphaId' });
            }
        };

        request.onsuccess = () => {
            const db = request.result;
            db.onversionchange = () => {
                db.close();
                dbPromise = null;
            };
            resolve(db);
        };
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
    const transaction = db.transaction(['alphas', 'pnls', 'prodCorrelations'], 'readonly');
    const alphaCountRequest = transaction.objectStore('alphas').count();
    const pnlCountRequest = transaction.objectStore('pnls').count();
    const prodCorrCountRequest = transaction.objectStore('prodCorrelations').count();
    const [alphaCount, pnlCount, prodCorrCount] = await Promise.all([
        requestResult(alphaCountRequest),
        requestResult(pnlCountRequest),
        requestResult(prodCorrCountRequest)
    ]);
    return { alphaCount, pnlCount, prodCorrCount };
}

async function clearIndexedDb() {
    const db = await openDatabase();
    const transaction = db.transaction(['alphas', 'pnls', 'corrResults', 'prodCorrelations'], 'readwrite');
    transaction.objectStore('alphas').clear();
    transaction.objectStore('pnls').clear();
    transaction.objectStore('corrResults').clear();
    transaction.objectStore('prodCorrelations').clear();
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

async function getCorrResults(alphaId) {
    const db = await openDatabase();
    const transaction = db.transaction(['corrResults', 'prodCorrelations'], 'readonly');
    const store = transaction.objectStore('corrResults');
    const selfRequest = store.get([alphaId, 'SELF']);
    const ppaRequest = store.get([alphaId, 'PPA']);
    const prodRequest = transaction.objectStore('prodCorrelations').get(alphaId);
    const [selfResult, ppa, prod] = await Promise.all([
        requestResult(selfRequest),
        requestResult(ppaRequest),
        requestResult(prodRequest)
    ]);
    const currentAlgorithmVersion = self.ProdMemoCorrCalculator.algorithmVersion;
    return {
        self: selfResult?.algorithmVersion === currentAlgorithmVersion ? selfResult : null,
        ppa: ppa?.algorithmVersion === currentAlgorithmVersion ? ppa : null,
        prod: prod || null
    };
}

function normalizeProdCorrRecord(alphaId, value) {
    if (!alphaId || !value || typeof value !== 'object') return null;
    if (value.result && typeof value.result === 'object') {
        return { alphaId, timestamp: value.timestamp || Date.now(), result: value.result };
    }
    return null;
}

async function ensureLegacyProdMigration() {
    if (prodMigrationPromise) return prodMigrationPromise;
    prodMigrationPromise = (async () => {
        const legacyData = await chrome.storage.local.get(null);
        const marker = legacyData[PROD_MIGRATION_KEY];
        const legacyRecords = [];
        for (const [key, value] of Object.entries(legacyData)) {
            if (!key.startsWith('prod_memo_')) continue;
            const alphaId = key.slice('prod_memo_'.length);
            const record = normalizeProdCorrRecord(alphaId, value);
            if (record) legacyRecords.push(record);
        }

        // Old markers did not record the scanned legacy count and must run again.
        // A matching v2 marker preserves the expected behavior after an intentional IndexedDB clear.
        if (marker?.completed && marker.legacyCount === legacyRecords.length) return marker;

        const db = await openDatabase();
        const existingTransaction = db.transaction('prodCorrelations', 'readonly');
        const existingRecords = await requestResult(existingTransaction.objectStore('prodCorrelations').getAll());
        const recordsById = new Map();
        const invalidExistingIds = [];

        for (const value of existingRecords) {
            const record = normalizeProdCorrRecord(value.alphaId, value);
            if (record) {
                recordsById.set(record.alphaId, record);
            } else if (value?.alphaId) {
                invalidExistingIds.push(value.alphaId);
            }
        }
        for (const record of legacyRecords) {
            const alphaId = record.alphaId;
            const existing = recordsById.get(alphaId);
            if (!existing || record.timestamp >= existing.timestamp) recordsById.set(alphaId, record);
        }

        if (recordsById.size > 0 || invalidExistingIds.length > 0) {
            const transaction = db.transaction('prodCorrelations', 'readwrite');
            const store = transaction.objectStore('prodCorrelations');
            invalidExistingIds.forEach(alphaId => store.delete(alphaId));
            recordsById.forEach(record => store.put(record));
            await transactionDone(transaction);
        }

        const result = {
            completed: true,
            count: recordsById.size,
            legacyCount: legacyRecords.length,
            removedInvalidCount: invalidExistingIds.length,
            migratedAt: Date.now()
        };
        await chrome.storage.local.set({ [PROD_MIGRATION_KEY]: result });
        return result;
    })().catch(error => {
        prodMigrationPromise = null;
        throw error;
    });
    return prodMigrationPromise;
}

async function saveProdCorr(alphaId, value) {
    const record = normalizeProdCorrRecord(alphaId, value);
    if (!record) throw new Error('Invalid Prod Corr record');
    const db = await openDatabase();
    const transaction = db.transaction('prodCorrelations', 'readwrite');
    transaction.objectStore('prodCorrelations').put(record);
    await transactionDone(transaction);
    return record;
}

async function importProdCorrs(entries) {
    const records = entries
        .map(([alphaId, value]) => normalizeProdCorrRecord(alphaId, value))
        .filter(Boolean);
    if (records.length === 0) return { imported: 0 };

    const db = await openDatabase();
    const transaction = db.transaction('prodCorrelations', 'readwrite');
    const store = transaction.objectStore('prodCorrelations');
    records.forEach(record => store.put(record));
    await transactionDone(transaction);
    return { imported: records.length };
}

async function getProdCorr(alphaId) {
    const db = await openDatabase();
    const transaction = db.transaction('prodCorrelations', 'readonly');
    return (await requestResult(transaction.objectStore('prodCorrelations').get(alphaId))) || null;
}

async function getProdCorrs(alphaIds = null) {
    const db = await openDatabase();
    const transaction = db.transaction('prodCorrelations', 'readonly');
    const records = await requestResult(transaction.objectStore('prodCorrelations').getAll());
    const requested = alphaIds ? new Set(alphaIds) : null;
    const result = {};
    for (const record of records) {
        if (!requested || requested.has(record.alphaId)) {
            result[record.alphaId] = { timestamp: record.timestamp, result: record.result };
        }
    }
    return { memoData: result, count: Object.keys(result).length };
}

function buildListCorrMemoData(alphaIds, localRecords, prodRecords) {
    const requested = new Set(alphaIds || []);
    const valuesByAlpha = new Map();

    const addValue = (alphaId, value) => {
        if (!requested.has(alphaId) || !Number.isFinite(value)) return;
        const values = valuesByAlpha.get(alphaId) || [];
        values.push(value);
        valuesByAlpha.set(alphaId, values);
    };

    localRecords.forEach(record => {
        if ((record.corrType === 'SELF' || record.corrType === 'PPA')
            && record.algorithmVersion !== self.ProdMemoCorrCalculator.algorithmVersion) return;
        if (record.corrType === 'SELF' || record.corrType === 'PPA') {
            addValue(record.alphaId, record.result?.max);
        }
    });
    prodRecords.forEach(record => addValue(record.alphaId, record.result?.max));

    const memoData = {};
    valuesByAlpha.forEach((values, alphaId) => {
        memoData[alphaId] = { result: { max: Math.max(...values) } };
    });
    return memoData;
}

async function getListCorrs(alphaIds) {
    const db = await openDatabase();
    const transaction = db.transaction(['corrResults', 'prodCorrelations'], 'readonly');
    const [localRecords, prodRecords] = await Promise.all([
        requestResult(transaction.objectStore('corrResults').getAll()),
        requestResult(transaction.objectStore('prodCorrelations').getAll())
    ]);
    return { memoData: buildListCorrMemoData(alphaIds, localRecords, prodRecords) };
}

async function clearProdCorrs() {
    const db = await openDatabase();
    const transaction = db.transaction('prodCorrelations', 'readwrite');
    transaction.objectStore('prodCorrelations').clear();
    await transactionDone(transaction);
    return { cleared: true };
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
        case 'GET_CORR_RESULTS':
            return getCorrResults(payload.alphaId);
        case 'CALCULATE_CORR':
            return self.ProdMemoCorrCalculator.calculateCorrelation(payload);
        case 'SAVE_PROD_CORR':
            return saveProdCorr(payload.alphaId, payload.value);
        case 'IMPORT_PROD_CORRS':
            return importProdCorrs(payload.entries || []);
        case 'GET_PROD_CORR':
            return getProdCorr(payload.alphaId);
        case 'GET_PROD_CORRS':
            return getProdCorrs(payload.alphaIds || null);
        case 'GET_LIST_CORRS':
            return getListCorrs(payload.alphaIds || []);
        case 'CLEAR_PROD_CORRS':
            return clearProdCorrs();
        default:
            throw new Error(`Unknown database action: ${action}`);
    }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== 'PROD_MEMO_DB') return false;

    ensureLegacyProdMigration()
        .then(() => handleDatabaseAction(message.action, message.payload))
        .then(result => sendResponse({ ok: true, result }))
        .catch(error => {
            console.error('[ProdMemo] IndexedDB action failed:', error);
            sendResponse({ ok: false, error: error.message || String(error) });
        });

    return true;
});
