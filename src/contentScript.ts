import { ParsedExpenseData, FillResult, FillSummary } from './types';

const CONFIDENCE_THRESHOLD = 0.8;
const UNKNOWN_THRESHOLD = 0.5; // Below this, consider the field unknown

// Store PDF file data in memory for cross-page access
let pendingPDFFileData: { name: string; type: string; arrayBuffer: number[] } | null = null;
let fileUploadObserver: MutationObserver | null = null;
// Store form data in memory for cross-page access
let pendingFormData: ParsedExpenseData | null = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'fillForm') {
    // Reconstruct PDF file from data if provided
    let pdfFile: File | undefined;
    if (message.pdfData) {
      const uint8Array = new Uint8Array(message.pdfData.arrayBuffer);
      const blob = new Blob([uint8Array], { type: message.pdfData.type });      
      pdfFile = new File([blob], message.pdfData.name, { type: message.pdfData.type });                                                                         

      // Store PDF file data for later upload if container doesn't exist yet    
      pendingPDFFileData = {
        name: message.pdfData.name,
        type: message.pdfData.type,
        arrayBuffer: message.pdfData.arrayBuffer
      };
    }
    // Store form data for refilling on subsequent pages
    pendingFormData = message.data;
    const summary = fillExpenseForm(message.data, pdfFile);
    sendResponse({ success: true, summary });
  }
});

// Intercept XHR and fetch to capture what the form normally sends
function setupUploadInterceptor(): void {
  // Intercept XMLHttpRequest to see what parameters the form sends
  const originalXHROpen = XMLHttpRequest.prototype.open;
  const originalXHRSend = XMLHttpRequest.prototype.send;
  
  XMLHttpRequest.prototype.open = function(method: string, url: string | URL, async?: boolean, username?: string | null, password?: string | null) {
    if (typeof url === 'string' && url.includes('UploadFile')) {
      console.log('Intercepted XHR upload request:', method, url);
      (this as any).__uploadUrl = url;
    }
    return originalXHROpen.call(this, method, url, async !== undefined ? async : true, username, password);
  };
  
  XMLHttpRequest.prototype.send = function(body?: any) {
    if ((this as any).__uploadUrl) {
      console.log('XHR upload body:', body);
      if (body instanceof FormData) {
        console.log('XHR FormData entries:');
        const formData = body as FormData;
        try {
          (formData as any).forEach((value: any, key: string) => {
            if (value instanceof File) {
              console.log(`  ${key}: [File] ${value.name}`);
            } else {
              console.log(`  ${key}: ${value}`);
            }
          });
        } catch (e) {
          console.log('  (Unable to iterate FormData)');
        }
      }
    }
    return originalXHRSend.apply(this, [body]);
  };
  
  // Also intercept fetch
  const originalFetch = window.fetch;
  window.fetch = function(input: RequestInfo | URL, init?: RequestInit) {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (typeof url === 'string' && url.includes('UploadFile')) {
      console.log('Intercepted fetch upload request:', url, init);
      if (init?.body instanceof FormData) {
        console.log('Fetch FormData entries:');
        const formData = init.body as FormData;
        try {
          (formData as any).forEach((value: any, key: string) => {
            if (value instanceof File) {
              console.log(`  ${key}: [File] ${value.name}`);
            } else {
              console.log(`  ${key}: ${value}`);
            }
          });
        } catch (e) {
          console.log('  (Unable to iterate FormData)');
        }
      }
    }
    return originalFetch.call(this, input, init);
  };
}

// Initialize file upload watcher when content script loads
function initializeFileUploadWatcher(): void {
  // Set up interceptors to capture form's upload format
  setupUploadInterceptor();
  
  // Check if file upload container exists immediately
  checkAndUploadPendingFile();
  
  // Clean up existing observer if any
  if (fileUploadObserver) {
    fileUploadObserver.disconnect();
    fileUploadObserver = null;
  }
  
  // Set up MutationObserver to watch for file upload container appearing
  fileUploadObserver = new MutationObserver((mutations, observer) => {
    // Check if file upload container appeared
    const fileUploadQuestion = document.querySelector('.form-group.fileUploadQuestion');
    const uploadButton = document.querySelector('input[type="button"].uploadFileLink');
    
    // If upload button appears, intercept it IMMEDIATELY to prevent file picker
    if (uploadButton && !(uploadButton as any).__uploadIntercepted && pendingPDFFileData) {
      console.log('Upload button detected, intercepting to prevent file picker...');
      
      // Intercept the button immediately
      (uploadButton as any).__uploadIntercepted = true;
      
      // Clone and replace button to remove existing handlers
      const newButton = uploadButton.cloneNode(true) as HTMLInputElement;
      uploadButton.parentNode?.replaceChild(newButton, uploadButton);
      
      // Add intercept handler in capture phase (runs first)
      newButton.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        console.log('Upload button click intercepted, preventing file picker');
        return false;
      }, true);
    }
    
    // Check if container exists and is visible
    if (fileUploadQuestion && uploadButton && pendingPDFFileData) {
      // Check if the element is actually visible (not hidden)
      const uploadQuestionHTMLElement = fileUploadQuestion as HTMLElement;
      const isVisible = uploadQuestionHTMLElement.offsetParent !== null ||
                       uploadQuestionHTMLElement.style.display !== 'none' ||
                       window.getComputedStyle(uploadQuestionHTMLElement).display !== 'none';
      
      if (isVisible) {
        console.log('File upload container detected and visible, uploading pending file...');
        // Small delay to ensure button interception is in place
        setTimeout(() => {
          checkAndUploadPendingFile();
        }, 50);
      }
    }
  });
  
  // Start observing the document body for changes
  // BUT: Only observe a limited scope to avoid performance issues
  // Focus on the main content area, not the entire body
  const observeTarget = document.querySelector('.main-content, .form-container, .survey-container') || document.body;
  fileUploadObserver.observe(observeTarget, {
    childList: true,
    subtree: false, // Don't watch all subtrees - too expensive
    attributes: false // Don't watch attributes - they change too frequently
  });
  
  // Also check periodically in case MutationObserver misses it
  // BUT: Use a much longer interval and limit checks to avoid performance issues
  let checkCount = 0;
  const maxChecks = 20; // Reduced from 120 - only check for 10 seconds (20 * 500ms)
  const checkInterval = setInterval(() => {
    // Skip if page is unresponsive (don't add more load)
    if (document.hidden || document.visibilityState === 'hidden') {
      return;
    }
    
    if (pendingPDFFileData && checkCount < maxChecks) {
      checkCount++;
      const fileUploadQuestion = document.querySelector('.form-group.fileUploadQuestion');                                                                      
      const uploadButton = document.querySelector('input[type="button"].uploadFileLink');                                                                       

      if (fileUploadQuestion && uploadButton) {
        // Check if visible
        const uploadQuestionHTMLElement = fileUploadQuestion as HTMLElement;    
        const isVisible = uploadQuestionHTMLElement.offsetParent !== null ||    
                         window.getComputedStyle(uploadQuestionHTMLElement).display !== 'none';                                                                 

        if (isVisible) {
          console.log('File upload container found via periodic check, uploading...');                                                                            
          if (checkAndUploadPendingFile()) {
            clearInterval(checkInterval);
          }
        }
      }
    }
    if (!pendingPDFFileData || checkCount >= maxChecks) {
      clearInterval(checkInterval);
    }
  }, 1000); // Increased interval from 500ms to 1000ms to reduce load
  
  // Listen for "Next" button clicks to trigger immediate check
  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    // Check if it's a "Next" button or navigation button
    const inputTarget = target as HTMLInputElement;
    const closestSubmit = target.closest('input[type="submit"]') as HTMLInputElement | null;
    if (target && (
      target.textContent?.toLowerCase().includes('next') ||
      (inputTarget && inputTarget.value?.toLowerCase().includes('next')) ||
      target.classList.contains('next') ||
      target.id?.toLowerCase().includes('next') ||
      target.closest('button')?.textContent?.toLowerCase().includes('next') ||
      (closestSubmit && closestSubmit.value?.toLowerCase().includes('next'))
    )) {
      console.log('Next button clicked, will check for file upload container and refill form after navigation...');
      // Reset refill count when Next is clicked
      refillCount = 0;
      // Wait a bit for the next page to load, then check
      setTimeout(() => {
        // Refill form on new page if form data is available (force refill on navigation)
        if (pendingFormData) {
          console.log('Refilling form fields on new page (Next button clicked)...');
          checkAndRefillOnNewPage(true); // Force refill on navigation
        }
        checkAndUploadPendingFile();
      }, 1200);
    }
  }, true); // Use capture phase to catch events early
}

