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

    // Find and replace Book Size header with Max Prod Corr
    const bookSizeHeader = headerRow.querySelector('.table__sort--bookSize');
    if (bookSizeHeader && !bookSizeHeader.classList.contains('prod-corr-replaced')) {
        bookSizeHeader.textContent = 'Max Prod Corr';
        bookSizeHeader.style.fontWeight = '600';
        bookSizeHeader.style.color = '#fff';
        bookSizeHeader.classList.add('prod-corr-replaced');
        bookSizeHeader.classList.remove('table__sort', 'table__sort--bookSize');
    }

    // Find all data rows
    const dataRows = document.querySelectorAll('.rt-tbody .rt-tr-group .rt-tr');
    if (dataRows.length === 0) {
        return false;
    }

    // Inject correlation data for each row by replacing Book Size cells
    dataRows.forEach((row, index) => {
        if (index >= alphaIds.length) return;

        const alphaId = alphaIds[index];
        const data = cachedData[`prod_memo_${alphaId}`];

        // Find the Book Size cell (second to last cell based on the HTML structure)
        const bookSizeCell = row.querySelector('.alphas-list-table__cell-content--bookSize');
        if (bookSizeCell) {
            const value = data?.result?.max;
            let displayValue = '-';
            let colorClass = '';

            if (value !== undefined) {
                displayValue = value.toFixed(4);
                // Red for high correlation (bad), green for low (good)
                colorClass = value > 0.7 ? 'high-corr' : (value > 0.5 ? 'medium-corr' : 'low-corr');
            }

            // Replace the content
            bookSizeCell.className = `alphas-list-table__cell-content alphas-list-table__cell-content--number ${colorClass}`;
            bookSizeCell.innerHTML = `<div>${displayValue}</div>`;
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
