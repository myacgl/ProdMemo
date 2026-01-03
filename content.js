// Inject the main world script
const script = document.createElement('script');
script.src = chrome.runtime.getURL('inject.js');
script.onload = function () {
    this.remove();
};
(document.head || document.documentElement).appendChild(script);

let currentAlphaId = null;
let isRendering = false; // Prevent concurrent renders
let renderTimeout = null; // Debounce timeout
let activeInterval = null; // Track active retry interval
let contextValid = true; // Track if extension context is still valid

// Detect extension context invalidation
if (typeof chrome !== 'undefined' && chrome.runtime) {
    chrome.runtime.onMessage.addListener(() => { });
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

            const storageKey = `prod_memo_${alphaId}`;
            await chrome.storage.local.set({
                [storageKey]: {
                    timestamp: Date.now(),
                    result: data
                }
            });

            console.log(`[ProdMemo] Data saved successfully for ${alphaId}`);

            // If we are currently viewing this alpha, update the UI immediately
            // Special handle for 'unsubmitted' pages where URL ID hasn't updated yet
            // OR the user just ran a check on the currently open page.
            const currentUrlId = getAlphaFromUrl();
            if (currentUrlId === alphaId || currentUrlId === 'unsubmitted') {
                console.log(`[ProdMemo] Triggering immediate render for ${alphaId} (Data Received)`);
                debouncedRenderMemo(alphaId);
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

        // If switching to a different alpha, cleanup first
        if (currentAlphaId && currentAlphaId !== alphaId) {
            console.log(`[ProdMemo] Switching from ${currentAlphaId} to ${alphaId}`);
            cleanupCard();
        }

        currentAlphaId = alphaId;
        debouncedRenderMemo(alphaId);
    }
});

// START: Lifecycle Management
// Simplified URL polling - mainly for cleanup when leaving alpha pages
// Navigation detection is primarily handled by /recordsets API requests
setInterval(() => {
    if (!contextValid) return; // Stop if context is invalid

    const urlAlphaId = getAlphaFromUrl();

    // Only cleanup when navigating away from alpha pages entirely
    if (!urlAlphaId && currentAlphaId) {
        // If URL no longer has an alpha ID and we have an active card
        if (!window.location.href.includes('/alphas/')) {
            console.log('[ProdMemo] Navigated away from Alphas. Cleaning up.');
            cleanupCard();
        }
    }
}, 2000);

// Initial check on load (in case we missed the Initial Request or it was cached by browser)
// Actually user said: "Only show card when observing the request". 
// But if I refresh the page, I will observe the request.
// If I navigate back, I will observe the request.
// So this logic holds. 'DOMContentLoaded' might be too early for the request interception, 
// so we don't need to force render here unless we want to cover the edge case where the script loaded late.
// Let's stick to the event trigger as requested.