// Check for pending file and upload if container exists
function checkAndUploadPendingFile(): boolean {
  if (!pendingPDFFileData) {
    return false;
  }
  
  const fileUploadQuestion = document.querySelector('.form-group.fileUploadQuestion') as HTMLElement;
  let uploadButton = document.querySelector('input[type="button"].uploadFileLink') as HTMLInputElement;
  
  if (!fileUploadQuestion || !uploadButton) {
    console.log('File upload container not found yet, waiting...');
    return false;
  }
  
  // Check if the container is actually visible
  const isVisible = fileUploadQuestion.offsetParent !== null || 
                   window.getComputedStyle(fileUploadQuestion).display !== 'none';
  
  if (!isVisible) {
    console.log('File upload container exists but is not visible yet...');
    return false;
  }
  
  // CRITICAL: Intercept the upload button BEFORE uploading to prevent file picker
  if (uploadButton && !(uploadButton as any).__uploadIntercepted) {
    (uploadButton as any).__uploadIntercepted = true;
    
    // Clone and replace button to remove any existing handlers
    const newButton = uploadButton.cloneNode(true) as HTMLInputElement;
    uploadButton.parentNode?.replaceChild(newButton, uploadButton);
    
    // Add intercept handler in capture phase (runs BEFORE other handlers)
    newButton.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      console.log('Upload button click intercepted (pre-upload), preventing file picker');
      return false;
    }, true);
    
    // Update reference to the new button for use in uploadPDFFile
    uploadButton = newButton;
  }
  
  // Reconstruct file from stored data
  const uint8Array = new Uint8Array(pendingPDFFileData.arrayBuffer);
  const blob = new Blob([uint8Array], { type: pendingPDFFileData.type });
  const pdfFile = new File([blob], pendingPDFFileData.name, { type: pendingPDFFileData.type });
  
  // Store file data before clearing
  const fileDataToUpload = { ...pendingPDFFileData };
  
  // Clear pending file data immediately to prevent duplicate uploads
  pendingPDFFileData = null;
  
  // Upload the file (pass the intercepted button reference if available)
  console.log('Uploading stored PDF file:', pdfFile.name);
  uploadPDFFile(pdfFile);
  
  return true;
}

// Initialize watcher when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeFileUploadWatcher);
} else {
  initializeFileUploadWatcher();
}

// Watch for URL changes (SPA navigation)
// Use a more efficient approach - check URL periodically instead of watching DOM
let lastUrl = location.href;
let urlCheckInterval: number | null = null;

function checkUrlChange(): void {
  const url = location.href;
  if (url !== lastUrl) {
    lastUrl = url;
    console.log('Page navigation detected, checking for file upload container and refilling form...');
    // Reset refill count on navigation
    refillCount = 0;
    // Small delay to allow new page content to load
    setTimeout(() => {
      // Refill form on new page if form data is available (force refill on navigation)
      if (pendingFormData) {
        console.log('Refilling form fields on new page (URL changed)...');
        checkAndRefillOnNewPage(true); // Force refill on navigation
      }
      
      if (checkAndUploadPendingFile()) {
        // File was uploaded successfully, can stop checking
        if (urlCheckInterval) {
          clearInterval(urlCheckInterval);
          urlCheckInterval = null;
        }
      } else {
        // Reinitialize watcher for new page
        initializeFileUploadWatcher();
        // Reinitialize form page observer (resets refill count)
        initializeFormPageObserver();
      }
    }, 1500); // Increased delay for AJAX page loads
  }
}

// Check URL every 500ms instead of watching DOM (much more efficient)
if (!urlCheckInterval) {
  urlCheckInterval = window.setInterval(checkUrlChange, 500);
}

