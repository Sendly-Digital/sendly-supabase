-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Create table for scheduled payout jobs
CREATE TABLE IF NOT EXISTS scheduled_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  source_type TEXT NOT NULL CHECK (source_type IN ('personal_contacts', 'twitch_table', 'manual', 'import')),
  source_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  token_symbol TEXT NOT NULL DEFAULT 'USDC',
  token_address TEXT,
  network TEXT NOT NULL DEFAULT 'ARC-TESTNET',
  amount_type TEXT NOT NULL DEFAULT 'fixed' CHECK (amount_type IN ('fixed', 'percentage', 'formula')),
  amount_value NUMERIC(36, 18) NOT NULL CHECK (amount_value >= 0),
  amount_field TEXT,
  currency TEXT NOT NULL DEFAULT 'USDC',
  schedule_type TEXT NOT NULL DEFAULT 'weekly' CHECK (schedule_type IN ('daily', 'weekly', 'monthly', 'custom')),
  day_of_week SMALLINT CHECK (day_of_week BETWEEN 0 AND 6),
  day_of_month SMALLINT CHECK (day_of_month BETWEEN 1 AND 31),
  time_of_day TIME WITHOUT TIME ZONE NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  cron_expression TEXT,
  start_at TIMESTAMP WITH TIME ZONE NOT NULL,
  end_at TIMESTAMP WITH TIME ZONE,
  max_runs INTEGER,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'completed', 'cancelled', 'draft')),
  paused BOOLEAN NOT NULL DEFAULT FALSE,
  skip_strategy TEXT NOT NULL DEFAULT 'catch_up' CHECK (skip_strategy IN ('catch_up', 'skip', 'manual')),
  last_run_at TIMESTAMP WITH TIME ZONE,
  next_run_at TIMESTAMP WITH TIME ZONE,
  total_runs INTEGER NOT NULL DEFAULT 0,
  total_failures INTEGER NOT NULL DEFAULT 0,
  total_amount NUMERIC(36, 18) NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_user_id ON scheduled_jobs(user_id);
CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_status ON scheduled_jobs(status);
CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_next_run ON scheduled_jobs(next_run_at);
CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_paused ON scheduled_jobs(paused);

-- Enable RLS
ALTER TABLE scheduled_jobs ENABLE ROW LEVEL SECURITY;

-- Policies
CREATE POLICY "Users can read their own schedules" ON scheduled_jobs
  FOR SELECT
  USING (auth.uid()::text = user_id OR user_id = current_setting('request.jwt.claims', true)::json->>'sub');

CREATE POLICY "Users can insert their own schedules" ON scheduled_jobs
  FOR INSERT
  WITH CHECK (auth.uid()::text = user_id OR user_id = current_setting('request.jwt.claims', true)::json->>'sub');

CREATE POLICY "Users can update their own schedules" ON scheduled_jobs
  FOR UPDATE
  USING (auth.uid()::text = user_id OR user_id = current_setting('request.jwt.claims', true)::json->>'sub');

CREATE POLICY "Users can delete their own schedules" ON scheduled_jobs
  FOR DELETE
  USING (auth.uid()::text = user_id OR user_id = current_setting('request.jwt.claims', true)::json->>'sub');

-- Trigger to maintain updated_at
CREATE TRIGGER update_scheduled_jobs_updated_at
  BEFORE UPDATE ON scheduled_jobs
  FOR EACH ROW
  EXECUTE FUNCTION update_social_contacts_updated_at();

-- Table for schedule execution logs
CREATE TABLE IF NOT EXISTS job_executions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id UUID NOT NULL REFERENCES scheduled_jobs(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'success', 'partial', 'failed', 'cancelled')),
  run_type TEXT NOT NULL DEFAULT 'automatic' CHECK (run_type IN ('automatic', 'manual', 'retry')),
  queued_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  started_at TIMESTAMP WITH TIME ZONE,
  finished_at TIMESTAMP WITH TIME ZONE,
  total_recipients INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  total_amount NUMERIC(36, 18) NOT NULL DEFAULT 0,
  amount_currency TEXT NOT NULL DEFAULT 'USDC',
  error_message TEXT,
  details JSONB NOT NULL DEFAULT '[]'::jsonb,
  payload_snapshot JSONB,
  result JSONB,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_job_executions_schedule_id ON job_executions(schedule_id);
CREATE INDEX IF NOT EXISTS idx_job_executions_user_id ON job_executions(user_id);
CREATE INDEX IF NOT EXISTS idx_job_executions_status ON job_executions(status);
CREATE INDEX IF NOT EXISTS idx_job_executions_queued_at ON job_executions(queued_at);

-- Enable RLS
ALTER TABLE job_executions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read their own job executions" ON job_executions
  FOR SELECT
  USING (
    auth.uid()::text = user_id
    OR user_id = current_setting('request.jwt.claims', true)::json->>'sub'
  );

CREATE POLICY "Users can insert their own job executions" ON job_executions
  FOR INSERT
  WITH CHECK (
    auth.uid()::text = user_id
    OR user_id = current_setting('request.jwt.claims', true)::json->>'sub'
  );

CREATE POLICY "Users can update their own job executions" ON job_executions
  FOR UPDATE
  USING (
    auth.uid()::text = user_id
    OR user_id = current_setting('request.jwt.claims', true)::json->>'sub'
  );

CREATE POLICY "Users can delete their own job executions" ON job_executions
  FOR DELETE
  USING (
    auth.uid()::text = user_id
    OR user_id = current_setting('request.jwt.claims', true)::json->>'sub'
  );

CREATE TRIGGER update_job_executions_updated_at
  BEFORE UPDATE ON job_executions
  FOR EACH ROW
  EXECUTE FUNCTION update_social_contacts_updated_at();
























