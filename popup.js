document.addEventListener('DOMContentLoaded', async () => {
    const countEl = document.getElementById('record-count');
    const alphaCountEl = document.getElementById('alpha-count');
    const pnlCountEl = document.getElementById('pnl-count');
    const fullSyncBtn = document.getElementById('full-sync-btn');
    const clearIndexedDbBtn = document.getElementById('clear-indexeddb-btn');
    const syncProgressEl = document.getElementById('sync-progress');
    const exportBtn = document.getElementById('export-btn');
    const importBtn = document.getElementById('import-btn');
    const importFile = document.getElementById('import-file');
    const clearBtn = document.getElementById('clear-btn');
    const statusEl = document.getElementById('status');
    const dataListEl = document.getElementById('data-list');
    let syncRunning = false;

    function setSyncRunning(running) {
        syncRunning = running;
        fullSyncBtn.disabled = false;
        fullSyncBtn.textContent = running ? '⏹ Stop Full Sync' : '🔄 Full Alpha + PnL Sync';
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
        const allData = await chrome.storage.local.get(null);
        const memoData = {};
        let count = 0;

        for (const [key, value] of Object.entries(allData)) {
            if (key.startsWith('prod_memo_')) {
                const alphaId = key.replace('prod_memo_', '');
                memoData[alphaId] = value;
                count++;
            }
        }
        return { memoData, count };
    }

    // Function to render data list
    async function renderDataList() {
        const { memoData, count } = await getStoredData();
        countEl.textContent = count;

        if (count === 0) {
            dataListEl.innerHTML = '<div class="empty-state">No cached data</div>';
            return;
        }

        let html = '';
        for (const [alphaId, data] of Object.entries(memoData)) {
            const date = new Date(data.timestamp).toLocaleString('zh-CN', {
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit'
            });
            const max = data.result?.max !== undefined ? data.result.max.toFixed(4) : 'N/A';
            const min = data.result?.min !== undefined ? data.result.min.toFixed(4) : 'N/A';

            html += `
                <div class="data-item">
                    <div class="alpha-id">${alphaId}</div>
                    <div class="timestamp">${date}</div>
                    <div class="values">Max: ${max} | Min: ${min}</div>
                </div>
            `;
        }
        dataListEl.innerHTML = html;
    }

    // Initialize display
    await renderDataList();
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

            // Validate and import data
            let importCount = 0;
            for (const [alphaId, value] of Object.entries(importedData)) {
                if (value.timestamp && value.result) {
                    await chrome.storage.local.set({
                        [`prod_memo_${alphaId}`]: value
                    });
                    importCount++;
                }
            }

            statusEl.textContent = `Imported ${importCount} records.`;
            await renderDataList();

            // Reset file input
            importFile.value = '';
        } catch (err) {
            statusEl.textContent = "Import failed: Invalid JSON";
            console.error(err);
        }
    });

    // Clear Handler
    clearBtn.addEventListener('click', async () => {
        if (confirm('Are you sure you want to delete all cached ProdMemo data?')) {
            const allData = await chrome.storage.local.get(null);
            const keysToRemove = Object.keys(allData).filter(k => k.startsWith('prod_memo_'));

            await chrome.storage.local.remove(keysToRemove);

            statusEl.textContent = "All data cleared.";
            await renderDataList();
        }
    });

    clearIndexedDbBtn.addEventListener('click', async () => {
        if (!confirm('Delete all saved Alpha and PnL data from IndexedDB?')) return;

        try {
            await databaseAction('CLEAR_INDEXED_DB');
            syncProgressEl.textContent = 'IndexedDB Alpha and PnL data cleared.';
            await renderIndexedDbStats();
        } catch (error) {
            syncProgressEl.textContent = `IndexedDB clear failed: ${error.message}`;
        }
    });
});
