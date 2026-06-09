'use strict';

/* ============================================================
   AVATAR COLOURS
   ============================================================ */
const AVATAR_COLORS = [
  '#6366f1', '#8b5cf6', '#ec4899', '#ef4444',
  '#f59e0b', '#10b981', '#3b82f6', '#14b8a6'
];

function avatarColor(name) {
  if (!name || name.length === 0) return AVATAR_COLORS[0];
  return AVATAR_COLORS[name.toUpperCase().charCodeAt(0) % AVATAR_COLORS.length];
}

/* ============================================================
   SHARED STATE
   ============================================================ */
let mediaStream          = null;
let recognitionTimer     = null;
let processing           = false;
let lastAttendanceRefresh = 0;

/* ============================================================
   CLOCK
   ============================================================ */
function startClock() {
  function tick() {
    var now = new Date();

    // Date string: e.g. "Tuesday, June 10 2026"
    var dateStr = now.toLocaleDateString('en-US', {
      weekday: 'long',
      month:   'long',
      day:     'numeric',
      year:    'numeric'
    });

    // Time string: HH:MM:SS
    var hh = String(now.getHours()).padStart(2, '0');
    var mm = String(now.getMinutes()).padStart(2, '0');
    var ss = String(now.getSeconds()).padStart(2, '0');
    var timeStr = hh + ':' + mm + ':' + ss;

    var dateEl = document.getElementById('currentDate');
    var timeEl = document.getElementById('currentTime');
    if (dateEl) dateEl.textContent = dateStr;
    if (timeEl) timeEl.textContent = timeStr;
  }

  tick(); // run immediately so there is no 1-second blank on load
  setInterval(tick, 1000);
}

/* ============================================================
   CAMERA HELPERS
   ============================================================ */
async function openCamera(videoEl) {
  try {
    var stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width:      { ideal: 640 },
        height:     { ideal: 480 },
        facingMode: 'user'
      },
      audio: false
    });

    mediaStream = stream;
    videoEl.srcObject = stream;

    await new Promise(function (resolve, reject) {
      videoEl.onloadedmetadata = resolve;
      videoEl.onerror          = reject;
    });

    videoEl.style.display = 'block';
    return true;
  } catch (err) {
    console.error('openCamera error:', err);
    return false;
  }
}

function closeCamera() {
  if (mediaStream) {
    mediaStream.getTracks().forEach(function (track) { track.stop(); });
    mediaStream = null;
  }
}

/* ============================================================
   FRAME CAPTURE
   ============================================================ */
function captureFrame(videoEl, quality) {
  if (quality === undefined) quality = 0.82;
  var w = videoEl.videoWidth  || 640;
  var h = videoEl.videoHeight || 480;
  var canvas = document.createElement('canvas');
  canvas.width  = w;
  canvas.height = h;
  var ctx = canvas.getContext('2d');
  // Mirror horizontally to undo the CSS scaleX(-1)
  ctx.translate(w, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(videoEl, 0, 0, w, h);
  return canvas.toDataURL('image/jpeg', quality);
}

/* ============================================================
   FACE BOX DRAWING
   ============================================================ */
function drawCornerBox(ctx, x, y, w, h, color) {
  var len = 22;
  ctx.strokeStyle = color;
  ctx.lineWidth   = 3;
  ctx.lineCap     = 'round';
  ctx.beginPath();
  // Top-left
  ctx.moveTo(x, y + len);          ctx.lineTo(x, y);          ctx.lineTo(x + len, y);
  // Top-right
  ctx.moveTo(x + w - len, y);      ctx.lineTo(x + w, y);      ctx.lineTo(x + w, y + len);
  // Bottom-right
  ctx.moveTo(x + w, y + h - len);  ctx.lineTo(x + w, y + h);  ctx.lineTo(x + w - len, y + h);
  // Bottom-left
  ctx.moveTo(x + len, y + h);      ctx.lineTo(x, y + h);      ctx.lineTo(x, y + h - len);
  ctx.stroke();
}

function roundRect(ctx, x, y, w, h, r) {
  if (w < 2 * r) r = w / 2;
  if (h < 2 * r) r = h / 2;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y,     x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x,     y + h, r);
  ctx.arcTo(x,     y + h, x,     y,     r);
  ctx.arcTo(x,     y,     x + w, y,     r);
  ctx.closePath();
}

