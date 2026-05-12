-- Create feedback table for storing user feedback
CREATE TABLE IF NOT EXISTS feedback (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT,
  user_address TEXT,
  user_email TEXT,
  feedback_type TEXT NOT NULL CHECK (feedback_type IN ('bug', 'feature', 'question', 'other', 'wallet_issue', 'broken_error', 'slow_unresponsive')),
  title TEXT,
  description TEXT NOT NULL,
  status TEXT DEFAULT 'new' CHECK (status IN ('new', 'in_progress', 'resolved', 'closed')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for faster queries
CREATE INDEX IF NOT EXISTS idx_feedback_user_id ON feedback(user_id);
CREATE INDEX IF NOT EXISTS idx_feedback_user_address ON feedback(user_address);
CREATE INDEX IF NOT EXISTS idx_feedback_type ON feedback(feedback_type);
CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback(status);
CREATE INDEX IF NOT EXISTS idx_feedback_created_at ON feedback(created_at DESC);

-- Enable Row Level Security (RLS)
ALTER TABLE feedback ENABLE ROW LEVEL SECURITY;

-- Create policy to allow anyone to insert feedback (users can submit feedback)
CREATE POLICY "Anyone can insert feedback" ON feedback
  FOR INSERT
  WITH CHECK (true);

-- Create policy to allow users to read their own feedback
CREATE POLICY "Users can read their own feedback" ON feedback
  FOR SELECT
  USING (
    auth.uid()::text = user_id 
    OR user_id = current_setting('request.jwt.claims', true)::json->>'sub'
    OR user_address = current_setting('request.jwt.claims', true)::json->>'wallet_address'
  );

-- Create function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_feedback_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger to automatically update updated_at
CREATE TRIGGER update_feedback_updated_at
  BEFORE UPDATE ON feedback
  FOR EACH ROW
  EXECUTE FUNCTION update_feedback_updated_at();

-- Documentation comments
COMMENT ON TABLE feedback IS 'User feedback and bug reports';
COMMENT ON COLUMN feedback.user_id IS 'Privy user ID';
COMMENT ON COLUMN feedback.user_address IS 'Wallet address of the user';
COMMENT ON COLUMN feedback.feedback_type IS 'Type of feedback: bug, feature, question, other, wallet_issue, broken_error, slow_unresponsive';
COMMENT ON COLUMN feedback.status IS 'Status of the feedback: new, in_progress, resolved, closed';

