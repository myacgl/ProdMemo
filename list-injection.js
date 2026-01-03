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
    // Find the table header row
    const headerRow = document.querySelector('.rt-thead .rt-tr');
    if (!headerRow) {
        return false;
    }

    // Add header cell if not already present
    if (!headerRow.querySelector('.prod-corr-header')) {
        const headerCell = createListHeaderCell();
        // Insert before the last column (usually tags or actions)
        const lastHeaderCell = headerRow.lastElementChild;
        if (lastHeaderCell) {
            headerRow.insertBefore(headerCell, lastHeaderCell);
        } else {
            headerRow.appendChild(headerCell);
        }
    }

    // Find all data rows
    const dataRows = document.querySelectorAll('.rt-tbody .rt-tr-group .rt-tr');
    if (dataRows.length === 0) {
        return false;
    }

    // Inject correlation data for each row
    dataRows.forEach((row, index) => {
        if (index >= alphaIds.length) return;

        const alphaId = alphaIds[index];
        const data = cachedData[`prod_memo_${alphaId}`];

        // Remove existing cell if present (for refresh)
        const existingCell = row.querySelector('.prod-corr-cell');
        if (existingCell) {
            existingCell.remove();
        }

        // Create and insert new cell
        const dataCell = createListDataCell(data);

        // Insert before the last column
        const lastDataCell = row.lastElementChild;
        if (lastDataCell) {
            row.insertBefore(dataCell, lastDataCell);
        } else {
            row.appendChild(dataCell);
        }
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
