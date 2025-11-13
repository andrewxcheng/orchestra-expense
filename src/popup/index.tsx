import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { UserProfile, ParsedExpenseData, FillSummary } from '../types';
import './popup.css';

const Popup: React.FC = () => {
  const [profile, setProfile] = useState<UserProfile>({
    purchaser_name: '',
    netid: '',
    default_club: '',
    default_payment_method: 'out_of_pocket'
  });
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [status, setStatus] = useState<{ type: 'info' | 'success' | 'error' | 'warning'; message: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [fillSummary, setFillSummary] = useState<FillSummary | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => {
    loadProfile();
  }, []);

  const loadProfile = async () => {
    const storage = await chrome.storage.sync.get(['userProfile']);
    if (storage.userProfile) {
      setProfile(storage.userProfile);
    }
  };

  const saveProfile = async () => {
    await chrome.storage.sync.set({ userProfile: profile });
    setStatus({ type: 'success', message: 'Profile saved!' });
    setTimeout(() => setStatus(null), 2000);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && file.type === 'application/pdf') {
      setSelectedFile(file);
      setStatus({ type: 'info', message: `Selected: ${file.name}` });
    } else {
      setStatus({ type: 'error', message: 'Please select a PDF file' });
    }
  };

  const handleAutoFill = async () => {
    if (!selectedFile) {
      setStatus({ type: 'error', message: 'Please select a receipt PDF first' });
      return;
    }

    if (!profile.purchaser_name || !profile.netid) {
      setStatus({ type: 'error', message: 'Please fill in your profile information first' });
      return;
    }

    setLoading(true);
    setStatus({ type: 'info', message: 'Parsing PDF...' });

    try {
      // Parse PDF in popup context (has DOM access)
      const { extractTextFromPDF } = await import('../utils/pdfParser');
      const pdfText = await extractTextFromPDF(selectedFile);
      
      setStatus({ type: 'info', message: 'Analyzing receipt with AI...' });
      
      // Send extracted text to background script for OpenAI processing
      const response = await chrome.runtime.sendMessage({
        action: 'parseReceipt',
        pdfText: pdfText,
        userProfile: profile
      });

      if (!response.success) {
        throw new Error(response.error || 'Failed to parse receipt');
      }

      const parsedData: ParsedExpenseData = response.data;

      setStatus({ type: 'info', message: 'Filling form...' });

      // Get active tab and send fill command
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab.id) {
        throw new Error('No active tab found. Please navigate to the NYU Engage expense form page.');
      }

      // Check if the tab URL matches NYU Engage form page
      // Accept both engage.nyu.edu and nyu.edu/engage URLs, and specifically check for form pages
      const url = tab.url || '';
      // Check for engage.nyu.edu OR (nyu.edu AND submitter/form path)
      const isEngagePage = url.includes('engage.nyu.edu') || (url.includes('nyu.edu') && url.includes('submitter/form'));
      
      if (!isEngagePage) {
        console.error('Current tab URL:', url);
        throw new Error('Please navigate to the NYU Engage expense form page first. Current page: ' + (url || 'unknown'));
      }

      // Convert PDF file to ArrayBuffer for transmission
      const pdfArrayBuffer = await selectedFile.arrayBuffer();
      const pdfData = {
        name: selectedFile.name,
        type: selectedFile.type,
        size: selectedFile.size,
        arrayBuffer: Array.from(new Uint8Array(pdfArrayBuffer)) // Convert to regular array for JSON serialization
      };

      try {
        // Try to send message to content script
        const fillResponse = await chrome.tabs.sendMessage(tab.id, {
          action: 'fillForm',
          data: parsedData,
          pdfData: pdfData
        });

        if (fillResponse && fillResponse.success) {
          setFillSummary(fillResponse.summary);
          const { filledFields, lowConfidenceFields, totalFields } = fillResponse.summary;
          setStatus({
            type: lowConfidenceFields > 0 ? 'warning' : 'success',
            message: `Filled ${filledFields}/${totalFields} fields. ${lowConfidenceFields} need review.`
          });
        } else {
          throw new Error('Failed to fill form - content script did not respond');
        }
      } catch (messageError: any) {
        // If content script isn't loaded, try to inject it
        if (messageError.message && messageError.message.includes('Receiving end does not exist')) {
          // Inject content script if not already loaded
          try {
            await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              files: ['contentScript.js']
            });
          
            // Wait a bit for script to initialize, then retry
            await new Promise(resolve => setTimeout(resolve, 500));
            
            const fillResponse = await chrome.tabs.sendMessage(tab.id, {
              action: 'fillForm',
              data: parsedData,
              pdfData: pdfData
            });

            if (fillResponse && fillResponse.success) {
              setFillSummary(fillResponse.summary);
              const { filledFields, lowConfidenceFields, totalFields } = fillResponse.summary;
              setStatus({
                type: lowConfidenceFields > 0 ? 'warning' : 'success',
                message: `Filled ${filledFields}/${totalFields} fields. ${lowConfidenceFields} need review.`
              });
            } else {
              throw new Error('Failed to fill form after injecting content script');
            }
          } catch (injectError) {
            throw new Error('Could not inject content script. Please refresh the NYU Engage page and try again.');
          }
        } else {
          throw messageError;
        }
      }
    } catch (error: any) {
      setStatus({ type: 'error', message: error.message || 'An error occurred' });
    } finally {
      setLoading(false);
    }
  };

  const getConfidenceBadge = (confidence: number) => {
    if (confidence >= 0.8) return 'high';
    if (confidence >= 0.6) return 'medium';
    return 'low';
  };

  return (
    <div className="container">
      <div className="header">
        <h1>🎯 NYU Expense Auto-Fill</h1>
        <button 
          className="gear-button"
          onClick={() => setShowSettings(!showSettings)}
          title="Settings"
        >
          ⚙️
        </button>
      </div>

      {showSettings ? (
        <div className="section">
          <h2>User Profile Settings</h2>
          <div className="form-group">
            <label>Purchaser Name</label>
            <input
              type="text"
              value={profile.purchaser_name}
              onChange={(e) => setProfile({ ...profile, purchaser_name: e.target.value })}
              placeholder="Andrew Cheng"
            />
          </div>
          <div className="form-group">
            <label>NetID</label>
            <input
              type="text"
              value={profile.netid}
              onChange={(e) => setProfile({ ...profile, netid: e.target.value })}
              placeholder="ac10051"
            />
          </div>
          <div className="form-group">
            <label>Default Club/Organization</label>
            <input
              type="text"
              value={profile.default_club}
              onChange={(e) => setProfile({ ...profile, default_club: e.target.value })}
              placeholder="Finance Society"
            />
          </div>
          <div className="form-group">
            <label>Default Payment Method</label>
            <div className="radio-group">
              <label className="radio-option">
                <input
                  type="radio"
                  value="club_card_no_extra"
                  checked={profile.default_payment_method === 'club_card_no_extra'}
                  onChange={(e) => setProfile({ ...profile, default_payment_method: e.target.value as any })}
                />
                Club Card (no extra funding)
              </label>
              <label className="radio-option">
                <input
                  type="radio"
                  value="club_card_with_extra"
                  checked={profile.default_payment_method === 'club_card_with_extra'}
                  onChange={(e) => setProfile({ ...profile, default_payment_method: e.target.value as any })}
                />
                Club Card (with extra funding)
              </label>
              <label className="radio-option">
                <input
                  type="radio"
                  value="out_of_pocket"
                  checked={profile.default_payment_method === 'out_of_pocket'}
                  onChange={(e) => setProfile({ ...profile, default_payment_method: e.target.value as any })}
                />
                Out of Pocket
              </label>
            </div>
          </div>
          <div className="form-group">
            <label>OpenAI API Key</label>
            <div className="help-text">
              Configure your API key in the <a href="#" onClick={(e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); }}>Options page</a>
            </div>
          </div>
          <div className="button-group">
            <button
              onClick={saveProfile}
              className="save-button"
            >
              Save Profile
            </button>
            <button
              onClick={() => setShowSettings(false)}
              className="back-button"
            >
              Back to Main
            </button>
          </div>
        </div>
      ) : (
        <div className="section">
          <h2>Upload Receipt & Auto-Fill</h2>
          <div className="form-group">
            <label>Upload Receipt PDF</label>
            <input
              type="file"
              accept=".pdf"
              onChange={handleFileChange}
            />
          </div>
          {selectedFile && (
            <div className="file-info">
              <strong>Selected:</strong> {selectedFile.name}
            </div>
          )}
          <button
            className="primary-button"
            onClick={handleAutoFill}
            disabled={loading || !selectedFile}
          >
            {loading && <span className="loading"></span>}
            {loading ? 'Processing...' : '🚀 Auto-Fill Expense Form'}
          </button>
        </div>
      )}

      {status && (
        <div className={`status-area ${status.type}`}>
          {status.message}
        </div>
      )}

      {fillSummary && (
        <div className="status-area info" style={{ marginTop: '12px' }}>
          <strong>Fill Summary:</strong>
          <ul className="summary-list">
            {fillSummary.results.map((result, idx) => (
              <li key={idx}>
                <strong>{result.fieldName}:</strong>
                {result.filled ? (
                  <>
                    <span className={result.needsReview ? 'needs-review' : ''}>
                      {result.value || '✓'}
                    </span>
                    <span className={`confidence-badge ${getConfidenceBadge(result.confidence)}`}>
                      {(result.confidence * 100).toFixed(0)}%
                    </span>
                    {result.needsReview && <span className="needs-review"> (Review needed)</span>}
                  </>
                ) : (
                  <span style={{ color: '#999' }}>Not filled</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};

const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  root.render(<Popup />);
}

