document.addEventListener('DOMContentLoaded', async () => {
    const countEl = document.getElementById('record-count');
    const alphaCountEl = document.getElementById('alpha-count');
    const pnlCountEl = document.getElementById('pnl-count');
    const fullSyncBtn = document.getElementById('full-sync-btn');
    const syncProgressEl = document.getElementById('sync-progress');
    const exportBtn = document.getElementById('export-btn');
    const importBtn = document.getElementById('import-btn');
    const importFile = document.getElementById('import-file');
    const statusEl = document.getElementById('status');
    let syncRunning = false;

    function setSyncRunning(running) {
        syncRunning = running;
        fullSyncBtn.disabled = false;
        fullSyncBtn.textContent = running ? '⏹ Stop Full Sync' : '🔄 Full Submitted Alpha + PnL Sync';
    }

    async function databaseAction(action, payload = {}) {
        const response = await chrome.runtime.sendMessage({
            type: 'PROD_MEMO_DB',
            action,
            payload
        });
        if (!response?.ok) throw new Error(response?.error || 'IndexedDB request failed');
        return response.result;
    }

    async function renderIndexedDbStats() {
        const stats = await databaseAction('GET_STATS');
        countEl.textContent = stats.prodCorrCount;
        alphaCountEl.textContent = stats.alphaCount;
        pnlCountEl.textContent = stats.pnlCount;
    }

    chrome.runtime.onMessage.addListener(message => {
        if (message?.type !== 'PROD_MEMO_SYNC_PROGRESS') return false;

        const progress = message.payload;
        if (progress.mode === 'incremental') return false;
        syncProgressEl.textContent = progress.message || progress.phase;
        if (progress.phase === 'alphas' || progress.phase === 'pnl' || progress.phase === 'pnl-warmup' || progress.phase === 'pnl-retry') {
            const total = progress.total || '?';
            syncProgressEl.textContent += `\n${progress.current || 0}/${total} · Success ${progress.success || 0} · Failed ${progress.failed || 0}`;
            setSyncRunning(true);
        }
        if (progress.phase === 'completed' || progress.phase === 'error' || progress.phase === 'stopped') {
            setSyncRunning(false);
            renderIndexedDbStats().catch(console.error);
        }
        return false;
    });

    // Function to get all ProdMemo data
    async function getStoredData() {
        return databaseAction('GET_PROD_CORRS');
    }

    // Initialize display
    try {
        await renderIndexedDbStats();
    } catch (error) {
        alphaCountEl.textContent = 'Error';
        pnlCountEl.textContent = 'Error';
        console.error('[ProdMemo] Failed to read IndexedDB stats:', error);
    }

    fullSyncBtn.addEventListener('click', async () => {
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!tab?.id) throw new Error('No active tab found');

            if (syncRunning) {
                syncProgressEl.textContent = 'Stopping full sync...';
                await chrome.tabs.sendMessage(tab.id, { type: 'PROD_MEMO_STOP_FULL_SYNC' });
                return;
            }

            setSyncRunning(true);
            syncProgressEl.textContent = 'Starting full sync in the active WQB tab...';
            const response = await chrome.tabs.sendMessage(tab.id, {
                type: 'PROD_MEMO_START_FULL_SYNC',
                syncId: `${Date.now()}`
            });
            if (!response?.started) throw new Error('The WQB page did not start synchronization');
        } catch (error) {
            setSyncRunning(false);
            syncProgressEl.textContent = `Start failed: ${error.message}. Open or refresh a WorldQuant BRAIN page and try again.`;
        }
    });

    // Export Handler
    exportBtn.addEventListener('click', async () => {
        const { memoData, count } = await getStoredData();

        if (count === 0) {
            statusEl.textContent = "No data to export.";
            return;
        }

        const jsonStr = JSON.stringify(memoData, null, 2);
        const blob = new Blob([jsonStr], { type: 'application/json' });
        const url = URL.createObjectURL(blob);

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `prod_memo_export_${timestamp}.json`;

        chrome.downloads.download({
            url: url,
            filename: filename,
            saveAs: true
        }, (downloadId) => {
            if (chrome.runtime.lastError) {
                statusEl.textContent = "Export failed.";
                console.error(chrome.runtime.lastError);
            } else {
                statusEl.textContent = "Export started!";
            }
        });
    });

    // Import Handler
    importBtn.addEventListener('click', () => {
        importFile.click();
    });

    importFile.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        try {
            const text = await file.text();
            const importedData = JSON.parse(text);

            // Preserve the legacy export format while storing records in IndexedDB.
            const entries = Object.entries(importedData).filter(([, value]) => value?.timestamp && value?.result);
            const { imported: importCount } = await databaseAction('IMPORT_PROD_CORRS', { entries });

            statusEl.textContent = `Imported ${importCount} records.`;
            await renderIndexedDbStats();

            // Reset file input
            importFile.value = '';
        } catch (err) {
            statusEl.textContent = "Import failed: Invalid JSON";
            console.error(err);
        }
    });

});
