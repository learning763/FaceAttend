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
    } else if (face.action === 'already_in') {
      color = '#6366f1';       // indigo — already checked in, in office
    } else if (face.action === 'already_done') {
      color = '#64748b';       // slate — already done for today
    } else if (face.action === 'too_early') {
      color = '#eab308';       // yellow — before check-in window
    } else if (face.name && face.name !== 'Unknown') {
      color = '#6366f1';       // indigo — recognised (fallback)
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
    if (face.action === 'check_in')      actionTag = '  ● IN';
    else if (face.action === 'check_out')     actionTag = '  ● OUT';
    else if (face.action === 'already_in')    actionTag = '  ● In Office';
    else if (face.action === 'already_done')  actionTag = '  ● Done';
    else if (face.action === 'too_early')     actionTag = '  ● Too Early';

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

    if (totalEl)   totalEl.textContent   = data.total_registered !== undefined ? data.total_registered : '—';
    if (presentEl) presentEl.textContent = data.present_today   !== undefined ? data.present_today   : '—';
    if (absentEl)  absentEl.textContent  = data.absent_today    !== undefined ? data.absent_today    : '—';
    if (rateEl) {
      if (data.attendance_rate !== undefined && data.attendance_rate !== null) {
        rateEl.textContent = Math.round(data.attendance_rate) + '%';
      } else if (data.total_registered > 0 && data.present_today !== undefined) {
        rateEl.textContent = Math.round((data.present_today / data.total_registered) * 100) + '%';
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

  var name       = nameInput.value.trim();
  var deptSelect = document.getElementById('deptSelect');
  var department = deptSelect ? deptSelect.value : '';

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
      body:    JSON.stringify({ name: name, images: images, department: department })
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
      if (deptSelect) deptSelect.value = '';
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

      var safeName = (p.name || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      return (
        '<div class="person-card">' +
          '<div class="att-avatar" style="background:' + color + ';width:40px;height:40px;font-size:16px;">' +
            initial +
          '</div>' +
          '<div class="person-info">' +
            '<div class="person-name">' + (p.name || 'Unknown') + '</div>' +
            '<div class="person-sub">' + dateLabel + '</div>' +
          '</div>' +
          '<div style="display:flex;gap:6px;">' +
            '<button class="btn-outline" style="padding:5px 10px;font-size:12px;" ' +
              'onclick="openEditModal(' + p.id + ', \'' + safeName + '\')" title="Edit name">' +
              '<i class="bi bi-pencil"></i>' +
            '</button>' +
            '<button class="btn-danger-sm" onclick="deletePerson(' + p.id + ', \'' + safeName + '\')" title="Delete">' +
              '<i class="bi bi-trash"></i>' +
            '</button>' +
          '</div>' +
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

      var coVal  = (rec.check_out && rec.check_out !== '—') ? rec.check_out : '';
      var rid    = rec.id || '';
      var dStr   = dateVal;

      return (
        '<tr>' +
          '<td style="color:var(--text-secondary);font-weight:500;">' + (idx + 1) + '</td>' +
          '<td><strong>' + (rec.name || 'Unknown') + '</strong></td>' +
          '<td>' + checkInBadge + '</td>' +
          '<td>' + checkOutBadge + '</td>' +
          '<td>' + durationCell + '</td>' +
          '<td>' + statusBadge + '</td>' +
          '<td style="text-align:right;">' +
            '<div style="display:inline-flex;gap:4px;">' +
              '<button class="btn-outline" style="padding:4px 8px;font-size:11px;" ' +
                'onclick="openEditAttendance(' + rid + ',\'' + dStr + '\',\'' + (rec.check_in||'') + '\',\'' + coVal + '\')" ' +
                'title="Edit">' +
                '<i class="bi bi-pencil"></i>' +
              '</button>' +
              '<button class="btn-danger-sm" style="padding:4px 8px;" ' +
                'onclick="deleteAttendanceRecord(' + rid + ')" title="Delete">' +
                '<i class="bi bi-trash"></i>' +
              '</button>' +
            '</div>' +
          '</td>' +
        '</tr>'
      );
    }).join('');

  } catch (err) {
    console.error('loadAttendance error:', err);
    tbody.innerHTML =
      '<tr><td colspan="7">' +
        '<div class="empty-state">' +
          '<i class="bi bi-wifi-off"></i>' +
          '<p>Failed to load records</p>' +
        '</div>' +
      '</td></tr>';
  }
}

/* ============================================================
   PERSON PROFILE (attendance history search)
   ============================================================ */
var _personTimeChart = null;
var _personDowChart  = null;

async function loadPersonProfile(name) {
  try {
    var resp = await fetch('/api/attendance/history?name=' + encodeURIComponent(name));
    var data = await resp.json();
    if (!data.found) { closePersonProfile(); return; }
    renderPersonProfile(data);
  } catch (e) {
    console.error('loadPersonProfile error:', e);
  }
}

function renderPersonProfile(data) {
  var panel = document.getElementById('personProfilePanel');
  if (!panel) return;
  panel.style.display = 'block';

  // Avatar — white background, colored letter
  var initial  = (data.person || '?').charAt(0).toUpperCase();
  var avatarEl = document.getElementById('profileAvatar');
  avatarEl.textContent      = initial;
  avatarEl.style.color      = avatarColor(data.person || '');
  avatarEl.style.background = '#fff';

  document.getElementById('profileName').textContent = data.person || '—';

  // KPI chips
  var s    = data.summary;
  var rate = s.total_present > 0 ? Math.round(s.on_time / s.total_present * 100) : 0;
  document.getElementById('phTotal').textContent    = s.total_present;
  document.getElementById('phOnTime').textContent   = s.on_time;
  document.getElementById('phLate').textContent     = s.late;
  document.getElementById('phRate').textContent     = rate + '%';
  document.getElementById('phRateBar').style.width  = rate + '%';
  document.getElementById('profileSubtitle').textContent =
    s.total_present + ' day' + (s.total_present !== 1 ? 's' : '') + ' recorded  ·  ' + rate + '% on-time';

  // Insight cards
  var ins = data.insights || {};

  // Usual Check-In
  var avgCI  = ins.avg_check_in_mins;
  document.getElementById('insAvgCI').textContent = avgCI != null ? minsToTime(avgCI) : '—';
  var range = ins.usual_range_ci;
  document.getElementById('insRangeCI').textContent =
    range ? 'Usually ' + minsToTime(range.from) + ' – ' + minsToTime(range.to) : 'Not enough data';

  // Usual Check-Out
  var avgCO  = ins.avg_check_out_mins;
  document.getElementById('insAvgCO').textContent = avgCO != null ? minsToTime(avgCO) : '—';
  var avgDur = ins.avg_duration_mins;
  document.getElementById('insAvgDur').textContent =
    avgDur != null
      ? 'Avg stay: ' + Math.floor(avgDur / 60) + 'h ' + (avgDur % 60) + 'm'
      : '';

  // Current streak
  var streak = ins.current_streak || 0;
  document.getElementById('insStreak').textContent    = streak + ' day' + (streak !== 1 ? 's' : '');
  document.getElementById('insStreakSub').textContent =
    streak >= 5 ? '🔥 On a roll!' : streak > 0 ? 'Keep it up!' : 'No current streak';

  // Deadline note
  var deadlineLabel = document.getElementById('phDeadlineNote');
  if (deadlineLabel) {
    deadlineLabel.textContent =
      '🟢 on time ≤ ' + minsToTime(data.on_time_deadline_mins) +
      '   🟡 late > '  + minsToTime(data.on_time_deadline_mins);
  }

  // Trend chart — last 30 days (oldest first)
  var chartRecords = data.records.slice(0, 30).reverse();
  renderPersonTimeChart(chartRecords, data.check_in_start_mins, data.on_time_deadline_mins);

  // Day-of-week pattern chart
  renderPersonDowChart(data.dow_pattern, data.check_in_start_mins, data.on_time_deadline_mins);

  // History table
  var tbody = document.getElementById('personHistoryBody');
  if (!tbody) return;

  if (data.records.length === 0) {
    tbody.innerHTML =
      '<tr><td colspan="6" style="text-align:center;padding:24px;color:var(--text-secondary);">' +
      '<i class="bi bi-calendar-x" style="font-size:20px;display:block;margin-bottom:6px;"></i>' +
      'No records found</td></tr>';
    return;
  }

  tbody.innerHTML = data.records.map(function (r) {
    var statusBadge;
    if (r.status === 'on_time') {
      statusBadge = '<span class="badge-in" style="background:#dcfce7;color:#15803d;">✓ On Time</span>';
    } else {
      statusBadge = '<span class="badge-in" style="background:#fef9c3;color:#92400e;">⚠ Late</span>';
    }
    var ciColor = r.status === 'on_time' ? '#15803d' : '#b45309';
    return '<tr>' +
      '<td style="font-weight:600;">'                   + r.date + '</td>' +
      '<td style="color:var(--text-secondary);">'       + r.day  + '</td>' +
      '<td><span style="color:' + ciColor + ';font-weight:600;">' + r.check_in + '</span></td>' +
      '<td>' + (r.check_out ? r.check_out : '<span style="color:var(--text-secondary);">—</span>') + '</td>' +
      '<td>' + (r.duration !== '—' ? '<strong>' + r.duration + '</strong>'
                                   : '<span style="color:var(--text-secondary);">—</span>') + '</td>' +
      '<td>' + statusBadge + '</td>' +
    '</tr>';
  }).join('');
}

function renderPersonTimeChart(records, startMins, deadlineMins) {
  var canvas = document.getElementById('personTimeChart');
  if (!canvas) return;
  if (_personTimeChart) { _personTimeChart.destroy(); _personTimeChart = null; }
  if (records.length === 0) return;

  var labels   = records.map(function (r) { return r.date.slice(5) + ' ' + r.day.slice(0, 3); });
  var dataVals = records.map(function (r) { return r.check_in_mins; });
  var colors   = records.map(function (r) {
    return r.status === 'on_time' ? 'rgba(34,197,94,0.75)' : 'rgba(245,158,11,0.75)';
  });
  var borders  = records.map(function (r) {
    return r.status === 'on_time' ? '#22c55e' : '#f59e0b';
  });

  _personTimeChart = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [{
        data:            dataVals,
        backgroundColor: colors,
        borderColor:     borders,
        borderWidth:     2,
        borderRadius:    4,
        barThickness:    'flex',
      }]
    },
    options: {
      responsive:          true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: function (c) {
              var r   = records[c.dataIndex];
              var tag = r.status === 'on_time' ? '✓ On Time' : '⚠ Late';
              return '  ' + tag + '   ' + r.check_in + (r.check_out ? ' → ' + r.check_out : ' (in office)');
            },
            title: function (c) { return c[0].label; }
          }
        }
      },
      scales: {
        x: {
          ticks: { font: { size: 9 }, maxRotation: 45, minRotation: 30 },
          grid:  { display: false }
        },
        y: {
          min: startMins - 20,
          max: deadlineMins + 60,
          ticks: {
            stepSize: 15,
            callback: function (v) { return minsToTime(v); },
            font: { size: 10 }
          },
          grid: { color: 'rgba(0,0,0,0.05)' }
        }
      }
    },
    plugins: [{
      id: 'personRefLines',
      afterDraw: function (chart) {
        var yAxis = chart.scales.y;
        var xAxis = chart.scales.x;
        var ctx   = chart.ctx;
        ctx.save();
        // Deadline line
        var yD = yAxis.getPixelForValue(deadlineMins);
        ctx.beginPath(); ctx.setLineDash([5, 4]);
        ctx.strokeStyle = '#f59e0b'; ctx.lineWidth = 1.5;
        ctx.moveTo(xAxis.left, yD); ctx.lineTo(xAxis.right, yD); ctx.stroke();
        ctx.fillStyle = '#f59e0b'; ctx.font = '10px Inter, system-ui, sans-serif';
        ctx.fillText('Deadline ' + minsToTime(deadlineMins), xAxis.left + 4, yD - 4);
        // Start line
        var yS = yAxis.getPixelForValue(startMins);
        ctx.beginPath(); ctx.setLineDash([5, 4]);
        ctx.strokeStyle = '#6366f1'; ctx.lineWidth = 1.5;
        ctx.moveTo(xAxis.left, yS); ctx.lineTo(xAxis.right, yS); ctx.stroke();
        ctx.fillStyle = '#6366f1';
        ctx.fillText(minsToTime(startMins) + ' Start', xAxis.left + 4, yS - 4);
        ctx.restore();
      }
    }]
  });
}

