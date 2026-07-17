# ProdMemo

English | [简体中文](README_zh.md)

ProdMemo is an unofficial Chrome extension for WorldQuant BRAIN. It keeps submitted Alpha and PnL data in IndexedDB, calculates Self and Power Pool correlation locally, and caches Production Correlation returned by the platform.

## Features

### Correlation on Alpha detail pages

- A unified **ProdMemo** card displays the latest local Self Corr, local PPA Corr, and platform Prod Corr results.
- **Calculate Local Corr** synchronizes newly submitted Alphas when needed, then calculates local Self and PPA correlation.
- **Calculate All Corr** refreshes the platform's **Prod Correlation** result first, then runs the same local calculations.
- The latest result for each Alpha is stored and restored when the Alpha page is opened again.
- PPA candidates must be in the same region and contain the `POWER_POOL:POWER_POOL_ELIGIBLE` classification.
- Self Corr candidates include eligible OS Alphas even when they are also Power Pool Eligible.

### Alpha and PnL synchronization

- **Full Submitted Alpha + PnL Sync** in the popup downloads every submitted Alpha and its PnL.
- Alpha pages are fetched in batches of up to 100.
- PnL requests use bounded concurrency, warm-up passes, and a final retry pass to reduce omissions.
- Synchronization reports progress, successes, and failures, and can be stopped from the same popup button.
- Incremental synchronization checks for newly submitted Alphas before a local calculation.

### Production Correlation cache

- Platform Prod Corr responses are intercepted and saved automatically.
- The unsubmitted Alpha list replaces **Book Size** with **Max Corr**, the highest saved Self, PPA, or Prod correlation.
- Prod Corr records can be imported and exported from the popup.

### Local data management

ProdMemo uses the `ProdMemoDB` IndexedDB database with separate stores for:

- submitted Alpha metadata;
- Alpha PnL time series;
- latest local Self/PPA results;
- platform Production Correlation results.

The popup shows Prod Corr, submitted Alpha, and PnL record counts without rendering the full Prod Corr list.

## Installation

1. Download or clone this repository.
2. Open `chrome://extensions/` in Chrome.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the `ProdMemo` directory.

ProdMemo must run on a logged-in `*.worldquantbrain.com` page because Alpha and PnL requests use the active platform session.

## Upgrading from v1

Chrome storage is isolated by extension ID. To retain the old v1 Prod Corr cache, replace the files in the directory previously loaded by Chrome and reload that existing extension. Loading the new files from a different path usually creates another unpacked extension ID, which cannot read the old extension's storage.

On first startup under the same extension ID, valid legacy `prod_memo_{alphaId}` records in `chrome.storage.local` are copied into the new IndexedDB Prod Corr store. The legacy records are left untouched.

If the extension ID has already changed, export the old extension's Prod Corr JSON and import it through the new extension popup.

Before upgrading or clearing browser data, exporting a backup is recommended.

## Usage

### Initial synchronization

1. Open a WorldQuant BRAIN page and sign in.
2. Open the ProdMemo popup.
3. Click **Full Submitted Alpha + PnL Sync**.
4. Keep the WQB tab open until the two-stage Alpha and PnL synchronization finishes.

Run a full synchronization again when WQB expands historical PnL periods, such as after an `endDate` update.

### Calculate correlation

1. Open an Alpha detail page and wait for its Correlation section to appear.
2. Click **Calculate Local Corr** to calculate local Self and PPA correlation only.
3. Click **Calculate All Corr** to refresh platform Prod Corr and calculate both local results in one operation.

### Import and export

The popup exports and imports Prod Corr records using the legacy-compatible JSON shape:

```json
{
  "alphaId": {
    "timestamp": 1760000000000,
    "result": {
      "max": 0.7012,
      "min": -0.2456
    }
  }
}
```

## Architecture

| File | Responsibility |
| --- | --- |
| `manifest.json` | Manifest V3 extension configuration |
| `inject.js` | WQB-page API interception and authenticated synchronization |
| `content.js` | Page controls, unified correlation card, and list enhancement |
| `background.js` | IndexedDB access, migration, and message handling |
| `corrWorker.js` | Local correlation calculation |
| `popup.html`, `popup.js` | Synchronization and data-management interface |
| `styles.css` | Injected page styles |

## Privacy and security

- All cached data and calculations remain in the local browser profile.
- ProdMemo does not use an external server or send data to a third party.
- The extension only operates on WorldQuant BRAIN domains.
- Clearing the browser profile or IndexedDB permanently removes local data unless it has been exported.

## Browser compatibility

- Chrome: supported
- Other Chromium browsers: expected to work, but not actively tested
- Firefox: not supported

## Development

After changing the source files, reload ProdMemo from `chrome://extensions/`, refresh the WQB tab, and inspect page-console messages prefixed with `[ProdMemo]`.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development and testing checklist.

## Known limitations

- An authenticated WQB page must remain open during synchronization.
- Platform API rate limits or temporary empty PnL responses can make synchronization slower.
- Local correlation is a browser-side reproduction and may differ slightly if WQB changes its calculation rules or source data.
- Unpacked-extension data is tied to its Chrome extension ID.

## Changelog

### v2.0.2 (2026-07-17)

- Restored Power Pool Eligible OS Alphas to the local Self Corr comparison pool.
- Invalidated Self Corr results produced by the incorrect v2.0.1 pool rule.

### v2.0.1 (2026-07-14)

- Excluded Power Pool Eligible Alphas from the local Self Corr comparison pool.
- Invalidated cached Self Corr results produced by the previous pool rule.

### v2.0.0 (2026-07-10)

- Moved active Prod Corr storage and data management to IndexedDB.
- Added safe migration of valid legacy Prod Corr records without deleting the originals.
- Added full and incremental submitted-Alpha synchronization.
- Added PnL synchronization with batching, concurrency control, warm-up, retry, progress, and stop support.
- Added local Self and same-region Power Pool correlation calculations.
- Added the unified Self/PPA/Prod result card with latest-result restoration.
- Added **Calculate Local Corr** and **Calculate All Corr** page actions.

### v1.0.0 (2026-01-13)

- Added Production Correlation capture and detail-page display.
- Added the Max Corr list column.
- Added JSON export and color-coded correlation indicators.

## License

MIT License. See `LICENSE` for details.

## Disclaimer

ProdMemo is not affiliated with or endorsed by WorldQuant LLC. Use it at your own discretion.
