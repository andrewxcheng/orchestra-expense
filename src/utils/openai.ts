import { ParsedExpenseData } from '../types';

export async function parseReceiptWithOpenAI(
  pdfText: string,
  userProfile: any,
  apiKey: string
): Promise<ParsedExpenseData> {
  const prompt = `You are an expert at parsing receipt information. Extract structured data from the following receipt text and return it as JSON.

Receipt Text:
${pdfText}

User Profile (use as defaults where applicable):
- Name: ${userProfile.purchaser_name || 'N/A'}
- NetID: ${userProfile.netid || 'N/A'}
- Default Club: ${userProfile.default_club || 'N/A'}
- Default Payment Method: ${userProfile.default_payment_method || 'N/A'}

Extract the following information and return ONLY valid JSON (no markdown, no code blocks, just the JSON object):
{
  "vendor_name": {"value": "string", "confidence": 0.0-1.0},
  "date_of_expense": {"value": "YYYY-MM-DD", "confidence": 0.0-1.0},
  "total_amount": {"value": number, "confidence": 0.0-1.0},
  "likely_purchase_type": {"value": "food|apparel|subscription|other", "confidence": 0.0-1.0},
  "description_suggestion": {"value": "string", "confidence": 0.0-1.0},
  "nyu_event_link_guess": {"value": "string or empty string if not found", "confidence": 0.0-1.0}
}

IMPORTANT INSTRUCTIONS:
1. For "description_suggestion": Create a 2-4 sentence description explaining the reason for the purchase based on the receipt. Use the items purchased, vendor name, and any context clues to create a reasonable business justification. If this is for a club/organization expense, frame it in that context. Make it professional and clear. Do NOT use "N/A" - always provide a reasonable description based on what you can infer from the receipt, even if details are limited.

2. For "nyu_event_link_guess": Only include a value if you can reasonably infer it from the receipt (e.g., event name mentioned). Otherwise use an empty string "", not "n/a".

3. For all other fields: If information cannot be determined with reasonable confidence (confidence < 0.5), use an empty string "" instead of "n/a" or "N/A".

For confidence scores:
- 0.9-1.0: Very clear in receipt
- 0.7-0.89: Likely but some ambiguity
- 0.5-0.69: Uncertain, best guess
- <0.5: Very uncertain or not found (use empty string for value)

Return ONLY the JSON object, nothing else.`;

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: 'You are a receipt parsing assistant. Always return valid JSON only, no markdown formatting.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      temperature: 0.3,
      max_tokens: 1000
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenAI API error: ${response.status} - ${error}`);
  }

  const data = await response.json();
  const content = data.choices[0]?.message?.content?.trim();
  
  if (!content) {
    throw new Error('No content returned from OpenAI');
  }

  // Clean the response - remove markdown code blocks if present
  let jsonText = content;
  if (jsonText.startsWith('```json')) {
    jsonText = jsonText.replace(/```json\n?/g, '').replace(/```\n?/g, '');
  } else if (jsonText.startsWith('```')) {
    jsonText = jsonText.replace(/```\n?/g, '');
  }

  const parsed = JSON.parse(jsonText);

  // Merge with user profile defaults
  const result: ParsedExpenseData = {
    purchaser_name: {
      value: userProfile.purchaser_name || '',
      confidence: 1.0
    },
    netid: {
      value: userProfile.netid || '',
      confidence: 1.0
    },
    club_name: {
      value: userProfile.default_club || '',
      confidence: 0.9
    },
    payment_method: {
      value: userProfile.default_payment_method || 'out_of_pocket',
      confidence: 0.9
    },
    vendor_name: parsed.vendor_name || { value: '', confidence: 0 },
    date_of_expense: parsed.date_of_expense || { value: '', confidence: 0 },
    total_amount: parsed.total_amount || { value: 0, confidence: 0 },
    purchase_type: parsed.likely_purchase_type || { value: 'other', confidence: 0 },
    event_link: parsed.nyu_event_link_guess || { value: '', confidence: 0 },
    description: parsed.description_suggestion || { value: '', confidence: 0 }
  };

  return result;
}

