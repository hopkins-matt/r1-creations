// =============================================================================
// CYBERDECK IDEAS — Admin Portal
// =============================================================================

(function () {
  'use strict';

  // ======================== STATE ========================
  const ADMIN = {
    supabase: null,
    user: null,
    profile: null,
    features: [],
    users: [],
    showHidden: false,
    searchFeatures: '',
    searchUsers: '',
    toastTimer: null,
  };

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  // ======================== INIT ========================
  async function init() {
    if (!CONFIG.SUPABASE_URL || CONFIG.SUPABASE_URL === 'YOUR_SUPABASE_URL') {
      showView('login');
      showError('login-error', 'Configure js/config.js with your Supabase credentials.');
      return;
    }

    ADMIN.supabase = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
    setupEventListeners();

    showLoading(true);
    try {
      const { data: { session } } = await ADMIN.supabase.auth.getSession();
      if (session) {
        ADMIN.user = session.user;
        await checkAccess();
      } else {
        showView('login');
      }
    } catch (e) {
      console.error('Init error:', e);
      showView('login');
    }
    showLoading(false);

    ADMIN.supabase.auth.onAuthStateChange(async (event, session) => {
      if (event === 'SIGNED_IN' && session && !ADMIN.user) {
        ADMIN.user = session.user;
        showLoading(true);
        await checkAccess();
        showLoading(false);
      } else if (event === 'SIGNED_OUT') {
        ADMIN.user = null;
        ADMIN.profile = null;
        showView('login');
      }
    });
  }

  async function checkAccess() {
    await loadProfile();
    if (!ADMIN.profile) {
      showView('denied');
      return;
    }

    const role = ADMIN.profile.role;
    if (!['moderator', 'admin', 'superadmin'].includes(role)) {
      showView('denied');
      return;
    }

    // Moderators can't access user management
    if (role === 'moderator') {
      $('#nav-users').classList.add('hidden');
    } else {
      $('#nav-users').classList.remove('hidden');
    }

    // Set sidebar info
    $('#sidebar-role').textContent = role.toUpperCase();
    $('#sidebar-role').className = 'sidebar-role role-' + role;
    $('#admin-name').textContent = ADMIN.profile.display_name;

    showView('admin');
    await loadFeatures();

    if (['admin', 'superadmin'].includes(role)) {
      await loadUsers();
    }
  }

  // ======================== VIEW MANAGEMENT ========================
  function showView(name) {
    $$('.view').forEach(v => v.classList.remove('active'));
    $(`#view-${name}`).classList.add('active');
  }

  function showTab(name) {
    $$('.tab').forEach(t => t.classList.remove('active'));
    $$('.nav-link').forEach(l => l.classList.remove('active'));
    $(`#tab-${name}`).classList.add('active');
    $(`.nav-link[data-tab="${name}"]`).classList.add('active');
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
      const { error } = await ADMIN.supabase.auth.signInWithOtp({
        email,
        options: { shouldCreateUser: false }
      });
      if (error) throw error;

      $('#otp-hint').textContent = `Code sent to ${email}`;
      $('#login-form') && $('#login-form').classList.add('hidden');
      $('.login-form').classList.add('hidden');
      $('#otp-section').classList.remove('hidden');
      showToast('Code sent!', 'success');
    } catch (e) {
      showError('login-error', e.message || 'Failed to send code.');
    }
    showLoading(false);
  }

  async function verifyOTP() {
    const email = $('#login-email').value.trim();
    const token = $('#otp-input').value.trim();

    if (!token || token.length !== 6) {
      showError('login-error', 'Enter the 6-digit code.');
      return;
    }

    showLoading(true);
    clearError('login-error');

    try {
      const { data, error } = await ADMIN.supabase.auth.verifyOtp({
        email,
        token,
        type: 'email'
      });
      if (error) throw error;
      ADMIN.user = data.user;
      await checkAccess();
    } catch (e) {
      showError('login-error', e.message || 'Invalid code.');
    }
    showLoading(false);
  }

  async function signInWithDiscord() {
    showLoading(true);
    try {
      const { error } = await ADMIN.supabase.auth.signInWithOAuth({
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
    await ADMIN.supabase.auth.signOut();
  }

  // ======================== DATA LOADING ========================
  async function loadProfile() {
    if (!ADMIN.user) return;
    try {
      const { data, error } = await ADMIN.supabase
        .from('profiles')
        .select('*')
        .eq('id', ADMIN.user.id)
        .single();
      if (error) throw error;
      ADMIN.profile = data;
    } catch (e) {
      console.error('Profile load error:', e);
      ADMIN.profile = null;
    }
  }

  async function loadFeatures() {
    try {
      const { data, error } = await ADMIN.supabase.rpc('get_features_admin');
      if (error) throw error;
      ADMIN.features = data || [];
      renderFeatures();
    } catch (e) {
      console.error('Features load error:', e);
    }
  }

  async function loadUsers() {
    try {
      const { data, error } = await ADMIN.supabase.rpc('get_users_admin');
      if (error) throw error;
      ADMIN.users = data || [];
      renderUsers();
    } catch (e) {
      console.error('Users load error:', e);
    }
  }

  // ======================== RENDER FEATURES ========================
  function renderFeatures() {
    const tbody = $('#features-tbody');
    const empty = $('#features-empty');
    let list = ADMIN.features;

    if (!ADMIN.showHidden) {
      list = list.filter(f => !f.is_hidden);
    }

    if (ADMIN.searchFeatures) {
      const q = ADMIN.searchFeatures.toLowerCase();
      list = list.filter(f =>
        f.title.toLowerCase().includes(q) ||
        (f.author_name || '').toLowerCase().includes(q)
      );
    }

    if (list.length === 0) {
      tbody.innerHTML = '';
      empty.classList.remove('hidden');
      return;
    }

    empty.classList.add('hidden');
    tbody.innerHTML = list.map(f => {
      const scoreClass = f.vote_score > 0 ? 'positive' : f.vote_score < 0 ? 'negative' : '';
      const statusBadge = f.is_hidden
        ? '<span class="badge badge-hidden">Hidden</span>'
        : '<span class="badge badge-visible">Visible</span>';
      const date = new Date(f.created_at).toLocaleDateString();
      const canDelete = ['admin', 'superadmin'].includes(ADMIN.profile.role);

      return `
        <tr>
          <td class="cell-score ${scoreClass}">${f.vote_score}</td>
          <td class="cell-title" title="${escapeAttr(f.title)}">${escapeHtml(f.title)}</td>
          <td>${escapeHtml(f.author_name || 'Unknown')}</td>
          <td>${date}</td>
          <td>${statusBadge}</td>
          <td class="cell-actions">
            <button class="btn-action" onclick="AdminActions.editFeature('${f.id}')">Edit</button>
            <button class="btn-action warn" onclick="AdminActions.toggleFeature('${f.id}')">${f.is_hidden ? 'Show' : 'Hide'}</button>
            ${canDelete ? `<button class="btn-action danger" onclick="AdminActions.deleteFeature('${f.id}')">Del</button>` : ''}
          </td>
        </tr>
      `;
    }).join('');
  }

  // ======================== RENDER USERS ========================
  function renderUsers() {
    const tbody = $('#users-tbody');
    const empty = $('#users-empty');
    let list = ADMIN.users;

    if (ADMIN.searchUsers) {
      const q = ADMIN.searchUsers.toLowerCase();
      list = list.filter(u =>
        u.display_name.toLowerCase().includes(q) ||
        (u.email || '').toLowerCase().includes(q)
      );
    }

    if (list.length === 0) {
      tbody.innerHTML = '';
      empty.classList.remove('hidden');
      return;
    }

    empty.classList.add('hidden');
    tbody.innerHTML = list.map(u => {
      const roleBadge = `<span class="badge badge-${u.role}">${u.role}</span>`;
      const statusBadge = u.is_banned
        ? '<span class="badge badge-banned">Banned</span>'
        : '<span class="badge badge-active">Active</span>';
      const isSelf = u.id === ADMIN.user.id;
      const isSuperadmin = u.role === 'superadmin';
      const canManage = !isSelf && !isSuperadmin;

      return `
        <tr>
          <td>${escapeHtml(u.display_name)}</td>
          <td>${escapeHtml(u.email || '—')}</td>
          <td>${roleBadge}</td>
          <td>${u.post_count}</td>
          <td>${statusBadge}</td>
          <td class="cell-actions">
            ${canManage ? `
              <button class="btn-action" onclick="AdminActions.editRole('${u.id}')">Role</button>
              <button class="btn-action ${u.is_banned ? '' : 'warn'}"
                      onclick="AdminActions.toggleBan('${u.id}')">${u.is_banned ? 'Unban' : 'Ban'}</button>
            ` : (isSelf ? '<span style="color:var(--text-dim);font-size:10px">You</span>' : '<span style="color:var(--text-dim);font-size:10px">Protected</span>')}
          </td>
        </tr>
      `;
    }).join('');
  }

  // ======================== ADMIN ACTIONS ========================
  // Exposed globally so inline onclick handlers work
  window.AdminActions = {
    async editFeature(id) {
      const feature = ADMIN.features.find(f => f.id === id);
      if (!feature) return;

      showModal('Edit Feature', `
        <div class="field-group">
          <label>Title</label>
          <input type="text" id="edit-title" class="input input-modal" value="${escapeAttr(feature.title)}" maxlength="150">
        </div>
        <div class="field-group">
          <label>Description</label>
          <textarea id="edit-desc" class="textarea-modal" rows="4">${escapeHtml(feature.description || '')}</textarea>
        </div>
        <div class="field-group">
          <label>Edit Reason (optional)</label>
          <input type="text" id="edit-reason" class="input input-modal" placeholder="Why was this edited?">
        </div>
      `, [
        { label: 'Cancel', class: 'btn btn-ghost btn-sm', action: closeModal },
        { label: 'Save', class: 'btn btn-primary btn-sm', action: async () => {
          const title = $('#edit-title').value.trim();
          const desc = $('#edit-desc').value.trim();
          const reason = $('#edit-reason').value.trim();

          if (!title || title.length < 3) {
            showToast('Title must be at least 3 characters', 'error');
            return;
          }

          const modCheck = ProfanityFilter.checkAll(title, desc);
          if (!modCheck.clean) {
            showToast(modCheck.reason, 'error');
            return;
          }

          showLoading(true);
          try {
            const { error } = await ADMIN.supabase.rpc('staff_edit_feature', {
              target_id: id,
              new_title: title,
              new_description: desc,
              reason: reason || null
            });
            if (error) throw error;
            closeModal();
            await loadFeatures();
            showToast('Feature updated', 'success');
          } catch (e) {
            showToast(e.message || 'Failed to update', 'error');
          }
          showLoading(false);
        }}
      ]);
    },

    async toggleFeature(id) {
      showLoading(true);
      try {
        const { data, error } = await ADMIN.supabase.rpc('staff_toggle_feature', {
          target_id: id
        });
        if (error) throw error;
        await loadFeatures();
        showToast(data ? 'Feature hidden' : 'Feature visible', 'success');
      } catch (e) {
        showToast(e.message || 'Failed to toggle', 'error');
      }
      showLoading(false);
    },

    async deleteFeature(id) {
      const feature = ADMIN.features.find(f => f.id === id);
      if (!feature) return;

      showModal('Delete Feature', `
        <p style="color:var(--red);margin-bottom:10px;">This action cannot be undone.</p>
        <p>Delete: <strong>${escapeHtml(feature.title)}</strong></p>
      `, [
        { label: 'Cancel', class: 'btn btn-ghost btn-sm', action: closeModal },
        { label: 'Delete', class: 'btn-danger-sm', action: async () => {
          showLoading(true);
          try {
            const { error } = await ADMIN.supabase.rpc('admin_delete_feature', {
              target_id: id
            });
            if (error) throw error;
            closeModal();
            await loadFeatures();
            showToast('Feature deleted', 'success');
          } catch (e) {
            showToast(e.message || 'Failed to delete', 'error');
          }
          showLoading(false);
        }}
      ]);
    },

    async editRole(id) {
      const user = ADMIN.users.find(u => u.id === id);
      if (!user) return;

      const isSuperadmin = ADMIN.profile.role === 'superadmin';
      const roles = ['user', 'moderator'];
      if (isSuperadmin) roles.push('admin');

      const options = roles.map(r =>
        `<option value="${r}" ${user.role === r ? 'selected' : ''}>${r.charAt(0).toUpperCase() + r.slice(1)}</option>`
      ).join('');

      showModal('Change Role', `
        <p style="margin-bottom:10px;">User: <strong>${escapeHtml(user.display_name)}</strong></p>
        <div class="field-group">
          <label>Role</label>
          <select id="edit-role-select">${options}</select>
        </div>
      `, [
        { label: 'Cancel', class: 'btn btn-ghost btn-sm', action: closeModal },
        { label: 'Save', class: 'btn btn-primary btn-sm', action: async () => {
          const newRole = $('#edit-role-select').value;
          showLoading(true);
          try {
            const { error } = await ADMIN.supabase.rpc('admin_update_role', {
              target_id: id,
              new_role: newRole
            });
            if (error) throw error;
            closeModal();
            await loadUsers();
            showToast(`Role updated to ${newRole}`, 'success');
          } catch (e) {
            showToast(e.message || 'Failed to update role', 'error');
          }
          showLoading(false);
        }}
      ]);
    },

    async toggleBan(id) {
      const user = ADMIN.users.find(u => u.id === id);
      if (!user) return;

      const action = user.is_banned ? 'unban' : 'ban';

      showModal(`${action.charAt(0).toUpperCase() + action.slice(1)} User`, `
        <p>${action === 'ban' ? 'Ban' : 'Unban'} <strong>${escapeHtml(user.display_name)}</strong>?</p>
        ${action === 'ban' ? '<p style="color:var(--text-dim);font-size:11px;margin-top:6px;">Banned users cannot submit new features.</p>' : ''}
      `, [
        { label: 'Cancel', class: 'btn btn-ghost btn-sm', action: closeModal },
        { label: action.charAt(0).toUpperCase() + action.slice(1), class: action === 'ban' ? 'btn-danger-sm' : 'btn btn-primary btn-sm', action: async () => {
          showLoading(true);
          try {
            const { data, error } = await ADMIN.supabase.rpc('admin_toggle_ban', {
              target_id: id
            });
            if (error) throw error;
            closeModal();
            await loadUsers();
            showToast(data ? 'User banned' : 'User unbanned', 'success');
          } catch (e) {
            showToast(e.message || 'Failed to toggle ban', 'error');
          }
          showLoading(false);
        }}
      ]);
    }
  };

  // ======================== MODAL ========================
  function showModal(title, bodyHtml, buttons) {
    $('#modal-title').textContent = title;
    $('#modal-body').innerHTML = bodyHtml;
    $('#modal-footer').innerHTML = '';

    buttons.forEach(btn => {
      const el = document.createElement('button');
      el.className = btn.class;
      el.textContent = btn.label;
      el.addEventListener('click', btn.action);
      $('#modal-footer').appendChild(el);
    });

    $('#modal-overlay').classList.remove('hidden');
  }

  function closeModal() {
    $('#modal-overlay').classList.add('hidden');
  }

  // ======================== EVENT LISTENERS ========================
  function setupEventListeners() {
    // Auth
    $('#btn-send-code').addEventListener('click', sendOTP);
    $('#login-email').addEventListener('keydown', e => { if (e.key === 'Enter') sendOTP(); });
    $('#btn-discord').addEventListener('click', signInWithDiscord);
    $('#btn-verify').addEventListener('click', verifyOTP);
    $('#otp-input').addEventListener('keydown', e => { if (e.key === 'Enter') verifyOTP(); });
    $('#btn-otp-back').addEventListener('click', () => {
      $('#otp-section').classList.add('hidden');
      $('.login-form').classList.remove('hidden');
    });

    // Sign out
    $('#btn-admin-signout').addEventListener('click', signOut);
    $('#btn-denied-signout').addEventListener('click', signOut);

    // Navigation
    $$('.nav-link').forEach(link => {
      link.addEventListener('click', () => showTab(link.dataset.tab));
    });

    // Search / filters
    $('#search-features').addEventListener('input', (e) => {
      ADMIN.searchFeatures = e.target.value;
      renderFeatures();
    });

    $('#search-users').addEventListener('input', (e) => {
      ADMIN.searchUsers = e.target.value;
      renderUsers();
    });

    $('#toggle-hidden').addEventListener('change', (e) => {
      ADMIN.showHidden = e.target.checked;
      renderFeatures();
    });

    // Modal close
    $('#modal-close').addEventListener('click', closeModal);
    $('#modal-overlay').addEventListener('click', (e) => {
      if (e.target === $('#modal-overlay')) closeModal();
    });
  }

  // ======================== UTILITIES ========================
  function showLoading(visible) {
    const el = $('#loading');
    if (visible) el.classList.remove('hidden');
    else el.classList.add('hidden');
  }

  function showToast(msg, type) {
    const el = $('#toast');
    el.textContent = msg;
    el.className = 'toast' + (type ? ' ' + type : '');
    requestAnimationFrame(() => el.classList.add('show'));
    clearTimeout(ADMIN.toastTimer);
    ADMIN.toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
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
    div.textContent = text || '';
    return div.innerHTML;
  }

  function escapeAttr(text) {
    return (text || '').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ======================== START ========================
  document.addEventListener('DOMContentLoaded', init);
})();
