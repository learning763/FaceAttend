import os
import base64
import pickle
from datetime import date, datetime, time as dtime

import cv2
import numpy as np
import mysql.connector
from deepface import DeepFace
from dotenv import load_dotenv
from flask import (Flask, render_template, request, jsonify,
                   Response, redirect, url_for, flash)
from flask_login import (LoginManager, UserMixin, login_user,
                         logout_user, login_required, current_user)
from werkzeug.security import generate_password_hash, check_password_hash

load_dotenv()

app = Flask(__name__)
app.secret_key = os.getenv('SECRET_KEY', 'face-attend-secret-2026')

# ── Flask-Login ───────────────────────────────────────────────────────────────
login_manager = LoginManager(app)
login_manager.login_view = 'login_page'

DB_CONFIG = {
    'host':     os.getenv('DB_HOST', 'localhost'),
    'port':     int(os.getenv('DB_PORT', 3306)),
    'user':     os.getenv('DB_USER', 'root'),
    'password': os.getenv('DB_PASS', ''),
    'database': os.getenv('DB_NAME', 'face_attendance'),
}

MODEL                  = 'Facenet512'
DETECTOR               = 'opencv'
THRESHOLD              = 0.40
DEFAULT_CHECK_IN_START  = '08:00'
DEFAULT_CHECK_OUT_START = '16:30'


# ── User model ────────────────────────────────────────────────────────────────

class User(UserMixin):
    def __init__(self, uid, name, email, role):
        self.id    = uid
        self.name  = name
        self.email = email
        self.role  = role


@login_manager.user_loader
def load_user(user_id):
    conn = get_conn()
    cur  = conn.cursor()
    cur.execute('SELECT id, name, email, role FROM users WHERE id=%s', (user_id,))
    row = cur.fetchone()
    cur.close(); conn.close()
    return User(row[0], row[1], row[2], row[3]) if row else None


@login_manager.unauthorized_handler
def unauthorized():
    if request.is_json or request.path.startswith('/api/'):
        return jsonify({'error': 'Unauthorized'}), 401
    return redirect(url_for('login_page'))


# ── Database ──────────────────────────────────────────────────────────────────

def get_conn():
    return mysql.connector.connect(**DB_CONFIG)


def init_db():
    base = mysql.connector.connect(
        host=DB_CONFIG['host'],
        port=DB_CONFIG['port'],
        user=DB_CONFIG['user'],
        password=DB_CONFIG['password'],
    )
    cur = base.cursor()
    cur.execute(f"CREATE DATABASE IF NOT EXISTS `{DB_CONFIG['database']}`")
    cur.execute(f"USE `{DB_CONFIG['database']}`")

    cur.execute('''
        CREATE TABLE IF NOT EXISTS users (
            id            INT AUTO_INCREMENT PRIMARY KEY,
            name          VARCHAR(255) NOT NULL,
            email         VARCHAR(255) NOT NULL UNIQUE,
            password_hash VARCHAR(512) NOT NULL,
            role          VARCHAR(50)  NOT NULL DEFAULT 'admin',
            created_at    DATETIME     NOT NULL
        )
    ''')

    cur.execute('''
        CREATE TABLE IF NOT EXISTS persons (
            id         INT AUTO_INCREMENT PRIMARY KEY,
            name       VARCHAR(255) NOT NULL,
            encoding   LONGBLOB     NOT NULL,
            created_at DATETIME     NOT NULL
        )
    ''')

    cur.execute('''
        CREATE TABLE IF NOT EXISTS attendance (
            id        INT AUTO_INCREMENT PRIMARY KEY,
            person_id INT          NOT NULL,
            name      VARCHAR(255) NOT NULL,
            date      DATE         NOT NULL,
            check_in  DATETIME     NOT NULL,
            check_out DATETIME     DEFAULT NULL,
            FOREIGN KEY (person_id) REFERENCES persons(id) ON DELETE CASCADE
        )
    ''')

    cur.execute('''
        CREATE TABLE IF NOT EXISTS settings (
            `key`  VARCHAR(100) NOT NULL PRIMARY KEY,
            value  VARCHAR(255) NOT NULL
        )
    ''')

    base.commit()
    cur.close()
    base.close()
    print('  Database ready.')


# ── Settings helpers ─────────────────────────────────────────────────────────

def get_setting(key, default=''):
    try:
        conn = get_conn()
        cur  = conn.cursor()
        cur.execute('SELECT value FROM settings WHERE `key`=%s', (key,))
        row = cur.fetchone()
        cur.close(); conn.close()
        return row[0] if row else default
    except Exception:
        return default


