-- =============================================================================
-- CYBERDECK IDEAS — Supabase Database Schema
-- =============================================================================
-- Run this in your Supabase project's SQL Editor (Database > SQL Editor).
--
-- SETUP STEPS:
-- 1. Create a Supabase project at https://supabase.com
-- 2. Go to Authentication > Providers and enable:
--    a. Email (enable "Confirm email" and "Secure email change")
--    b. Discord (add Client ID and Secret from Discord Developer Portal)
-- 3. Go to Authentication > URL Configuration and add your site URL + redirect URLs
-- 4. Run this entire SQL file in the SQL Editor
-- 5. After signing up your first account, promote it to superadmin:
--    UPDATE public.profiles SET role = 'superadmin' WHERE id = '<your-user-uuid>';
--    (Find your UUID in Authentication > Users)
-- 6. Update js/config.js with your Supabase URL and anon key
--    (Found in Settings > API)
-- =============================================================================

-- ========================
-- TABLES
-- ========================

-- User profiles (extends Supabase auth.users)
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL DEFAULT 'Anonymous',
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'moderator', 'admin', 'superadmin')),
  is_banned BOOLEAN NOT NULL DEFAULT FALSE,
  rate_limit_cooldown TIMESTAMPTZ DEFAULT NULL,
  consecutive_rate_hits INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Feature ideas
CREATE TABLE public.features (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (char_length(title) >= 3),
  description TEXT DEFAULT '',
  is_hidden BOOLEAN NOT NULL DEFAULT FALSE,
  edited_by UUID REFERENCES public.profiles(id),
  edit_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Votes (one per user per feature)
CREATE TABLE public.votes (
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  feature_id UUID NOT NULL REFERENCES public.features(id) ON DELETE CASCADE,
  vote_type SMALLINT NOT NULL CHECK (vote_type IN (-1, 1)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, feature_id)
);

-- ========================
-- INDEXES
-- ========================

CREATE INDEX idx_features_created_at ON public.features(created_at DESC);
CREATE INDEX idx_features_user_id ON public.features(user_id);
CREATE INDEX idx_features_is_hidden ON public.features(is_hidden);
CREATE INDEX idx_votes_feature_id ON public.votes(feature_id);
CREATE INDEX idx_votes_user_id ON public.votes(user_id);

-- ========================
-- TRIGGERS & FUNCTIONS
-- ========================

-- Auto-create profile on new user signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, display_name)
  VALUES (
    NEW.id,
    COALESCE(
      NEW.raw_user_meta_data->>'full_name',
      NEW.raw_user_meta_data->>'user_name',
      NEW.raw_user_meta_data->>'name',
      split_part(NEW.email, '@', 1),
      'Anonymous'
    )
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();

-- Auto-update updated_at timestamp
CREATE OR REPLACE FUNCTION public.update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_profiles_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

CREATE TRIGGER update_features_updated_at
  BEFORE UPDATE ON public.features
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

CREATE TRIGGER update_votes_updated_at
  BEFORE UPDATE ON public.votes
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- Rate limiting on feature submissions
CREATE OR REPLACE FUNCTION public.check_rate_limit()
RETURNS TRIGGER AS $$
DECLARE
  prof RECORD;
  minute_count INTEGER;
  hour_count INTEGER;
BEGIN
  SELECT * INTO prof FROM public.profiles WHERE id = NEW.user_id;

  -- Banned users can't post
  IF prof.is_banned THEN
    RAISE EXCEPTION 'Your account has been suspended.';
  END IF;

  -- Check active cooldown
  IF prof.rate_limit_cooldown IS NOT NULL AND prof.rate_limit_cooldown > NOW() THEN
    RAISE EXCEPTION 'Rate limited. Try again later.';
  END IF;

  -- 1 submission per minute
  SELECT COUNT(*) INTO minute_count
  FROM public.features
  WHERE user_id = NEW.user_id AND created_at > NOW() - INTERVAL '1 minute';

  IF minute_count >= 1 THEN
    UPDATE public.profiles
    SET consecutive_rate_hits = consecutive_rate_hits + 1,
        rate_limit_cooldown = NOW() + (INTERVAL '1 minute' * LEAST(consecutive_rate_hits + 1, 30))
    WHERE id = NEW.user_id;
    RAISE EXCEPTION 'Too fast! Wait at least 1 minute between submissions.';
  END IF;

  -- 10 submissions per hour
  SELECT COUNT(*) INTO hour_count
  FROM public.features
  WHERE user_id = NEW.user_id AND created_at > NOW() - INTERVAL '1 hour';

  IF hour_count >= 10 THEN
    UPDATE public.profiles
    SET consecutive_rate_hits = consecutive_rate_hits + 1,
        rate_limit_cooldown = NOW() + (INTERVAL '5 minutes' * LEAST(consecutive_rate_hits + 1, 12))
    WHERE id = NEW.user_id;
    RAISE EXCEPTION 'Hourly limit reached (10/hr). Take a break!';
  END IF;

  -- Reset consecutive hits on successful submission
  IF prof.consecutive_rate_hits > 0 THEN
    UPDATE public.profiles SET consecutive_rate_hits = 0 WHERE id = NEW.user_id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER check_feature_rate_limit
  BEFORE INSERT ON public.features
  FOR EACH ROW
  EXECUTE FUNCTION public.check_rate_limit();

-- ========================
-- ROW LEVEL SECURITY
-- ========================

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.features ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.votes ENABLE ROW LEVEL SECURITY;

-- Profiles: anyone can read, users can update their own (but not role/ban)
CREATE POLICY "profiles_select" ON public.profiles
  FOR SELECT USING (true);

CREATE POLICY "profiles_update_own" ON public.profiles
  FOR UPDATE USING (auth.uid() = id)
  WITH CHECK (
    auth.uid() = id
    AND role = (SELECT role FROM public.profiles WHERE id = auth.uid())
    AND is_banned = (SELECT is_banned FROM public.profiles WHERE id = auth.uid())
  );

-- Features: visible if not hidden (or user is author/staff)
CREATE POLICY "features_select" ON public.features
  FOR SELECT USING (
    is_hidden = false
    OR user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid() AND role IN ('moderator', 'admin', 'superadmin')
    )
  );

