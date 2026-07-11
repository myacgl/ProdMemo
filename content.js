// Inject the main world script
const script = document.createElement('script');
script.src = chrome.runtime.getURL('inject.js');
script.onload = function () {
    this.remove();
};
(document.head || document.documentElement).appendChild(script);

let currentAlphaId = null;
let contextValid = true; // Track if extension context is still valid
let contextWarnedOnce = false; // Track if we've already warned about context invalidation
let incrementalSyncRunning = false;
let pendingCorrCalculation = false;
let corrCalculationRunning = false;
let loadedCorrAlphaId = null;
const currentPageAlphas = new Map();
const currentPagePnls = new Map();
const currentDataRequests = new Map();

// Detect extension context invalidation
if (typeof chrome !== 'undefined' && chrome.runtime) {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message?.type === 'PROD_MEMO_STOP_FULL_SYNC') {
            window.postMessage({ type: 'PROD_MEMO_STOP_FULL_SYNC' }, '*');
            sendResponse({ stopping: true });
            return false;
        }

        if (message?.type !== 'PROD_MEMO_START_FULL_SYNC') return false;

        window.postMessage({
            type: 'PROD_MEMO_START_FULL_SYNC',
            syncId: message.syncId
        }, '*');
        sendResponse({ started: true });
        return false;
    });
    // Test if context is valid
    try {
        chrome.runtime.getURL('');
    } catch (e) {
        contextValid = false;
        console.warn('[ProdMemo] Extension context invalidated. Script will stop.');
    }
}

// Listen for messages from inject.js
window.addEventListener('message', async (event) => {
    if (!contextValid) return; // Stop if context is invalid
    if (event.source !== window) return;

    if (event.data.type === 'PROD_MEMO_DB_REQUEST') {
        const { requestId, action, payload } = event.data;
        try {
            const response = await chrome.runtime.sendMessage({
                type: 'PROD_MEMO_DB',
                action,
                payload
            });
            window.postMessage({
                type: 'PROD_MEMO_DB_RESPONSE',
                requestId,
                response
            }, '*');
        } catch (error) {
            window.postMessage({
                type: 'PROD_MEMO_DB_RESPONSE',
                requestId,
                response: { ok: false, error: error.message || String(error) }
            }, '*');
        }
        return;
    }

    if (event.data.type === 'PROD_MEMO_SYNC_PROGRESS') {
        updateIncrementalSyncButton(event.data.payload);
        handleCorrSyncProgress(event.data.payload);
        chrome.runtime.sendMessage({
            type: 'PROD_MEMO_SYNC_PROGRESS',
            payload: event.data.payload
        }).catch(error => {
            if (!error.message?.includes('Receiving end does not exist')) {
                console.warn('[ProdMemo] Failed to forward sync progress:', error);
            }
        });
        return;
    }

    if (event.data.type === 'PROD_MEMO_CURRENT_ALPHA') {
        currentPageAlphas.set(event.data.alphaId, event.data.data);
        if (window.location.pathname.startsWith('/simulate')) selectCurrentAlpha(event.data.alphaId);
        return;
    }

    if (event.data.type === 'PROD_MEMO_CURRENT_PNL') {
        currentPagePnls.set(event.data.alphaId, event.data.data);
        if (window.location.pathname.startsWith('/simulate')) selectCurrentAlpha(event.data.alphaId);
        return;
    }

    if (event.data.type === 'PROD_MEMO_TARGET_ALPHA') {
        selectCurrentAlpha(event.data.alphaId);
        return;
    }

    if (event.data.type === 'PROD_MEMO_CURRENT_DATA_RESPONSE') {
        const pending = currentDataRequests.get(event.data.requestId);
        if (!pending) return;
        currentDataRequests.delete(event.data.requestId);
        clearTimeout(pending.timeoutId);
        if (event.data.ok) {
            pending.resolve(event.data.data);
        } else {
            pending.reject(new Error(event.data.error || 'Current Alpha data request failed'));
        }
        return;
    }

    // DATA CAPTURE
    if (event.data.type === 'PROD_MEMO_DATA') {
        try {
            if (!chrome.runtime?.id) {
                contextValid = false;
                console.warn('[ProdMemo] Extension context lost. Stopping script.');
                return;
            }

            const { alphaId, data } = event.data;
            console.log(`[ProdMemo] Received data for Alpha ${alphaId}`, data);

            const record = await databaseAction('SAVE_PROD_CORR', {
                alphaId,
                value: {
                    timestamp: Date.now(),
                    result: data
                }
            });

            console.log(`[ProdMemo] Prod Corr saved to IndexedDB for ${alphaId}`);

            // If we are currently viewing this alpha, update the UI immediately
            // Special handle for 'unsubmitted' pages where URL ID hasn't updated yet
            // OR the user just ran a check on the currently open page.
            const currentUrlId = getAlphaFromUrl();
            if (currentAlphaId === alphaId || currentUrlId === alphaId || currentUrlId === 'unsubmitted') {
                ensureLocalCorrCards();
                renderCorrResult('PROD', record);
            }
        } catch (error) {
            if (error.message.includes('Extension context invalidated')) {
                contextValid = false;
                console.warn('[ProdMemo] Extension context invalidated. Stopping script.');
                return;
            }
            console.error('[ProdMemo] Error saving data:', error);
        }
    }

    // VIEW TRIGGER (from /recordsets)
    if (event.data.type === 'PROD_MEMO_VIEW') {
        const { alphaId } = event.data;
        console.log(`[ProdMemo] View detected for Alpha ${alphaId}`);
        selectCurrentAlpha(alphaId);
    }

    // LIST VIEW TRIGGER (from /users/self/alphas)
    if (event.data.type === 'PROD_MEMO_LIST') {
        const { alphaIds } = event.data;
        console.log(`[ProdMemo] List view detected with ${alphaIds.length} alphas`);

        if (!contextValid || !chrome.runtime?.id) {
            if (!contextWarnedOnce) {
                console.warn('[ProdMemo] Extension context invalid, stopping all operations');
                contextWarnedOnce = true;
            }
            return;
        }

        // Query the highest saved Self, PPA, or Prod Corr for each visible Alpha.
        databaseAction('GET_LIST_CORRS', { alphaIds }).then(({ memoData }) => {
            const cachedData = {};
            Object.entries(memoData).forEach(([alphaId, value]) => {
                cachedData[`prod_memo_${alphaId}`] = value;
            });
            console.log('[ProdMemo] Retrieved cached data, injecting into list...');
            injectListCorrelations(alphaIds, cachedData);
        }).catch(error => {
            console.error('[ProdMemo] Error querying cached data for list:', error);
        });
    }
});

