/**
 * sleuth — R1 Creation
 * AI-powered camera object identifier
 * Built with ♥ by HopIT
 *
 * Architecture:
 *  - Single video element, screens overlay via opacity
 *  - State machine drives all UI transitions
 *  - Hardware-accelerated CSS only (transform, opacity)
 *  - All LLM inference on Rabbit's servers (no external API cost)
 */

'use strict';

// ═══════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════

const STATES = {
  CAMERA:          'camera',
  ANALYZING:       'analyzing',
  RESULT:          'result',
  SETTINGS:        'settings',
  HD_CAMERA:       'hd-camera',
  HD_ANALYZING:    'hd-analyzing',
  HD_RESULT:       'hd-result',
};

let state        = STATES.CAMERA;
let resultPage   = 1;          // 1 = description, 2 = fun fact
let creditClicks = 0;          // easter egg counter (need 3)
let errorTimer   = null;
let llmTimer     = null;

const RESPONSE_TIMEOUT_MS = 20000;

const settings = {
  voice:  false,
  hotdog: false,
};

// ═══════════════════════════════════════════
// PROMPTS
// ═══════════════════════════════════════════

const PROMPT_STANDARD = `Identify the primary object centered in this image. The surrounding context is useful for identification but focus your answer on the center subject.
Respond with ONLY raw JSON — no markdown, no code fences, no explanation outside the JSON:
{"name":"","category":"","description":"One to two sentences about what it is.","fun_fact":"One genuinely interesting fact about it."}`;

const PROMPT_HOTDOG = `Is there a hot dog in this image? A hot dog is specifically a cooked sausage served in a sliced bun.
Respond with ONLY raw JSON — no markdown, no code fences:
{"result":"HOT DOG" or "NOT HOT DOG","reason":"One short, blunt sentence in the deadpan style of Jian-Yang from Silicon Valley."}`;

// ═══════════════════════════════════════════
// DOM REFS
// ═══════════════════════════════════════════

const $ = id => document.getElementById(id);

const screens = {
  camera:        $('s-camera'),
  analyzing:     $('s-analyzing'),
  result:        $('s-result'),
  settings:      $('s-settings'),
  hdResult:      $('s-hotdog-result'),
  hdAnalyzing:   $('s-hotdog-analyzing'),
};

const video       = $('video');
const canvas      = $('canvas');
const hdOverlay   = $('hd-cam-overlay');

// ═══════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════

document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  bindUIEvents();
  bindHardwareEvents();
  startCamera();
  addErrorToast();

  // R1 WebView may block autoplay — retry video.play() on first user interaction
  function resumeVideo() {
    if (video.paused && video.srcObject) {
      dbg('resuming video on user gesture');
      video.play().catch(function() {});
    }
    document.removeEventListener('touchstart', resumeVideo);
    document.removeEventListener('click', resumeVideo);
    window.removeEventListener('sideClick', resumeVideo);
  }
  document.addEventListener('touchstart', resumeVideo);
  document.addEventListener('click', resumeVideo);
  window.addEventListener('sideClick', resumeVideo);
});

// ═══════════════════════════════════════════
// CAMERA
// ═══════════════════════════════════════════

function dbg(msg) {
  console.log('[sleuth] ' + msg);
  // Temporary on-screen debug — remove before release
  var d = document.getElementById('dbg');
  if (!d) { d = document.createElement('div'); d.id = 'dbg'; d.style.cssText = 'position:fixed;bottom:0;left:0;right:0;background:#000;color:#0f0;font:9px monospace;padding:4px;z-index:9999;max-height:80px;overflow-y:auto;'; document.body.appendChild(d); }
  d.textContent += msg + '\n';
}

async function startCamera() {
  async function attachStream(stream) {
    dbg('stream obtained, tracks: ' + stream.getVideoTracks().length);
    video.srcObject = stream;

    // Strategy 1: wait for metadata then play
    var metadataFired = false;
    var played = new Promise(function(resolve) {
      video.onloadedmetadata = async function() {
        metadataFired = true;
        dbg('metadata fired, w=' + video.videoWidth + ' h=' + video.videoHeight);
        try {
          await video.play();
          dbg('play() succeeded');
        } catch (e) {
          dbg('play() failed: ' + e.message);
        }
        setTimeout(resolve, 100);
      };

      // Strategy 2: if metadata doesn't fire in 2s, try play() anyway
      setTimeout(async function() {
        if (!metadataFired) {
          dbg('metadata timeout — forcing play()');
          try {
            await video.play();
            dbg('forced play() succeeded, w=' + video.videoWidth);
          } catch (e) {
            dbg('forced play() failed: ' + e.message);
          }
          resolve();
        }
      }, 2000);
    });

    await played;
  }

  var constraints = [
    { video: { facingMode: 'environment', width: { ideal: 640 }, height: { ideal: 480 } }, audio: false },
    { video: { facingMode: 'environment' }, audio: false },
    { video: true, audio: false },
  ];

  for (var i = 0; i < constraints.length; i++) {
    try {
      dbg('trying constraints #' + i);
      var stream = await navigator.mediaDevices.getUserMedia(constraints[i]);
      await attachStream(stream);
      dbg('camera ready, videoWidth=' + video.videoWidth);
      return;
    } catch (err) {
      dbg('constraints #' + i + ' failed: ' + err.message);
    }
  }

  showError('Camera not available');
  dbg('all constraints failed');
}

