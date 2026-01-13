# Contributing to ProdMemo

Thank you for your interest in contributing to ProdMemo! This document provides guidelines for contributing to the project.

## Getting Started

1. Fork the repository
2. Clone your fork locally
3. Create a new branch for your feature/fix
4. Make your changes
5. Test thoroughly
6. Submit a pull request

## Development Setup

1. Load the extension in Chrome:
   - Navigate to `chrome://extensions/`
   - Enable "Developer mode"
   - Click "Load unpacked"
   - Select the project directory

2. Make changes to the code

3. Reload the extension:
   - Go to `chrome://extensions/`
   - Click the reload icon on the ProdMemo extension

4. Test on WorldQuant Brain platform

## Code Style

- Use consistent indentation (4 spaces)
- Use meaningful variable and function names
- Add comments for complex logic
- Follow existing code patterns
- Keep functions focused and small

## Commit Messages

- Use clear, descriptive commit messages
- Start with a verb (Add, Fix, Update, Remove)
- Reference issue numbers when applicable
- Example: `Fix: Book Size column replacement logic (#15)`

## Testing

Before submitting a PR, please test:

1. **Alpha Detail Page**
   - Card appears after running prod correlation
   - Values display correctly
   - Card persists on page refresh

2. **List View (Unsubmitted)**
   - Book Size column is replaced
   - Cached data displays correctly
   - Color coding works

3. **List View (Submitted)**
   - No changes to Self-Correlation column
   - Extension doesn't interfere

4. **Popup**
   - Stats display correctly
   - Export function works
   - Clear data function works

## Pull Request Process

1. Update README.md if needed
2. Ensure all tests pass
3. Update version in manifest.json if appropriate
4. Describe changes in PR description
5. Link related issues

## Reporting Bugs

When reporting bugs, please include:

- Chrome version
- Extension version
- Steps to reproduce
- Expected behavior
- Actual behavior
- Console errors (if any)
- Screenshots (if applicable)

## Feature Requests

Feature requests are welcome! Please:

- Check if the feature already exists
- Describe the use case clearly
- Explain the expected behavior
- Consider potential implementation challenges

## Questions?

Feel free to open an issue for any questions or discussions!