// Also watch for DOM changes that might indicate a new form page loaded
// DISABLED: This was causing page unresponsiveness. We'll rely on URL changes and navigation events instead.
let formPageObserver: MutationObserver | null = null;
let lastFormFieldsCount = 0;
let refillDebounceTimer: number | null = null;
let isRefilling = false; // Prevent recursive refilling
let lastUserInteraction = 0;
let refillCount = 0; // Track how many times we've refilled to prevent infinite loops
const MAX_REFILLS_PER_PAGE = 1; // Only refill once per page

function checkAndRefillOnNewPage(force: boolean = false): void {
  // SKIP refilling on page 2+ to prevent unresponsiveness
  // Only allow refilling on explicit navigation (force=true) and even then be conservative
  if (!pendingFormData || isRefilling) return;
  
  // Don't refill if page appears to be unresponsive
  if (document.hidden || document.visibilityState === 'hidden') {
    console.log('Page is hidden, skipping refill');
    return;
  }
  
  // Prevent too many refills on the same page
  if (!force && refillCount >= MAX_REFILLS_PER_PAGE) {
    console.log('Max refills per page reached, skipping');
    return;
  }
  
  // Don't refill if user has recently interacted with the page
  const timeSinceInteraction = Date.now() - lastUserInteraction;
  if (!force && timeSinceInteraction < 5000) { // Wait 5 seconds after user interaction (increased)
    console.log('Skipping refill - user recently interacted with form');
    return;
  }
  
  // Check if form fields are present
  const formGroups = document.querySelectorAll('.form-group');
  const currentFieldsCount = formGroups.length;
  
  if (currentFieldsCount === 0) {
    return; // No form fields, nothing to fill
  }
  
  // Only trigger on significant changes (more than 5 fields difference, or first time)
  const fieldsChanged = Math.abs(currentFieldsCount - lastFormFieldsCount);
  const isSignificantChange = fieldsChanged > 5 || (lastFormFieldsCount === 0 && currentFieldsCount > 7);
  
  // Only refill on forced navigation (explicit page change), not on every DOM change
  if (force) {
    console.log(`Form fields detected (${currentFieldsCount}), checking if refill needed (force: ${force})...`);
    lastFormFieldsCount = currentFieldsCount;
    
    // Debounce to avoid rapid-fire refilling
    if (refillDebounceTimer) {
      clearTimeout(refillDebounceTimer);
    }
    
    refillDebounceTimer = window.setTimeout(() => {
      if (!pendingFormData || isRefilling) return;
      
      // Quick check - only refill if there are many empty fields
      const formGroups = document.querySelectorAll('.form-group');
      let emptyFieldCount = 0;
      
      // Only check first 10 form groups to avoid performance issues
      const groupsToCheck = Array.from(formGroups).slice(0, 10);
      const hasEmptyFields = groupsToCheck.some(group => {
        // Skip if this group has user focus (user is actively editing)
        const activeElement = document.activeElement;
        if (activeElement && group.contains(activeElement)) {
          return false;
        }
        
        const input = group.querySelector<HTMLInputElement>('input[type="text"], input.free-text, textarea');                                                 
        const select = group.querySelector<HTMLSelectElement>('select');      
        const radioGroup = group.querySelectorAll<HTMLInputElement>('input[type="radio"]:checked');                                                           

        const isEmpty = (input && !input.value) ||
                       (select && (!select.value || select.value === '-1')) ||        
                       (radioGroup.length === 0 && group.querySelectorAll('input[type="radio"]').length > 0);
        
        if (isEmpty) emptyFieldCount++;
        return isEmpty;
      });

      // Only refill if there are multiple empty fields
      if (hasEmptyFields && emptyFieldCount > 3) {
        console.log(`Refilling form fields (${emptyFieldCount} empty fields found)...`);
        isRefilling = true;
        refillCount++;
        try {
          fillExpenseForm(pendingFormData, undefined);
        } catch (error) {
          console.error('Error during form refill:', error);
        } finally {
          // Reset flag after a delay to allow form to stabilize
          setTimeout(() => {
            isRefilling = false;
          }, 2000); // Increased delay
        }
      } else {
        console.log(`Skipping refill - only ${emptyFieldCount} empty fields (need >3)`);
      }
    }, 2000); // Longer delay - wait 2 seconds after navigation
  } else if (currentFieldsCount > 0) {
    lastFormFieldsCount = currentFieldsCount;
  }
}

// Track user interactions to avoid interfering
function trackUserInteraction(): void {
  lastUserInteraction = Date.now();
}

// Set up event listeners to track user interactions
function setupUserInteractionTracking(): void {
  const events = ['input', 'change', 'click', 'keydown', 'focus'];
  events.forEach(eventType => {
    document.addEventListener(eventType, trackUserInteraction, true);
  });
}

// DISABLED: Form page observer is too aggressive and causes unresponsiveness
// We'll rely on URL changes and explicit navigation events instead
function initializeFormPageObserver(): void {
  // Disable the observer completely - it was causing page unresponsiveness
  if (formPageObserver) {
    formPageObserver.disconnect();
    formPageObserver = null;
  }
  
  // Set up user interaction tracking
  setupUserInteractionTracking();
  
  // Reset refill count when observer is initialized (new page)
  refillCount = 0;
  
  // Initial check (with longer delay to avoid immediate refilling)
  setTimeout(() => {
    checkAndRefillOnNewPage(false);
  }, 1500);
}

// Initialize form page observer
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeFormPageObserver);
} else {
  initializeFormPageObserver();
}

// Also use popstate event for browser navigation
window.addEventListener('popstate', () => {
  console.log('Browser navigation detected, checking for file upload container and refilling form...');
  // Reset refill count on navigation
  refillCount = 0;
  setTimeout(() => {
    // Refill form on new page if form data is available (force refill on navigation)
    if (pendingFormData) {
      console.log('Refilling form fields on new page (browser navigation)...');
      checkAndRefillOnNewPage(true); // Force refill on navigation
    }
    
    checkAndUploadPendingFile();
    initializeFileUploadWatcher();
    // Reinitialize form page observer (resets refill count)
    initializeFormPageObserver();
  }, 800);
});