// START: Lifecycle Management
// Simplified URL polling - mainly for cleanup when leaving alpha pages
// Navigation detection is primarily handled by /recordsets API requests
setInterval(() => {
    if (!contextValid) return; // Stop if context is invalid

    // Check for both /alpha/ (singular) and /alphas/ (plural)
    const isOnAlphaPage = window.location.href.includes('/alpha/')
        || window.location.href.includes('/alphas/')
        || window.location.href.includes('/simulate');

    // Only cleanup when definitively navigating away from alpha pages
    // Be conservative: only cleanup if we're NOT on an alpha page at all
    if (currentAlphaId && !isOnAlphaPage) {
        console.log('[ProdMemo] Navigated away from Alphas. Cleaning up.');
        cleanupCard();
    }
}, 2000);

// Add title attributes to truncated alpha names for native tooltips
const titleObserver = new MutationObserver(() => {
    const titleElement = document.querySelector('.alphas-details-content__header-title');
    if (titleElement && !titleElement.hasAttribute('title')) {
        titleElement.setAttribute('title', titleElement.textContent.trim());
    }
    ensureIncrementalSyncButton();
    ensureLocalCorrCards();
});

// content.js runs at document_start, when document.body may not exist yet.
// Observe the Document itself so SPA-rendered correlation content is always detected.
titleObserver.observe(document, {
    childList: true,
    subtree: true
});
document.addEventListener('DOMContentLoaded', ensureIncrementalSyncButton, { once: true });
document.addEventListener('DOMContentLoaded', ensureLocalCorrCards, { once: true });