function renderPersonDowChart(dowPattern, startMins, deadlineMins) {
  var canvas = document.getElementById('personDowChart');
  if (!canvas) return;
  if (_personDowChart) { _personDowChart.destroy(); _personDowChart = null; }
  if (!dowPattern) return;

  var days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  var vals = days.map(function (d) { return dowPattern[d] != null ? dowPattern[d] : null; });
  if (!vals.some(function (v) { return v !== null; })) return;

  var bgColors = vals.map(function (v) {
    if (v === null) return 'rgba(203,213,225,0.35)';
    return v <= deadlineMins ? 'rgba(34,197,94,0.7)' : 'rgba(245,158,11,0.7)';
  });
  var borderColors = vals.map(function (v) {
    if (v === null) return '#cbd5e1';
    return v <= deadlineMins ? '#22c55e' : '#f59e0b';
  });

  _personDowChart = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels: days,
      datasets: [{
        data:            vals,
        backgroundColor: bgColors,
        borderColor:     borderColors,
        borderWidth:     2,
        borderRadius:    4,
        barThickness:    'flex',
      }]
    },
    options: {
      responsive:          true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: function (c) {
              return c.raw != null ? '  Avg: ' + minsToTime(c.raw) : '  No data';
            }
          }
        }
      },
      scales: {
        x: {
          ticks: { font: { size: 10 } },
          grid:  { display: false }
        },
        y: {
          min: startMins - 20,
          max: deadlineMins + 60,
          ticks: {
            stepSize: 30,
            callback: function (v) { return minsToTime(v); },
            font: { size: 9 }
          },
          grid: { color: 'rgba(0,0,0,0.05)' }
        }
      }
    },
    plugins: [{
      id: 'dowDeadline',
      afterDraw: function (chart) {
        var yAxis = chart.scales.y;
        var xAxis = chart.scales.x;
        var ctx   = chart.ctx;
        var yD    = yAxis.getPixelForValue(deadlineMins);
        ctx.save();
        ctx.beginPath(); ctx.setLineDash([4, 3]);
        ctx.strokeStyle = '#f59e0b'; ctx.lineWidth = 1.5;
        ctx.moveTo(xAxis.left, yD); ctx.lineTo(xAxis.right, yD); ctx.stroke();
        ctx.restore();
      }
    }]
  });
}

