(function () {
    console.log('[ProdMemo] Inject script initialized.'); // CONFIRM SCRIPT LOAD
    const originalFetch = window.fetch;

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