function ensureIncrementalSyncButton() {
    if (!contextValid) return;
    const title = document.querySelector('#alphas-correlation .correlation__title');
    if (!title) return;

    title.style.display = 'flex';
    title.style.alignItems = 'center';

    if (!document.getElementById('prod-memo-incremental-sync')) {
        const button = document.createElement('button');
        button.id = 'prod-memo-incremental-sync';
        button.className = 'prod-memo-sync-button';
        button.type = 'button';
        button.textContent = 'Calculate Local Corr';
        button.addEventListener('click', async () => {
            if (incrementalSyncRunning) {
                button.textContent = 'Stopping...';
                window.postMessage({ type: 'PROD_MEMO_STOP_FULL_SYNC' }, '*');
                return;
            }
            await startCombinedCorrWorkflow();
        });
        title.appendChild(button);
    }

    if (!document.getElementById('prod-memo-all-corr')) {
        const button = document.createElement('button');
        button.id = 'prod-memo-all-corr';
        button.className = 'prod-memo-sync-button';
        button.type = 'button';
        button.textContent = 'Calculate All Corr';
        button.addEventListener('click', async () => {
            if (incrementalSyncRunning || corrCalculationRunning || pendingCorrCalculation) return;
            setAllCorrButtonRunning(true);
            const prodSection = Array.from(
                document.querySelectorAll('#alphas-correlation .correlation__content')
            ).find(section => section.querySelector('.correlation__content-status-title')
                ?.textContent.trim() === 'Prod Correlation');
            prodSection?.querySelector('.correlation__content-status-time-refresh')?.click();
            await startCombinedCorrWorkflow(true);
        });
        title.appendChild(button);
    }
}

function setAllCorrButtonRunning(running) {
    const button = document.getElementById('prod-memo-all-corr');
    if (!button) return;
    button.disabled = running;
    button.textContent = running ? 'Calculating All...' : 'Calculate All Corr';
}

function updateIncrementalSyncButton(progress) {
    if (progress?.mode !== 'incremental') return;
    const button = document.getElementById('prod-memo-incremental-sync');
    if (!button) return;

    if (progress.phase === 'incremental-check') button.textContent = 'Checking...';
    if (progress.phase === 'incremental-alphas') button.textContent = `New: ${progress.success || 0}`;
    if (progress.phase === 'pnl-warmup') button.textContent = 'Syncing PnL...';
    if (progress.phase === 'pnl-retry') button.textContent = `Retry PnL: ${progress.failed || 0}`;

    if (progress.phase === 'incremental-completed' || progress.phase === 'error' || progress.phase === 'stopped') {
        incrementalSyncRunning = false;
        button.classList.remove('is-running');
        if (!pendingCorrCalculation) {
            button.textContent = progress.phase === 'incremental-completed'
                ? 'Calculate Local Corr'
                : (progress.phase === 'stopped' ? 'Sync stopped' : 'Sync failed');
        }
    }
}

function createCombinedLocalCorrCard() {
    const card = document.createElement('div');
    card.id = 'prod-memo-local-corr-card';
    card.className = 'prod-memo-card prod-memo-local-corr-card';
    card.innerHTML = `
        <div class="memo-header">
            <div class="memo-title-group">
                <span class="memo-title">⚡ ProdMemo</span>
                <span class="memo-badge">Correlation</span>
            </div>
            <span class="memo-time">Latest saved results</span>
        </div>
        <div class="local-corr-columns">
            <div class="local-corr-column" data-corr-type="SELF">
                <div class="local-corr-column-title">Self Corr</div>
                <div class="local-corr-values">
                    <div><span>Max</span><strong data-field="max">-</strong></div>
                    <div><span>Min</span><strong data-field="min">-</strong></div>
                </div>
                <div class="local-corr-meta">
                    <span data-field="count">Compared: -</span>
                    <span data-field="time">Not calculated</span>
                </div>
                <div class="local-corr-status" data-field="status">Ready</div>
            </div>
            <div class="local-corr-column" data-corr-type="PPA">
                <div class="local-corr-column-title">PPA Corr</div>
                <div class="local-corr-values">
                    <div><span>Max</span><strong data-field="max">-</strong></div>
                    <div><span>Min</span><strong data-field="min">-</strong></div>
                </div>
                <div class="local-corr-meta">
                    <span data-field="count">Compared: -</span>
                    <span data-field="time">Not calculated</span>
                </div>
                <div class="local-corr-status" data-field="status">Ready</div>
            </div>
            <div class="local-corr-column" data-corr-type="PROD">
                <div class="local-corr-column-title">Prod Corr</div>
                <div class="local-corr-values">
                    <div><span>Max</span><strong data-field="max">-</strong></div>
                    <div><span>Min</span><strong data-field="min">-</strong></div>
                </div>
                <div class="local-corr-meta">
                    <span data-field="count">Source: WQB</span>
                    <span data-field="time">Not captured</span>
                </div>
                <div class="local-corr-status" data-field="status">Waiting for platform query</div>
            </div>
        </div>
    `;
    return card;
}