function closePersonProfile() {
  var panel = document.getElementById('personProfilePanel');
  if (panel) panel.style.display = 'none';
  if (_personTimeChart) { _personTimeChart.destroy(); _personTimeChart = null; }
  if (_personDowChart)  { _personDowChart.destroy();  _personDowChart  = null; }
}

/* ============================================================
   DEPARTMENT ANALYTICS
   ============================================================ */
var _donutChart    = null;
var _timelineChart = null;

async function loadDepartmentStats() {
  try {
    var resp = await fetch('/api/stats/department');
    var data = await resp.json();
    renderDonut(data);
    renderTimeline(data);
    renderLateList(data);
    renderAbsentList(data);
  } catch (e) {
    console.error('loadDepartmentStats error:', e);
  }
}

function renderLateList(data) {
  var listEl  = document.getElementById('lateList');
  var badgeEl = document.getElementById('lateCountBadge');
  if (!listEl) return;

  var late    = data.records.filter(function (r) { return r.status === 'late'; });
  var ciStart = data.check_in_start_mins;
  var deadline= data.on_time_deadline_mins;

  if (badgeEl) badgeEl.textContent = late.length;

  if (late.length === 0) {
    listEl.innerHTML =
      '<div class="empty-state" style="padding:32px 20px;">' +
        '<i class="bi bi-check-circle" style="color:#22c55e;font-size:32px;"></i>' +
        '<p style="margin-top:8px;">No late arrivals yet</p>' +
        '<small>Everyone is on time today</small>' +
      '</div>';
    return;
  }

  // Sort by most-late first (highest check_in_mins first)
  late.sort(function (a, b) { return b.check_in_mins - a.check_in_mins; });

  listEl.innerHTML = late.map(function (r) {
    var minsLate = r.check_in_mins - deadline;
    var initial  = (r.name || '?').charAt(0).toUpperCase();
    var color    = avatarColor(r.name || '');
    return (
      '<div style="display:flex;align-items:center;gap:12px;padding:12px 16px;' +
             'border-bottom:1px solid var(--border);">' +
        '<div class="att-avatar" style="background:' + color + ';width:36px;height:36px;font-size:14px;flex-shrink:0;">' +
          initial +
        '</div>' +
        '<div style="flex:1;min-width:0;">' +
          '<div style="font-weight:600;font-size:13.5px;color:var(--text-primary);">' + r.name + '</div>' +
          '<div style="font-size:11.5px;color:var(--text-secondary);margin-top:2px;">' +
            'Arrived <strong style="color:#b45309;">' + r.check_in + '</strong>' +
            (r.check_out ? '  →  Out: ' + r.check_out : '  · still in office') +
          '</div>' +
        '</div>' +
        '<div style="text-align:right;flex-shrink:0;">' +
          '<div style="font-size:13px;font-weight:700;color:#ef4444;">+' + minsLate + ' min</div>' +
          '<div style="font-size:10px;color:var(--text-secondary);">late</div>' +
        '</div>' +
      '</div>'
    );
  }).join('');
}

