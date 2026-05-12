-- Alternative fix: Use a function-based approach or disable RLS for INSERT
-- Option 1: Drop and recreate with no role restriction (allows all roles)
DROP POLICY IF EXISTS "Anyone can insert feedback" ON feedback;

-- Create policy without role restriction - this should work for all roles including anon
CREATE POLICY "Anyone can insert feedback" ON feedback
  FOR INSERT
  WITH CHECK (true);

-- If the above still doesn't work, we can try using a SECURITY DEFINER function
-- This function bypasses RLS when called
CREATE OR REPLACE FUNCTION insert_feedback(
  p_user_id TEXT,
  p_user_address TEXT,
  p_user_email TEXT,
  p_feedback_type TEXT,
  p_title TEXT,
  p_description TEXT,
  p_status TEXT DEFAULT 'new'
)
RETURNS TABLE (
  id BIGINT,
  user_id TEXT,
  user_address TEXT,
  user_email TEXT,
  feedback_type TEXT,
  title TEXT,
  description TEXT,
  status TEXT,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  INSERT INTO feedback (
    user_id,
    user_address,
    user_email,
    feedback_type,
    title,
    description,
    status
  )
  VALUES (
    p_user_id,
    p_user_address,
    p_user_email,
    p_feedback_type,
    p_title,
    p_description,
    p_status
  )
  RETURNING 
    feedback.id,
    feedback.user_id,
    feedback.user_address,
    feedback.user_email,
    feedback.feedback_type,
    feedback.title,
    feedback.description,
    feedback.status,
    feedback.created_at,
    feedback.updated_at;
END;
$$;

-- Grant execute permission to anon and authenticated roles
GRANT EXECUTE ON FUNCTION insert_feedback TO anon, authenticated;


