function ensureLocalCorrCards() {
    if (!contextValid) return;
    const title = document.querySelector('#alphas-correlation .correlation__title');
    if (!title) return;
    if (!document.getElementById('prod-memo-local-corr-card')) {
        title.insertAdjacentElement('afterend', createCombinedLocalCorrCard());
    }

    if (currentAlphaId && loadedCorrAlphaId !== currentAlphaId) {
        loadCachedCorrResults(currentAlphaId);
    }
}

function getLocalCorrPanel(corrType) {
    return document.querySelector(`#prod-memo-local-corr-card [data-corr-type="${corrType}"]`);
}

function resetLocalCorrCards() {
    for (const corrType of ['SELF', 'PPA', 'PROD']) {
        const panel = getLocalCorrPanel(corrType);
        if (!panel) continue;
        panel.querySelector('[data-field="max"]').textContent = '-';
        panel.querySelector('[data-field="min"]').textContent = '-';
        panel.querySelector('[data-field="count"]').textContent = corrType === 'PROD' ? 'Source: WQB' : 'Compared: -';
        panel.querySelector('[data-field="time"]').textContent = corrType === 'PROD' ? 'Not captured' : 'Not calculated';
        panel.querySelector('[data-field="status"]').textContent = corrType === 'PROD' ? 'Waiting for platform query' : 'Ready';
    }
}

function setCorrCardStatus(corrType, text) {
    const panel = getLocalCorrPanel(corrType);
    if (!panel) return;
    panel.querySelector('[data-field="status"]').textContent = text;
}

function renderCorrResult(corrType, record) {
    const panel = getLocalCorrPanel(corrType);
    if (!panel || !record?.result) return;
    const maxElement = panel.querySelector('[data-field="max"]');
    const minElement = panel.querySelector('[data-field="min"]');
    maxElement.textContent = Number(record.result.max).toFixed(4);
    minElement.textContent = Number(record.result.min).toFixed(4);
    maxElement.className = record.result.max >= 0.7 ? 'negative' : 'positive';
    minElement.className = 'positive';
    if (corrType === 'PROD') {
        panel.querySelector('[data-field="count"]').textContent = 'Source: WQB';
        panel.querySelector('[data-field="time"]').textContent = new Date(record.timestamp).toLocaleString();
        panel.querySelector('[data-field="status"]').textContent = 'Platform result';
    } else {
        panel.querySelector('[data-field="count"]').textContent = `Compared: ${record.corrCount ?? '-'}`;
        panel.querySelector('[data-field="time"]').textContent = new Date(record.calculatedAt).toLocaleString();
        panel.querySelector('[data-field="status"]').textContent = `Pool: ${record.poolSize ?? '-'}`;
    }
}

async function databaseAction(action, payload = {}) {
    const response = await chrome.runtime.sendMessage({ type: 'PROD_MEMO_DB', action, payload });
    if (!response?.ok) throw new Error(response?.error || 'IndexedDB request failed');
    return response.result;
}

async function loadCachedCorrResults(alphaId) {
    if (!alphaId || loadedCorrAlphaId === alphaId) return;
    loadedCorrAlphaId = alphaId;
    try {
        const results = await databaseAction('GET_CORR_RESULTS', { alphaId });
        if (currentAlphaId !== alphaId) return;
        if (results.self) renderCorrResult('SELF', results.self);
        if (results.ppa) renderCorrResult('PPA', results.ppa);
        if (results.prod) renderCorrResult('PROD', results.prod);
    } catch (error) {
        loadedCorrAlphaId = null;
        console.error('[ProdMemo] Failed to load cached Corr results:', error);
    }
}