function renderAbsentList(data) {
  var listEl  = document.getElementById('absentList');
  var badgeEl = document.getElementById('absentCountBadge');
  if (!listEl) return;

  var absent = data.records.filter(function (r) { return r.status === 'absent'; });
  if (badgeEl) badgeEl.textContent = absent.length;

  if (absent.length === 0) {
    listEl.innerHTML =
      '<div class="empty-state" style="padding:32px 20px;">' +
        '<i class="bi bi-check-circle" style="color:#22c55e;font-size:32px;"></i>' +
        '<p style="margin-top:8px;">All registered staff have checked in</p>' +
      '</div>';
    return;
  }

  listEl.innerHTML = absent.map(function (r) {
    var initial = (r.name || '?').charAt(0).toUpperCase();
    var color   = avatarColor(r.name || '');
    return (
      '<div style="display:flex;align-items:center;gap:12px;padding:12px 16px;' +
             'border-bottom:1px solid var(--border);">' +
        '<div class="att-avatar" style="background:' + color + ';opacity:.5;width:36px;height:36px;font-size:14px;flex-shrink:0;">' +
          initial +
        '</div>' +
        '<div style="flex:1;min-width:0;">' +
          '<div style="font-weight:600;font-size:13.5px;color:var(--text-secondary);">' + r.name + '</div>' +
          '<div style="font-size:11px;color:#94a3b8;margin-top:2px;">No check-in recorded today</div>' +
        '</div>' +
        '<span style="background:#fee2e2;color:#b91c1c;font-size:11px;font-weight:600;' +
               'padding:2px 8px;border-radius:20px;flex-shrink:0;">Absent</span>' +
      '</div>'
    );
  }).join('');
}

