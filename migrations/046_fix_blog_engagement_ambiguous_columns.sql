-- Fix 42702: like_count/view_count ambiguous when RETURNS TABLE output names match table columns

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