function drawFaces(canvas, video, faces) {
  var dw = video.offsetWidth;
  var dh = video.offsetHeight;
  canvas.width  = dw;
  canvas.height = dh;
  var ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, dw, dh);

  if (!faces || faces.length === 0) return;

  faces.forEach(function (face) {
    var loc    = face.location || {};
    var left   = loc.left   || 0;
    var top    = loc.top    || 0;
    var right  = loc.right  || 0;
    var bottom = loc.bottom || 0;

    // Convert normalised coords → pixel coords (mirrored on x because video is mirrored)
    var x = (1 - right)  * dw;
    var y = top           * dh;
    var w = (right - left) * dw;
    var h = (bottom - top) * dh;

    // Pick colour based on action
    var color;
    if (face.action === 'check_in') {
      color = '#22c55e';       // green
    } else if (face.action === 'check_out') {
      color = '#f59e0b';       // orange
    } else if (face.name && face.name !== 'Unknown') {
      color = '#6366f1';       // indigo — already-marked known person
    } else {
      color = '#ef4444';       // red — unknown
    }

    var isKnown = (face.name && face.name !== 'Unknown');

    // Glow effect for known faces
    if (isKnown) {
      ctx.shadowColor = color;
      ctx.shadowBlur  = 14;
    }

    drawCornerBox(ctx, x, y, w, h, color);
    ctx.shadowBlur = 0;

    // Label pill
    var actionTag = '';
    if (face.action === 'check_in')  actionTag = '  ● IN';
    if (face.action === 'check_out') actionTag = '  ● OUT';

    var conf       = face.confidence ? Math.round(face.confidence) : '';
    var confStr    = conf ? ('  ' + conf + '%') : '';
    var labelText  = (face.name || 'Unknown') + actionTag + confStr;

    ctx.font = '600 13px Inter, system-ui, sans-serif';
    var textW   = ctx.measureText(labelText).width;
    var padX    = 10;
    var padY    = 5;
    var pillW   = textW + padX * 2;
    var pillH   = 24;
    var pillX   = x;
    var pillY   = y - pillH - 6;
    if (pillY < 2) pillY = y + h + 6; // flip below box if too close to top

    // Draw pill background
    ctx.fillStyle = color;
    roundRect(ctx, pillX, pillY, pillW, pillH, 6);
    ctx.fill();

    // Draw pill text
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'middle';
    ctx.fillText(labelText, pillX + padX, pillY + pillH / 2);
  });
}

/* ============================================================
   TOAST NOTIFICATIONS
   ============================================================ */
