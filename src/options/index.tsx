import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import './options.css';

const Options: React.FC = () => {
  const [apiKey, setApiKey] = useState('');
  const [status, setStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    const storage = await chrome.storage.sync.get(['openaiApiKey']);
    if (storage.openaiApiKey) {
      setApiKey(storage.openaiApiKey);
    }
  };

  const handleSave = async () => {
    if (!apiKey.trim()) {
      setStatus({ type: 'error', message: 'API key cannot be empty' });
      return;
    }

    try {
      await chrome.storage.sync.set({ openaiApiKey: apiKey.trim() });
      setStatus({ type: 'success', message: 'Settings saved successfully!' });
      setTimeout(() => setStatus(null), 3000);
    } catch (error) {
      setStatus({ type: 'error', message: 'Failed to save settings' });
    }
  };

  return (
    <div className="container">
      <h1>⚙️ NYU Expense Auto-Fill Settings</h1>
      <p className="subtitle">Configure your OpenAI API key and extension preferences</p>

      <div className="section">
        <h2>ChatGPT / OpenAI API Key</h2>
        <div className="form-group">
          <label htmlFor="apiKey">OpenAI API Key (Required)</label>
          <div className="help-text">
            <strong>This is required for the extension to work.</strong> Your API key is stored securely in Chrome's sync storage and never shared.
            <br /><br />
            Get your API key from <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer">OpenAI Platform</a> (sign up/login required).
            The key should start with "sk-".
          </div>
          <input
            id="apiKey"
            type="password"
            className="api-key-input"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-..."
          />
        </div>
        <button className="save-button" onClick={handleSave}>
          Save Settings
        </button>
        {status && (
          <div className={`status-message ${status.type}`}>
            {status.message}
          </div>
        )}
      </div>

      <div className="section">
        <h2>About</h2>
        <p style={{ color: '#666', lineHeight: '1.6', fontSize: '14px' }}>
          This extension helps you automatically fill NYU Engage expense forms by parsing receipt PDFs
          using AI. Your API key is stored locally and used only for receipt parsing requests.
        </p>
      </div>
    </div>
  );
};

const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  root.render(<Options />);
}