function fillExpenseForm(data: ParsedExpenseData, pdfFile?: File): FillSummary {
  const results: FillResult[] = [];

  // Handle PDF file upload - try immediately, but also set up watcher for later pages
  if (pdfFile) {
    // Try to upload immediately if container exists
    const fileUploadQuestion = document.querySelector('.form-group.fileUploadQuestion');
    if (fileUploadQuestion) {
      console.log('File upload container found on current page, uploading immediately...');
      setTimeout(() => {
        uploadPDFFile(pdfFile);
      }, 100);
    } else {
      console.log('File upload container not found on current page. File will be uploaded when you navigate to the upload page.');
      // File data is already stored in pendingPDFFileData by the message listener
      // The watcher will upload it when the container appears
    }
  }

  // Map of field labels to their handlers - using label patterns directly
  const fieldMappings = [
    {
      labelPattern: /Purchaser Name/i,
      fieldName: 'Purchaser Name',
      handler: () => fillTextFieldByPattern(/Purchaser Name/i, 'Purchaser Name', data.purchaser_name.value, data.purchaser_name.confidence)
    },
    {
      labelPattern: /Purchaser's NetID/i,
      fieldName: 'NetID',
      handler: () => fillTextFieldByPattern(/Purchaser's NetID/i, 'NetID', data.netid.value, data.netid.confidence)
    },
    {
      labelPattern: /Club\/Organization/i,
      fieldName: 'Club/Organization',
      handler: () => fillDropdownByPattern(/Club\/Organization/i, 'Club/Organization', data.club_name.value, data.club_name.confidence)
    },
    {
      labelPattern: /Payment Method/i,
      fieldName: 'Payment Method',
      handler: () => fillRadioGroupByPattern(/Payment Method/i, 'Payment Method', data.payment_method.value, data.payment_method.confidence)
    },
    {
      labelPattern: /Vendor Name/i,
      fieldName: 'Vendor Name',
      handler: () => fillTextFieldByPattern(/Vendor Name/i, 'Vendor Name', data.vendor_name.value, data.vendor_name.confidence)
    },
    {
      labelPattern: /Date of Expense/i,
      fieldName: 'Date of Expense',
      handler: () => fillTextFieldByPattern(/Date of Expense/i, 'Date of Expense', formatDate(data.date_of_expense.value), data.date_of_expense.confidence)
    },
    {
      labelPattern: /Expense Amount/i,
      fieldName: 'Expense Amount',
      handler: () => fillTextFieldByPattern(/Expense Amount/i, 'Expense Amount', String(data.total_amount.value), data.total_amount.confidence)
    },
    {
      labelPattern: /Purchase Type/i,
      fieldName: 'Purchase Type',
      handler: () => fillRadioGroupByPattern(/Purchase Type/i, 'Purchase Type', data.purchase_type.value, data.purchase_type.confidence)
    },
    {
      labelPattern: /Include the link to the applicable NYU Engage event/i,
      fieldName: 'Event Link',
      handler: () => fillTextFieldByPattern(/Include the link.*NYU Engage event/i, 'Event Link', data.event_link.value, data.event_link.confidence)
    },
    {
      labelPattern: /In a few sentences.*describe the reason for the purchase/i,
      fieldName: 'Description',
      handler: () => fillTextFieldByPattern(/In a few sentences.*describe the reason for the purchase/i, 'Description', data.description.value, data.description.confidence, true) // Always fill description if value exists
    }
  ];

  fieldMappings.forEach(({ labelPattern, fieldName, handler }) => {
    try {
    const result = handler();
    if (result) {
      results.push(result);
        if (!result.filled && result.needsReview) {
          console.log(`Field marked for review: ${fieldName} - ${result.filled ? 'filled' : 'not filled'}, needsReview: ${result.needsReview}`);
        }
      } else {
        // If handler returned null, the field wasn't found - still log it
        console.warn(`Field handler returned null: ${fieldName} (pattern: ${labelPattern})`);
        // Try to debug by checking if the label exists
        const formGroups = document.querySelectorAll('.form-group');
        for (const formGroup of Array.from(formGroups)) {
          const labelSet = formGroup.querySelector('.label-set');
          if (labelSet) {
            const text = labelSet.textContent || '';
            if (labelPattern.test(text)) {
              console.warn(`Found matching label but handler returned null: ${fieldName}`);
              console.warn(`Label text: ${text.substring(0, 100)}...`);
            }
          }
        }
      }
    } catch (error) {
      console.error(`Error processing field ${fieldName}:`, error);
    }
  });

  const filledFields = results.filter(r => r.filled).length;
  const lowConfidenceFields = results.filter(r => r.needsReview).length;

  return {
    results,
    totalFields: fieldMappings.length,
    filledFields,
    lowConfidenceFields
  };
}

function findFieldByLabel(labelPattern: RegExp): HTMLElement | null {
  // Normalize text for comparison - remove extra whitespace, normalize case
  const normalizeText = (text: string): string => {
    return text
      .replace(/\s+/g, ' ')  // Replace multiple spaces with single space
      .replace(/[\n\r\t]/g, ' ')  // Replace newlines/tabs with spaces
      .trim()
      .toLowerCase();
  };
  
  // Try multiple selectors to find labels
  const labelSelectors = [
    '.label-set',
    'label.label-set',
    '.form-group .label-set',
    'label strong',
    '.label-set strong',
    '.label-set > strong',
    '.label-set strong strong'  // Handle nested strong tags
  ];
  
  const patternString = labelPattern.source;
  const normalizedPattern = new RegExp(patternString, 'i');
  
  for (const selector of labelSelectors) {
    try {
      const labels = document.querySelectorAll(selector);
  
  for (const label of Array.from(labels)) {
        // Get text content, handling nested elements
        const rawText = label.textContent || '';
        const normalizedText = normalizeText(rawText);
        
        // Test if pattern matches the text (both normalized and original)
        if (normalizedPattern.test(normalizedText) || labelPattern.test(rawText)) {
      // Find the parent form-group
      const formGroup = label.closest('.form-group');
      if (formGroup) {
            return formGroup as HTMLElement;
          }
          
          // Also check if the label itself is in a form-group
          let parent: HTMLElement | null = label.parentElement as HTMLElement;
          while (parent && parent !== document.body) {
            if (parent.classList.contains('form-group')) {
              return parent;
            }
            parent = parent.parentElement as HTMLElement;
          }
        }
      }
    } catch (error) {
      // Skip selector if it causes an error
      continue;
    }
  }
  
  // Fallback: search all form-groups and check their label content
  const formGroups = document.querySelectorAll('.form-group');
  for (const formGroup of Array.from(formGroups)) {
    const labelSet = formGroup.querySelector('.label-set');
    if (labelSet) {
      const rawText = labelSet.textContent || '';
      const normalizedText = normalizeText(rawText);
      
      if (normalizedPattern.test(normalizedText) || labelPattern.test(rawText)) {
        return formGroup as HTMLElement;
      }
    }
  }
  
  return null;
}

function isUnknownValue(value: string, confidence: number): boolean {
  if (!value || value.trim() === '') return true;
  const lowerValue = value.toLowerCase().trim();
  if (lowerValue === 'n/a' || lowerValue === 'na' || lowerValue === 'none' || lowerValue === 'unknown') return true;
  if (confidence < UNKNOWN_THRESHOLD) return true;
  return false;
}

function fillTextFieldByPattern(labelPattern: RegExp, fieldName: string, value: string, confidence: number, alwaysFillIfNotEmpty: boolean = false): FillResult | null {
  const formGroup = findFieldByLabel(labelPattern);
  if (!formGroup) {
    console.warn(`Form group not found for field: ${fieldName} (pattern: ${labelPattern})`);
    return { fieldName, filled: false, confidence: 0, needsReview: false };
  }

  // Try multiple selectors to find the input
  let input = formGroup.querySelector<HTMLInputElement>('input.free-text');
  if (!input) {
    input = formGroup.querySelector<HTMLInputElement>('input[type="text"]');
  }
  if (!input) {
    input = formGroup.querySelector<HTMLInputElement>('textarea');
  }
  if (!input) {
    // Look for input with id containing "answerTextBox"
    input = formGroup.querySelector<HTMLInputElement>('input[id*="answerTextBox"]');
  }
  
  if (!input) {
    console.warn(`Input element not found in form group for field: ${fieldName}`);
    return { fieldName, filled: false, confidence: 0, needsReview: false };
  }

  // For fields like description that should always be filled if a value exists (even if confidence is low)
  if (alwaysFillIfNotEmpty && value && value.trim() !== '') {
    // Still check for N/A values
    const lowerValue = value.toLowerCase().trim();
    if (lowerValue !== 'n/a' && lowerValue !== 'na' && lowerValue !== 'none' && lowerValue !== 'unknown') {
      // Don't overwrite if field already has a value (user may have entered it)
      if (input.value && input.value.trim() !== '' && !input.hasAttribute('data-autofilled')) {
        console.log(`Skipping ${fieldName} - field already has value: "${input.value}"`);
        return {
          fieldName,
          filled: false,
          confidence: 0,
          needsReview: false
        };
      }

      input.value = value;
      // Mark as autofilled to prevent accidental overwrites
      input.setAttribute('data-autofilled', 'true');
      // Trigger multiple events to ensure the form recognizes the change       
      input.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));                                                                         
      input.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));                                                                          
      input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));                                                                                      
      input.dispatchEvent(new FocusEvent('blur', { bubbles: true }));

      // Mark for review if confidence is low
      const needsReview = confidence < CONFIDENCE_THRESHOLD;
      if (needsReview) {
        markLowConfidenceField(formGroup, `AI-generated description (confidence: ${Math.round(confidence * 100)}%). Please review and edit if needed.`);
      }

      return {
        fieldName,
        filled: true,
        confidence,
        value,
        needsReview
      };
    }
  }

  // Check if value is unknown - if so, highlight field instead of filling
  if (isUnknownValue(value, confidence)) {
    markUnknownField(formGroup, fieldName, 'This field could not be determined from the receipt. Please fill it manually.');
    return {
      fieldName,
      filled: false,
      confidence: 0,
      needsReview: true,
      value: undefined
    };
  }

  // Don't overwrite if field already has a value (user may have entered it)
  // Only fill if field is empty or has placeholder/default value
  if (input.value && input.value.trim() !== '' && !input.hasAttribute('data-autofilled')) {
    console.log(`Skipping ${fieldName} - field already has value: "${input.value}"`);
    return {
      fieldName,
      filled: false,
      confidence: 0,
      needsReview: false
    };
  }

  input.value = value;
  // Mark as autofilled to prevent accidental overwrites
  input.setAttribute('data-autofilled', 'true');
  // Trigger multiple events to ensure the form recognizes the change
  input.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
  input.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
  input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
  input.dispatchEvent(new FocusEvent('blur', { bubbles: true }));

  const needsReview = confidence < CONFIDENCE_THRESHOLD;
  if (needsReview) {
    markLowConfidenceField(formGroup, `Low confidence (${Math.round(confidence * 100)}%). Please review.`);
  }

  return {
    fieldName,
    filled: true,
    confidence,
    value,
    needsReview
  };
}

