export interface ParsedExpenseData {
  purchaser_name: { value: string; confidence: number };
  netid: { value: string; confidence: number };
  club_name: { value: string; confidence: number };
  payment_method: { 
    value: "club_card_no_extra" | "club_card_with_extra" | "out_of_pocket"; 
    confidence: number 
  };
  vendor_name: { value: string; confidence: number };
  date_of_expense: { value: string; confidence: number };
  total_amount: { value: string | number; confidence: number };
  purchase_type: { value: string; confidence: number };
  event_link: { value: string; confidence: number };
  description: { value: string; confidence: number };
}

export interface UserProfile {
  purchaser_name: string;
  netid: string;
  default_club: string;
  default_payment_method: "club_card_no_extra" | "club_card_with_extra" | "out_of_pocket";
}

export interface FillResult {
  fieldName: string;
  filled: boolean;
  confidence: number;
  value?: string;
  needsReview: boolean;
}

export interface FillSummary {
  results: FillResult[];
  totalFields: number;
  filledFields: number;
  lowConfidenceFields: number;
}