function captureFrame() {
  if (!video.videoWidth) return null;
  canvas.width  = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d', { willReadFrequently: false, alpha: false, desynchronized: true });
  ctx.drawImage(video, 0, 0);
  return canvas.toDataURL('image/jpeg', 0.8);
}

// ═══════════════════════════════════════════
// LLM BRIDGE
// ═══════════════════════════════════════════

function sendToLLM(imageBase64, prompt) {
  dbg('sendToLLM called, PMH=' + (typeof PluginMessageHandler));
  dbg('imageBase64 len=' + (imageBase64 ? imageBase64.length : 0));

  if (typeof PluginMessageHandler === 'undefined') {
    // Dev mode — simulate a response after a short delay
    dbg('dev mode — sending mock response');
    setTimeout(() => {
      const mock = state === STATES.HD_ANALYZING
        ? '{"result":"NOT HOT DOG","reason":"This is a keyboard. Not a hot dog."}'
        : '{"name":"Mechanical Keyboard","category":"Technology","description":"A mechanical keyboard uses individual switches beneath each key for tactile feedback. Popular among programmers and gamers.","fun_fact":"The first computer keyboard was derived from the typewriter, which itself was invented in 1868."}';
      handleLLMResponse({ data: mock });
    }, 1800);
    return;
  }

  // Re-assign callback right before send (Launch Pad R1 pattern)
  window.onPluginMessage = _onPluginMsg;

  // Official SDK flags:
  // - useLLM: request LLM inference
  // - wantsJournalEntry: keep this out of Rabbithole journal entries
  var payload = {
    message:           prompt,
    useLLM:            true,
    wantsR1Response:   !!settings.voice,
    wantsJournalEntry: false,
  };
  if (imageBase64) payload.imageBase64 = imageBase64;
  dbg('posting to PMH, msg len=' + prompt.length + ', img len=' + (imageBase64 ? imageBase64.length : 0));
  try {
    PluginMessageHandler.postMessage(JSON.stringify(payload));
    dbg('postMessage sent OK — waiting for onPluginMessage...');
  } catch (e) {
    dbg('postMessage error: ' + e.message);
    showError('Request failed — try again');
    setState(state === STATES.HD_ANALYZING ? STATES.HD_CAMERA : STATES.CAMERA);
    return;
  }

  clearTimeout(llmTimer);
  llmTimer = setTimeout(function() {
    if (state === STATES.ANALYZING || state === STATES.HD_ANALYZING) {
      dbg('WATCHDOG: no response after ' + RESPONSE_TIMEOUT_MS + 'ms');
      dbg('onPluginMessage is: ' + typeof window.onPluginMessage);
      dbg('onPluginMessage === _onPluginMsg: ' + (window.onPluginMessage === _onPluginMsg));
      showError('No response yet — try again');
      setState(state === STATES.HD_ANALYZING ? STATES.HD_CAMERA : STATES.CAMERA);
    }
  }, RESPONSE_TIMEOUT_MS);
}

// Register callback — try both assignment styles the R1 might expect
function _onPluginMsg(data) {
  try {
    dbg('onPluginMessage fired, type=' + typeof data);
    if (typeof data === 'string') {
      dbg('data is string, len=' + data.length + ': ' + data.substring(0, 150));
    } else {
      dbg('data keys=' + (data ? Object.keys(data).join(',') : 'null'));
      dbg('data.data=' + (data && data.data ? String(data.data).substring(0, 150) : 'empty'));
      dbg('data.message=' + (data && data.message ? String(data.message).substring(0, 150) : 'empty'));
    }
    handleLLMResponse(data);
  } catch (e) {
    dbg('onPluginMessage ERROR: ' + e.message);
  }
}
window.onPluginMessage = _onPluginMsg;