def save_setting(key, value):
    conn = get_conn()
    cur  = conn.cursor()
    cur.execute(
        'INSERT INTO settings (`key`, value) VALUES (%s,%s) '
        'ON DUPLICATE KEY UPDATE value=%s',
        (key, value, value)
    )
    conn.commit()
    cur.close(); conn.close()


def get_time_setting(key, default_str):
    val = get_setting(key, default_str)
    h, m = map(int, val.split(':'))
    return dtime(h, m)


# ── Image helpers ─────────────────────────────────────────────────────────────

def decode_bgr(image_b64: str) -> np.ndarray:
    raw = base64.b64decode(image_b64.split(',')[1])
    arr = np.frombuffer(raw, np.uint8)
    return cv2.imdecode(arr, cv2.IMREAD_COLOR)


def cosine_distance(a: np.ndarray, b: np.ndarray) -> float:
    a, b = np.array(a, dtype=np.float64), np.array(b, dtype=np.float64)
    na, nb = np.linalg.norm(a), np.linalg.norm(b)
    if na == 0 or nb == 0:
        return 1.0
    return float(1.0 - np.dot(a, b) / (na * nb))


def detect_and_embed(bgr_img: np.ndarray):
    h, w = bgr_img.shape[:2]
    out  = []
    try:
        face_objs = DeepFace.extract_faces(
            bgr_img, detector_backend=DETECTOR,
            enforce_detection=False, align=True
        )
    except Exception as e:
        print(f'[detect] {e}')
        return out

    for fo in face_objs:
        if fo.get('confidence', 0) < 0.5:
            continue
        region = fo['facial_area']
        x, y, fw, fh = region['x'], region['y'], region['w'], region['h']
        face_bgr = (fo['face'][:, :, ::-1] * 255).astype(np.uint8)
        try:
            rep = DeepFace.represent(
                face_bgr, model_name=MODEL,
                detector_backend='skip', enforce_detection=False
            )
            if not rep:
                continue
            embedding = np.array(rep[0]['embedding'], dtype=np.float64)
        except Exception as e:
            print(f'[embed] {e}')
            continue

        out.append(({
            'top':    y / h,
            'right':  (x + fw) / w,
            'bottom': (y + fh) / h,
            'left':   x / w,
        }, embedding))
    return out


def get_known_faces():
    conn = get_conn()
    cur  = conn.cursor()
    cur.execute('SELECT id, name, encoding FROM persons')
    rows = cur.fetchall()
    cur.close(); conn.close()

    ids, names, encodings = [], [], []
    for pid, name, blob in rows:
        ids.append(pid)
        names.append(name)
        encodings.append(pickle.loads(blob))
    return ids, names, encodings


# ── Attendance helpers ────────────────────────────────────────────────────────

def mark_attendance(person_id: int, name: str):
    today  = date.today()
    now_dt = datetime.now()
    now_t  = now_dt.time().replace(second=0, microsecond=0)

    check_in_start  = get_time_setting('check_in_start',  DEFAULT_CHECK_IN_START)
    check_out_start = get_time_setting('check_out_start', DEFAULT_CHECK_OUT_START)

    conn = get_conn()
    cur  = conn.cursor()
    try:
        cur.execute(
            'SELECT id, check_in, check_out FROM attendance WHERE person_id=%s AND date=%s',
            (person_id, today)
        )
        row = cur.fetchone()

        if not row:
            if now_t >= check_in_start:
                cur.execute(
                    'INSERT INTO attendance (person_id, name, date, check_in) VALUES (%s,%s,%s,%s)',
                    (person_id, name, today, now_dt)
                )
                conn.commit()
                return 'check_in'
            return None

        att_id, check_in_dt, check_out_dt = row

        if check_out_dt is not None:
            return None

        if now_t >= check_out_start:
            cur.execute('UPDATE attendance SET check_out=%s WHERE id=%s', (now_dt, att_id))
            conn.commit()
            return 'check_out'

    finally:
        cur.close()
        conn.close()

    return None


def fmt_time(dt_val):
    if dt_val is None:
        return '—'
    if isinstance(dt_val, datetime):
        return dt_val.strftime('%H:%M:%S')
    return str(dt_val)


