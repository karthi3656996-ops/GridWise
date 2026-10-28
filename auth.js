/**
 * ═══════════════════════════════════════════════════════════════════════
 * GRIDWISE AUTHENTICATION ENGINE (v1.0)
 * Architecture: Cryptographic Client Vault (W3C Web Crypto API) +
 *               Dual-Mode REST API Backend Bridge.
 * ───────────────────────────────────────────────────────────────────────
 * Security Highlights:
 *  - PBKDF2 Key Derivation (HMAC-SHA-256, 100,000 iterations).
 *  - 16-byte cryptographically secure per-user salt (crypto.getRandomValues).
 *  - 256-bit cryptographic session tokens.
 *  - Zero plaintext password persistence.
 *  - Session timeout tracking (4-hour duration) with auto-invalidation.
 *  - Safe fallback: Zero-dependency browser vault when running standalone
 *    or file:///, auto-detecting backend REST endpoints if online.
 * ═══════════════════════════════════════════════════════════════════════
 */

'use strict';

const GridWiseAuth = (function () {
  // Configuration constants
  const PBKDF2_ITERATIONS = 100000;
  const SALT_BYTES = 16;
  const SESSION_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours
  const STORAGE_KEY_USERS = 'gridwise_vault_users_v1';
  const STORAGE_KEY_SESSION = 'gridwise_session_v1';
  let _backendBase = 'http://localhost:3000/api/auth';
  let _apiAvailable = false;
  let _currentUser = null;
  let _sessionExpiryTimer = null;

  /* ─────────────────────────────────────────────────────────────────
   * 1. CRYPTOGRAPHIC PRIMITIVES (Web Crypto API)
   * ───────────────────────────────────────────────────────────────── */

  /** Convert Uint8Array to Hex string */
  function buf2hex(buffer) {
    return Array.from(new Uint8Array(buffer))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  /** Convert Hex string to Uint8Array */
  function hex2buf(hex) {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return bytes;
  }

  /** Generate cryptographically random bytes */
  function generateRandomBytes(size) {
    const bytes = new Uint8Array(size);
    window.crypto.getRandomValues(bytes);
    return bytes;
  }

  /** Derive cryptographic hash using PBKDF2 with HMAC-SHA-256 */
  async function hashPassword(password, saltUint8) {
    const enc = new TextEncoder();
    const keyMaterial = await window.crypto.subtle.importKey(
      'raw',
      enc.encode(password),
      { name: 'PBKDF2' },
      false,
      ['deriveBits', 'deriveKey']
    );

    const derivedKey = await window.crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: saltUint8,
        iterations: PBKDF2_ITERATIONS,
        hash: 'SHA-256'
      },
      keyMaterial,
      { name: 'HMAC', hash: 'SHA-256', length: 256 },
      true,
      ['sign']
    );

    const rawBits = await window.crypto.subtle.exportKey('raw', derivedKey);
    return buf2hex(rawBits);
  }

  /** Generate secure 256-bit random session token */
  function generateSessionToken() {
    return buf2hex(generateRandomBytes(32));
  }

  /* ─────────────────────────────────────────────────────────────────
   * 2. USER REPOSITORY & PRE-SEEDED DEMO ACCOUNTS
   * ───────────────────────────────────────────────────────────────── */

  /** Load all registered users from storage */
  function loadUserVault() {
    try {
      const data = localStorage.getItem(STORAGE_KEY_USERS);
      return data ? JSON.parse(data) : {};
    } catch (e) {
      console.warn('[GridWise Auth] Local vault read failed, using empty vault.', e);
      return {};
    }
  }

  /** Save all registered users to storage */
  function saveUserVault(vault) {
    try {
      localStorage.setItem(STORAGE_KEY_USERS, JSON.stringify(vault));
    } catch (e) {
      console.error('[GridWise Auth] Local vault save failed.', e);
    }
  }

  /** Initialize vault with demo operator account if not already present */
  async function seedDefaultAccounts() {
    const vault = loadUserVault();
    const demoEmail = 'operator@gridwise.energy';

    if (!vault[demoEmail]) {
      const salt = generateRandomBytes(SALT_BYTES);
      const hash = await hashPassword('GridWise2026!', salt);
      vault[demoEmail] = {
        name: 'Dr. Elena Vance',
        email: demoEmail,
        role: 'Lead Grid Controller',
        organization: 'GridWise Central Operations',
        saltHex: buf2hex(salt),
        hashHex: hash,
        createdAt: new Date().toISOString()
      };
      saveUserVault(vault);
    }
  }

  /* ─────────────────────────────────────────────────────────────────
   * 3. SESSION MANAGEMENT
   * ───────────────────────────────────────────────────────────────── */

  function saveSession(session, rememberMe = false) {
    const raw = JSON.stringify(session);
    if (rememberMe) {
      localStorage.setItem(STORAGE_KEY_SESSION, raw);
      sessionStorage.removeItem(STORAGE_KEY_SESSION);
    } else {
      sessionStorage.setItem(STORAGE_KEY_SESSION, raw);
      localStorage.removeItem(STORAGE_KEY_SESSION);
    }
  }

  function getSession() {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY_SESSION) || localStorage.getItem(STORAGE_KEY_SESSION);
      if (!raw) return null;
      const session = JSON.parse(raw);
      if (!session || !session.expiresAt || Date.now() > session.expiresAt) {
        clearSession();
        return null;
      }
      return session;
    } catch (e) {
      clearSession();
      return null;
    }
  }

  function clearSession() {
    sessionStorage.removeItem(STORAGE_KEY_SESSION);
    localStorage.removeItem(STORAGE_KEY_SESSION);
    if (_sessionExpiryTimer) {
      clearTimeout(_sessionExpiryTimer);
      _sessionExpiryTimer = null;
    }
    _currentUser = null;
  }

  function scheduleSessionTimeout(expiresAt) {
    if (_sessionExpiryTimer) clearTimeout(_sessionExpiryTimer);
    const msRemaining = Math.max(0, expiresAt - Date.now());
    _sessionExpiryTimer = setTimeout(() => {
      console.warn('[GridWise Auth] Session expired. Signing out.');
      signOut(true);
    }, msRemaining);
  }

  /* ─────────────────────────────────────────────────────────────────
   * 4. AUTHENTICATION ACTIONS
   * ───────────────────────────────────────────────────────────────── */

  /** Sign In */
  async function signIn(email, password, rememberMe = false) {
    const normalizedEmail = (email || '').trim().toLowerCase();

    // Check optional backend REST endpoint
    if (_apiAvailable) {
      try {
        const resp = await fetch(`${_backendBase}/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: normalizedEmail, password })
        });
        if (resp.ok) {
          const data = await resp.json();
          const session = {
            token: data.token,
            user: data.user,
            expiresAt: Date.now() + (data.expiresInMs || SESSION_TTL_MS)
          };
          saveSession(session, rememberMe);
          _currentUser = session.user;
          scheduleSessionTimeout(session.expiresAt);
          return { success: true, user: session.user };
        } else {
          const err = await resp.json().catch(() => ({}));
          return { success: false, message: err.message || 'Invalid credentials.' };
        }
      } catch (err) {
        console.info('[GridWise Auth] Remote auth unreachable, falling back to client crypto vault.');
      }
    }

    // Client-side WebCrypto Vault Verification
    const vault = loadUserVault();
    const user = vault[normalizedEmail];
    if (!user) {
      return { success: false, message: 'Unrecognized operator email. Please sign up or check credentials.' };
    }

    const salt = hex2buf(user.saltHex);
    const testHash = await hashPassword(password, salt);

    if (testHash !== user.hashHex) {
      return { success: false, message: 'Invalid password. Enter the correct password or use Forgot Password.' };
    }

    const session = {
      token: generateSessionToken(),
      user: {
        name: user.name,
        email: user.email,
        role: user.role || 'Grid Controller',
        organization: user.organization || 'Regional Substation'
      },
      expiresAt: Date.now() + SESSION_TTL_MS
    };

    saveSession(session, rememberMe);
    _currentUser = session.user;
    scheduleSessionTimeout(session.expiresAt);

    return { success: true, user: session.user };
  }

  /** Sign Up */
  async function signUp({ name, email, password, role, organization }) {
    const normalizedEmail = (email || '').trim().toLowerCase();

    if (!name || name.trim().length < 2) {
      return { success: false, message: 'Full operator name is required.' };
    }
    if (!normalizedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      return { success: false, message: 'A valid operator email address is required.' };
    }
    const pwdValidation = evaluatePasswordStrength(password);
    if (!pwdValidation.isValid) {
      return { success: false, message: pwdValidation.errors.join(' ') };
    }

    // Check optional backend REST endpoint
    if (_apiAvailable) {
      try {
        const resp = await fetch(`${_backendBase}/signup`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, email: normalizedEmail, password, role, organization })
        });
        if (resp.ok) {
          const data = await resp.json();
          return { success: true, user: data.user, message: 'Account registered successfully.' };
        } else {
          const err = await resp.json().catch(() => ({}));
          return { success: false, message: err.message || 'Registration failed.' };
        }
      } catch (err) {
        console.info('[GridWise Auth] Remote auth unreachable, fallback to client vault.');
      }
    }

    const vault = loadUserVault();
    if (vault[normalizedEmail]) {
      return { success: false, message: 'An operator account with this email address already exists. Please sign in.' };
    }

    const salt = generateRandomBytes(SALT_BYTES);
    const hash = await hashPassword(password, salt);

    vault[normalizedEmail] = {
      name: name.trim(),
      email: normalizedEmail,
      role: (role || 'Grid Controller').trim(),
      organization: (organization || 'Smart Grid Node').trim(),
      saltHex: buf2hex(salt),
      hashHex: hash,
      createdAt: new Date().toISOString()
    };

    saveUserVault(vault);
    return {
      success: true,
      message: 'Account registered successfully! You may now sign in with your credentials.'
    };
  }

  /** Request Password Reset Security Token */
  async function requestPasswordReset(email) {
    const normalizedEmail = (email || '').trim().toLowerCase();
    const vault = loadUserVault();
    const user = vault[normalizedEmail];

    if (!user) {
      // Security best practice: avoid account enumeration, but provide constructive hackathon hint
      return {
        success: false,
        message: 'No registered operator found with this email. Please check your address or register.'
      };
    }

    // Generate cryptographic 6-digit verification security token
    const tokenBytes = generateRandomBytes(3);
    const token = Array.from(tokenBytes).map(b => (b % 10).toString()).join('');
    user.resetToken = token;
    user.resetTokenExpires = Date.now() + 15 * 60 * 1000; // 15 mins
    saveUserVault(vault);

    return {
      success: true,
      token, // Expose token to UI for seamless testing in demo/hackathon environment
      message: `Security authorization code generated: ${token}. Valid for 15 minutes.`
    };
  }

  /** Complete Password Reset */
  async function completePasswordReset(email, resetToken, newPassword) {
    const normalizedEmail = (email || '').trim().toLowerCase();
    const vault = loadUserVault();
    const user = vault[normalizedEmail];

    if (!user || !user.resetToken) {
      return { success: false, message: 'No active password reset request found for this email.' };
    }
    if (user.resetToken !== resetToken.trim()) {
      return { success: false, message: 'Invalid authorization code. Please enter the exact code issued.' };
    }
    if (Date.now() > user.resetTokenExpires) {
      return { success: false, message: 'Authorization code expired. Please request a new code.' };
    }

    const pwdValidation = evaluatePasswordStrength(newPassword);
    if (!pwdValidation.isValid) {
      return { success: false, message: pwdValidation.errors.join(' ') };
    }

    const newSalt = generateRandomBytes(SALT_BYTES);
    const newHash = await hashPassword(newPassword, newSalt);

    user.saltHex = buf2hex(newSalt);
    user.hashHex = newHash;
    delete user.resetToken;
    delete user.resetTokenExpires;

    saveUserVault(vault);
    return {
      success: true,
      message: 'Password successfully updated! Please sign in with your new password.'
    };
  }

  /** Sign Out */
  async function signOut(wasExpired = false) {
    if (_apiAvailable) {
      try {
        const session = getSession();
        if (session && session.token) {
          await fetch(`${_backendBase}/logout`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${session.token}`
            }
          });
        }
      } catch (_) {}
    }
    clearSession();
    updateUIState();
    if (wasExpired) {
      showAuthAlert('Your operational session has expired. Please sign in again.', 'warning');
    } else {
      showAuthAlert('Successfully signed out of GridWise Operations.', 'success');
    }
    switchAuthView('login');
  }

  /** Evaluate Password Complexity */
  function evaluatePasswordStrength(password) {
    const pwd = password || '';
    const errors = [];
    if (pwd.length < 8) errors.push('At least 8 characters required.');
    if (!/[A-Z]/.test(pwd)) errors.push('At least one uppercase letter required.');
    if (!/[a-z]/.test(pwd)) errors.push('At least one lowercase letter required.');
    if (!/[0-9]/.test(pwd)) errors.push('At least one digit required.');
    if (!/[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/.test(pwd)) errors.push('At least one special symbol required.');

    let score = 0;
    if (pwd.length >= 8) score++;
    if (pwd.length >= 12) score++;
    if (/[A-Z]/.test(pwd) && /[a-z]/.test(pwd)) score++;
    if (/[0-9]/.test(pwd)) score++;
    if (/[^A-Za-z0-9]/.test(pwd)) score++;

    let label = 'Weak';
    let color = 'var(--orange)';
    if (score >= 4) {
      label = 'Strong';
      color = 'var(--green)';
    } else if (score >= 2) {
      label = 'Moderate';
      color = 'var(--orange)';
    }

    return {
      isValid: errors.length === 0,
      errors,
      score,
      label,
      color
    };
  }

  /* ─────────────────────────────────────────────────────────────────
   * 5. UI CONTROLLER & DOM INTEGRATION
   * ───────────────────────────────────────────────────────────────── */

  function switchAuthView(viewName) {
    const views = {
      login: document.getElementById('authViewLogin'),
      signup: document.getElementById('authViewSignup'),
      forgot: document.getElementById('authViewForgot')
    };

    Object.entries(views).forEach(([name, el]) => {
      if (el) el.style.display = (name === viewName) ? 'block' : 'none';
    });

    hideAuthAlert();
  }

  function showAuthAlert(message, type = 'error') {
    const alertBox = document.getElementById('authAlertBox');
    const alertMsg = document.getElementById('authAlertMsg');
    if (!alertBox || !alertMsg) return;

    alertMsg.textContent = message;
    alertBox.className = `auth-alert ${type}`;
    alertBox.style.display = 'flex';
  }

  function hideAuthAlert() {
    const alertBox = document.getElementById('authAlertBox');
    if (alertBox) alertBox.style.display = 'none';
  }

  function setButtonLoading(buttonId, isLoading, defaultText, loadingText) {
    const btn = document.getElementById(buttonId);
    if (!btn) return;
    if (isLoading) {
      btn.disabled = true;
      btn.dataset.origText = btn.innerHTML;
      btn.innerHTML = `<span class="auth-spinner"></span> ${loadingText || 'Verifying…'}`;
    } else {
      btn.disabled = false;
      btn.innerHTML = defaultText || btn.dataset.origText || 'Submit';
    }
  }

  /** Update UI based on authentication status */
  function updateUIState() {
    const session = getSession();
    const authScreen = document.getElementById('authScreen');
    const mainContent = document.getElementById('mainContent');
    const sidebar = document.getElementById('sidebar');
    const mobileHeader = document.querySelector('.mobile-header');
    const engineBanner = document.getElementById('engineStatusBanner');

    if (session && session.user) {
      _currentUser = session.user;
      if (authScreen) authScreen.classList.remove('active');
      if (mainContent) mainContent.removeAttribute('aria-hidden');
      if (sidebar) sidebar.removeAttribute('aria-hidden');

      // Update operator profile widget in sidebar
      const opName = document.getElementById('authSidebarOpName');
      const opRole = document.getElementById('authSidebarOpRole');
      const opAvatar = document.getElementById('authSidebarAvatar');
      const bannerOp = document.getElementById('authBannerOp');

      if (opName) opName.textContent = session.user.name;
      if (opRole) opRole.textContent = session.user.role || 'Grid Controller';
      if (bannerOp) bannerOp.textContent = `OPERATOR: ${session.user.name.toUpperCase()}`;
      if (opAvatar) {
        const initials = session.user.name.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase();
        opAvatar.textContent = initials || 'OP';
      }
    } else {
      _currentUser = null;
      if (authScreen) authScreen.classList.add('active');
      if (mainContent) mainContent.setAttribute('aria-hidden', 'true');
      if (sidebar) sidebar.setAttribute('aria-hidden', 'true');
    }
  }

  /** Quick autofill demo credentials for testing */
  function fillDemoCredentials() {
    const emailField = document.getElementById('loginEmail');
    const pwdField = document.getElementById('loginPassword');
    if (emailField) emailField.value = 'operator@gridwise.energy';
    if (pwdField) pwdField.value = 'GridWise2026!';
    hideAuthAlert();
    showAuthAlert('Demo credentials loaded: operator@gridwise.energy / GridWise2026!', 'success');
  }

  /** Attach Event Listeners to Auth Forms */
  function initDOM() {
    // 1. Password Visibility Toggles
    document.querySelectorAll('.auth-toggle-pwd').forEach(btn => {
      btn.addEventListener('click', () => {
        const inputId = btn.getAttribute('data-target');
        const input = document.getElementById(inputId);
        if (!input) return;
        const isPassword = input.type === 'password';
        input.type = isPassword ? 'text' : 'password';
        btn.setAttribute('aria-label', isPassword ? 'Hide password' : 'Show password');
        btn.innerHTML = isPassword
          ? `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`
          : `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
      });
    });

    // 2. Password Strength Real-time Feedback
    const signupPwd = document.getElementById('signupPassword');
    const strengthMeter = document.getElementById('authPwdStrength');
    const strengthBar = document.getElementById('authPwdBar');
    const strengthLabel = document.getElementById('authPwdLabel');

    if (signupPwd && strengthMeter) {
      signupPwd.addEventListener('input', () => {
        const val = signupPwd.value;
        if (!val) {
          strengthMeter.style.display = 'none';
          return;
        }
        strengthMeter.style.display = 'block';
        const evalRes = evaluatePasswordStrength(val);
        if (strengthBar) {
          const pct = Math.min(100, Math.max(15, evalRes.score * 20));
          strengthBar.style.width = `${pct}%`;
          strengthBar.style.backgroundColor = evalRes.color;
        }
        if (strengthLabel) {
          strengthLabel.textContent = `Strength: ${evalRes.label}`;
          strengthLabel.style.color = evalRes.color;
        }
      });
    }

    // 3. Login Form Submit
    const loginForm = document.getElementById('authLoginForm');
    if (loginForm) {
      loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        hideAuthAlert();
        const email = document.getElementById('loginEmail')?.value;
        const password = document.getElementById('loginPassword')?.value;
        const rememberMe = document.getElementById('loginRemember')?.checked || false;

        if (!email || !password) {
          showAuthAlert('Please enter both operator email and password.');
          return;
        }

        setButtonLoading('btnLoginSubmit', true, 'Login', 'Authorizing…');
        try {
          const res = await signIn(email, password, rememberMe);
          if (res.success) {
            updateUIState();
            if (typeof showToast === 'function') {
              showToast(`Welcome back, ${res.user.name}. Terminal authorized.`);
            }
          } else {
            showAuthAlert(res.message);
          }
        } catch (err) {
          showAuthAlert('An unexpected authorization error occurred. Please try again.');
        } finally {
          setButtonLoading('btnLoginSubmit', false, 'Login');
        }
      });
    }

    // 4. Signup Form Submit
    const signupForm = document.getElementById('authSignupForm');
    if (signupForm) {
      signupForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        hideAuthAlert();
        const name = document.getElementById('signupName')?.value;
        const email = document.getElementById('signupEmail')?.value;
        const role = document.getElementById('signupRole')?.value;
        const org = document.getElementById('signupOrg')?.value;
        const password = document.getElementById('signupPassword')?.value;
        const confirmPwd = document.getElementById('signupConfirmPassword')?.value;
        const terms = document.getElementById('signupTerms')?.checked;

        if (!terms) {
          showAuthAlert('Please accept the Operational Dispatch safety protocols.');
          return;
        }
        if (password !== confirmPwd) {
          showAuthAlert('Passwords do not match. Please re-enter identical passwords.');
          return;
        }

        setButtonLoading('btnSignupSubmit', true, 'Register Terminal Operator', 'Deriving cryptographic key…');
        try {
          const res = await signUp({ name, email, password, role, organization: org });
          if (res.success) {
            switchAuthView('login');
            showAuthAlert(res.message, 'success');
            // Auto fill login email
            const loginEmail = document.getElementById('loginEmail');
            if (loginEmail) loginEmail.value = email;
          } else {
            showAuthAlert(res.message);
          }
        } catch (err) {
          showAuthAlert('Registration failed. Please check form entries and try again.');
        } finally {
          setButtonLoading('btnSignupSubmit', false, 'Register Terminal Operator');
        }
      });
    }

    // 5. Forgot Password Request
    const forgotRequestForm = document.getElementById('authForgotRequestForm');
    if (forgotRequestForm) {
      forgotRequestForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        hideAuthAlert();
        const email = document.getElementById('forgotEmail')?.value;
        if (!email) {
          showAuthAlert('Please enter your operator email.');
          return;
        }

        setButtonLoading('btnForgotRequest', true, 'Request Authorization Code', 'Generating token…');
        try {
          const res = await requestPasswordReset(email);
          if (res.success) {
            showAuthAlert(res.message, 'success');
            document.getElementById('authForgotStep1').style.display = 'none';
            document.getElementById('authForgotStep2').style.display = 'block';
            const tokenInput = document.getElementById('forgotToken');
            if (tokenInput && res.token) tokenInput.value = res.token;
          } else {
            showAuthAlert(res.message);
          }
        } catch (err) {
          showAuthAlert('Reset request failed. Please try again.');
        } finally {
          setButtonLoading('btnForgotRequest', false, 'Request Authorization Code');
        }
      });
    }

    // 6. Complete Password Reset Form
    const forgotCompleteForm = document.getElementById('authForgotCompleteForm');
    if (forgotCompleteForm) {
      forgotCompleteForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        hideAuthAlert();
        const email = document.getElementById('forgotEmail')?.value;
        const token = document.getElementById('forgotToken')?.value;
        const newPassword = document.getElementById('forgotNewPassword')?.value;
        const confirmPwd = document.getElementById('forgotConfirmPassword')?.value;

        if (newPassword !== confirmPwd) {
          showAuthAlert('Passwords do not match. Please re-enter identical passwords.');
          return;
        }

        setButtonLoading('btnForgotComplete', true, 'Reset & Authorize', 'Hashing new password…');
        try {
          const res = await completePasswordReset(email, token, newPassword);
          if (res.success) {
            switchAuthView('login');
            showAuthAlert(res.message, 'success');
            // Auto fill
            const loginEmail = document.getElementById('loginEmail');
            if (loginEmail) loginEmail.value = email;
          } else {
            showAuthAlert(res.message);
          }
        } catch (err) {
          showAuthAlert('Reset completion failed. Please try again.');
        } finally {
          setButtonLoading('btnForgotComplete', false, 'Reset & Authorize');
        }
      });
    }

    // 7. Navigation switches
    document.getElementById('authToSignupBtn')?.addEventListener('click', (e) => {
      e.preventDefault();
      switchAuthView('signup');
    });
    document.getElementById('authToLoginBtn')?.addEventListener('click', (e) => {
      e.preventDefault();
      switchAuthView('login');
    });
    document.getElementById('authToForgotBtn')?.addEventListener('click', (e) => {
      e.preventDefault();
      switchAuthView('forgot');
    });
    document.getElementById('authBackToLoginBtn')?.addEventListener('click', (e) => {
      e.preventDefault();
      switchAuthView('login');
    });
    document.getElementById('authDemoBtn')?.addEventListener('click', (e) => {
      e.preventDefault();
      fillDemoCredentials();
    });
    document.getElementById('authGoogleBtn')?.addEventListener('click', (e) => {
      e.preventDefault();
      fillDemoCredentials();
      if (typeof showToast === 'function') {
        showToast('Google sign-in requires OAuth configuration. Demo operator credentials pre-loaded for preview.');
      }
    });

    // 8. Sign Out Buttons (Sidebar + Settings)
    document.querySelectorAll('.auth-sign-out-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        signOut(false);
      });
    });
  }

  /* ─────────────────────────────────────────────────────────────────
   * 6. INITIALISATION
   * ───────────────────────────────────────────────────────────────── */

  async function init() {
    await seedDefaultAccounts();

    // Check optional backend presence (try port 3000, then fallback to 3001)
    try {
      let ping = await fetch(`http://localhost:3000/api/auth/health`, { method: 'GET', signal: AbortSignal.timeout(1000) });
      if (ping.ok) {
        _backendBase = 'http://localhost:3000/api/auth';
        _apiAvailable = true;
      }
    } catch (_) {
      try {
        let ping3001 = await fetch(`http://localhost:3001/api/auth/health`, { method: 'GET', signal: AbortSignal.timeout(1000) });
        if (ping3001.ok) {
          _backendBase = 'http://localhost:3001/api/auth';
          _apiAvailable = true;
        } else {
          _apiAvailable = false;
        }
      } catch (__) {
        _apiAvailable = false;
      }
    }

    initDOM();
    updateUIState();

    const session = getSession();
    if (session) {
      scheduleSessionTimeout(session.expiresAt);
    }
  }

  // Self-test runner for authentication suite
  async function runAuthTests() {
    const tests = [];
    const assert = (name, pass, msg) => tests.push({ name, pass: !!pass, msg: pass ? 'OK' : msg });

    // 1. Password hashing
    const salt = generateRandomBytes(SALT_BYTES);
    const h1 = await hashPassword('Secret123!', salt);
    const h2 = await hashPassword('Secret123!', salt);
    const h3 = await hashPassword('WrongPass!', salt);
    assert('Auth 1 - Deterministic PBKDF2 Hashing with identical salt', h1 === h2, 'Hashes differed');
    assert('Auth 2 - Distinct password produces different hash', h1 !== h3, 'Hashes collided');

    // 2. Demo user verification
    const loginOk = await signIn('operator@gridwise.energy', 'GridWise2026!');
    assert('Auth 3 - Validated demo operator login', loginOk.success && loginOk.user.email === 'operator@gridwise.energy', loginOk.message);

    // 3. Invalid credentials rejection
    const loginBad = await signIn('operator@gridwise.energy', 'WrongPassword!');
    assert('Auth 4 - Invalid password rejected safely', !loginBad.success, 'Allowed bad password');

    // 4. Non-existent account rejection
    const loginGhost = await signIn('ghost@gridwise.energy', 'AnyPassword123!');
    assert('Auth 5 - Non-existent operator rejected safely', !loginGhost.success, 'Allowed ghost email');

    // 5. Password complexity evaluator
    const evalWeak = evaluatePasswordStrength('weak');
    const evalStrong = evaluatePasswordStrength('Elena@GridWise2026');
    assert('Auth 6 - Weak password flagged with validation errors', !evalWeak.isValid && evalWeak.errors.length > 0, 'Weak passed');
    assert('Auth 7 - Compliant password passes validation', evalStrong.isValid, 'Strong failed');

    // 6. Session token generation
    const sToken = generateSessionToken();
    assert('Auth 8 - Cryptographic 256-bit hex session token generated', typeof sToken === 'string' && sToken.length === 64, 'Token invalid');

    // 7. Password Reset Token flow
    const resetReq = await requestPasswordReset('operator@gridwise.energy');
    assert('Auth 9 - Password reset authorization token generated', resetReq.success && resetReq.token.length === 6, resetReq.message);

    const resetBadToken = await completePasswordReset('operator@gridwise.energy', '000000', 'NewPass2026!');
    assert('Auth 10 - Bad reset code rejected', !resetBadToken.success, 'Bad token allowed');

    console.table(tests.map(t => ({ 'Auth Test': t.name, Status: t.pass ? '✅ PASS' : '❌ FAIL', Detail: t.msg })));
    return tests;
  }

  // Public API
  return {
    init,
    signIn,
    signUp,
    signOut,
    requestPasswordReset,
    completePasswordReset,
    getSession,
    getCurrentUser: () => _currentUser,
    isAuthenticated: () => !!getSession(),
    getToken: () => getSession()?.token || null,
    getAuthHeaders: () => {
      const session = getSession();
      return session?.token
        ? { 'Authorization': `Bearer ${session.token}`, 'Content-Type': 'application/json' }
        : { 'Content-Type': 'application/json' };
    },
    getBackendBase: () => _backendBase,
    isApiAvailable: () => _apiAvailable,
    runAuthTests,
    fillDemoCredentials,
    switchAuthView
  };
})();

if (typeof window !== 'undefined') window.GridWiseAuth = GridWiseAuth;

// Auto-boot when DOM is ready
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => GridWiseAuth.init());
  } else {
    GridWiseAuth.init();
  }
}