function showToast(title, sub, type) {
  if (sub   === undefined) sub   = '';
  if (type  === undefined) type  = 'success';

  var container = document.getElementById('toastContainer');
  if (!container) return;

  var toast = document.createElement('div');
  toast.className = 'toast-item' + (type === 'warn' ? ' warn' : type === 'err' ? ' err' : '');

  var iconClass;
  if (type === 'warn')    iconClass = 'bi-clock';
  else if (type === 'err') iconClass = 'bi-exclamation-circle';
  else                    iconClass = 'bi-check-circle-fill';

  var subHtml = sub ? '<div class="toast-sub">' + sub + '</div>' : '';

  toast.innerHTML =
    '<div class="toast-icon"><i class="bi ' + iconClass + '"></i></div>' +
    '<div class="toast-text">' +
      '<div class="toast-title">' + title + '</div>' +
      subHtml +
    '</div>';

  container.appendChild(toast);

  // Auto-remove after 4 s with fade
  setTimeout(function () {
    toast.style.opacity = '0';
    setTimeout(function () {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 300);
  }, 4000);
}

/* ============================================================
   STATUS BAR
   ============================================================ */
function setStatus(msg) {
  var el = document.getElementById('statusBar');
  if (el) el.textContent = msg;
}

/* ============================================================
   RECOGNITION — START / STOP
   ============================================================ */
async function startRecognition() {
  var video       = document.getElementById('video');
  var overlay     = document.getElementById('overlay');
  var placeholder = document.getElementById('camPlaceholder');
  var liveDot     = document.getElementById('liveDot');
  var startBtn    = document.getElementById('startBtn');
  var stopBtn     = document.getElementById('stopBtn');
  var badge       = document.getElementById('faceCountBadge');

  if (!video) return;

  setStatus('Opening camera…');
  var ok = await openCamera(video);

  if (!ok) {
    setStatus('Camera access denied');
    showToast('Camera Error', 'Could not access camera.', 'err');
    return;
  }

  // Update UI
  if (placeholder) placeholder.style.display = 'none';
  if (liveDot)     liveDot.classList.add('active');
  if (startBtn)    startBtn.classList.add('d-none');
  if (stopBtn)     stopBtn.classList.remove('d-none');
  setStatus('Scanning for faces…');

  // Recognition loop — poll every 900 ms
  recognitionTimer = setInterval(async function () {
    if (processing || !video.videoWidth) return;
    processing = true;

    try {
      var frame = captureFrame(video);

      var response = await fetch('/api/recognize', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ image: frame })
      });

      var data = await response.json();
      var faces  = data.faces  || [];
      var events = data.events || [];

      // Draw face boxes on overlay
      if (overlay) drawFaces(overlay, video, faces);

      // Update face count badge
      if (badge) {
        if (faces.length > 0) {
          badge.style.display = 'inline-flex';
          var numEl = document.getElementById('faceCountNum');
          if (numEl) numEl.textContent = faces.length;
        } else {
          badge.style.display = 'none';
        }
      }

      // Handle events (check-in / check-out)
      events.forEach(function (ev) {
        if (ev.action === 'check_in') {
          showToast(
            'Checked In',
            (ev.name || 'Unknown') + ' at ' + (ev.time || ''),
            'success'
          );
        } else if (ev.action === 'check_out') {
          showToast(
            'Checked Out',
            (ev.name || 'Unknown') + ' at ' + (ev.time || ''),
            'warn'
          );
        }
      });

      // Refresh attendance list when events fire or every 5 s
      if (events.length > 0 || Date.now() - lastAttendanceRefresh > 5000) {
        loadTodayAttendance();
        lastAttendanceRefresh = Date.now();
      }

      // Update status text
      if (faces.length === 0) {
        setStatus('No faces detected');
      } else {
        var known = faces.filter(function (f) {
          return f.name && f.name !== 'Unknown';
        }).length;
        setStatus(faces.length + ' face' + (faces.length !== 1 ? 's' : '') + ' detected' +
          (known > 0 ? ' — ' + known + ' recognised' : ''));
      }

    } catch (err) {
      console.error('Recognition error:', err);
    } finally {
      processing = false;
    }
  }, 900);
}

function stopRecognition() {
  if (recognitionTimer) {
    clearInterval(recognitionTimer);
    recognitionTimer = null;
  }
  closeCamera();
  processing = false;

  // Reset UI
  var video       = document.getElementById('video');
  var overlay     = document.getElementById('overlay');
  var placeholder = document.getElementById('camPlaceholder');
  var liveDot     = document.getElementById('liveDot');
  var startBtn    = document.getElementById('startBtn');
  var stopBtn     = document.getElementById('stopBtn');
  var badge       = document.getElementById('faceCountBadge');

  if (video)       video.style.display = 'none';
  if (overlay)     {
    var ctx = overlay.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, overlay.width, overlay.height);
  }
  if (placeholder) placeholder.style.display = '';
  if (liveDot)     liveDot.classList.remove('active');
  if (startBtn)    startBtn.classList.remove('d-none');
  if (stopBtn)     stopBtn.classList.add('d-none');
  if (badge)       badge.style.display = 'none';
  setStatus('Camera inactive');
}

/* ============================================================
   TODAY'S ATTENDANCE (Dashboard feed)
   ============================================================ */