function getAlphaFromUrl() {
    // Pattern: .../alphas/{alphaID}
    const match = window.location.href.match(/alphas\/([^/?#]+)/);
    return match ? match[1] : null;
}

function cleanupCard() {
    removeExistingMemo();
    currentAlphaId = null;
    isRendering = false;

    // Clear any pending renders
    if (renderTimeout) {
        clearTimeout(renderTimeout);
        renderTimeout = null;
    }

    // Clear any active retry intervals
    if (activeInterval) {
        clearInterval(activeInterval);
        activeInterval = null;
    }
}

function removeExistingMemo() {
    const existing = document.getElementById('prod-memo-card');
    if (existing) {
        console.log('[ProdMemo] Removing existing card');
        existing.remove();
    }
}

// Debounced render to prevent rapid re-renders
function debouncedRenderMemo(alphaId) {
    // Clear any pending render
    if (renderTimeout) {
        clearTimeout(renderTimeout);
    }

    // Schedule new render
    renderTimeout = setTimeout(() => {
        tryRenderMemo(alphaId);
    }, 300); // 300ms debounce delay
}

async function tryRenderMemo(alphaId) {
    // Check if extension context is still valid - do this FIRST
    if (!contextValid) {
        return; // Silent return, context already invalidated
    }

    try {
        // Double-check context before making API calls
        if (!chrome.runtime?.id) {
            contextValid = false;
            console.warn('[ProdMemo] Extension context lost, stopping operations');
            return;
        }

        // Prevent concurrent renders
        if (isRendering) {
            console.log(`[ProdMemo] Already rendering, skipping duplicate request for ${alphaId}`);
            return;
        }

        isRendering = true;

        // Clear any existing interval from previous render attempt
        if (activeInterval) {
            clearInterval(activeInterval);
            activeInterval = null;
        }

        const storageKey = `prod_memo_${alphaId}`;
        const stored = await chrome.storage.local.get(storageKey);
        const cachedData = stored[storageKey];

        if (!cachedData) {
            console.log(`[ProdMemo] No cached data found for Alpha ${alphaId}. Not showing card.`);
            isRendering = false;
            return;
        }

        console.log(`[ProdMemo] Found cached data for ${alphaId}, attempting inject...`);

        // Try immediate injection first
        const immediateSuccess = injectUI(cachedData);
        if (immediateSuccess) {
            console.log('[ProdMemo] UI Injected successfully immediately');
            isRendering = false;
            return;
        }

        // Retry finding the container
        let attempts = 0;
        const maxAttempts = 15; // Reduced from 20
        activeInterval = setInterval(() => {
            attempts++;
            const success = injectUI(cachedData);
            if (success) {
                console.log('[ProdMemo] UI Injected successfully on attempt ' + attempts);
                clearInterval(activeInterval);
                activeInterval = null;
                isRendering = false;
            } else if (attempts >= maxAttempts) {
                console.log('[ProdMemo] Failed to find UI insertion point after max retries');
                clearInterval(activeInterval);
                activeInterval = null;
                isRendering = false;
            }
        }, 500);
    } catch (error) {
        // Only log if it's NOT a context invalidation error
        if (error.message && error.message.includes('Extension context invalidated')) {
            contextValid = false;
            // Silent - no console output to avoid spam
        } else {
            console.error('[ProdMemo] Error in tryRenderMemo:', error);
        }
        isRendering = false;
        if (activeInterval) {
            clearInterval(activeInterval);
            activeInterval = null;
        }
    }
}

function injectUI(cachedData) {
    if (document.getElementById('prod-memo-card')) return true;

    // Finding injection target
    // Robust search: Look for ANY element containing "Prod Correlation" (case insensitive)
    const allElements = Array.from(document.body.querySelectorAll('*'));
    const targetHeader = allElements.find(el => {
        if (!el.innerText) return false;
        if (el.offsetParent === null) return false; // Check visibility

        const text = el.innerText.toLowerCase();
        const matches = text.includes('prod correlation') || text.includes('production correlation');
        if (!matches) return false;

        if (el.closest('#prod-memo-card')) return false;

        // heuristic: The element should be relatively small
        return el.innerText.length < 100;
    });

    if (!targetHeader) {
        return false;
    }

    // Build UI
    const card = document.createElement('div');
    card.id = 'prod-memo-card';
    card.className = 'prod-memo-card';

    const maxVal = cachedData.result.max !== undefined ? cachedData.result.max.toFixed(4) : 'N/A';
    const minVal = cachedData.result.min !== undefined ? cachedData.result.min.toFixed(4) : 'N/A';
    const dateStr = new Date(cachedData.timestamp).toLocaleString();

    card.innerHTML = `
        <div class="memo-header">
            <div class="memo-title-group">
                <span class="memo-title">⚡ ProdMemo</span>
                <span class="memo-badge">Cached</span>
            </div>
            <span class="memo-time">${dateStr}</span>
        </div>
        
        <div class="memo-stats">
            <div class="stat-item">
                <div class="stat-label">Max Correlation</div>
                <div class="stat-value ${parseFloat(maxVal) > 0.7 ? 'negative' : 'positive'}">${maxVal}</div>
            </div>
            <div class="stat-item">
                <div class="stat-label">Min Correlation</div>
                <div class="stat-value ${parseFloat(minVal) < -0.7 ? 'negative' : 'positive'}">${minVal}</div>
            </div>
        </div>
    `;

    // Append to parent of header
    targetHeader.parentElement.appendChild(card);
    return true;
}
