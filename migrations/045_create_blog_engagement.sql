-- Blog post view/like counters and per-visitor likes

CREATE TABLE IF NOT EXISTS blog_post_stats (
  slug TEXT PRIMARY KEY CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  view_count BIGINT NOT NULL DEFAULT 0 CHECK (view_count >= 0),
  like_count BIGINT NOT NULL DEFAULT 0 CHECK (like_count >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS blog_post_likes (
  slug TEXT NOT NULL REFERENCES blog_post_stats(slug) ON DELETE CASCADE,
  visitor_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (slug, visitor_id)
);

CREATE INDEX IF NOT EXISTS idx_blog_post_likes_visitor ON blog_post_likes(visitor_id);

ALTER TABLE blog_post_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE blog_post_likes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public read blog_post_stats" ON blog_post_stats
  FOR SELECT
  USING (true);

-- No direct writes from clients on stats/likes tables

CREATE OR REPLACE FUNCTION blog_ensure_stats_row(p_slug TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_slug IS NULL OR p_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' THEN
    RAISE EXCEPTION 'invalid slug';
  END IF;
  INSERT INTO blog_post_stats (slug)
  VALUES (p_slug)
  ON CONFLICT (slug) DO NOTHING;
END;
$$;

CREATE OR REPLACE FUNCTION blog_record_view(p_slug TEXT)
RETURNS TABLE (view_count BIGINT, like_count BIGINT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM blog_ensure_stats_row(p_slug);
  UPDATE blog_post_stats AS st
  SET view_count = st.view_count + 1,
      updated_at = NOW()
  WHERE st.slug = p_slug;
  RETURN QUERY
  SELECT st.view_count, st.like_count
  FROM blog_post_stats AS st
  WHERE st.slug = p_slug;
END;
$$;

CREATE OR REPLACE FUNCTION blog_toggle_like(p_slug TEXT, p_visitor_id UUID)
RETURNS TABLE (liked BOOLEAN, view_count BIGINT, like_count BIGINT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_exists BOOLEAN;
  v_liked BOOLEAN;
BEGIN
  IF p_visitor_id IS NULL THEN
    RAISE EXCEPTION 'visitor_id required';
  END IF;
  PERFORM blog_ensure_stats_row(p_slug);

  SELECT EXISTS (
    SELECT 1 FROM blog_post_likes AS bl
    WHERE bl.slug = p_slug AND bl.visitor_id = p_visitor_id
  ) INTO v_exists;

  IF v_exists THEN
    DELETE FROM blog_post_likes AS bl
    WHERE bl.slug = p_slug AND bl.visitor_id = p_visitor_id;
    UPDATE blog_post_stats AS st
    SET like_count = GREATEST(st.like_count - 1, 0),
        updated_at = NOW()
    WHERE st.slug = p_slug;
    v_liked := FALSE;
  ELSE
    INSERT INTO blog_post_likes (slug, visitor_id)
    VALUES (p_slug, p_visitor_id);
    UPDATE blog_post_stats AS st
    SET like_count = st.like_count + 1,
        updated_at = NOW()
    WHERE st.slug = p_slug;
    v_liked := TRUE;
  END IF;

  RETURN QUERY
  SELECT v_liked, st.view_count, st.like_count
  FROM blog_post_stats AS st
  WHERE st.slug = p_slug;
END;
$$;

CREATE OR REPLACE FUNCTION blog_get_stats(p_slug TEXT)
RETURNS TABLE (view_count BIGINT, like_count BIGINT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM blog_ensure_stats_row(p_slug);
  RETURN QUERY
  SELECT st.view_count, st.like_count
  FROM blog_post_stats AS st
  WHERE st.slug = p_slug;
END;
$$;

GRANT EXECUTE ON FUNCTION blog_record_view(TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION blog_toggle_like(TEXT, UUID) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION blog_get_stats(TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION blog_ensure_stats_row(TEXT) TO anon, authenticated;

INSERT INTO blog_post_stats (slug, view_count, like_count)
VALUES
  ('privy-results', 0, 0),
  ('nft-gift-cards-guide', 0, 0),
  ('zktls-payments-guide', 0, 0),
  ('circle-sdk-wallet-playbook', 0, 0)
ON CONFLICT (slug) DO NOTHING;

COMMENT ON TABLE blog_post_stats IS 'Aggregate view/like counts per blog post slug';
COMMENT ON TABLE blog_post_likes IS 'Per-visitor like records for blog posts';