async function loadTodayAttendance() {
  var listEl  = document.getElementById('attendanceList');
  var countEl = document.getElementById('attendanceCount');
  if (!listEl) return;

  try {
    var response = await fetch('/api/attendance?date=' + localDateStr());
    var data     = await response.json();
    var records  = Array.isArray(data) ? data : (data.records || []);

    if (countEl) countEl.textContent = records.length;

    if (records.length === 0) {
      listEl.innerHTML =
        '<div class="empty-state">' +
          '<i class="bi bi-calendar-x"></i>' +
          '<p>No attendance yet</p>' +
          '<small>Records will appear as faces are recognized</small>' +
        '</div>';
      return;
    }

    listEl.innerHTML = records.map(function (rec) {
      var initial = (rec.name || '?').charAt(0).toUpperCase();
      var color   = avatarColor(rec.name || '');

      var checkInBadge =
        '<span class="badge-in">' + (rec.check_in || '—') + '</span>';

      var checkOutBadge;
      if (rec.check_out && rec.check_out !== '—') {
        checkOutBadge = '<span class="badge-out">' + rec.check_out + '</span>';
      } else {
        checkOutBadge = '<span class="badge-office">In Office</span>';
      }

      var duration = (rec.duration && rec.duration !== '—')
        ? '<span style="color:var(--text-secondary);font-size:11px;">' + rec.duration + '</span>'
        : '';

      return (
        '<div class="att-entry">' +
          '<div class="att-avatar" style="background:' + color + ';">' + initial + '</div>' +
          '<div class="att-info">' +
            '<div class="att-name">' + (rec.name || 'Unknown') + '</div>' +
            '<div class="att-meta">' +
              checkInBadge +
              checkOutBadge +
              duration +
            '</div>' +
          '</div>' +
        '</div>'
      );
    }).join('');

  } catch (err) {
    console.error('loadTodayAttendance error:', err);
  }
}

/* ============================================================
   STATS (Dashboard)
   ============================================================ */
async function loadStats() {
  try {
    var response = await fetch('/api/stats');
    var data     = await response.json();

    var totalEl   = document.getElementById('statTotal');
    var presentEl = document.getElementById('statPresent');
    var absentEl  = document.getElementById('statAbsent');
    var rateEl    = document.getElementById('statRate');

    if (totalEl)   totalEl.textContent   = data.total   !== undefined ? data.total   : '—';
    if (presentEl) presentEl.textContent = data.present !== undefined ? data.present : '—';
    if (absentEl)  absentEl.textContent  = data.absent  !== undefined ? data.absent  : '—';
    if (rateEl) {
      if (data.rate !== undefined && data.rate !== null) {
        rateEl.textContent = Math.round(data.rate) + '%';
      } else if (data.total && data.total > 0 && data.present !== undefined) {
        rateEl.textContent = Math.round((data.present / data.total) * 100) + '%';
      } else {
        rateEl.textContent = '—';
      }
    }
  } catch (err) {
    console.error('loadStats error:', err);
  }
}

/* ============================================================
   REGISTER PAGE — init
   ============================================================ */
async function initRegisterPage() {
  var video       = document.getElementById('video');
  var placeholder = document.getElementById('camPlaceholder');
  if (!video) return;

  var ok = await openCamera(video);

  if (ok) {
    if (placeholder) placeholder.style.display = 'none';
  } else {
    if (placeholder) {
      placeholder.innerHTML =
        '<i class="bi bi-camera-video-off" style="font-size:40px;color:#ef4444;margin-bottom:8px;"></i>' +
        '<p style="color:#ef4444;font-weight:600;">Camera unavailable</p>' +
        '<small style="color:var(--text-secondary);">Check browser permissions</small>';
    }
    showToast('Camera Error', 'Could not access camera. Check permissions.', 'err');
  }
}

/* ============================================================
   REGISTER — Capture & Submit
   ============================================================ */