function minsToTime(mins) {
  var h = Math.floor(mins / 60);
  var m = mins % 60;
  return String(h).padStart(2, '0') + ':' + String(m < 0 ? 0 : m).padStart(2, '0');
}

function renderDonut(data) {
  var s = data.summary;
  var presentEl = document.getElementById('donutPresentNum');
  var legendEl  = document.getElementById('donutLegend');
  if (!presentEl || !legendEl) return;

  presentEl.textContent = s.on_time + s.late;

  var items = [
    { label: 'On Time', count: s.on_time, color: '#22c55e' },
    { label: 'Late',    count: s.late,    color: '#f59e0b' },
    { label: 'Absent',  count: s.absent,  color: '#ef4444' },
  ];
  legendEl.innerHTML = items.map(function(it) {
    return '<div style="display:flex;align-items:center;justify-content:space-between;">' +
      '<div style="display:flex;align-items:center;gap:8px;">' +
        '<div style="width:10px;height:10px;border-radius:50%;background:' + it.color + ';flex-shrink:0;"></div>' +
        '<span style="font-size:13px;color:var(--text-secondary);">' + it.label + '</span>' +
      '</div>' +
      '<span style="font-size:13px;font-weight:700;color:var(--text-primary);">' + it.count + '</span>' +
    '</div>';
  }).join('');

  var canvas = document.getElementById('donutChart');
  if (!canvas) return;
  if (_donutChart) { _donutChart.destroy(); _donutChart = null; }

  _donutChart = new Chart(canvas.getContext('2d'), {
    type: 'doughnut',
    data: {
      labels: ['On Time', 'Late', 'Absent'],
      datasets: [{
        data:            [s.on_time, s.late, s.absent],
        backgroundColor: ['#22c55e', '#f59e0b', '#ef4444'],
        borderWidth:     0,
        hoverOffset:     6,
      }]
    },
    options: {
      cutout: '70%',
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: function(c) {
              return '  ' + c.label + ': ' + c.raw + ' person' + (c.raw !== 1 ? 's' : '');
            }
          }
        }
      }
    }
  });
}

