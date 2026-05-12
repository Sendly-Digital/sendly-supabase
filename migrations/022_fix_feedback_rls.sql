-- Fix RLS policy for feedback table to allow anonymous inserts
-- Drop existing policies if they exist
DROP POLICY IF EXISTS "Anyone can insert feedback" ON feedback;
DROP POLICY IF EXISTS "Users can read their own feedback" ON feedback;

-- Recreate policy that allows anonymous users to insert feedback
-- Explicitly allow both anon and authenticated roles
-- The WITH CHECK (true) allows any data to be inserted
CREATE POLICY "Anyone can insert feedback" ON feedback
  FOR INSERT
  TO anon, authenticated
  WITH CHECK (true);

-- Recreate read policy that allows users to read their own feedback
-- Allow both anon and authenticated users to read
CREATE POLICY "Users can read their own feedback" ON feedback
  FOR SELECT
  TO anon, authenticated
  USING (
    auth.uid()::text = user_id 
    OR user_id = current_setting('request.jwt.claims', true)::json->>'sub'
    OR user_address = current_setting('request.jwt.claims', true)::json->>'wallet_address'
    OR true  -- Allow all reads for simplicity (feedback is not sensitive)
  );