async function startCapture() {
  var nameInput      = document.getElementById('nameInput');
  var captureBtn     = document.getElementById('captureBtn');
  var captureProgress = document.getElementById('captureProgress');
  var progressBar    = document.getElementById('progressBar');
  var captureCounter = document.getElementById('captureCounter');
  var video          = document.getElementById('video');

  if (!nameInput) return;

  var name = nameInput.value.trim();
  if (!name) {
    showRegMessage(
      '<i class="bi bi-exclamation-circle"></i> Please enter a full name before capturing.',
      'err'
    );
    nameInput.focus();
    return;
  }

  if (!mediaStream || !video || !video.videoWidth) {
    showRegMessage(
      '<i class="bi bi-camera-video-off"></i> Camera is not active. Please wait for camera to start.',
      'err'
    );
    return;
  }

  // Disable button and show progress
  if (captureBtn)      captureBtn.disabled = true;
  if (captureProgress) captureProgress.style.display = 'block';

  var total  = 5;
  var images = [];

  try {
    for (var i = 0; i < total; i++) {
      await delay(600);
      var frame = captureFrame(video);
      images.push(frame);

      var pct = Math.round(((i + 1) / total) * 100);
      if (progressBar)    progressBar.style.width   = pct + '%';
      if (captureCounter) captureCounter.textContent = (i + 1) + ' / ' + total;
    }

    // Submit to backend
    var response = await fetch('/api/register', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ name: name, images: images })
    });

    var data = await response.json();

    if (response.ok && (data.success || data.message)) {
      showRegMessage(
        '<i class="bi bi-check-circle-fill"></i> ' +
        (data.message || name + ' registered successfully!'),
        'success'
      );
      showToast('Registration Successful', name + ' has been registered.', 'success');
      nameInput.value = '';
      loadPersons();
    } else {
      showRegMessage(
        '<i class="bi bi-x-circle-fill"></i> ' +
        (data.error || data.message || 'Registration failed. Please try again.'),
        'err'
      );
      showToast('Registration Failed', data.error || 'Unknown error.', 'err');
    }

  } catch (err) {
    console.error('startCapture error:', err);
    showRegMessage(
      '<i class="bi bi-wifi-off"></i> Network error. Please try again.',
      'err'
    );
    showToast('Network Error', 'Could not reach server.', 'err');
  } finally {
    if (captureBtn)      captureBtn.disabled = false;
    if (captureProgress) captureProgress.style.display = 'none';
    if (progressBar)     progressBar.style.width = '0%';
    if (captureCounter)  captureCounter.textContent = '0 / 5';
  }
}

/* ============================================================
   REGISTRATION MESSAGE
   ============================================================ */
function showRegMessage(html, type) {
  var el = document.getElementById('regMessage');
  if (!el) return;

  var bgColor, borderColor, textColor;
  if (type === 'success') {
    bgColor = '#f0fdf4'; borderColor = '#bbf7d0'; textColor = '#15803d';
  } else if (type === 'err') {
    bgColor = '#fef2f2'; borderColor = '#fecaca'; textColor = '#b91c1c';
  } else {
    bgColor = '#fffbeb'; borderColor = '#fed7aa'; textColor = '#b45309';
  }

  el.innerHTML =
    '<div style="background:' + bgColor + ';border:1px solid ' + borderColor + ';' +
    'color:' + textColor + ';border-radius:8px;padding:10px 14px;font-size:13px;' +
    'font-weight:500;display:flex;align-items:center;gap:8px;">' +
    html + '</div>';

  // Auto-clear after 5 s
  setTimeout(function () {
    if (el.innerHTML) el.innerHTML = '';
  }, 5000);
}

/* ============================================================
   LOAD PERSONS
   ============================================================ */
