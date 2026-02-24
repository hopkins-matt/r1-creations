// =============================================================================
// CYBERDECK IDEAS — R1 Creation App
// =============================================================================

(function () {
  'use strict';

  // ======================== STATE ========================
  const APP = {
    supabase: null,
    user: null,
    profile: null,
    features: [],
    userVotes: {},       // { featureId: 1 | -1 }
    currentFeature: null,
    currentScreen: 'login',
    toastTimer: null,
  };

  // ======================== DOM REFS ========================
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  // ======================== INIT ========================
  async function init() {
    // Check configuration
    if (!CONFIG.SUPABASE_URL || CONFIG.SUPABASE_URL === 'YOUR_SUPABASE_URL' ||
        !CONFIG.SUPABASE_ANON_KEY || CONFIG.SUPABASE_ANON_KEY === 'YOUR_SUPABASE_ANON_KEY') {
      $('#config-error').classList.remove('hidden');
      return;
    }

    APP.supabase = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);

    setupEventListeners();

    // Check existing session
    showLoading(true);
    try {
      const { data: { session } } = await APP.supabase.auth.getSession();
      if (session) {
        APP.user = session.user;
        await loadProfile();
        await loadFeatures();
        await loadUserVotes();
        showScreen('feed');
      } else {
        showScreen('login');
      }
    } catch (e) {
      console.error('Init error:', e);
      showScreen('login');
    }
    showLoading(false);

    // Listen for auth state changes (handles OAuth redirect)
    APP.supabase.auth.onAuthStateChange(async (event, session) => {
      if (event === 'SIGNED_IN' && session && !APP.user) {
        APP.user = session.user;
        showLoading(true);
        await loadProfile();
        await loadFeatures();
        await loadUserVotes();
        showScreen('feed');
        showLoading(false);
      } else if (event === 'SIGNED_OUT') {
        APP.user = null;
        APP.profile = null;
        APP.features = [];
        APP.userVotes = {};
        showScreen('login');
      }
    });
  }

  // ======================== SCREEN MANAGEMENT ========================
  function showScreen(name) {
    $$('.screen').forEach(s => s.classList.remove('active'));
    const screen = $(`#screen-${name}`);
    if (screen) {
      screen.classList.add('active');
      APP.currentScreen = name;
    }
  }

  // ======================== AUTH ========================
  async function sendOTP() {
    const email = $('#login-email').value.trim();
    if (!email || !email.includes('@')) {
      showError('login-error', 'Enter a valid email address.');
      return;
    }

    showLoading(true);
    clearError('login-error');

    try {
      const { error } = await APP.supabase.auth.signInWithOtp({
        email,
        options: { shouldCreateUser: true }
      });

      if (error) throw error;

      $('#otp-hint').textContent = email;
      showScreen('otp');
      showToast('Code sent!', 'success');
    } catch (e) {
      showError('login-error', e.message || 'Failed to send code.');
    }
    showLoading(false);
  }

  async function verifyOTP() {
    const email = $('#otp-hint').textContent;
    const token = $('#otp-input').value.trim();

    if (!token || token.length !== 6) {
      showError('otp-error', 'Enter the 6-digit code.');
      return;
    }

    showLoading(true);
    clearError('otp-error');

    try {
      const { data, error } = await APP.supabase.auth.verifyOtp({
        email,
        token,
        type: 'email'
      });

      if (error) throw error;

      APP.user = data.user;
      await loadProfile();
      await loadFeatures();
      await loadUserVotes();
      showScreen('feed');
      showToast('Signed in!', 'success');
      $('#otp-input').value = '';
    } catch (e) {
      showError('otp-error', e.message || 'Invalid code.');
    }
    showLoading(false);
  }

  async function signInWithDiscord() {
    showLoading(true);
    try {
      const { error } = await APP.supabase.auth.signInWithOAuth({
        provider: 'discord',
        options: {
          redirectTo: window.location.origin + window.location.pathname
        }
      });
      if (error) throw error;
    } catch (e) {
      showError('login-error', e.message || 'Discord login failed.');
      showLoading(false);
    }
  }

  async function signOut() {
    showLoading(true);
    await APP.supabase.auth.signOut();
    showLoading(false);
  }

  // ======================== DATA LOADING ========================
  async function loadProfile() {
    if (!APP.user) return;
    try {
      const { data, error } = await APP.supabase
        .from('profiles')
        .select('*')
        .eq('id', APP.user.id)
        .single();

      if (error) throw error;
      APP.profile = data;
    } catch (e) {
      console.error('Load profile error:', e);
    }
  }

  async function loadFeatures() {
    try {
      const { data, error } = await APP.supabase.rpc('get_features_feed');
      if (error) throw error;
      APP.features = data || [];
      renderFeed();
    } catch (e) {
      console.error('Load features error:', e);
      APP.features = [];
      renderFeed();
    }
  }

  async function loadUserVotes() {
    if (!APP.user) return;
    try {
      const { data, error } = await APP.supabase
        .from('votes')
        .select('feature_id, vote_type')
        .eq('user_id', APP.user.id);

      if (error) throw error;
      APP.userVotes = {};
      (data || []).forEach(v => {
        APP.userVotes[v.feature_id] = v.vote_type;
      });
    } catch (e) {
      console.error('Load votes error:', e);
    }
  }

  // ======================== FEED RENDERING ========================
  function renderFeed() {
    const list = $('#feed-list');
    const empty = $('#feed-empty');

    if (APP.features.length === 0) {
      list.innerHTML = '';
      empty.classList.remove('hidden');
      return;
    }

    empty.classList.add('hidden');

    list.innerHTML = APP.features.map(f => {
      const userVote = APP.userVotes[f.id] || 0;
      const scoreClass = f.vote_score > 0 ? 'positive' : f.vote_score < 0 ? 'negative' : '';
      const timeAgo = formatTimeAgo(f.created_at);

      return `
        <div class="card" data-id="${f.id}">
          <div class="card-vote" data-id="${f.id}">
            <button class="vote-btn upvote ${userVote === 1 ? 'active' : ''}"
                    data-id="${f.id}" data-vote="1"
                    aria-label="Upvote">&blacktriangle;</button>
            <span class="vote-score ${scoreClass}">${f.vote_score}</span>
            <button class="vote-btn downvote ${userVote === -1 ? 'active' : ''}"
                    data-id="${f.id}" data-vote="-1"
                    aria-label="Downvote">&blacktriangledown;</button>
          </div>
          <div class="card-body" data-id="${f.id}">
            <div class="card-title">${escapeHtml(f.title)}</div>
            <div class="card-meta">${escapeHtml(f.author_name)} &middot; ${timeAgo}</div>
          </div>
        </div>
      `;
    }).join('');
  }

  // ======================== DETAIL VIEW ========================
  function showDetail(featureId) {
    const feature = APP.features.find(f => f.id === featureId);
    if (!feature) return;

    APP.currentFeature = feature;
    const userVote = APP.userVotes[feature.id] || 0;
    const scoreClass = feature.vote_score > 0 ? 'positive' : feature.vote_score < 0 ? 'negative' : '';
    const date = new Date(feature.created_at).toLocaleDateString();

    $('#detail-content').innerHTML = `
      <div class="detail-title">${escapeHtml(feature.title)}</div>
      <div class="detail-meta">
        By ${escapeHtml(feature.author_name)} &middot; ${date}
      </div>
      ${feature.description ? `<div class="detail-desc">${escapeHtml(feature.description)}</div>` : ''}
      <div class="detail-vote-row">
        <button class="detail-vote-btn upvote ${userVote === 1 ? 'active' : ''}"
                data-id="${feature.id}" data-vote="1"
                aria-label="Upvote">&blacktriangle;</button>
        <span class="detail-score ${scoreClass}">${feature.vote_score}</span>
        <button class="detail-vote-btn downvote ${userVote === -1 ? 'active' : ''}"
                data-id="${feature.id}" data-vote="-1"
                aria-label="Downvote">&blacktriangledown;</button>
      </div>
    `;

    showScreen('detail');
  }

  // ======================== VOTING ========================
  async function handleVote(featureId, voteType) {
    if (!APP.user) return;

    voteType = parseInt(voteType, 10);
    const currentVote = APP.userVotes[featureId] || 0;

    try {
      if (currentVote === voteType) {
        // Remove vote
        await APP.supabase
          .from('votes')
          .delete()
          .eq('user_id', APP.user.id)
          .eq('feature_id', featureId);
        delete APP.userVotes[featureId];
      } else if (currentVote !== 0) {
        // Change vote
        await APP.supabase
          .from('votes')
          .update({ vote_type: voteType })
          .eq('user_id', APP.user.id)
          .eq('feature_id', featureId);
        APP.userVotes[featureId] = voteType;
      } else {
        // New vote
        await APP.supabase
          .from('votes')
          .insert({ user_id: APP.user.id, feature_id: featureId, vote_type: voteType });
        APP.userVotes[featureId] = voteType;
      }

      // Refresh features to get updated scores
      await loadFeatures();

      // If in detail view, re-render it
      if (APP.currentScreen === 'detail' && APP.currentFeature?.id === featureId) {
        showDetail(featureId);
      }
    } catch (e) {
      console.error('Vote error:', e);
      showToast('Vote failed', 'error');
    }
  }

  // ======================== SUBMIT FEATURE ========================
  async function submitFeature() {
    const title = $('#submit-title').value.trim();
    const description = $('#submit-desc').value.trim();

    clearError('submit-error');

    if (!title || title.length < 3) {
      showError('submit-error', 'Title must be at least 3 characters.');
      return;
    }

    if (title.length > CONFIG.TITLE_HARD_LIMIT) {
      showError('submit-error', `Title too long (max ${CONFIG.TITLE_HARD_LIMIT}).`);
      return;
    }

    // Profanity check
    const modCheck = ProfanityFilter.checkAll(title, description);
    if (!modCheck.clean) {
      showError('submit-error', modCheck.reason);
      return;
    }

    showLoading(true);
    try {
      const { error } = await APP.supabase
        .from('features')
        .insert({
          user_id: APP.user.id,
          title: title,
          description: description
        });

      if (error) {
        // Parse rate limit errors from the database trigger
        if (error.message?.includes('Rate limit') || error.message?.includes('Too fast') ||
            error.message?.includes('Hourly limit') || error.message?.includes('rate limited')) {
          showError('submit-error', error.message);
        } else if (error.message?.includes('suspended') || error.message?.includes('banned')) {
          showError('submit-error', 'Your account has been suspended.');
        } else {
          throw error;
        }
        showLoading(false);
        return;
      }

      // Success
      $('#submit-title').value = '';
      $('#submit-desc').value = '';
      updateCharCount();
      await loadFeatures();
      showScreen('feed');
      showToast('Idea submitted!', 'success');
    } catch (e) {
      console.error('Submit error:', e);
      showError('submit-error', 'Failed to submit. Try again.');
    }
    showLoading(false);
  }

  // ======================== SETTINGS ========================
  function populateSettings() {
    if (APP.profile) {
      $('#settings-name').value = APP.profile.display_name || '';
    }
    if (APP.user?.email) {
      $('#settings-email').value = APP.user.email;
    }

    // Show auth method info
    const provider = APP.user?.app_metadata?.provider;
    const info = $('#auth-info');
    if (provider === 'discord') {
      info.textContent = 'Signed in via Discord';
      $('#email-settings').classList.add('hidden');
    } else {
      info.textContent = `Signed in as ${APP.user?.email || 'email user'}`;
      $('#email-settings').classList.remove('hidden');
    }
  }

  async function saveName() {
    const name = $('#settings-name').value.trim();
    if (!name || name.length < 1) {
      showToast('Enter a display name', 'error');
      return;
    }
    if (name.length > 30) {
      showToast('Name too long (max 30)', 'error');
      return;
    }

    // Profanity check on name
    const modCheck = ProfanityFilter.check(name);
    if (!modCheck.clean) {
      showToast(modCheck.reason, 'error');
      return;
    }

    showLoading(true);
    try {
      const { error } = await APP.supabase
        .from('profiles')
        .update({ display_name: name })
        .eq('id', APP.user.id);

      if (error) throw error;
      APP.profile.display_name = name;
      showToast('Name saved!', 'success');
    } catch (e) {
      showToast('Failed to save name', 'error');
    }
    showLoading(false);
  }

  async function updateEmail() {
    const email = $('#settings-email').value.trim();
    if (!email || !email.includes('@')) {
      showToast('Enter a valid email', 'error');
      return;
    }

    showLoading(true);
    try {
      const { error } = await APP.supabase.auth.updateUser({ email });
      if (error) throw error;
      showToast('Verification sent to new email', 'success');
    } catch (e) {
      showToast(e.message || 'Failed to update email', 'error');
    }
    showLoading(false);
  }

  // ======================== CHARACTER COUNTING ========================
  function updateCharCount() {
    const len = ($('#submit-title').value || '').length;
    const counter = $('#title-chars');
    counter.textContent = len;
    counter.className = 'char-count';
    if (len > CONFIG.TITLE_HARD_LIMIT) {
      counter.classList.add('over');
    } else if (len > CONFIG.TITLE_SOFT_LIMIT) {
      counter.classList.add('warn');
    }
  }

  // ======================== EVENT LISTENERS ========================
  function setupEventListeners() {
    // Login
    $('#btn-send-code').addEventListener('click', sendOTP);
    $('#login-email').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') sendOTP();
    });
    $('#btn-discord').addEventListener('click', signInWithDiscord);

    // OTP
    $('#btn-verify').addEventListener('click', verifyOTP);
    $('#otp-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') verifyOTP();
    });
    $('#btn-otp-back').addEventListener('click', () => showScreen('login'));

    // Feed interactions
    $('#feed-list').addEventListener('click', (e) => {
      // Vote button clicked
      const voteBtn = e.target.closest('.vote-btn');
      if (voteBtn) {
        e.stopPropagation();
        handleVote(voteBtn.dataset.id, voteBtn.dataset.vote);
        return;
      }
      // Card body clicked -> detail
      const card = e.target.closest('.card');
      if (card) {
        showDetail(card.dataset.id);
      }
    });

    // Detail interactions
    $('#detail-content').addEventListener('click', (e) => {
      const voteBtn = e.target.closest('.detail-vote-btn');
      if (voteBtn) {
        handleVote(voteBtn.dataset.id, voteBtn.dataset.vote);
      }
    });

    // Navigation
    $('#btn-new-idea').addEventListener('click', () => showScreen('submit'));
    $('#btn-settings').addEventListener('click', () => {
      populateSettings();
      showScreen('settings');
    });
    $('#btn-detail-back').addEventListener('click', () => {
      APP.currentFeature = null;
      showScreen('feed');
    });
    $('#btn-submit-back').addEventListener('click', () => showScreen('feed'));
    $('#btn-settings-back').addEventListener('click', () => {
      loadFeatures(); // Refresh feed
      showScreen('feed');
    });

    // Submit
    $('#btn-submit-idea').addEventListener('click', submitFeature);
    $('#submit-title').addEventListener('input', updateCharCount);

    // Settings
    $('#btn-save-name').addEventListener('click', saveName);
    $('#btn-update-email').addEventListener('click', updateEmail);
    $('#btn-sign-out').addEventListener('click', signOut);
  }

  // ======================== UTILITIES ========================
  function showLoading(visible) {
    const el = $('#loading');
    if (visible) {
      el.classList.remove('hidden');
    } else {
      el.classList.add('hidden');
    }
  }

  function showToast(msg, type) {
    const el = $('#toast');
    el.textContent = msg;
    el.className = 'toast' + (type ? ' ' + type : '');

    // Trigger show
    requestAnimationFrame(() => {
      el.classList.add('show');
    });

    clearTimeout(APP.toastTimer);
    APP.toastTimer = setTimeout(() => {
      el.classList.remove('show');
    }, 2500);
  }

  function showError(id, msg) {
    const el = $(`#${id}`);
    if (el) el.textContent = msg;
  }

  function clearError(id) {
    const el = $(`#${id}`);
    if (el) el.textContent = '';
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function formatTimeAgo(dateStr) {
    const now = Date.now();
    const then = new Date(dateStr).getTime();
    const diff = Math.floor((now - then) / 1000);

    if (diff < 60) return 'now';
    if (diff < 3600) return Math.floor(diff / 60) + 'm';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h';
    if (diff < 604800) return Math.floor(diff / 86400) + 'd';
    return new Date(dateStr).toLocaleDateString();
  }

  // ======================== START ========================
  document.addEventListener('DOMContentLoaded', init);
})();