// Legacy function for backwards compatibility
function fillTextField(fieldName: string, value: string, confidence: number, alwaysFillIfNotEmpty: boolean = false): FillResult | null {
  const escapedFieldName = fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return fillTextFieldByPattern(new RegExp(escapedFieldName, 'i'), fieldName, value, confidence, alwaysFillIfNotEmpty);
}

function fillDropdownByPattern(labelPattern: RegExp, fieldName: string, value: string, confidence: number): FillResult | null {
  const formGroup = findFieldByLabel(labelPattern);
  if (!formGroup) {
    console.warn(`Form group not found for dropdown field: ${fieldName} (pattern: ${labelPattern})`);
    return { fieldName, filled: false, confidence: 0, needsReview: false };
  }

  const select = formGroup.querySelector<HTMLSelectElement>('select');
  if (!select) {
    return { fieldName, filled: false, confidence: 0, needsReview: false };
  }

  // Check if value is unknown - if so, highlight field instead of filling
  if (isUnknownValue(value, confidence)) {
    markUnknownField(formGroup, fieldName, 'This field could not be determined from the receipt. Please select an option manually.');
    return {
      fieldName,
      filled: false,
      confidence: 0,
      needsReview: true,
      value: undefined
    };
  }

  // Try to find option by text (case-insensitive)
  const options = Array.from(select.options);
  const matchingOption = options.find(opt => 
    opt.textContent?.toLowerCase().includes(value.toLowerCase()) ||
    value.toLowerCase().includes(opt.textContent?.toLowerCase() || '')
  );

  if (matchingOption && matchingOption.value !== '-1') {
    select.value = matchingOption.value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    
    const needsReview = confidence < CONFIDENCE_THRESHOLD;
    if (needsReview) {
      markLowConfidenceField(formGroup, `Low confidence (${Math.round(confidence * 100)}%). Please review.`);
    }

    return {
      fieldName,
      filled: true,
      confidence,
      value: matchingOption.textContent || value,
      needsReview
    };
  }

  // No matching option found - mark as unknown
  markUnknownField(formGroup, fieldName, `Could not find matching option for "${value}". Please select manually.`);
  return {
    fieldName,
    filled: false,
    confidence: 0,
    needsReview: true,
    value: undefined
  };
}

