# ProdMemo - Chrome Extension for WorldQuant Brain

A Chrome extension that caches and displays Production Correlation data for WorldQuant Brain alphas, making it easier to track and analyze alpha performance.

## Features

### 📊 Alpha Detail View
- **Cached Correlation Card**: Displays max/min prod correlation values on alpha detail pages
- **Timestamp Tracking**: Shows when correlation data was last cached
- **Visual Indicators**: Color-coded values (red for high correlation, green for low)

### 📋 List View Enhancement
- **Smart Column Replacement**: Replaces the "Book Size" column with "Max Prod Corr" in unsubmitted alpha lists
- **Automatic Detection**: Only replaces columns when appropriate (unsubmitted alphas)
- **Color Coding**: 
  - 🔴 Red: High correlation (>0.7) - potential concern
  - 🟠 Orange: Medium correlation (>0.5)
  - 🟢 Green: Low correlation - good for diversification

### 💾 Data Management
- **Automatic Caching**: Intercepts prod correlation API requests and stores results
- **Persistent Storage**: Uses Chrome's local storage for data persistence
- **Export Functionality**: Export cached data as JSON via popup interface

## Installation

### From Source

1. Clone this repository:
   ```bash
   git clone https://github.com/yourusername/ProdMemo.git
   ```

2. Open Chrome and navigate to `chrome://extensions/`

3. Enable "Developer mode" (toggle in top right)

4. Click "Load unpacked" and select the `ProdMemo` directory

5. The extension icon should appear in your toolbar

## Usage

### Viewing Cached Correlations

1. Navigate to any alpha detail page on WorldQuant Brain
2. Run a Production Correlation check
3. The ProdMemo card will automatically appear below the correlation section
4. Cached data persists across sessions

### List View

1. Navigate to the unsubmitted alphas list
2. The "Book Size" column will be replaced with "Max Prod Corr" values
3. Values are color-coded for quick assessment

### Managing Data

1. Click the ProdMemo extension icon in the toolbar
2. View the number of cached alphas
3. Export all cached data as JSON
4. Clear all cached data if needed

## Technical Details

### Architecture

- **`manifest.json`**: Extension configuration
- **`content.js`**: Main content script for DOM manipulation and data handling
- **`inject.js`**: Injected script for API interception (main world context)
- **`popup.html/js`**: Extension popup interface
- **`styles.css`**: Styling for injected elements

### API Interception

The extension intercepts the following WorldQuant Brain API endpoints:

- `/alphas/{alphaID}/correlations/prod` - Production correlation data
- `/alphas/{alphaID}/recordsets` - Alpha page view detection
- `/users/self/alphas` - Alpha list data

### Storage Format

Cached data is stored in Chrome's local storage with the key format:
```
prod_memo_{alphaId}: {
  timestamp: <unix_timestamp>,
  result: {
    max: <number>,
    min: <number>
  }
}
```

## Browser Compatibility

- **Chrome**: ✅ Tested and supported
- **Chromium-based browsers**: ✅ Should work (Edge, Brave, etc.)
- **Firefox**: ❌ Not supported (uses Chrome Extension Manifest V3)

## Privacy & Security

- All data is stored locally in your browser
- No external servers or third-party services
- Only operates on `*.worldquantbrain.com` domains
- No personal data collection

## Development

### File Structure

```
ProdMemo/
├── manifest.json          # Extension manifest
├── content.js            # Content script (isolated world)
├── inject.js             # Injected script (main world)
├── popup.html            # Extension popup UI
├── popup.js              # Popup logic
├── styles.css            # Injected styles
└── README.md             # This file
```

### Debugging

1. Open Chrome DevTools (F12) on any WorldQuant Brain page
2. Look for console messages prefixed with `[ProdMemo]`
3. Common issues:
   - **Card not showing**: Check if correlation data was cached
   - **List not updating**: Refresh the page after loading extension
   - **Extension context invalidated**: Reload the extension

## Known Limitations

- Only works on WorldQuant Brain platform
- Requires manual correlation checks to populate cache
- Book Size column replacement only works on unsubmitted alpha lists
- Extension must be reloaded after updates

## Contributing

Contributions are welcome! Please feel free to submit issues or pull requests.

## License

MIT License - see LICENSE file for details

## Disclaimer

This is an unofficial extension and is not affiliated with or endorsed by WorldQuant LLC. Use at your own discretion.

## Changelog

### v1.0.0 (2026-01-13)
- Initial release
- Cached correlation display on detail pages
- Book Size column replacement in lists
- Data export functionality
- Color-coded correlation indicators