function renderTimeline(data) {
  var records  = data.records;
  var ciStart  = data.check_in_start_mins;
  var coStart  = data.check_out_start_mins;
  var deadline = data.on_time_deadline_mins;

  var labelEl = document.getElementById('onTimeDeadlineLabel');
  if (labelEl) {
    labelEl.textContent = 'On-time: ' + minsToTime(ciStart) + ' – ' + minsToTime(deadline) +
                          '   Late after: ' + minsToTime(deadline);
  }

  var canvas   = document.getElementById('timelineChart');
  var emptyEl  = document.getElementById('timelineEmpty');
  var wrapEl   = document.getElementById('timelineWrap');
  if (!canvas) return;

  var present = records.filter(function(r) { return r.status !== 'absent'; });
  if (present.length === 0) {
    if (emptyEl)  emptyEl.style.display  = 'block';
    if (wrapEl)   wrapEl.style.display   = 'none';
    if (_timelineChart) { _timelineChart.destroy(); _timelineChart = null; }
    return;
  }
  if (emptyEl) emptyEl.style.display = 'none';
  if (wrapEl)  wrapEl.style.display  = 'block';

  var barH = Math.max(22, Math.min(38, 280 / Math.max(records.length, 1)));
  canvas.style.height = Math.max(160, records.length * (barH + 12) + 60) + 'px';

  var barData = records.map(function(r) {
    return r.check_in_mins != null ? [r.check_in_mins, r.check_out_mins] : null;
  });
  var bgColors = records.map(function(r) {
    if (r.status === 'on_time') return 'rgba(34,197,94,0.25)';
    if (r.status === 'late')    return 'rgba(245,158,11,0.25)';
    return 'transparent';
  });
  var borderColors = records.map(function(r) {
    if (r.status === 'on_time') return '#22c55e';
    if (r.status === 'late')    return '#f59e0b';
    return 'transparent';
  });

  if (_timelineChart) { _timelineChart.destroy(); _timelineChart = null; }

  _timelineChart = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels: records.map(function(r) { return r.name; }),
      datasets: [{
        data:            barData,
        backgroundColor: bgColors,
        borderColor:     borderColors,
        borderWidth:     2,
        borderRadius:    4,
        barThickness:    barH,
      }]
    },
    options: {
      indexAxis:          'y',
      responsive:         true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: function() { return ''; },
            label: function(c) {
              var r = records[c.dataIndex];
              if (!r.check_in) return '  ' + r.name + ': Absent';
              var tag = r.status === 'on_time' ? '✓ On Time' : '⚠ Late';
              var line = '  ' + tag + '   In: ' + r.check_in;
              line += r.check_out ? '   Out: ' + r.check_out : '   (In Office)';
              return line;
            }
          }
        }
      },
      scales: {
        x: {
          min:  ciStart - 30,
          max:  coStart + 90,
          ticks: {
            stepSize: 30,
            callback: function(v) { return minsToTime(v); },
            font: { size: 11 }
          },
          grid: { color: 'rgba(0,0,0,0.05)' }
        },
        y: {
          ticks: { font: { size: 12 } },
          grid:  { display: false }
        }
      }
    },
    plugins: [{
      id: 'refLines',
      afterDraw: function(chart) {
        var xAxis = chart.scales.x;
        var yAxis = chart.scales.y;
        var ctx   = chart.ctx;

        // Check-in start line (indigo)
        drawRefLine(ctx, xAxis, yAxis, ciStart, '#6366f1', minsToTime(ciStart) + ' Start');
        // On-time deadline line (orange)
        if (deadline !== ciStart) {
          drawRefLine(ctx, xAxis, yAxis, deadline, '#f59e0b', minsToTime(deadline) + ' Deadline');
        }
      }
    }]
  });
}