// Legacy function for backwards compatibility
function fillDropdown(fieldName: string, value: string, confidence: number): FillResult | null {
  const escapedFieldName = fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return fillDropdownByPattern(new RegExp(escapedFieldName, 'i'), fieldName, value, confidence);
}

function fillRadioGroupByPattern(labelPattern: RegExp, fieldName: string, value: string, confidence: number): FillResult | null {
  const formGroup = findFieldByLabel(labelPattern);
  if (!formGroup) {
    console.warn(`Form group not found for radio group field: ${fieldName} (pattern: ${labelPattern})`);
    return { fieldName, filled: false, confidence: 0, needsReview: false };
  }

  const radioGroup = formGroup.querySelector('[role="group"]') || formGroup;
  const radios = radioGroup.querySelectorAll<HTMLInputElement>('input[type="radio"]');
  
  if (radios.length === 0) {
    return { fieldName, filled: false, confidence: 0, needsReview: false };
  }

  // Check if value is unknown - if so, highlight field instead of filling
  if (isUnknownValue(value, confidence)) {
    markUnknownField(formGroup, fieldName, 'This field could not be determined from the receipt. Please select an option manually.');
    return {
      fieldName,
      filled: false,
      confidence: 0,
      needsReview: true,
      value: undefined
    };
  }

  // Map canonical values to label text patterns
  const valueMappings: Record<string, Record<string, RegExp[]>> = {
    'Payment Method': {
      'club_card_no_extra': [/club spending card.*without.*additional funding/i, /club spending card.*no.*extra/i],
      'club_card_with_extra': [/club spending card.*with.*additional funding/i, /club spending card.*with.*extra/i],
      'out_of_pocket': [/out of pocket/i]
    },
    'Purchase Type': {
      'food': [/food/i],
      'apparel': [/apparel/i, /clothing/i],
      'subscription': [/subscription/i],
      'other': [/other/i]
    }
  };

  let patterns: RegExp[] = valueMappings[fieldName]?.[value] || [];
  if (patterns.length === 0) {
    // Fallback: try direct text matching
    patterns = [new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')];
  }

  for (const radio of Array.from(radios)) {
    const label = radio.closest('label') || radio.parentElement;
    const labelText = label?.textContent || '';
    
    if (patterns.some(pattern => pattern.test(labelText))) {
      radio.checked = true;
      radio.dispatchEvent(new Event('change', { bubbles: true }));
      radio.dispatchEvent(new Event('click', { bubbles: true }));

      const needsReview = confidence < CONFIDENCE_THRESHOLD;
      if (needsReview) {
        markLowConfidenceField(formGroup, `Low confidence (${Math.round(confidence * 100)}%). Please review.`);
      }

      return {
        fieldName,
        filled: true,
        confidence,
        value: labelText.trim(),
        needsReview
      };
    }
  }

  // No matching radio found - mark as unknown
  markUnknownField(formGroup, fieldName, `Could not find matching option for "${value}". Please select manually.`);
  return {
    fieldName,
    filled: false,
    confidence: 0,
    needsReview: true,
    value: undefined
  };
}

// Legacy function for backwards compatibility
function fillRadioGroup(fieldName: string, value: string, confidence: number): FillResult | null {
  const escapedFieldName = fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return fillRadioGroupByPattern(new RegExp(escapedFieldName, 'i'), fieldName, value, confidence);
}

function formatDate(dateStr: string): string {
  if (!dateStr) return '';
  
  // If already in MM/DD/YYYY format, return as is
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(dateStr)) {
    return dateStr;
  }
  
  // Try to parse YYYY-MM-DD format
  const date = new Date(dateStr);
  if (!isNaN(date.getTime())) {
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const year = date.getFullYear();
    return `${month}/${day}/${year}`;
  }
  
  return dateStr;
}

function markLowConfidenceField(container: HTMLElement, tooltipText: string = 'Low confidence - please review'): void {
  container.style.backgroundColor = '#fff9cc';
  container.style.outline = '2px solid #ff6b6b';
  container.style.borderRadius = '4px';
  container.style.padding = '8px';
  container.style.margin = '4px 0';
  container.style.position = 'relative';
  
  // Add a warning indicator with tooltip
  let warning = container.querySelector('.expense-autofill-warning') as HTMLElement;
  if (!warning) {
    warning = document.createElement('div');
    warning.className = 'expense-autofill-warning';
    warning.textContent = '⚠ AI low confidence – please review';
    warning.style.color = '#d32f2f';
    warning.style.fontSize = '12px';
    warning.style.fontWeight = 'bold';
    warning.style.marginTop = '4px';
    warning.style.cursor = 'help';
    
    // Add tooltip
    warning.title = tooltipText;
    container.appendChild(warning);
  } else {
    warning.title = tooltipText;
  }
}