def calc_duration(check_in_dt, check_out_dt):
    if check_out_dt is None:
        return '—'
    diff = check_out_dt - check_in_dt
    h = int(diff.total_seconds() // 3600)
    m = int((diff.total_seconds() % 3600) // 60)
    return f'{h}h {m:02d}m'


# ── Auth Routes ───────────────────────────────────────────────────────────────

@app.route('/login', methods=['GET', 'POST'])
def login_page():
    if current_user.is_authenticated:
        return redirect('/')

    error = None
    if request.method == 'POST':
        email    = request.form.get('email', '').strip().lower()
        password = request.form.get('password', '')

        conn = get_conn()
        cur  = conn.cursor()
        cur.execute(
            'SELECT id, name, email, password_hash, role FROM users WHERE email=%s',
            (email,)
        )
        row = cur.fetchone()
        cur.close(); conn.close()

        if row and check_password_hash(row[3], password):
            user = User(row[0], row[1], row[2], row[4])
            login_user(user, remember=True)
            return redirect('/')
        error = 'Invalid email or password. Please try again.'

    registered = request.args.get('registered')
    return render_template('login.html', error=error, registered=registered)


@app.route('/signup', methods=['GET', 'POST'])
def signup_page():
    if current_user.is_authenticated:
        return redirect('/')

    error = None
    if request.method == 'POST':
        name     = request.form.get('name', '').strip()
        email    = request.form.get('email', '').strip().lower()
        password = request.form.get('password', '')
        confirm  = request.form.get('confirm_password', '')

        if not all([name, email, password, confirm]):
            error = 'All fields are required.'
        elif password != confirm:
            error = 'Passwords do not match.'
        elif len(password) < 6:
            error = 'Password must be at least 6 characters.'
        else:
            conn = get_conn()
            cur  = conn.cursor()
            cur.execute('SELECT id FROM users WHERE email=%s', (email,))
            if cur.fetchone():
                error = 'This email is already registered.'
            else:
                hashed = generate_password_hash(password)
                cur.execute(
                    'INSERT INTO users (name, email, password_hash, role, created_at) '
                    'VALUES (%s,%s,%s,%s,%s)',
                    (name, email, hashed, 'Admin', datetime.now())
                )
                conn.commit()
                cur.close(); conn.close()
                return redirect('/login?registered=1')
            cur.close(); conn.close()

    return render_template('signup.html', error=error)


@app.route('/logout')
@login_required
def logout():
    logout_user()
    return redirect('/login')


# ── Page Routes ───────────────────────────────────────────────────────────────

@app.route('/')
@login_required
def index():
    return render_template('index.html')

@app.route('/register')
@login_required
def register():
    return render_template('register.html')

@app.route('/attendance')
@login_required
def attendance_page():
    return render_template('attendance.html')

@app.route('/settings')
@login_required
def settings_page():
    return render_template('settings.html')


# ── API ───────────────────────────────────────────────────────────────────────

@app.route('/api/recognize', methods=['POST'])
@login_required
def recognize():
    data = request.get_json(silent=True) or {}
    if 'image' not in data:
        return jsonify({'error': 'No image provided'}), 400

    bgr       = decode_bgr(data['image'])
    face_data = detect_and_embed(bgr)
    ids, names, known_encs = get_known_faces()

    faces, events = [], []
    for loc, embedding in face_data:
        name, person_id, confidence = 'Unknown', None, 0.0

        if known_encs:
            distances = [cosine_distance(embedding, ke) for ke in known_encs]
            idx = int(np.argmin(distances))
            if distances[idx] < THRESHOLD:
                name       = names[idx]
                person_id  = ids[idx]
                confidence = round((1.0 - distances[idx]) * 100, 1)

        action = None
        if person_id:
            try:
                action = mark_attendance(person_id, name)
                if action:
                    events.append({'name': name, 'action': action,
                                   'time': datetime.now().strftime('%H:%M:%S')})
            except Exception as e:
                print(f'[attendance error] {e}')

        faces.append({'name': name, 'confidence': confidence,
                      'action': action, 'location': loc})

    return jsonify({'faces': faces, 'events': events})


@app.route('/api/register', methods=['POST'])
@login_required
def register_face():
    data   = request.get_json(silent=True) or {}
    name   = data.get('name', '').strip()
    images = data.get('images', [])

    if not name:
        return jsonify({'error': 'Name is required'}), 400
    if not images:
        return jsonify({'error': 'No images provided'}), 400

    encodings = []
    for img_b64 in images:
        face_data = detect_and_embed(decode_bgr(img_b64))
        if face_data:
            encodings.append(face_data[0][1])

    if not encodings:
        return jsonify({'error': 'No face detected. Ensure good lighting and '
                                 'face the camera directly.'}), 400

    blob = pickle.dumps(np.mean(encodings, axis=0))
    now  = datetime.now()
    conn = get_conn()
    cur  = conn.cursor()
    cur.execute('INSERT INTO persons (name, encoding, created_at) VALUES (%s,%s,%s)',
                (name, blob, now))
    conn.commit()
    cur.close(); conn.close()

    return jsonify({'success': True, 'message': f'{name} registered successfully!'})


@app.route('/api/attendance')
@login_required
def get_attendance():
    filter_date = request.args.get('date', date.today().isoformat())
    conn = get_conn()
    cur  = conn.cursor()
    cur.execute(
        'SELECT name, check_in, check_out FROM attendance WHERE date=%s ORDER BY check_in',
        (filter_date,)
    )
    rows = cur.fetchall()
    cur.close(); conn.close()

    records = []
    for name, check_in, check_out in rows:
        records.append({
            'name':      name,
            'check_in':  fmt_time(check_in),
            'check_out': fmt_time(check_out),
            'duration':  calc_duration(check_in, check_out),
            'status':    'Complete' if check_out else 'In Office',
        })
    return jsonify({'records': records, 'date': filter_date, 'count': len(records)})


@app.route('/api/attendance/export')
@login_required
def export_attendance():
    filter_date = request.args.get('date', date.today().isoformat())
    conn = get_conn()
    cur  = conn.cursor()
    cur.execute(
        'SELECT name, check_in, check_out FROM attendance WHERE date=%s ORDER BY check_in',
        (filter_date,)
    )
    rows = cur.fetchall()
    cur.close(); conn.close()

    lines = ['Name,Check-In,Check-Out,Duration']
    for name, ci, co in rows:
        lines.append(f'{name},{fmt_time(ci)},{fmt_time(co)},{calc_duration(ci, co)}')
    return Response('\n'.join(lines), mimetype='text/csv',
                    headers={'Content-Disposition': f'attachment; filename=attendance_{filter_date}.csv'})


@app.route('/api/persons')
@login_required
def get_persons():
    conn = get_conn()
    cur  = conn.cursor()
    cur.execute('SELECT id, name, created_at FROM persons ORDER BY name')
    rows = cur.fetchall()
    cur.close(); conn.close()
    return jsonify({'persons': [
        {'id': r[0], 'name': r[1],
         'created_at': r[2].strftime('%Y-%m-%d %H:%M:%S') if r[2] else ''}
        for r in rows
    ]})


@app.route('/api/persons/<int:pid>', methods=['DELETE'])
@login_required
def delete_person(pid):
    conn = get_conn()
    cur  = conn.cursor()
    cur.execute('DELETE FROM persons WHERE id=%s', (pid,))
    conn.commit()
    cur.close(); conn.close()
    return jsonify({'success': True})


@app.route('/api/stats')
@login_required
def get_stats():
    today = date.today().isoformat()
    conn  = get_conn()
    cur   = conn.cursor()
    cur.execute('SELECT COUNT(*) FROM persons')
    total = cur.fetchone()[0]
    cur.execute('SELECT COUNT(*) FROM attendance WHERE date=%s', (today,))
    present = cur.fetchone()[0]
    cur.execute('SELECT COUNT(*) FROM attendance WHERE date=%s AND check_out IS NOT NULL', (today,))
    checked_out = cur.fetchone()[0]
    cur.close(); conn.close()

    absent = max(0, total - present)
    rate   = round(present / total * 100, 1) if total else 0
    return jsonify({
        'total_registered': total,
        'present_today':    present,
        'absent_today':     absent,
        'checked_out':      checked_out,
        'in_office':        present - checked_out,
        'attendance_rate':  rate,
    })


@app.route('/api/settings', methods=['GET'])
@login_required
def api_get_settings():
    return jsonify({
        'check_in_start':  get_setting('check_in_start',  DEFAULT_CHECK_IN_START),
        'check_out_start': get_setting('check_out_start', DEFAULT_CHECK_OUT_START),
    })


@app.route('/api/settings', methods=['POST'])
@login_required
def api_save_settings():
    import re
    data = request.get_json(silent=True) or {}
    ci   = data.get('check_in_start',  '').strip()
    co   = data.get('check_out_start', '').strip()

    if not re.match(r'^\d{2}:\d{2}$', ci) or not re.match(r'^\d{2}:\d{2}$', co):
        return jsonify({'error': 'Invalid time format. Use HH:MM'}), 400

    save_setting('check_in_start',  ci)
    save_setting('check_out_start', co)
    return jsonify({'success': True, 'check_in_start': ci, 'check_out_start': co})


if __name__ == '__main__':
    init_db()
    print('\n  Face Attendance System  (MySQL + Auth)')
    print('  Running at http://localhost:5000\n')
    app.run(debug=True, host='0.0.0.0', port=5000)