// Shotgun approach — try every possible way the R1 might return data
// 1. Standard postMessage (Flutter WebView commonly uses this)
window.addEventListener('message', function(e) {
  dbg('window.message event: ' + typeof e.data + ' ' + String(e.data).substring(0, 150));
  if (e.data && typeof e.data === 'string') {
    try { var parsed = JSON.parse(e.data); _onPluginMsg(parsed); } catch(ex) { _onPluginMsg({ data: e.data }); }
  } else if (e.data) {
    _onPluginMsg(e.data);
  }
});
// 2. Custom event
window.addEventListener('pluginMessage', function(e) {
  dbg('pluginMessage EVENT fired');
  _onPluginMsg(e.detail || e.data || e);
});
// 3. Probe the bridge object for clues
try {
  var pmhKeys = [];
  for (var k in PluginMessageHandler) { pmhKeys.push(k); }
  dbg('PMH keys: ' + (pmhKeys.length ? pmhKeys.join(',') : 'none'));
  dbg('PMH type: ' + typeof PluginMessageHandler);
  dbg('PMH proto: ' + Object.getPrototypeOf(PluginMessageHandler));
} catch(e) { dbg('PMH probe: ' + e.message); }
// 4. Monitor if onPluginMessage gets overwritten
var _origDesc = Object.getOwnPropertyDescriptor(window, 'onPluginMessage');
dbg('onPluginMessage defined: ' + (typeof window.onPluginMessage) + ', configurable: ' + (_origDesc ? _origDesc.configurable : 'N/A'));

function cleanJSONText(raw) {
  return String(raw || '')
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
}

function tryParseJSON(raw) {
  if (typeof raw !== 'string') return null;
  const cleaned = cleanJSONText(raw);
  if (!cleaned) return null;

  try {
    return JSON.parse(cleaned);
  } catch (e) {
    // Fall through to extract-first-object parsing
  }

  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch (e) {
      return null;
    }
  }
  return null;
}

function isResultPayload(value) {
  return !!value && typeof value === 'object' && (
    typeof value.name === 'string' ||
    typeof value.category === 'string' ||
    typeof value.description === 'string' ||
    typeof value.fun_fact === 'string' ||
    typeof value.reason === 'string' ||
    typeof value.result === 'string'
  );
}

function extractPlainText(value, depth) {
  if (depth > 5 || value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value !== 'object') return '';

  const keys = ['data', 'message', 'response', 'output', 'content', 'text'];
  for (const key of keys) {
    if (typeof value[key] === 'string' && value[key].trim()) return value[key].trim();
  }
  for (const key of keys) {
    if (value[key] && typeof value[key] === 'object') {
      const nested = extractPlainText(value[key], depth + 1);
      if (nested) return nested;
    }
  }
  return '';
}

function extractResultPayload(value, depth) {
  if (depth > 5 || value == null) return null;

  if (typeof value === 'string') {
    const parsedString = tryParseJSON(value);
    return parsedString ? extractResultPayload(parsedString, depth + 1) : null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = extractResultPayload(item, depth + 1);
      if (nested) return nested;
    }
    return null;
  }

  if (typeof value !== 'object') return null;
  if (isResultPayload(value)) return value;

  const wrapperKeys = ['data', 'message', 'response', 'payload', 'result', 'output', 'content', 'text'];
  for (const key of wrapperKeys) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      const nested = extractResultPayload(value[key], depth + 1);
      if (nested) return nested;
    }
  }

  return null;
}

function handleLLMResponse(data) {
  // Only process responses while actively waiting on the LLM.
  if (state !== STATES.ANALYZING && state !== STATES.HD_ANALYZING) {
    dbg('ignoring plugin message while state=' + state);
    return;
  }

  let parsed = extractResultPayload(data, 0);
  if (!parsed && state === STATES.HD_ANALYZING) {
    const fallbackText = extractPlainText(data, 0);
    const upper = fallbackText.toUpperCase();
    if (upper.includes('HOT DOG')) {
      parsed = {
        result: upper.includes('NOT HOT DOG') ? 'NOT HOT DOG' : 'HOT DOG',
        reason: fallbackText.length <= 200 ? fallbackText : 'Unable to classify.',
      };
    }
  }

  if (!parsed) {
    dbg('ignored plugin message (no parseable result payload)');
    return;
  }

  clearTimeout(llmTimer);
  llmTimer = null;

  dbg('parsed response keys=' + Object.keys(parsed).join(','));
  if (state === STATES.HD_ANALYZING || typeof parsed.result === 'string') showHotdogResult(parsed);
  else showResult(parsed);
}