function drawRefLine(ctx, xAxis, yAxis, mins, color, label) {
  var x = xAxis.getPixelForValue(mins);
  ctx.save();
  ctx.beginPath();
  ctx.setLineDash([5, 4]);
  ctx.strokeStyle = color;
  ctx.lineWidth   = 1.5;
  ctx.moveTo(x, yAxis.top);
  ctx.lineTo(x, yAxis.bottom);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle   = color;
  ctx.font        = '10px Inter, system-ui, sans-serif';
  ctx.fillText(label, x + 4, yAxis.top + 12);
  ctx.restore();
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

/* ============================================================
   MANUAL ATTENDANCE CORRECTION
   ============================================================ */
var _attEditId = null;

async function openAddAttendance() {
  _attEditId = null;
  var titleEl = document.getElementById('attModalTitle');
  var personRow = document.getElementById('attPersonRow');
  var errorEl = document.getElementById('attModalError');
  if (titleEl)   titleEl.textContent = 'Add Record';
  if (personRow) personRow.style.display = 'block';
  if (errorEl)   errorEl.style.display   = 'none';

  // Load persons into select
  var sel = document.getElementById('attPerson');
  if (sel) {
    sel.innerHTML = '<option value="">— select person —</option>';
    try {
      var resp = await fetch('/api/persons');
      var data = await resp.json();
      var persons = Array.isArray(data) ? data : (data.persons || []);
      persons.forEach(function(p) {
        var opt = document.createElement('option');
        opt.value       = p.id;
        opt.textContent = p.name;
        sel.appendChild(opt);
      });
    } catch(e) { console.error(e); }
  }

  document.getElementById('attDate').value     = localDateStr();
  document.getElementById('attCheckIn').value  = '';
  document.getElementById('attCheckOut').value = '';
  document.getElementById('attModal').style.display = 'flex';
  setTimeout(function() {
    var s = document.getElementById('attPerson');
    if (s) s.focus();
  }, 50);
}

function openEditAttendance(rid, dateStr, checkIn, checkOut) {
  _attEditId = rid;
  var titleEl   = document.getElementById('attModalTitle');
  var personRow = document.getElementById('attPersonRow');
  var errorEl   = document.getElementById('attModalError');
  if (titleEl)   titleEl.textContent    = 'Edit Record';
  if (personRow) personRow.style.display = 'none';
  if (errorEl)   errorEl.style.display   = 'none';

  document.getElementById('attDate').value     = dateStr;
  document.getElementById('attCheckIn').value  = checkIn  || '';
  document.getElementById('attCheckOut').value = checkOut || '';
  document.getElementById('attModal').style.display = 'flex';
  setTimeout(function() {
    var ci = document.getElementById('attCheckIn');
    if (ci) ci.focus();
  }, 50);
}

function closeAttModal() {
  var modal = document.getElementById('attModal');
  if (modal) modal.style.display = 'none';
  _attEditId = null;
}

async function saveAttendance() {
  var errorEl = document.getElementById('attModalError');
  var saveBtn = document.getElementById('attSaveBtn');
  errorEl.style.display = 'none';

  var dateVal = document.getElementById('attDate').value;
  var ciVal   = document.getElementById('attCheckIn').value;
  var coVal   = document.getElementById('attCheckOut').value;

  if (!dateVal || !ciVal) {
    errorEl.textContent = 'Date and check-in time are required.';
    errorEl.style.display = 'block';
    return;
  }

  saveBtn.disabled = true;
  saveBtn.innerHTML = '<i class="bi bi-hourglass-split"></i> Saving…';

  try {
    var url, body;
    if (_attEditId) {
      url  = '/api/attendance/' + _attEditId;
      body = { date: dateVal, check_in: ciVal, check_out: coVal };
      var resp = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      var data = await resp.json();
      if (resp.ok) {
        showToast('Updated', 'Attendance record updated', 'success');
        closeAttModal();
        if (typeof loadAttendance === 'function') loadAttendance();
      } else {
        errorEl.textContent = data.error || 'Could not update record.';
        errorEl.style.display = 'block';
      }
    } else {
      var personId = document.getElementById('attPerson').value;
      if (!personId) {
        errorEl.textContent = 'Please select a person.';
        errorEl.style.display = 'block';
        saveBtn.disabled = false;
        saveBtn.innerHTML = '<i class="bi bi-check-lg"></i> Save';
        return;
      }
      body = { person_id: parseInt(personId), date: dateVal, check_in: ciVal, check_out: coVal };
      var resp = await fetch('/api/attendance/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      var data = await resp.json();
      if (resp.ok) {
        showToast('Added', data.name + '\'s attendance added', 'success');
        closeAttModal();
        if (typeof loadAttendance === 'function') loadAttendance();
      } else {
        errorEl.textContent = data.error || 'Could not add record.';
        errorEl.style.display = 'block';
      }
    }
  } catch(e) {
    errorEl.textContent = 'Network error. Please try again.';
    errorEl.style.display = 'block';
  } finally {
    saveBtn.disabled = false;
    saveBtn.innerHTML = '<i class="bi bi-check-lg"></i> Save';
  }
}

async function deleteAttendanceRecord(rid) {
  if (!rid) return;
  if (!confirm('Delete this attendance record? This cannot be undone.')) return;
  try {
    var resp = await fetch('/api/attendance/' + rid, { method: 'DELETE' });
    if (resp.ok) {
      showToast('Deleted', 'Record removed', 'warn');
      if (typeof loadAttendance === 'function') loadAttendance();
    } else {
      showToast('Error', 'Could not delete record.', 'err');
    }
  } catch(e) {
    showToast('Network Error', 'Could not reach server.', 'err');
  }
}