CREATE POLICY "features_insert" ON public.features
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "features_update_staff" ON public.features
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid() AND role IN ('moderator', 'admin', 'superadmin')
    )
  );

CREATE POLICY "features_delete_admin" ON public.features
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid() AND role IN ('admin', 'superadmin')
    )
  );

-- Votes: anyone can read, users manage their own
CREATE POLICY "votes_select" ON public.votes
  FOR SELECT USING (true);

CREATE POLICY "votes_insert" ON public.votes
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "votes_update_own" ON public.votes
  FOR UPDATE USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "votes_delete_own" ON public.votes
  FOR DELETE USING (auth.uid() = user_id);

-- ========================
-- RPC FUNCTIONS
-- ========================

-- Get features with computed vote scores (public feed)
CREATE OR REPLACE FUNCTION public.get_features_feed()
RETURNS TABLE (
  id UUID,
  user_id UUID,
  title TEXT,
  description TEXT,
  is_hidden BOOLEAN,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  author_name TEXT,
  vote_score BIGINT,
  upvotes BIGINT,
  downvotes BIGINT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    f.id, f.user_id, f.title, f.description, f.is_hidden,
    f.created_at, f.updated_at,
    p.display_name AS author_name,
    COALESCE(SUM(v.vote_type)::BIGINT, 0) AS vote_score,
    COUNT(CASE WHEN v.vote_type = 1 THEN 1 END)::BIGINT AS upvotes,
    COUNT(CASE WHEN v.vote_type = -1 THEN 1 END)::BIGINT AS downvotes
  FROM public.features f
  LEFT JOIN public.votes v ON f.id = v.feature_id
  LEFT JOIN public.profiles p ON f.user_id = p.id
  WHERE f.is_hidden = false
  GROUP BY f.id, f.user_id, f.title, f.description, f.is_hidden,
           f.created_at, f.updated_at, p.display_name
  ORDER BY vote_score DESC, f.created_at ASC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Get ALL features for admin (including hidden)
CREATE OR REPLACE FUNCTION public.get_features_admin()
RETURNS TABLE (
  id UUID,
  user_id UUID,
  title TEXT,
  description TEXT,
  is_hidden BOOLEAN,
  edited_by UUID,
  edit_reason TEXT,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  author_name TEXT,
  editor_name TEXT,
  vote_score BIGINT,
  upvotes BIGINT,
  downvotes BIGINT
) AS $$
DECLARE
  caller_role TEXT;
BEGIN
  SELECT p.role INTO caller_role FROM public.profiles p WHERE p.id = auth.uid();
  IF caller_role NOT IN ('moderator', 'admin', 'superadmin') THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  RETURN QUERY
  SELECT
    f.id, f.user_id, f.title, f.description, f.is_hidden,
    f.edited_by, f.edit_reason,
    f.created_at, f.updated_at,
    p.display_name AS author_name,
    ep.display_name AS editor_name,
    COALESCE(SUM(v.vote_type)::BIGINT, 0) AS vote_score,
    COUNT(CASE WHEN v.vote_type = 1 THEN 1 END)::BIGINT AS upvotes,
    COUNT(CASE WHEN v.vote_type = -1 THEN 1 END)::BIGINT AS downvotes
  FROM public.features f
  LEFT JOIN public.votes v ON f.id = v.feature_id
  LEFT JOIN public.profiles p ON f.user_id = p.id
  LEFT JOIN public.profiles ep ON f.edited_by = ep.id
  GROUP BY f.id, f.user_id, f.title, f.description, f.is_hidden,
           f.edited_by, f.edit_reason, f.created_at, f.updated_at,
           p.display_name, ep.display_name
  ORDER BY f.created_at DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Get all users for admin
CREATE OR REPLACE FUNCTION public.get_users_admin()
RETURNS TABLE (
  id UUID,
  display_name TEXT,
  email TEXT,
  role TEXT,
  is_banned BOOLEAN,
  consecutive_rate_hits INTEGER,
  rate_limit_cooldown TIMESTAMPTZ,
  created_at TIMESTAMPTZ,
  post_count BIGINT
) AS $$
DECLARE
  caller_role TEXT;
BEGIN
  SELECT p.role INTO caller_role FROM public.profiles p WHERE p.id = auth.uid();
  IF caller_role NOT IN ('admin', 'superadmin') THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  RETURN QUERY
  SELECT
    p.id, p.display_name,
    u.email,
    p.role, p.is_banned, p.consecutive_rate_hits, p.rate_limit_cooldown,
    p.created_at,
    COUNT(f.id)::BIGINT AS post_count
  FROM public.profiles p
  LEFT JOIN auth.users u ON p.id = u.id
  LEFT JOIN public.features f ON p.id = f.user_id
  GROUP BY p.id, p.display_name, u.email, p.role, p.is_banned,
           p.consecutive_rate_hits, p.rate_limit_cooldown, p.created_at
  ORDER BY p.created_at DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Admin: update user role
CREATE OR REPLACE FUNCTION public.admin_update_role(target_id UUID, new_role TEXT)
RETURNS VOID AS $$
DECLARE
  caller_role TEXT;
  target_role TEXT;
BEGIN
  SELECT p.role INTO caller_role FROM public.profiles p WHERE p.id = auth.uid();
  SELECT p.role INTO target_role FROM public.profiles p WHERE p.id = target_id;

  IF caller_role NOT IN ('admin', 'superadmin') THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;
  IF target_role = 'superadmin' THEN
    RAISE EXCEPTION 'Cannot modify superadmin';
  END IF;
  IF new_role = 'admin' AND caller_role != 'superadmin' THEN
    RAISE EXCEPTION 'Only superadmin can promote to admin';
  END IF;
  IF new_role NOT IN ('user', 'moderator', 'admin') THEN
    RAISE EXCEPTION 'Invalid role';
  END IF;

  UPDATE public.profiles SET role = new_role WHERE id = target_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Admin: toggle ban
CREATE OR REPLACE FUNCTION public.admin_toggle_ban(target_id UUID)
RETURNS BOOLEAN AS $$
DECLARE
  caller_role TEXT;
  target_role TEXT;
  new_banned BOOLEAN;
BEGIN
  SELECT p.role INTO caller_role FROM public.profiles p WHERE p.id = auth.uid();
  SELECT p.role INTO target_role FROM public.profiles p WHERE p.id = target_id;

  IF caller_role NOT IN ('admin', 'superadmin') THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;
  IF target_role IN ('admin', 'superadmin') THEN
    RAISE EXCEPTION 'Cannot ban staff members';
  END IF;

  UPDATE public.profiles
  SET is_banned = NOT is_banned
  WHERE id = target_id
  RETURNING is_banned INTO new_banned;

  RETURN new_banned;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Staff: edit feature
CREATE OR REPLACE FUNCTION public.staff_edit_feature(
  target_id UUID,
  new_title TEXT,
  new_description TEXT,
  reason TEXT DEFAULT NULL
)
RETURNS VOID AS $$
DECLARE
  caller_role TEXT;
BEGIN
  SELECT p.role INTO caller_role FROM public.profiles p WHERE p.id = auth.uid();
  IF caller_role NOT IN ('moderator', 'admin', 'superadmin') THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  UPDATE public.features
  SET title = new_title,
      description = new_description,
      edited_by = auth.uid(),
      edit_reason = reason
  WHERE id = target_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Staff: toggle feature visibility
CREATE OR REPLACE FUNCTION public.staff_toggle_feature(target_id UUID)
RETURNS BOOLEAN AS $$
DECLARE
  caller_role TEXT;
  new_hidden BOOLEAN;
BEGIN
  SELECT p.role INTO caller_role FROM public.profiles p WHERE p.id = auth.uid();
  IF caller_role NOT IN ('moderator', 'admin', 'superadmin') THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  UPDATE public.features
  SET is_hidden = NOT is_hidden
  WHERE id = target_id
  RETURNING is_hidden INTO new_hidden;

  RETURN new_hidden;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Admin: delete feature permanently
CREATE OR REPLACE FUNCTION public.admin_delete_feature(target_id UUID)
RETURNS VOID AS $$
DECLARE
  caller_role TEXT;
BEGIN
  SELECT p.role INTO caller_role FROM public.profiles p WHERE p.id = auth.uid();
  IF caller_role NOT IN ('admin', 'superadmin') THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  DELETE FROM public.features WHERE id = target_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