async function loadPersons() {
  var listEl = document.getElementById('personsList');
  if (!listEl) return;

  try {
    var response = await fetch('/api/persons');
    var data     = await response.json();
    var persons  = Array.isArray(data) ? data : (data.persons || []);

    if (persons.length === 0) {
      listEl.innerHTML =
        '<div class="empty-state">' +
          '<i class="bi bi-person-x"></i>' +
          '<p>No persons registered yet</p>' +
          '<small>Register someone using the form on the left</small>' +
        '</div>';
      return;
    }

    listEl.innerHTML = persons.map(function (p) {
      var initial   = (p.name || '?').charAt(0).toUpperCase();
      var color     = avatarColor(p.name || '');
      var dateLabel = p.created_at
        ? 'Registered: ' + p.created_at.split('T')[0]
        : 'Registered: unknown';

      return (
        '<div class="person-card">' +
          '<div class="att-avatar" style="background:' + color + ';width:40px;height:40px;font-size:16px;">' +
            initial +
          '</div>' +
          '<div class="person-info">' +
            '<div class="person-name">' + (p.name || 'Unknown') + '</div>' +
            '<div class="person-sub">' + dateLabel + '</div>' +
          '</div>' +
          '<button class="btn-danger-sm" onclick="deletePerson(' + p.id + ', \'' +
            (p.name || '').replace(/'/g, "\\'") + '\')">' +
            '<i class="bi bi-trash"></i>' +
          '</button>' +
        '</div>'
      );
    }).join('');

  } catch (err) {
    console.error('loadPersons error:', err);
    listEl.innerHTML =
      '<div class="empty-state">' +
        '<i class="bi bi-wifi-off"></i>' +
        '<p>Failed to load persons</p>' +
      '</div>';
  }
}

/* ============================================================
   DELETE PERSON
   ============================================================ */
async function deletePerson(id, name) {
  if (!confirm('Delete "' + name + '"? This action cannot be undone.')) return;

  try {
    var response = await fetch('/api/persons/' + id, { method: 'DELETE' });
    var data     = await response.json();

    if (response.ok) {
      showToast('Deleted', name + ' has been removed.', 'warn');
      loadPersons();
    } else {
      showToast('Error', data.error || 'Could not delete.', 'err');
    }
  } catch (err) {
    console.error('deletePerson error:', err);
    showToast('Network Error', 'Could not reach server.', 'err');
  }
}

/* ============================================================
   ATTENDANCE RECORDS PAGE
   ============================================================ */
async function loadAttendance() {
  var tbody       = document.getElementById('attendanceTableBody');
  var totalCountEl = document.getElementById('totalCount');
  var checkedOutEl = document.getElementById('checkedOutCount');
  var dateFilter  = document.getElementById('dateFilter');

  if (!tbody) return;

  var dateVal = dateFilter ? dateFilter.value : localDateStr();

  tbody.innerHTML =
    '<tr><td colspan="6" style="text-align:center;padding:32px 16px;color:var(--text-secondary);">' +
      '<i class="bi bi-hourglass-split" style="font-size:24px;display:block;margin-bottom:8px;color:#cbd5e1;"></i>' +
      'Loading…' +
    '</td></tr>';

  try {
    var response = await fetch('/api/attendance?date=' + encodeURIComponent(dateVal));
    var data     = await response.json();
    var records  = Array.isArray(data) ? data : (data.records || []);

    // Update counters
    if (totalCountEl) totalCountEl.textContent = records.length;

    var checkedOut = records.filter(function (r) {
      return r.check_out && r.check_out !== '—';
    }).length;
    if (checkedOutEl) checkedOutEl.textContent = checkedOut;

    // Update percentage if function exists in page scope
    if (typeof updatePct === 'function') updatePct();

    if (records.length === 0) {
      tbody.innerHTML =
        '<tr><td colspan="6">' +
          '<div class="empty-state">' +
            '<i class="bi bi-calendar-x"></i>' +
            '<p>No records for ' + dateVal + '</p>' +
            '<small>Try selecting a different date</small>' +
          '</div>' +
        '</td></tr>';
      return;
    }

    tbody.innerHTML = records.map(function (rec, idx) {
      var checkInBadge =
        '<span class="badge-in">' + (rec.check_in || '—') + '</span>';

      var checkOutBadge;
      if (rec.check_out && rec.check_out !== '—') {
        checkOutBadge = '<span class="badge-out">' + rec.check_out + '</span>';
      } else {
        checkOutBadge = '<span style="color:var(--text-secondary);">—</span>';
      }

      var durationCell;
      if (rec.duration && rec.duration !== '—') {
        durationCell = '<strong>' + rec.duration + '</strong>';
      } else {
        durationCell = '<span style="color:var(--text-secondary);">—</span>';
      }

      var statusBadge;
      if (rec.check_out && rec.check_out !== '—') {
        statusBadge = '<span class="badge-in">Complete</span>';
      } else {
        statusBadge = '<span class="badge-office">In Office</span>';
      }

      return (
        '<tr>' +
          '<td style="color:var(--text-secondary);font-weight:500;">' + (idx + 1) + '</td>' +
          '<td><strong>' + (rec.name || 'Unknown') + '</strong></td>' +
          '<td>' + checkInBadge + '</td>' +
          '<td>' + checkOutBadge + '</td>' +
          '<td>' + durationCell + '</td>' +
          '<td>' + statusBadge + '</td>' +
        '</tr>'
      );
    }).join('');

  } catch (err) {
    console.error('loadAttendance error:', err);
    tbody.innerHTML =
      '<tr><td colspan="6">' +
        '<div class="empty-state">' +
          '<i class="bi bi-wifi-off"></i>' +
          '<p>Failed to load records</p>' +
        '</div>' +
      '</td></tr>';
  }
}

/* ============================================================
   UTILITY FUNCTIONS
   ============================================================ */
function localDateStr() {
  var now = new Date();
  var y   = now.getFullYear();
  var m   = String(now.getMonth() + 1).padStart(2, '0');
  var d   = String(now.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + d;
}

function delay(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

/* ============================================================
   BOOT
   ============================================================ */
startClock();