function markUnknownField(container: HTMLElement, fieldName: string, tooltipText: string): void {
  container.style.backgroundColor = '#fff9cc';
  container.style.outline = '2px solid #d32f2f';
  container.style.borderRadius = '4px';
  container.style.padding = '8px';
  container.style.margin = '4px 0';
  container.style.position = 'relative';
  
  // Remove any existing warnings
  const existingWarning = container.querySelector('.expense-autofill-unknown');
  if (existingWarning) {
    existingWarning.remove();
  }
  
  // Add an unknown field indicator with tooltip
  const warning = document.createElement('div');
  warning.className = 'expense-autofill-unknown';
  warning.textContent = '⚠ Field could not be determined – manual input required';
  warning.style.color = '#d32f2f';
  warning.style.fontSize = '12px';
  warning.style.fontWeight = 'bold';
  warning.style.marginTop = '4px';
  warning.style.cursor = 'help';
  
  // Add tooltip on hover
  warning.title = tooltipText;
  
  // Enhanced tooltip on mouseover
  let tooltip: HTMLElement | null = null;
  warning.addEventListener('mouseenter', () => {
    tooltip = document.createElement('div');
    tooltip.textContent = tooltipText;
    tooltip.style.position = 'absolute';
    tooltip.style.backgroundColor = '#333';
    tooltip.style.color = '#fff';
    tooltip.style.padding = '8px 12px';
    tooltip.style.borderRadius = '4px';
    tooltip.style.fontSize = '11px';
    tooltip.style.zIndex = '10000';
    tooltip.style.maxWidth = '300px';
    tooltip.style.boxShadow = '0 2px 8px rgba(0,0,0,0.2)';
    tooltip.style.pointerEvents = 'none';
    tooltip.style.whiteSpace = 'normal';
    tooltip.style.wordWrap = 'break-word';
    
    const rect = warning.getBoundingClientRect();
    tooltip.style.top = `${rect.bottom + 5}px`;
    tooltip.style.left = `${rect.left}px`;
    
    document.body.appendChild(tooltip);
  });
  
  warning.addEventListener('mouseleave', () => {
    if (tooltip) {
      tooltip.remove();
      tooltip = null;
    }
  });
  
    container.appendChild(warning);
}

function uploadPDFFile(file: File): void {
  try {
    // Find the file upload container and button
    const fileUploadQuestion = document.querySelector('.form-group.fileUploadQuestion') as HTMLElement;
    let uploadButton = document.querySelector('input[type="button"].uploadFileLink') as HTMLInputElement;
    const uploadContainer = document.querySelector('.uploadFile') as HTMLElement;
    
    if (!fileUploadQuestion) {
      console.warn('PDF upload container not found');
      return;
    }
    
    // CRITICAL: Intercept the upload button IMMEDIATELY to prevent file picker
    // We need to do this before NYU Engage's JavaScript attaches its handlers
    if (uploadButton && !(uploadButton as any).__uploadIntercepted) {
      (uploadButton as any).__uploadIntercepted = true;
      
      // Remove the button and replace it to clear any existing handlers
      const newButton = uploadButton.cloneNode(true) as HTMLInputElement;
      uploadButton.parentNode?.replaceChild(newButton, uploadButton);
      uploadButton = newButton;
      
      // Intercept ALL click events on the button using capture phase (runs first)
      newButton.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        
        // Check if file is already uploaded
        const fileNameLabel = uploadContainer?.querySelector('.fileNameLabel');
        if (fileNameLabel && fileNameLabel.textContent && fileNameLabel.textContent.trim() !== '') {
          // File already uploaded, show notification
          const notification = document.createElement('div');
          notification.textContent = `File "${file.name}" is already uploaded.`;
          notification.style.cssText = 'position: fixed; top: 20px; right: 20px; background: #4caf50; color: white; padding: 12px 20px; border-radius: 4px; z-index: 10000; box-shadow: 0 2px 8px rgba(0,0,0,0.2);';
          document.body.appendChild(notification);
          setTimeout(() => notification.remove(), 3000);
          return false;
        }
        
        // File not uploaded yet, prevent file picker and upload programmatically
        console.log('Upload button clicked, preventing file picker and uploading file...');
        // The upload will happen via our AJAX call below
        return false;
      }, true); // Capture phase - runs BEFORE other handlers
    }

    // Extract required form fields from the HTML structure
    // Look for AnswerId in hidden inputs
    const answerIdInput = fileUploadQuestion.querySelector('input[name*="AnswerId"]') as HTMLInputElement;
    const answerIdFromId = fileUploadQuestion.querySelector('input[id*="AnswerId"]') as HTMLInputElement;
    
    // Get the AnswerId - this is required for the upload
    const answerId = answerIdInput?.value || 
                     answerIdFromId?.value ||
                     fileUploadQuestion.querySelector('input[name*="AnswerId"]')?.getAttribute('value') ||
                     null;
    
    // Find the upload URL - it might be in an input with name="uploadUrl"
    const uploadUrlInput = fileUploadQuestion.querySelector('input[name="uploadUrl"]') as HTMLInputElement;
    const uploadDialogUrlInput = fileUploadQuestion.querySelector('input.uploadDialogUrl') as HTMLInputElement;
    const uploadDialogUrl = uploadDialogUrlInput?.value;
    
    // Use uploadUrl (the actual upload endpoint), not uploadDialogUrl (which opens a dialog)
    // If uploadUrl is not found, try to construct it from uploadDialogUrl
    let uploadUrl = uploadUrlInput?.value;
    if (!uploadUrl && uploadDialogUrl) {
      // Replace GetFileUploadDialog with UploadFile
      uploadUrl = uploadDialogUrl.replace('GetFileUploadDialog', 'UploadFile');
    }
    // Fallback to default URL if neither is found
    if (!uploadUrl) {
      uploadUrl = 'https://engage.nyu.edu/submitter/FileUploadQuestion/UploadFile';
    }
    
    if (!answerId) {
      console.warn('AnswerId not found, cannot upload file');
      return;
    }

    console.log('Uploading PDF file to NYU Engage:', {
      fileName: file.name,
      fileSize: file.size,
      answerId: answerId,
      uploadUrl: uploadUrl
    });

    // Strategy: NYU Engage likely uses a modal dialog system for file uploads
    // The 500 error suggests the API endpoint requires specific authentication/parameters we don't have
    // Instead of calling the API directly, we'll:
    // 1. Try to find and use the form's file input (if it exists)
    // 2. If that doesn't work, show a helpful message to the user
    
    // Look for existing file input in the form
    let fileInput = fileUploadQuestion.querySelector('input[type="file"]') as HTMLInputElement;
    
    // Also check the upload container
    if (!fileInput && uploadContainer) {
      fileInput = uploadContainer.querySelector('input[type="file"]') as HTMLInputElement;
    }
    
    // Check if form uses a hidden file input
    if (!fileInput) {
      const allFileInputs = document.querySelectorAll('input[type="file"]');
      for (const input of Array.from(allFileInputs)) {
        if (uploadButton) {
          const inputRect = input.getBoundingClientRect();
          const buttonRect = uploadButton.getBoundingClientRect();
          const distance = Math.abs(inputRect.top - buttonRect.top) + Math.abs(inputRect.left - buttonRect.left);
          if (distance < 200) {
            fileInput = input as HTMLInputElement;
            break;
          }
        }
      }
    }
    
    // If we found a file input, try to set the file on it
    if (fileInput) {
      console.log('Found file input element, attempting to set file...');
      
      try {
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(file);
        
        // Set the files property
        Object.defineProperty(fileInput, 'files', {
          value: dataTransfer.files,
          writable: false,
          configurable: true
        });
        
        console.log('File set on input element, triggering change event...');
        
        // Trigger change event - the form's JavaScript should handle the upload
        const changeEvent = new Event('change', { bubbles: true, cancelable: true });
        fileInput.dispatchEvent(changeEvent);
        
        // Also trigger input event
        fileInput.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
        
        // Update UI to show file name
        const fileNameLabel = uploadContainer?.querySelector('.fileNameLabel') as HTMLElement;
        if (fileNameLabel) {
          fileNameLabel.textContent = file.name;
          fileNameLabel.style.display = 'inline';
        }
        
        const uploadFileNameDiv = uploadContainer?.querySelector('.uploadFileName') as HTMLElement;
        if (uploadFileNameDiv) {
          uploadFileNameDiv.style.display = 'block';
        }
        
        // Wait to see if the form processes the file
        setTimeout(() => {
          const tempFileNameInput = fileUploadQuestion.querySelector('input.temporaryFileNameField') as HTMLInputElement;
          const fileNameInput = fileUploadQuestion.querySelector('input[name*="FileName"]') as HTMLInputElement;
          
          if (tempFileNameInput?.value || fileNameInput?.value) {
            console.log('✅ File upload successful - form handler processed the file');
            pendingPDFFileData = null;
            if (uploadButton) {
              uploadButton.value = '✓ File Uploaded';
              uploadButton.style.backgroundColor = '#4caf50';
              uploadButton.style.color = 'white';
              uploadButton.disabled = true;
            }
          } else {
            console.warn('⚠ File input found but form handler did not process the file automatically');
            console.warn('This might mean the form uses a modal dialog system');
            showManualUploadMessage(file.name, uploadContainer);
          }
        }, 2000); // Wait 2 seconds for form to process
        
        return; // Exit - file is set, let form handle it
        
      } catch (error) {
        console.error('❌ Could not set file on input element:', error);
        showManualUploadMessage(file.name, uploadContainer);
      }
    } else {
      console.warn('⚠ No file input element found');
      console.warn('NYU Engage likely uses a modal dialog for file uploads');
      console.warn('The file picker dialog cannot be bypassed due to browser security restrictions');
      showManualUploadMessage(file.name, uploadContainer);
    }
  } catch (error) {
    console.error('Error in uploadPDFFile:', error);
    delete (window as any).__pendingPDFFile;
  }
}

