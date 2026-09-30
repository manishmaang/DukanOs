-- Current-day/range listing and exact bill-number history search, newest first.
-- Existing bill/open and date/number uniqueness indexes remain intact.
CREATE INDEX bills_business_date_listing_idx ON bills(business_date DESC,opened_at DESC,id DESC);
CREATE INDEX bills_number_history_idx ON bills(bill_number,business_date DESC,opened_at DESC,id DESC);