// ═══════════════════════════════════════════
// CAPTURE FLOW
// ═══════════════════════════════════════════

function doCapture() {
  const isHotdog = state === STATES.HD_CAMERA;
  const nextState = isHotdog ? STATES.HD_ANALYZING : STATES.ANALYZING;
  setState(nextState);

  const imageBase64 = captureFrame();
  if (!imageBase64) {
    showError('Camera not ready — try again');
    setState(isHotdog ? STATES.HD_CAMERA : STATES.CAMERA);
    return;
  }

  sendToLLM(imageBase64, isHotdog ? PROMPT_HOTDOG : PROMPT_STANDARD);
}

// ═══════════════════════════════════════════
// DISPLAY RESULTS
// ═══════════════════════════════════════════

function showResult(parsed) {
  const name     = parsed.name        || 'Unknown';
  const category = parsed.category    || '';
  const desc     = parsed.description || '';
  const fact     = parsed.fun_fact    || '';

  $('result-category').textContent   = category;
  $('result-name').textContent       = name;
  $('result-description').textContent = desc;
  $('result-fact').textContent       = fact;

  // Hide category pill if empty
  $('result-category').style.display = category ? 'inline-block' : 'none';

  resultPage = 1;
  showResultPage(1);
  setState(STATES.RESULT);
}

function showHotdogResult(parsed) {
  const isHotDog = (parsed.result || '').toUpperCase().includes('HOT DOG') &&
                   !(parsed.result || '').toUpperCase().includes('NOT HOT DOG');

  $('hd-icon').textContent   = isHotDog ? '🌭' : '🚫';
  $('hd-verdict').textContent = isHotDog ? 'HOT DOG' : 'NOT HOT DOG';
  $('hd-reason').textContent  = parsed.reason || '';

  // Border color via R1 API
  if (typeof updateAppBorderColor !== 'undefined') {
    updateAppBorderColor(isHotDog ? '#22c55e' : '#ef4444');
  }

  setState(STATES.HD_RESULT);
}

function showResultPage(page) {
  resultPage = page;
  $('result-desc-page').classList.toggle('active-page', page === 1);
  $('result-fact-page').classList.toggle('active-page', page === 2);
}

// ═══════════════════════════════════════════
// STATE MACHINE
// ═══════════════════════════════════════════

function setState(newState) {
  state = newState;

  if (newState !== STATES.ANALYZING && newState !== STATES.HD_ANALYZING) {
    clearTimeout(llmTimer);
    llmTimer = null;
  }

  // Deactivate all screens
  Object.values(screens).forEach(s => s.classList.remove('active'));
  hdOverlay.classList.add('hidden');

  // Reset border color when leaving hot dog result
  if (newState !== STATES.HD_RESULT) {
    if (typeof updateAppBorderColor !== 'undefined') {
      updateAppBorderColor('#000000');
    }
  }

  switch (newState) {
    case STATES.CAMERA:
      screens.camera.classList.add('active');
      break;

    case STATES.ANALYZING:
      screens.analyzing.classList.add('active');
      break;

    case STATES.RESULT:
      screens.result.classList.add('active');
      break;

    case STATES.SETTINGS:
      screens.settings.classList.add('active');
      break;

    case STATES.HD_CAMERA:
      // Video shows through; just overlay the HD UI
      hdOverlay.classList.remove('hidden');
      break;

    case STATES.HD_ANALYZING:
      screens.hdAnalyzing.classList.add('active');
      break;

    case STATES.HD_RESULT:
      screens.hdResult.classList.add('active');
      break;
  }
}

// ═══════════════════════════════════════════
// HARDWARE EVENTS (R1 Scroll + PTT)
// ═══════════════════════════════════════════

function bindHardwareEvents() {
  // Scroll wheel
  window.addEventListener('scrollUp',   onScrollUp);
  window.addEventListener('scrollDown', onScrollDown);

  // PTT side button
  window.addEventListener('sideClick',     onSideClick);
  window.addEventListener('longPressEnd',  onLongPress);
}

function onSideClick() {
  switch (state) {
    case STATES.CAMERA:
    case STATES.HD_CAMERA:
      doCapture();
      break;

    case STATES.RESULT:
      // Short press on result → back to camera
      returnToCamera();
      break;

    case STATES.HD_RESULT:
      // Short press on hot dog result → back to hd camera
      setState(STATES.HD_CAMERA);
      break;

    case STATES.SETTINGS:
      // Short press closes settings
      closeSettings();
      break;
  }
}

