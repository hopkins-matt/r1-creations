// =============================================================================
// CYBERDECK IDEAS — Supabase Configuration
// =============================================================================
// Replace these values with your Supabase project credentials.
// Found in: Supabase Dashboard > Settings > API
// =============================================================================

const CONFIG = {
  // Your Supabase project URL (e.g., https://abcdefghij.supabase.co)
  SUPABASE_URL: 'YOUR_SUPABASE_URL',

  // Your Supabase anon/public key (safe to expose in frontend — RLS protects data)
  SUPABASE_ANON_KEY: 'YOUR_SUPABASE_ANON_KEY',

  // Soft character limit for feature titles (visual warning, not hard block)
  TITLE_SOFT_LIMIT: 60,

  // Max characters for titles (hard limit)
  TITLE_HARD_LIMIT: 150,

  // Truncation length for titles in the feed card view
  TITLE_TRUNCATE: 40,
};
