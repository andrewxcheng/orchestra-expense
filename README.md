# NYU Engage Expense Auto-Fill Chrome Extension

A Chrome Extension (Manifest V3) that uses AI to automatically fill NYU Engage expense forms from receipt PDFs. The extension parses receipts using OpenAI's API and intelligently fills form fields with confidence-based highlighting for review.

## Features

- 🤖 **AI-Powered Receipt Parsing**: Extracts structured data from PDF receipts using OpenAI GPT-4
- 📝 **Smart Form Auto-Fill**: Automatically fills NYU Engage expense forms based on label matching
- ⚠️ **Confidence Highlighting**: Highlights low-confidence fields in yellow with red borders for review
- 💾 **User Profile Storage**: Saves your default information (name, NetID, club, payment method)
- 🎨 **Modern UI**: Clean, sleek side panel interface built with React + TypeScript
- ⚙️ **Settings Panel**: Easy access to user profile settings via gear icon

## Setup Instructions

### 1. Install Dependencies

```bash
npm install
```

### 2. Build the Extension

```bash
npm run build
```

For development with watch mode:

```bash
npm run dev
```

### 3. Add Extension Icons (Optional but Recommended)

Before loading the extension, you may want to add icon files:
- Create or download icon images (16x16, 48x48, 128x128 pixels)
- Place them in the `icons/` folder as `icon16.png`, `icon48.png`, and `icon128.png`
- See `icons/README.md` for more details

The extension will work without icons, but Chrome may show warnings.

### 4. Load Extension in Chrome

**Note:** Side panel feature requires Chrome 114 or later. If you're using an older version, the extension will open in a new tab instead.

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable **Developer mode** (toggle in the top-right corner)
3. Click **Load unpacked**
4. Select the `dist` folder from this project
5. The extension should now appear in your extensions list

**Check your Chrome version:** Go to `chrome://version/` to see your Chrome version. Update Chrome if it's below version 114 for the best experience.

### 5. Configure ChatGPT / OpenAI API Key

**This is required for the extension to work!**

1. Right-click the extension icon and select **Options** (or go to `chrome://extensions/`, find the extension, and click "Options")
2. Enter your OpenAI API key
   - Get your key from [OpenAI Platform](https://platform.openai.com/api-keys) (sign up/login required)
   - The key should start with "sk-"
   - The key is stored securely in Chrome's sync storage and never shared
3. Click **Save Settings**

### 6. Set Up Your Profile

1. Click the extension icon to open the **side panel**
2. Click the **⚙️ gear icon** in the top-right corner to open settings
3. Fill in your **User Profile**:
   - Purchaser Name
   - NetID
   - Default Club/Organization
   - Default Payment Method
4. Click **Save Profile**
5. Click **Back to Main** to return to the receipt upload view

## Usage

1. **Navigate to NYU Engage Expense Form**
   - Go to the NYU Engage expense request form page
   - The extension will automatically detect the form

2. **Open Extension Side Panel**
   - Click the extension icon in your Chrome toolbar
   - The side panel will open on the right side of your browser

3. **Upload Receipt**
   - In the main view, click "Upload Receipt PDF" and select your receipt file
   - The selected file name will be displayed

4. **Auto-Fill Form**
   - Click **"🚀 Auto-Fill Expense Form"**
   - The extension will:
     - Extract text from the PDF
     - Call OpenAI API to parse structured data
     - Fill the form fields automatically
     - Highlight any low-confidence fields in yellow with red borders

5. **Review and Submit**
   - Check highlighted fields (yellow background, red border) for accuracy
   - Review the fill summary in the side panel
   - Make any necessary corrections
   - Submit the form as usual

6. **Access Settings**
   - Click the **⚙️ gear icon** in the top-right corner of the side panel
   - Edit your profile or access the Options page for API key configuration

## How It Works

### Architecture

- **Content Script** (`contentScript.ts`): Runs on NYU Engage pages, detects form fields by label text, and fills them with parsed data
- **Background Service Worker** (`background.ts`): Handles PDF parsing and OpenAI API calls (keeps API key secure)
- **Popup UI** (`popup/`): React-based interface for user interaction
- **Options Page** (`options/`): Settings page for API key configuration

### Field Detection

The extension uses **label text matching** rather than hard-coded IDs, making it resilient to form changes. It searches for labels containing:
- "Purchaser Name"
- "Purchaser's NetID"
- "Club/Organization"
- "Payment Method"
- "Vendor Name"
- "Date of Expense"
- "Expense Amount"
- "Purchase Type"
- "Include the link to the applicable NYU Engage event"
- "describe the reason for the purchase"

### Confidence System

- **High Confidence (≥0.8)**: Fields filled normally, no highlighting
- **Low Confidence (<0.8)**: Fields highlighted in yellow with red border, marked for review

## Development

### Project Structure

```
├── manifest.json          # Extension manifest
├── package.json           # Dependencies
├── tsconfig.json          # TypeScript config
├── webpack.config.js      # Build configuration
├── src/
│   ├── background.ts      # Service worker
│   ├── contentScript.ts   # Form filling logic
│   ├── types.ts           # TypeScript types
│   ├── utils/
│   │   ├── pdfParser.ts   # PDF text extraction
│   │   └── openai.ts      # OpenAI API integration
│   ├── popup/
│   │   ├── index.tsx      # Popup React component
│   │   ├── popup.html     # Popup HTML
│   │   └── popup.css      # Popup styles
│   └── options/
│       ├── index.tsx      # Options React component
│       ├── options.html   # Options HTML
│       └── options.css    # Options styles
└── dist/                  # Built files (generated)
```

### Building

```bash
# Production build
npm run build

# Development with watch
npm run dev

# Type checking
npm run type-check
```

## Permissions

The extension requires:
- `activeTab`: To interact with the current tab
- `scripting`: To inject content scripts
- `storage`: To save user profile and API key
- `https://api.openai.com/*`: To call OpenAI API

## Security Notes

- API keys are stored in Chrome's `chrome.storage.sync` (encrypted by Chrome)
- API calls are made from the background service worker, not the content script
- No data is sent to third parties except OpenAI for receipt parsing

## Troubleshooting

### Extension not filling forms
- Ensure you're on a NYU Engage page (`engage.nyu.edu`)
- Check that the form has loaded completely
- Verify your API key is set in Options

### API errors
- Verify your OpenAI API key is correct and has credits
- Check the browser console for detailed error messages
- Ensure you have internet connectivity

### Fields not detected
- The extension uses label text matching - if NYU changes label text, it may not detect fields
- Check the browser console for debugging information

## License

This project is for educational/personal use.