function onLongPress() {
  switch (state) {
    case STATES.RESULT:
    case STATES.HD_RESULT:
      returnToCamera();
      break;

    case STATES.SETTINGS:
      closeSettings();
      break;
  }
}

function onScrollUp() {
  switch (state) {
    case STATES.RESULT:
      if (resultPage === 2) showResultPage(1);
      break;
  }
}

function onScrollDown() {
  switch (state) {
    case STATES.RESULT:
      if (resultPage === 1) {
        showResultPage(2);
      } else if (resultPage === 2) {
        returnToCamera();
      }
      break;
  }
}

function returnToCamera() {
  setState(settings.hotdog ? STATES.HD_CAMERA : STATES.CAMERA);
}

// ═══════════════════════════════════════════
// UI EVENTS
// ═══════════════════════════════════════════

/**
 * Bind a tap handler that fires on touchend (instant, no 300ms delay)
 * with click as a fallback for desktop/dev mode.
 * preventDefault() on touchend stops the browser synthesising a
 * duplicate click event afterwards.
 */
function on(id, handler) {
  const el = $(id);
  if (!el) return;
  el.addEventListener('touchend', (e) => {
    e.preventDefault();   // suppress the follow-up synthesised click
    handler(e);
  }, { passive: false });
  el.addEventListener('click', handler);  // desktop / dev fallback
}

function bindUIEvents() {
  // Settings open
  on('btn-settings',    () => setState(STATES.SETTINGS));
  on('btn-hd-settings', () => setState(STATES.SETTINGS));

  // Settings close
  on('btn-close-settings', closeSettings);

  // Back buttons on result screens
  on('btn-back-desc', returnToCamera);
  on('btn-back-fact', returnToCamera);

  // Voice toggle
  on('toggle-voice', () => {
    settings.voice = !settings.voice;
    updateToggleUI('toggle-voice', settings.voice);
    saveSettings();
  });

  // Hot Dog mode toggle
  on('toggle-hotdog', () => {
    settings.hotdog = !settings.hotdog;
    updateToggleUI('toggle-hotdog', settings.hotdog);
    saveSettings();
    // Mode change takes effect when returning to camera from settings
  });

  // Easter egg — 3 taps on credit (3 Comma Club)
  on('credit', () => {
    creditClicks++;
    if (creditClicks >= 3) {
      creditClicks = 0;
      $('hotdog-row').hidden = false;
      // Brief amber flash as acknowledgment
      $('credit').style.color = '#f59e0b';
      setTimeout(() => { $('credit').style.color = ''; }, 600);
    }
  });
}

function closeSettings() {
  // Return to whichever camera mode is active
  setState(settings.hotdog ? STATES.HD_CAMERA : STATES.CAMERA);
}

function updateToggleUI(id, isOn) {
  const btn = $(id);
  btn.textContent     = isOn ? 'ON' : 'OFF';
  btn.dataset.on      = isOn ? 'true' : 'false';
}

// ═══════════════════════════════════════════
// STORAGE
// ═══════════════════════════════════════════

const STORAGE_KEY = 'sleuth_v1_settings';

async function loadSettings() {
  try {
    if (window.creationStorage && window.creationStorage.plain) {
      const raw = await window.creationStorage.plain.getItem(STORAGE_KEY);
      if (raw) {
        const saved = JSON.parse(atob(raw));
        settings.voice  = !!saved.voice;
        settings.hotdog = !!saved.hotdog;
      }
    }
  } catch (e) {
    // Storage unavailable or corrupt — use defaults
  }

  // Apply loaded settings to UI
  updateToggleUI('toggle-voice',  settings.voice);
  updateToggleUI('toggle-hotdog', settings.hotdog);

  // If hotdog was previously unlocked, show the row
  if (settings.hotdog) {
    $('hotdog-row').hidden = false;
  }
}

async function saveSettings() {
  try {
    if (window.creationStorage && window.creationStorage.plain) {
      const payload = btoa(JSON.stringify({
        voice:  settings.voice,
        hotdog: settings.hotdog,
      }));
      await window.creationStorage.plain.setItem(STORAGE_KEY, payload);
    }
  } catch (e) {
    // Fail silently
  }
}

// ═══════════════════════════════════════════
// ERROR TOAST
// ═══════════════════════════════════════════

function addErrorToast() {
  const toast = document.createElement('div');
  toast.id = 'error-toast';
  document.getElementById('app').appendChild(toast);
}

function showError(msg) {
  const toast = $('error-toast');
  if (!toast) return;
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(errorTimer);
  errorTimer = setTimeout(() => toast.classList.remove('show'), 3000);
}
