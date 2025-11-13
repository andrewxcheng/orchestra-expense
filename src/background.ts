import { parseReceiptWithOpenAI } from './utils/openai';
import { ParsedExpenseData, UserProfile } from './types';

// Open side panel when extension icon is clicked
// Requires Chrome 114 or later
chrome.action.onClicked.addListener((tab) => {
  // Call open() directly without await to preserve user gesture context
  // The promise will resolve asynchronously but the gesture is captured
  if (chrome.sidePanel) {
    chrome.sidePanel.open({ windowId: tab.windowId }).catch((error) => {
      console.error('Error opening side panel:', error);
    });
  } else {
    console.error('Side panel API not available');
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'parseReceipt') {
    handleReceiptParsing(message.pdfText, message.userProfile)
      .then((result) => sendResponse({ success: true, data: result }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true; // Keep channel open for async response
  }
});

async function handleReceiptParsing(
  pdfText: string,
  userProfile: UserProfile
): Promise<ParsedExpenseData> {
  // Get API key from storage
  const storage = await chrome.storage.sync.get(['openaiApiKey']);
  const apiKey = storage.openaiApiKey;

  if (!apiKey) {
    throw new Error('OpenAI API key not set. Please configure it in the options page.');
  }

  // Parse with OpenAI (PDF text already extracted in popup)
  const parsedData = await parseReceiptWithOpenAI(pdfText, userProfile, apiKey);

  return parsedData;
}

