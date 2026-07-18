(() => {
const DB_NAME = 'ProdMemoDB';
const DB_VERSION = 4;
const ALGORITHM_VERSION = 4;
const YEARS = 4;
const POWER_POOL_CLASSIFICATION = 'POWER_POOL:POWER_POOL_ELIGIBLE';
const REGULAR_CLASSIFICATION = 'REGULAR:REGULAR';

const RESULT_PROPERTIES = [
    { name: 'id', title: 'Id', type: 'string' },
    { name: 'name', title: 'Name', type: 'string' },
    { name: 'instrumentType', title: 'Instrument Type', type: 'string' },
    { name: 'region', title: 'Region', type: 'string' },
    { name: 'universe', title: 'Universe', type: 'string' },
    { name: 'correlation', title: 'Correlation', type: 'decimal' },
    { name: 'sharpe', title: 'Sharpe', type: 'decimal' },
    { name: 'returns', title: 'Returns', type: 'percent' },
    { name: 'turnover', title: 'Turnover', type: 'percent' },
    { name: 'fitness', title: 'Fitness', type: 'decimal' },
    { name: 'margin', title: 'Margin', type: 'permyriad' }
];

function resultSchema(corrType) {
    return {
        name: corrType === 'SELF' ? 'selfCorrelation' : 'powerPoolCorrelation',
        title: corrType === 'SELF' ? 'Self Correlated' : 'Power Pool Correlated',
        properties: RESULT_PROPERTIES
    };
}

function requestResult(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function transactionDone(transaction) {
    return new Promise((resolve, reject) => {
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted'));
    });
}

function openDatabase() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains('alphas')) {
                db.createObjectStore('alphas', { keyPath: 'id' });
            }
            if (!db.objectStoreNames.contains('pnls')) {
                db.createObjectStore('pnls', { keyPath: 'alphaId' });
            }
            if (!db.objectStoreNames.contains('corrResults')) {
                db.createObjectStore('corrResults', { keyPath: ['alphaId', 'corrType'] });
            }
            if (!db.objectStoreNames.contains('prodCorrelations')) {
                db.createObjectStore('prodCorrelations', { keyPath: 'alphaId' });
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function normalizePnl(data) {
    if (!data || !Array.isArray(data.records)) return [];
    return data.records
        .filter(record => Array.isArray(record) && record.length >= 2 && record[0] && Number.isFinite(Number(record[1])))
        .map(record => [String(record[0]).slice(0, 10), Number(record[1])])
        .sort((a, b) => a[0].localeCompare(b[0]));
}

function calendarWindowStart(records) {
    if (records.length === 0) return null;
    const lastYear = Number(records[records.length - 1][0].slice(0, 4));
    return `${lastYear - YEARS + 1}-01-01`;
}

function calculateReturns(records, startDate) {
    const returns = new Map();
    let previous = null;
    for (const [date, value] of records) {
        if (previous !== null && date >= startDate) returns.set(date, value - previous);
        previous = value;
    }
    return returns;
}

function calculateForwardFilledReturns(records, dates, startDate) {
    const returns = new Map();
    let recordIndex = 0;
    let currentValue = null;
    let previousValue = null;

    for (const date of dates) {
        while (recordIndex < records.length && records[recordIndex][0] <= date) {
            currentValue = records[recordIndex][1];
            recordIndex++;
        }
        if (currentValue === null) continue;
        if (previousValue !== null && date >= startDate) {
            returns.set(date, currentValue - previousValue);
        }
        previousValue = currentValue;
    }
    return returns;
}

function pearson(targetReturns, peerReturns) {
    let count = 0;
    let sumX = 0;
    let sumY = 0;
    let sumXX = 0;
    let sumYY = 0;
    let sumXY = 0;

    for (const [date, x] of targetReturns) {
        if (!peerReturns.has(date)) continue;
        const y = peerReturns.get(date);
        count++;
        sumX += x;
        sumY += y;
        sumXX += x * x;
        sumYY += y * y;
        sumXY += x * y;
    }

    if (count < 2) return null;
    const covariance = count * sumXY - sumX * sumY;
    const varianceX = count * sumXX - sumX * sumX;
    const varianceY = count * sumYY - sumY * sumY;
    const denominator = Math.sqrt(varianceX * varianceY);
    if (!Number.isFinite(denominator) || denominator === 0) return null;
    const value = covariance / denominator;
    return Number.isFinite(value) ? { value, overlapCount: count } : null;
}

function isPowerPoolAlpha(alpha) {
    return (alpha.classifications || []).some(item =>
        (item?.id || item) === POWER_POOL_CLASSIFICATION
    );
}

function isRegularAlpha(alpha) {
    return (alpha.classifications || []).some(item =>
        (item?.id || item) === REGULAR_CLASSIFICATION
    );
}

function selectPool(alphas, pnlById, alphaId, region, corrType) {
    return alphas.filter(alpha => {
        if (alpha.id === alphaId
            || alpha.settings?.region !== region
            || !pnlById.has(alpha.id)) return false;
        if (corrType === 'SELF') {
            return alpha.stage === 'OS' && (!isPowerPoolAlpha(alpha) || isRegularAlpha(alpha));
        }
        if (corrType === 'PPA') return isPowerPoolAlpha(alpha);
        return false;
    });
}

function makeOfficialRecord(alpha, correlation) {
    return [
        alpha.id,
        alpha.name ?? null,
        alpha.settings?.instrumentType ?? null,
        alpha.settings?.region ?? null,
        alpha.settings?.universe ?? null,
        correlation,
        alpha.is?.sharpe ?? null,
        alpha.is?.returns ?? null,
        alpha.is?.turnover ?? null,
        alpha.is?.fitness ?? null,
        alpha.is?.margin ?? null
    ];
}

function roundOfficial(value) {
    return Math.round((value + Number.EPSILON) * 10000) / 10000;
}

function buildOfficialResult(corrType, correlations) {
    const values = correlations.map(item => item.value);
    return {
        schema: resultSchema(corrType),
        records: correlations.slice(0, 5).map(item => makeOfficialRecord(item.alpha, roundOfficial(item.value))),
        min: roundOfficial(Math.min(...values)),
        max: roundOfficial(Math.max(...values))
    };
}

function fingerprintPool(alphas, pnlById) {
    const source = alphas.map(alpha => {
        const records = normalizePnl(pnlById.get(alpha.id));
        return `${alpha.id}:${records.at(-1)?.[0] || ''}:${records.length}`;
    }).sort().join('|');
    let hash = 2166136261;
    for (let index = 0; index < source.length; index++) {
        hash ^= source.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
}

async function calculateCorrelation({ alphaId, corrType, targetAlpha, targetPnl }) {
    const db = await openDatabase();
    const readTransaction = db.transaction(['alphas', 'pnls'], 'readonly');
    const alphaRequest = readTransaction.objectStore('alphas').getAll();
    const pnlRequest = readTransaction.objectStore('pnls').getAll();
    const [alphas, pnls] = await Promise.all([
        requestResult(alphaRequest),
        requestResult(pnlRequest)
    ]);
    const alphaById = new Map(alphas.map(alpha => [alpha.id, alpha]));
    const pnlById = new Map(pnls.map(pnl => [pnl.alphaId, pnl]));

    const resolvedTargetAlpha = targetAlpha || alphaById.get(alphaId);
    const resolvedTargetPnl = targetPnl || pnlById.get(alphaId);
    if (!resolvedTargetAlpha) throw new Error(`Target Alpha metadata is unavailable: ${alphaId}`);
    if (!resolvedTargetPnl) throw new Error(`Target PnL is unavailable: ${alphaId}`);

    const region = resolvedTargetAlpha.settings?.region;
    if (!region) throw new Error('Target Alpha region is unavailable');

    const pool = selectPool(alphas, pnlById, alphaId, region, corrType);
    if (pool.length === 0) throw new Error(`No eligible ${corrType} Alpha PnL found for ${region}`);

    const targetRecords = normalizePnl(resolvedTargetPnl);
    if (targetRecords.length < 2) throw new Error('Target PnL has insufficient records');
    const targetStartDate = calendarWindowStart(targetRecords);
    const targetReturns = calculateReturns(targetRecords, targetStartDate);
    const globalDates = [...new Set(pnls.flatMap(pnl => normalizePnl(pnl).map(record => record[0])))].sort();
    const poolStartDate = globalDates.length > 0
        ? `${Number(globalDates.at(-1).slice(0, 4)) - YEARS + 1}-01-01`
        : targetStartDate;
    const correlations = [];

    for (const alpha of pool) {
        const peerRecords = normalizePnl(pnlById.get(alpha.id));
        const peerReturns = calculateForwardFilledReturns(peerRecords, globalDates, poolStartDate);
        const correlation = pearson(targetReturns, peerReturns);
        if (correlation) correlations.push({ alpha, ...correlation });
    }
    correlations.sort((a, b) => b.value - a.value);
    if (correlations.length === 0) throw new Error('No valid overlapping PnL correlations were produced');

    const result = buildOfficialResult(corrType, correlations);
    const record = {
        alphaId,
        corrType,
        result,
        calculatedAt: Date.now(),
        algorithmVersion: ALGORITHM_VERSION,
        poolFingerprint: fingerprintPool(pool, pnlById),
        poolSize: pool.length,
        corrCount: correlations.length,
        windowStart: targetStartDate > poolStartDate ? targetStartDate : poolStartDate,
        windowEnd: targetRecords.at(-1)[0]
    };

    const writeTransaction = db.transaction('corrResults', 'readwrite');
    writeTransaction.objectStore('corrResults').put(record);
    await transactionDone(writeTransaction);
    db.close();
    return record;
}

self.ProdMemoCorrCalculator = {
    algorithmVersion: ALGORITHM_VERSION,
    calculateCorrelation,
    test: {
        calendarWindowStart,
        calculateReturns,
        calculateForwardFilledReturns,
        pearson,
        isPowerPoolAlpha,
        isRegularAlpha,
        selectPool,
        resultSchema,
        roundOfficial,
        buildOfficialResult
    }
};
})();