async function startCombinedCorrWorkflow(includePlatformCorr = false) {
    if (!currentAlphaId) {
        setCorrCardStatus('SELF', 'Detecting target Alpha...');
        setCorrCardStatus('PPA', 'Detecting target Alpha...');
        await waitForCurrentAlphaId(3000);
    }
    if (!currentAlphaId) {
        setCorrCardStatus('SELF', 'Target Alpha unavailable');
        setCorrCardStatus('PPA', 'Target Alpha unavailable');
        if (includePlatformCorr) setAllCorrButtonRunning(false);
        return;
    }
    if (corrCalculationRunning || pendingCorrCalculation) {
        return;
    }

    pendingCorrCalculation = true;
    if (includePlatformCorr) setAllCorrButtonRunning(true);
    setCorrCardStatus('SELF', 'Syncing Alpha data...');
    setCorrCardStatus('PPA', 'Syncing Alpha data...');
    if (!incrementalSyncRunning) {
        incrementalSyncRunning = true;
        const syncButton = document.getElementById('prod-memo-incremental-sync');
        syncButton?.classList.add('is-running');
        if (syncButton) syncButton.textContent = 'Checking...';
        window.postMessage({ type: 'PROD_MEMO_START_INCREMENTAL_SYNC' }, '*');
    }
}

function waitForCurrentAlphaId(timeoutMs) {
    if (currentAlphaId) return Promise.resolve(currentAlphaId);
    return new Promise(resolve => {
        const startedAt = Date.now();
        const intervalId = setInterval(() => {
            if (currentAlphaId || Date.now() - startedAt >= timeoutMs) {
                clearInterval(intervalId);
                resolve(currentAlphaId);
            }
        }, 50);
    });
}

function handleCorrSyncProgress(progress) {
    if (progress?.mode !== 'incremental' || !pendingCorrCalculation) return;
    if (progress.phase === 'incremental-completed') {
        pendingCorrCalculation = false;
        calculateBothLocalCorr();
    } else if (progress.phase === 'error' || progress.phase === 'stopped') {
        pendingCorrCalculation = false;
        setCorrCardStatus('SELF', progress.message || 'Sync failed');
        setCorrCardStatus('PPA', progress.message || 'Sync failed');
        const button = document.getElementById('prod-memo-incremental-sync');
        if (button) button.textContent = 'Calculate Local Corr';
        setAllCorrButtonRunning(false);
    }
}

async function calculateBothLocalCorr() {
    corrCalculationRunning = true;
    setCorrCardStatus('SELF', 'Calculating...');
    setCorrCardStatus('PPA', 'Waiting...');
    const alphaId = currentAlphaId;
    const button = document.getElementById('prod-memo-incremental-sync');
    if (button) button.textContent = 'Calculating Self...';

    try {
        await ensureCurrentCalculationData(alphaId);
        for (const corrType of ['SELF', 'PPA']) {
            setCorrCardStatus(corrType, 'Calculating...');
            if (button) button.textContent = `Calculating ${corrType}...`;
            try {
                const record = await databaseAction('CALCULATE_CORR', {
                    alphaId,
                    corrType,
                    targetAlpha: currentPageAlphas.get(alphaId) || null,
                    targetPnl: currentPagePnls.get(alphaId) || null
                });
                if (currentAlphaId === alphaId) renderCorrResult(corrType, record);
            } catch (error) {
                setCorrCardStatus(corrType, error.message || 'Calculation failed');
                console.error(`[ProdMemo] ${corrType} calculation failed:`, error);
            }
        }
    } catch (error) {
        setCorrCardStatus('SELF', error.message || 'Calculation failed');
        setCorrCardStatus('PPA', error.message || 'Calculation failed');
        console.error('[ProdMemo] Local Corr calculation failed:', error);
    } finally {
        corrCalculationRunning = false;
        setAllCorrButtonRunning(false);
        if (button) {
            button.classList.remove('is-running');
            button.textContent = 'Calculate Local Corr';
        }
    }
}

