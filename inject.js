(function () {
    console.log('[ProdMemo] Inject script initialized.'); // CONFIRM SCRIPT LOAD
    const originalFetch = window.fetch;
    const ALPHA_PAGE_LIMIT = 100;
    const PNL_BATCH_SIZE = 100;
    const PNL_CONCURRENCY = 3;
    const PNL_RETRY_DELAYS_MS = [1000, 2000, 4000];
    const pendingDatabaseRequests = new Map();
    let syncRunning = false;
    let syncAbortController = null;

    function delay(ms, signal) {
        return new Promise((resolve, reject) => {
            const onAbort = () => {
                clearTimeout(timeoutId);
                reject(new DOMException('Synchronization stopped', 'AbortError'));
            };
            const timeoutId = setTimeout(() => {
                signal?.removeEventListener('abort', onAbort);
                resolve();
            }, ms);
            signal?.addEventListener('abort', onAbort, { once: true });
        });
    }

    function checkStopped(signal) {
        if (signal?.aborted) {
            throw new DOMException('Synchronization stopped', 'AbortError');
        }
    }

    async function readJsonOrNull(response) {
        const text = await response.text();
        if (!text.trim()) return null;
        return JSON.parse(text);
    }

    function postProgress(payload) {
        window.postMessage({ type: 'PROD_MEMO_SYNC_PROGRESS', payload }, '*');
    }

    function databaseRequest(action, payload) {
        const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        return new Promise((resolve, reject) => {
            pendingDatabaseRequests.set(requestId, { resolve, reject });
            window.postMessage({
                type: 'PROD_MEMO_DB_REQUEST',
                requestId,
                action,
                payload
            }, '*');
        });
    }

    window.addEventListener('message', event => {
        if (event.source !== window) return;

        if (event.data?.type === 'PROD_MEMO_DB_RESPONSE') {
            const pending = pendingDatabaseRequests.get(event.data.requestId);
            if (!pending) return;
            pendingDatabaseRequests.delete(event.data.requestId);

            if (event.data.response?.ok) {
                pending.resolve(event.data.response.result);
            } else {
                pending.reject(new Error(event.data.response?.error || 'IndexedDB request failed'));
            }
            return;
        }

        if (event.data?.type === 'PROD_MEMO_START_FULL_SYNC') {
            if (syncRunning) {
                postProgress({ phase: 'error', message: 'A full sync is already running.' });
                return;
            }
            runFullSync().catch(error => {
                console.error('[ProdMemo] Full sync failed:', error);
                postProgress({ phase: 'error', message: error.message || String(error) });
            });
            return;
        }

        if (event.data?.type === 'PROD_MEMO_START_INCREMENTAL_SYNC') {
            if (syncRunning) {
                postProgress({ phase: 'error', mode: 'incremental', message: 'A sync is already running.' });
                return;
            }
            runIncrementalSync().catch(error => {
                console.error('[ProdMemo] Incremental sync failed:', error);
                postProgress({ phase: 'error', mode: 'incremental', message: error.message || String(error) });
            });
            return;
        }

        if (event.data?.type === 'PROD_MEMO_STOP_FULL_SYNC' && syncRunning) {
            syncAbortController?.abort();
        }
    });

    async function fetchAlphaPage(offset, signal, limit = ALPHA_PAGE_LIMIT) {
        const query = new URLSearchParams({
            limit: String(limit),
            offset: String(offset),
            order: '-dateSubmitted',
            hidden: 'false'
        });
        const url = `https://api.worldquantbrain.com/users/self/alphas?${query.toString()}&status%21=UNSUBMITTED%1FIS-FAIL`;
        const response = await originalFetch(url, {
            headers: { accept: 'application/json;version=4.0' },
            credentials: 'include',
            signal
        });
        if (!response.ok) throw new Error(`Alpha list HTTP ${response.status}`);

        const data = await response.json();
        if (!Array.isArray(data.results) || typeof data.count !== 'number') {
            throw new Error('Invalid Alpha list response');
        }
        return data;
    }

    async function fetchAllSubmittedAlphas(signal) {
        let firstPage;
        try {
            firstPage = await fetchAlphaPage(0, signal);
        } catch (firstError) {
            postProgress({ phase: 'alphas', message: 'First Alpha page failed; retrying once...' });
            firstPage = await fetchAlphaPage(0, signal);
        }

        const totalPages = Math.max(1, Math.ceil(firstPage.count / ALPHA_PAGE_LIMIT));
        const alphaIds = [];
        const failedOffsets = [];
        let saved = 0;
        let completedPages = 0;

        async function savePage(data, offset) {
            const submitted = data.results.filter(alpha =>
                alpha?.id && alpha.dateSubmitted && alpha.status !== 'UNSUBMITTED'
            );
            await databaseRequest('SAVE_ALPHA_BATCH', { alphas: submitted });
            submitted.forEach(alpha => alphaIds.push(alpha.id));
            saved += submitted.length;
            completedPages++;
            postProgress({
                phase: 'alphas',
                current: completedPages,
                total: totalPages,
                success: saved,
                failed: failedOffsets.length,
                message: `Alpha page ${Math.floor(offset / ALPHA_PAGE_LIMIT) + 1}/${totalPages}`
            });
        }

        await savePage(firstPage, 0);

        for (let offset = ALPHA_PAGE_LIMIT; offset < firstPage.count; offset += ALPHA_PAGE_LIMIT) {
            checkStopped(signal);
            try {
                await savePage(await fetchAlphaPage(offset, signal), offset);
            } catch (error) {
                if (error.name === 'AbortError') throw error;
                console.warn(`[ProdMemo] Alpha page offset ${offset} failed:`, error);
                failedOffsets.push(offset);
                postProgress({
                    phase: 'alphas',
                    current: completedPages,
                    total: totalPages,
                    success: saved,
                    failed: failedOffsets.length,
                    message: `Alpha page failed at offset ${offset}; queued for retry.`
                });
            }
        }

        for (const offset of [...failedOffsets]) {
            checkStopped(signal);
            try {
                await savePage(await fetchAlphaPage(offset, signal), offset);
                failedOffsets.splice(failedOffsets.indexOf(offset), 1);
            } catch (error) {
                if (error.name === 'AbortError') throw error;
                console.warn(`[ProdMemo] Alpha page retry offset ${offset} failed:`, error);
            }
        }

        if (failedOffsets.length > 0) {
            throw new Error(`${failedOffsets.length} Alpha page(s) still failed after retry; PnL stage was not started.`);
        }

        const uniqueAlphaIds = [...new Set(alphaIds)];
        await databaseRequest('RECONCILE_ALPHAS', { alphaIds: uniqueAlphaIds });
        return uniqueAlphaIds;
    }

    async function requestPnlOnce(alphaId, signal) {
        const url = `https://api.worldquantbrain.com/alphas/${encodeURIComponent(alphaId)}/recordsets/pnl`;
        const response = await originalFetch(url, {
            headers: { accept: 'application/json;version=2.0' },
            credentials: 'include',
            signal
        });

        if (response.status === 401 || response.status === 403) {
            const error = new Error(`PnL authentication failed: HTTP ${response.status}`);
            error.fatal = true;
            throw error;
        }
        if (response.status === 202 || response.status === 204 || response.status === 429) {
            return { ready: false, reason: `HTTP ${response.status}` };
        }
        if (!response.ok) return { ready: false, reason: `HTTP ${response.status}` };

        try {
            const data = await readJsonOrNull(response);
            if (data && Array.isArray(data.records) && data.records.length > 0) {
                return { ready: true, data };
            }
            return { ready: false, reason: 'Empty PnL response' };
        } catch (error) {
            return { ready: false, reason: error.message || 'Invalid PnL JSON' };
        }
    }

    async function runConcurrent(items, worker, signal) {
        let nextIndex = 0;
        const workerCount = Math.min(PNL_CONCURRENCY, items.length);

        async function runWorker() {
            while (true) {
                checkStopped(signal);
                const index = nextIndex++;
                if (index >= items.length) return;
                await worker(items[index], index);
            }
        }

        await Promise.all(Array.from({ length: workerCount }, runWorker));
    }

    async function fetchPnlRound(alphaIds, signal, onSaved) {
        const pendingIds = [];
        await runConcurrent(alphaIds, async alphaId => {
            try {
                const result = await requestPnlOnce(alphaId, signal);
                if (!result.ready) {
                    pendingIds.push(alphaId);
                    return;
                }
                await databaseRequest('SAVE_PNL', { alphaId, data: result.data });
                onSaved(alphaId);
            } catch (error) {
                if (error.fatal) {
                    syncAbortController?.abort();
                    throw error;
                }
                if (error.name === 'AbortError') throw error;
                console.warn(`[ProdMemo] PnL request failed for ${alphaId}:`, error);
                pendingIds.push(alphaId);
            }
        }, signal);
        return pendingIds;
    }

    async function fetchAllPnls(alphaIds, signal, mode = 'full') {
        const savedIds = new Set();
        const totalBatches = Math.ceil(alphaIds.length / PNL_BATCH_SIZE);

        for (let start = 0; start < alphaIds.length; start += PNL_BATCH_SIZE) {
            checkStopped(signal);
            const batch = alphaIds.slice(start, start + PNL_BATCH_SIZE);
            const batchNumber = Math.floor(start / PNL_BATCH_SIZE) + 1;
            const onSaved = alphaId => savedIds.add(alphaId);

            postProgress({
                phase: 'pnl-warmup',
                mode,
                current: start,
                total: alphaIds.length,
                success: savedIds.size,
                failed: 0,
                message: `Warming PnL batch ${batchNumber}/${totalBatches} (${batch.length} Alphas)...`
            });

            let pendingIds = await fetchPnlRound(batch, signal, onSaved);

            for (let round = 0; round < PNL_RETRY_DELAYS_MS.length && pendingIds.length > 0; round++) {
                const waitMs = PNL_RETRY_DELAYS_MS[round];
                postProgress({
                    phase: 'pnl-retry',
                    mode,
                    current: start + batch.length - pendingIds.length,
                    total: alphaIds.length,
                    success: savedIds.size,
                    failed: pendingIds.length,
                    message: `Batch ${batchNumber}/${totalBatches}: ${pendingIds.length} pending, retrying in ${waitMs / 1000}s...`
                });
                await delay(waitMs, signal);
                pendingIds = await fetchPnlRound(pendingIds, signal, onSaved);
            }
        }

        const verification = await databaseRequest('GET_MISSING_PNL_IDS', { alphaIds });
        const failedIds = new Set(alphaIds.filter(alphaId => !savedIds.has(alphaId)));
        verification.missingIds.forEach(alphaId => failedIds.add(alphaId));
        return { success: alphaIds.length - failedIds.size, failedIds: [...failedIds] };
    }

    async function runFullSync() {
        syncRunning = true;
        syncAbortController = new AbortController();
        const signal = syncAbortController.signal;
        postProgress({ phase: 'alphas', current: 0, total: 0, success: 0, failed: 0, message: 'Starting Alpha sync...' });
        try {
            const alphaIds = await fetchAllSubmittedAlphas(signal);
            postProgress({
                phase: 'pnl',
                current: 0,
                total: alphaIds.length,
                success: 0,
                failed: 0,
                message: `Alpha sync complete. Starting ${alphaIds.length} PnL requests...`
            });
            const result = await fetchAllPnls(alphaIds, signal);
            postProgress({
                phase: 'completed',
                total: alphaIds.length,
                success: result.success,
                failed: result.failedIds.length,
                failedIds: result.failedIds,
                message: `Full sync complete: ${alphaIds.length} Alphas, ${result.success} PnLs, ${result.failedIds.length} failed.`
            });
        } catch (error) {
            if (error.name === 'AbortError') {
                postProgress({ phase: 'stopped', message: 'Full sync stopped.' });
                return;
            }
            throw error;
        } finally {
            syncRunning = false;
            syncAbortController = null;
        }
    }

    async function runIncrementalSync() {
        syncRunning = true;
        syncAbortController = new AbortController();
        const signal = syncAbortController.signal;
        postProgress({
            phase: 'incremental-check',
            mode: 'incremental',
            message: 'Checking submitted Alphas...'
        });

        try {
            const [remoteHead, localState] = await Promise.all([
                fetchAlphaPage(0, signal, 1),
                databaseRequest('GET_INCREMENTAL_SYNC_STATE')
            ]);
            const localIds = new Set(localState.alphaIds);
            const newestRemoteId = remoteHead.results[0]?.id;
            const alphaListCurrent = remoteHead.count === localIds.size &&
                (!newestRemoteId || localIds.has(newestRemoteId));
            const isCurrent = alphaListCurrent && localState.missingPnlIds.length === 0;

            if (isCurrent) {
                postProgress({
                    phase: 'incremental-completed',
                    mode: 'incremental',
                    added: 0,
                    pnlUpdated: 0,
                    message: `Up to date: ${localIds.size} Alphas.`
                });
                return;
            }

            const newAlphas = [];
            for (let offset = 0; !alphaListCurrent && offset < remoteHead.count; offset += ALPHA_PAGE_LIMIT) {
                checkStopped(signal);
                const page = await fetchAlphaPage(offset, signal);
                const submitted = page.results.filter(alpha =>
                    alpha?.id && alpha.dateSubmitted && alpha.status !== 'UNSUBMITTED'
                );
                submitted.forEach(alpha => {
                    if (!localIds.has(alpha.id)) newAlphas.push(alpha);
                });

                postProgress({
                    phase: 'incremental-alphas',
                    mode: 'incremental',
                    current: Math.min(offset + page.results.length, remoteHead.count),
                    total: remoteHead.count,
                    success: newAlphas.length,
                    failed: 0,
                    message: `Checking newest Alphas: ${newAlphas.length} new.`
                });

                if (submitted.some(alpha => localIds.has(alpha.id)) || page.results.length < ALPHA_PAGE_LIMIT) {
                    break;
                }
            }

            if (newAlphas.length > 0) {
                await databaseRequest('SAVE_ALPHA_BATCH', { alphas: newAlphas });
            }

            const pnlTargets = [...new Set([
                ...newAlphas.map(alpha => alpha.id),
                ...localState.missingPnlIds
            ])];
            let pnlResult = { success: 0, failedIds: [] };
            if (pnlTargets.length > 0) {
                pnlResult = await fetchAllPnls(pnlTargets, signal, 'incremental');
            }

            postProgress({
                phase: 'incremental-completed',
                mode: 'incremental',
                added: newAlphas.length,
                pnlUpdated: pnlResult.success,
                failed: pnlResult.failedIds.length,
                failedIds: pnlResult.failedIds,
                message: `Incremental sync complete: ${newAlphas.length} new Alphas, ${pnlResult.success} PnLs, ${pnlResult.failedIds.length} failed.`
            });
        } catch (error) {
            if (error.name === 'AbortError') {
                postProgress({ phase: 'stopped', mode: 'incremental', message: 'Incremental sync stopped.' });
                return;
            }
            throw error;
        } finally {
            syncRunning = false;
            syncAbortController = null;
        }
    }

    window.fetch = async function (...args) {
        // console.log('[ProdMemo] Fetch called', args[0]); // Optional: noisy
        const response = await originalFetch.apply(this, args);

        try {
            const url = response.url;

            // 1. Intercept Prod Correlation Data
            // Pattern: .../alphas/{alphaID}/correlations/prod
            // Relaxed regex to be safer
            if (url.includes('/correlations/prod')) {
                console.log('[ProdMemo] Detected Prod Correlation URL:', url);

                const prodMatch = url.match(/\/alphas\/([^/]+)\/correlations\/prod/);
                if (prodMatch) {
                    const alphaId = prodMatch[1];
                    console.log(`[ProdMemo] Extracted Alpha ID: ${alphaId}`);

                    // Only try to parse if the request was successful
                    if (response.ok && response.status !== 204) {
                        try {
                            const clone = response.clone();
                            clone.text().then(text => {
                                if (!text) {
                                    console.warn('[ProdMemo] Empty response body');
                                    return;
                                }
                                try {
                                    const data = JSON.parse(text);
                                    console.log('[ProdMemo] JSON parsed successfully, posting message...');
                                    window.postMessage({
                                        type: 'PROD_MEMO_DATA',
                                        alphaId: alphaId,
                                        data: data
                                    }, '*');
                                } catch (parseErr) {
                                    console.warn('[ProdMemo] Failed to parse JSON', parseErr);
                                }
                            }).catch(err => {
                                console.warn('[ProdMemo] Error reading clone text', err);
                            });
                        } catch (cloneErr) {
                            console.warn('[ProdMemo] Error cloning response', cloneErr);
                        }
                    } else {
                        console.warn(`[ProdMemo] Response not OK: ${response.status}`);
                    }
                } else {
                    console.warn('[ProdMemo] URL matched includes string but failed regex match');
                }
            }

            // 2. Intercept Alpha Page Load (Recordsets) to trigger UI check
            // Pattern: .../alphas/{alphaID}/recordsets (exact, not sub-paths)
            // This is the signal that the user has opened an Alpha page
            // Match only /recordsets, not /recordsets/yearly-stats or /recordsets/pnl
            const recordsetsMatch = url.match(/\/alphas\/([^/]+)\/recordsets(?:[?#]|$)/);
            if (recordsetsMatch) {
                const alphaId = recordsetsMatch[1];
                console.log(`[ProdMemo] Detected Alpha View (Recordsets): ${alphaId}`);
                window.postMessage({
                    type: 'PROD_MEMO_VIEW',
                    alphaId: alphaId
                }, '*');
            }

            // 3. Intercept Alpha List API to display correlations in table
            // Pattern: .../users/self/alphas?...
            if (url.includes('/users/self/alphas') && !url.includes('/alphas/')) {
                console.log('[ProdMemo] Detected Alpha List API:', url);

                if (response.ok && response.status !== 204) {
                    try {
                        const clone = response.clone();
                        clone.json().then(data => {
                            if (data.results && Array.isArray(data.results)) {
                                const alphaIds = data.results.map(r => r.id);
                                console.log(`[ProdMemo] Extracted ${alphaIds.length} alpha IDs from list`);
                                window.postMessage({
                                    type: 'PROD_MEMO_LIST',
                                    alphaIds: alphaIds
                                }, '*');
                            }
                        }).catch(err => {
                            console.warn('[ProdMemo] Error parsing list JSON', err);
                        });
                    } catch (cloneErr) {
                        console.warn('[ProdMemo] Error cloning list response', cloneErr);
                    }
                }
            }

        } catch (e) {
            console.error('[ProdMemo] Error in fetch interceptor', e);
        }

        return response;
    };
})();
