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
let contextWarnedOnce = false; // Track if we've already warned about context invalidation

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

        // Query cached data for all alphas
        const keys = alphaIds.map(id => `prod_memo_${id}`);
        chrome.storage.local.get(keys).then(cachedData => {
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

// Add title attributes to truncated alpha names for native tooltips
const titleObserver = new MutationObserver(() => {
    const titleElement = document.querySelector('.alphas-details-content__header-title');
    if (titleElement && !titleElement.hasAttribute('title')) {
        titleElement.setAttribute('title', titleElement.textContent.trim());
    }
});

// Start observing for title elements
if (document.body) {
    titleObserver.observe(document.body, {
        childList: true,
        subtree: true
    });
}

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
    // Check if extension context is still valid
    if (!contextValid) return;

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
            if (!contextWarnedOnce) {
                console.warn('[ProdMemo] Extension context lost, stopping operations');
                contextWarnedOnce = true;
            }
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
    // Find all table header rows (there are multiple: headerGroups, header, filters)
    const headerGroups = document.querySelector('.rt-thead.-headerGroups .rt-tr');
    if (!headerGroups) {
        return false;
    }

    // Add header cell to the main header row if not already present
    if (!headerGroups.querySelector('.prod-corr-header')) {
        const headerCell = createListHeaderCell();
        headerGroups.appendChild(headerCell);
    }

    // Also add empty cells to other header rows for proper alignment
    const otherHeaderRows = document.querySelectorAll('.rt-thead.-header .rt-tr, .rt-thead.-filters .rt-tr');
    otherHeaderRows.forEach(row => {
        if (!row.querySelector('.prod-corr-placeholder')) {
            const placeholder = document.createElement('div');
            placeholder.className = 'rt-th prod-corr-placeholder';
            placeholder.setAttribute('role', 'columnheader');
            placeholder.setAttribute('tabindex', '-1');
            placeholder.style.cssText = 'flex: 100 0 auto; width: 100px; max-width: 100px;';
            row.appendChild(placeholder);
        }
    });

    // Find all data rows
    const dataRows = document.querySelectorAll('.rt-tbody .rt-tr-group .rt-tr');
    if (dataRows.length === 0) {
        return false;
    }

    // Inject correlation data for each row at the end
    dataRows.forEach((row, index) => {
        if (index >= alphaIds.length) return;

        const alphaId = alphaIds[index];
        const data = cachedData[`prod_memo_${alphaId}`];

        // Remove existing cell if present (for refresh)
        const existingCell = row.querySelector('.prod-corr-cell');
        if (existingCell) {
            existingCell.remove();
        }

        // Create and append new cell at the end
        const dataCell = createListDataCell(data);
        row.appendChild(dataCell);
    });

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
            <div style="font-weight: 600;color:#fff">Max Prod Corr</div>
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