async function ensureCurrentCalculationData(alphaId) {
    const needAlpha = !currentPageAlphas.has(alphaId);
    const needPnl = !currentPagePnls.has(alphaId);
    if (!needAlpha && !needPnl) return;

    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const data = await new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
            currentDataRequests.delete(requestId);
            reject(new Error('Timed out while loading current Alpha data'));
        }, 30000);
        currentDataRequests.set(requestId, { resolve, reject, timeoutId });
        window.postMessage({
            type: 'PROD_MEMO_REQUEST_CURRENT_DATA',
            requestId,
            alphaId,
            needAlpha,
            needPnl
        }, '*');
    });

    if (data.alpha) currentPageAlphas.set(alphaId, data.alpha);
    if (data.pnl) currentPagePnls.set(alphaId, data.pnl);
}

ensureIncrementalSyncButton();
ensureLocalCorrCards();

function getAlphaFromUrl() {
    // Pattern: .../alpha/{alphaID} or .../alphas/{alphaID}
    const match = window.location.href.match(/\/alphas?\/([^/?#]+)/);
    return match ? match[1] : null;
}

function cleanupCard() {
    removeExistingMemo();
    currentAlphaId = null;
}

function selectCurrentAlpha(alphaId) {
    if (!alphaId || currentAlphaId === alphaId) return;
    if (currentAlphaId) {
        console.log(`[ProdMemo] Switching from ${currentAlphaId} to ${alphaId}`);
        cleanupCard();
    }
    currentAlphaId = alphaId;
    removeExistingMemo();
    loadedCorrAlphaId = null;
    resetLocalCorrCards();
    ensureLocalCorrCards();
}

function removeExistingMemo() {
    const existing = document.getElementById('prod-memo-card');
    if (existing) {
        console.log('[ProdMemo] Removing existing card');
        existing.remove();
    }
}

// ========== LIST VIEW INJECTION ==========

function injectListCorrelations(alphaIds, cachedData) {
    // Use retry mechanism since table might not be rendered yet
    let attempts = 0;
    const maxAttempts = 10;

    const tryInject = () => {
        attempts++;
        const success = injectListCorrelationsOnce(alphaIds, cachedData);

        if (success) {
            console.log('[ProdMemo] List correlations injected successfully');
        } else if (attempts < maxAttempts) {
            setTimeout(tryInject, 300);
        } else {
            console.warn('[ProdMemo] Failed to inject list correlations after max retries');
        }
    };

    tryInject();
}

function injectListCorrelationsOnce(alphaIds, cachedData) {
    console.log('[ProdMemo] Starting list injection', { alphaCount: alphaIds.length, cachedKeys: Object.keys(cachedData) });

    // Find the header groups row (the one with column names)
    const headerGroups = document.querySelector('.rt-thead.-headerGroups .rt-tr');
    if (!headerGroups) {
        console.warn('[ProdMemo] Header groups row not found');
        return false;
    }

    // Find and replace Book Size header with Max Corr
    // DEBUG: Log all headers to find Book Size
    console.log('[ProdMemo] Exploring header structure...');
    const allHeaders = headerGroups.querySelectorAll('.rt-th');
    allHeaders.forEach((header, idx) => {
        const sortElement = header.querySelector('[class*="table__sort"]');
        console.log(`Header ${idx}:`, {
            text: header.textContent.trim(),
            classes: header.className,
            sortClasses: sortElement?.className
        });
    });

    let bookSizeHeader = headerGroups.querySelector('.table__sort--bookSize');

    // Fallback: search by text content
    if (!bookSizeHeader) {
        console.log('[ProdMemo] Trying to find Book Size header by text content...');
        allHeaders.forEach(header => {
            if (header.textContent.trim().toLowerCase().includes('book size')) {
                bookSizeHeader = header.querySelector('.table__sort') || header;
                console.log('[ProdMemo] Found Book Size by text, classes:', bookSizeHeader?.className);
            }
        });
    }

    console.log('[ProdMemo] Book Size header found:', !!bookSizeHeader);

    if (bookSizeHeader && !bookSizeHeader.classList.contains('prod-corr-replaced')) {
        // Find the parent div that contains the sort element
        const sortDiv = bookSizeHeader;
        sortDiv.textContent = 'Max Corr';
        sortDiv.style.fontWeight = '600';
        sortDiv.style.color = '#fff';
        sortDiv.classList.add('prod-corr-replaced');
        // Remove sort-related classes to prevent clicking
        sortDiv.classList.remove('table__sort', 'table__sort--bookSize');
        console.log('[ProdMemo] Header replaced successfully');
    }

    // First, verify that this list actually HAS a Book Size column
    // Look for the header (either original or already replaced)
    const bookSizeHeaderCheck = headerGroups.querySelector('.table__sort--bookSize') ||
        headerGroups.querySelector('.prod-corr-replaced');
    if (!bookSizeHeaderCheck) {
        console.log('[ProdMemo] This list does not have a Book Size column, skipping injection');
        return false;
    }

    // Find all data rows
    const dataRows = document.querySelectorAll('.rt-tbody .rt-tr-group .rt-tr');
    console.log('[ProdMemo] Data rows found:', dataRows.length);

    if (dataRows.length === 0) {
        return false;
    }

    // Inject correlation data for each row by replacing Book Size cells
    // ONLY replace cells that actually have the bookSize class
    let replacedCount = 0;
    dataRows.forEach((row, index) => {
        if (index >= alphaIds.length) return;

        const alphaId = alphaIds[index];
        const data = cachedData[`prod_memo_${alphaId}`];

        // Find the Book Size cell content - STRICT: only by class selector
        const bookSizeCell = row.querySelector('.alphas-list-table__cell-content--bookSize');

        if (!bookSizeCell) {
            if (index === 0) {
                console.log('[ProdMemo] No Book Size cell found in first row, list structure may not support this feature');
            }
            return;
        }

        const value = data?.result?.max;
        let displayValue = '-';
        let colorClass = '';

        if (value !== undefined) {
            displayValue = value.toFixed(4);
            // Red for high correlation (bad), green for low (good)
            colorClass = value > 0.7 ? 'high-corr' : (value > 0.5 ? 'medium-corr' : 'low-corr');
        }

        // Replace the content and update class - KEEP bookSize class to avoid breaking selector
        bookSizeCell.className = `alphas-list-table__cell-content alphas-list-table__cell-content--number alphas-list-table__cell-content--bookSize prod-corr-replaced ${colorClass}`;
        bookSizeCell.innerHTML = `<div>${displayValue}</div>`;
        replacedCount++;

        if (index < 3 || replacedCount <= 3) {
            console.log(`[ProdMemo] Row ${index} (${alphaId}): Replaced with ${displayValue} (${colorClass})`);
        }
    });

    console.log(`[ProdMemo] Successfully replaced ${replacedCount} cells`);
    return true;
}

function createListHeaderCell() {
    const cell = document.createElement('div');
    cell.className = 'rt-th prod-corr-header';
    cell.setAttribute('role', 'columnheader');
    cell.setAttribute('tabindex', '-1');
    cell.style.cssText = 'flex: 100 0 auto; width: 100px; max-width: 100px;';

    cell.innerHTML = `
        <div class="rt-resizable-header-content">
            <div style="font-weight: 600;color:#fff">Max Corr</div>
        </div>
    `;

    return cell;
}

function createListDataCell(data) {
    const cell = document.createElement('div');
    cell.className = 'rt-td prod-corr-cell';
    cell.setAttribute('role', 'gridcell');
    cell.style.cssText = 'flex: 100 0 auto; width: 100px; max-width: 100px;';

    const value = data?.result?.max;
    let displayValue = '-';
    let colorClass = '';

    if (value !== undefined) {
        displayValue = value.toFixed(4);
        // Red for high correlation (bad), green for low (good)
        colorClass = value > 0.7 ? 'high-corr' : (value > 0.5 ? 'medium-corr' : 'low-corr');
    }

    cell.innerHTML = `
        <div class="alphas-list-table__cell-content alphas-list-table__cell-content--number ${colorClass}">
            <div>${displayValue}</div>
        </div>
    `;

    return cell;
}
