INSERT INTO storage.buckets (id, name, public)
VALUES ('telegram-avatars', 'telegram-avatars', true)
ON CONFLICT (id) DO UPDATE SET public = true;

DROP POLICY IF EXISTS "telegram_avatars_public_read" ON storage.objects;
CREATE POLICY "telegram_avatars_public_read"
  ON storage.objects
  FOR SELECT
  USING (bucket_id = 'telegram-avatars');

DROP POLICY IF EXISTS "telegram_avatars_service_insert" ON storage.objects;
CREATE POLICY "telegram_avatars_service_insert"
  ON storage.objects
  FOR INSERT
  WITH CHECK (bucket_id = 'telegram-avatars' AND auth.role() = 'service_role');

DROP POLICY IF EXISTS "telegram_avatars_service_update" ON storage.objects;
CREATE POLICY "telegram_avatars_service_update"
  ON storage.objects
  FOR UPDATE
  USING (bucket_id = 'telegram-avatars' AND auth.role() = 'service_role');