// Show helpful message when automatic upload isn't possible
function showManualUploadMessage(fileName: string, uploadContainer: HTMLElement | null): void {
  console.log('Showing manual upload message for file:', fileName);
  
  // Check if message already exists to avoid duplicates
  const existingMessage = document.querySelector('.expense-autofill-upload-message');
  if (existingMessage) {
    return; // Message already shown
  }
  
  // Create a helpful message box
  const messageBox = document.createElement('div');
  messageBox.className = 'expense-autofill-upload-message';
  messageBox.style.cssText = `
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: white;
    padding: 16px;
    margin: 12px 0;
    border-radius: 8px;
    box-shadow: 0 4px 6px rgba(0,0,0,0.1);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    position: relative;
  `;
  
  messageBox.innerHTML = `
    <div style="display: flex; align-items: center; margin-bottom: 8px;">
      <span style="font-size: 24px; margin-right: 8px;">📎</span>
      <strong style="font-size: 16px;">File Ready for Upload</strong>
    </div>
    <div style="font-size: 14px; line-height: 1.5; margin-bottom: 12px;">
      Your receipt PDF <strong>"${fileName}"</strong> has been processed and is ready.<br>
      <strong>Please click the "Upload File" button above to upload it.</strong>
    </div>
    <div style="font-size: 12px; opacity: 0.9; padding-top: 8px; border-top: 1px solid rgba(255,255,255,0.3);">
      💡 <strong>Tip:</strong> The file picker will open - select the same PDF file you uploaded in the extension.
    </div>
  `;
  
  if (uploadContainer) {
    // Insert message before the upload button
    const uploadButton = uploadContainer.querySelector('input[type="button"].uploadFileLink');
    if (uploadButton && uploadButton.parentElement) {
      uploadButton.parentElement.insertBefore(messageBox, uploadButton);
    } else {
      uploadContainer.insertBefore(messageBox, uploadContainer.firstChild);
    }
  } else {
    // Fallback: show near the file upload question
    const fileUploadQuestion = document.querySelector('.form-group.fileUploadQuestion');
    if (fileUploadQuestion) {
      fileUploadQuestion.insertBefore(messageBox, fileUploadQuestion.firstChild);
    }
  }
  
  // Also log for debugging
  console.log('Manual upload required - file picker cannot be bypassed due to browser security');
  console.log('File name to upload:', fileName);
}

// NOTE: Direct API upload was removed because it causes 500 errors
// The NYU Engage API endpoint requires specific authentication/parameters that we cannot reliably provide
// Instead, we rely on the form's file input mechanism (if available) or show a helpful manual upload message

