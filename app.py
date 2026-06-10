import os
import base64
import pickle
from datetime import date, datetime, time as dtime, timedelta

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
CHECK_IN_GRACE_MINUTES  = 60       # check-ins within this many mins of check_in_start count as on-time


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

    try:
        cur.execute("ALTER TABLE persons ADD COLUMN department VARCHAR(100) DEFAULT NULL")
        base.commit()
    except Exception:
        pass  # column already exists

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
        # Only consider check-ins that happened during business hours (>= check_in_start).
        # Pre-business-hours records (e.g. testing at 1 AM) are ignored so each person
        # can still complete a proper check-in/check-out during the work day.
        check_in_start_dt = datetime.combine(today, check_in_start)
        cur.execute(
            'SELECT id, check_in, check_out FROM attendance '
            'WHERE person_id=%s AND date=%s AND check_in >= %s '
            'ORDER BY check_in DESC LIMIT 1',
            (person_id, today, check_in_start_dt)
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
            return 'too_early'

        att_id, check_in_dt, check_out_dt = row

        if check_out_dt is not None:
            return 'already_done'

        if now_t >= check_out_start:
            # Require at least 30 min between check-in and check-out to prevent
            # instant checkout for people who arrive after check_out_start time
            if (now_dt - check_in_dt).total_seconds() >= 1800:
                cur.execute('UPDATE attendance SET check_out=%s WHERE id=%s', (now_dt, att_id))
                conn.commit()
                return 'check_out'

        return 'already_in'

    finally:
        cur.close()
        conn.close()

    return 'already_in'


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

@app.route('/people')
@login_required
def people_page():
    return render_template('people.html')

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
                if action in ('check_in', 'check_out'):
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

    department = data.get('department', '').strip() or None

    blob = pickle.dumps(np.mean(encodings, axis=0))
    now  = datetime.now()
    conn = get_conn()
    cur  = conn.cursor()
    cur.execute(
        'INSERT INTO persons (name, encoding, created_at, department) VALUES (%s,%s,%s,%s)',
        (name, blob, now, department)
    )
    conn.commit()
    cur.close(); conn.close()

    return jsonify({'success': True, 'message': f'{name} registered successfully!'})


@app.route('/api/attendance')
@login_required
def get_attendance():
    filter_date = request.args.get('date', date.today().isoformat())
    check_in_start = get_time_setting('check_in_start', DEFAULT_CHECK_IN_START)
    check_in_start_dt = datetime.combine(
        date.fromisoformat(filter_date), check_in_start
    )
    conn = get_conn()
    cur  = conn.cursor()
    # Only show business-hours records; pre-business-hours (testing) records are excluded
    cur.execute(
        'SELECT id, name, check_in, check_out FROM attendance '
        'WHERE date=%s AND check_in >= %s '
        'ORDER BY check_in',
        (filter_date, check_in_start_dt)
    )
    rows = cur.fetchall()
    cur.close(); conn.close()

    records = []
    for rid, name, check_in, check_out in rows:
        records.append({
            'id':        rid,
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
    check_in_start = get_time_setting('check_in_start', DEFAULT_CHECK_IN_START)
    check_in_start_dt = datetime.combine(
        date.fromisoformat(filter_date), check_in_start
    )
    conn = get_conn()
    cur  = conn.cursor()
    cur.execute(
        'SELECT name, check_in, check_out FROM attendance '
        'WHERE date=%s AND check_in >= %s ORDER BY check_in',
        (filter_date, check_in_start_dt)
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
    cur.execute('SELECT id, name, created_at, department FROM persons ORDER BY name')
    rows = cur.fetchall()
    cur.close(); conn.close()
    return jsonify({'persons': [
        {'id': r[0], 'name': r[1],
         'created_at': r[2].strftime('%Y-%m-%d %H:%M:%S') if r[2] else '',
         'department': r[3] or ''}
        for r in rows
    ]})


@app.route('/api/persons/<int:pid>', methods=['PUT'])
@login_required
def update_person(pid):
    data       = request.get_json(force=True)
    new_name   = (data.get('name') or '').strip()
    department = data.get('department', None)  # None means don't change
    if not new_name:
        return jsonify({'error': 'Name cannot be empty'}), 400

    conn = get_conn()
    cur  = conn.cursor()
    # Check new name is not already taken by another person
    cur.execute('SELECT id FROM persons WHERE name=%s AND id != %s', (new_name, pid))
    if cur.fetchone():
        cur.close(); conn.close()
        return jsonify({'error': 'Name already exists'}), 409

    cur.execute('UPDATE persons    SET name=%s WHERE id=%s', (new_name, pid))
    cur.execute('UPDATE attendance SET name=%s WHERE person_id=%s', (new_name, pid))
    if department is not None:
        cur.execute('UPDATE persons SET department=%s WHERE id=%s', (department.strip(), pid))
    conn.commit()
    cur.close(); conn.close()
    return jsonify({'success': True, 'name': new_name})


@app.route('/api/persons/<int:pid>', methods=['DELETE'])
@login_required
def delete_person(pid):
    conn = get_conn()
    cur  = conn.cursor()
    cur.execute('DELETE FROM persons WHERE id=%s', (pid,))
    conn.commit()
    cur.close(); conn.close()
    return jsonify({'success': True})


@app.route('/api/departments')
@login_required
def get_departments():
    conn = get_conn()
    cur  = conn.cursor()
    cur.execute("SELECT DISTINCT department FROM persons WHERE department IS NOT NULL AND department != '' ORDER BY department")
    depts = [r[0] for r in cur.fetchall()]
    cur.close(); conn.close()
    return jsonify({'departments': depts})


@app.route('/api/attendance/add', methods=['POST'])
@login_required
def add_attendance_manual():
    data      = request.get_json(force=True)
    person_id = data.get('person_id')
    date_str  = data.get('date', '')
    ci_str    = data.get('check_in', '')
    co_str    = data.get('check_out', '')
    if not person_id or not date_str or not ci_str:
        return jsonify({'error': 'person_id, date, and check_in are required'}), 400
    try:
        ci_dt = datetime.strptime(date_str + ' ' + ci_str, '%Y-%m-%d %H:%M')
        co_dt = datetime.strptime(date_str + ' ' + co_str, '%Y-%m-%d %H:%M') if co_str else None
    except ValueError:
        return jsonify({'error': 'Invalid date/time format'}), 400
    if co_dt and co_dt <= ci_dt:
        return jsonify({'error': 'Check-out must be after check-in'}), 400
    conn = get_conn()
    cur  = conn.cursor()
    cur.execute('SELECT name FROM persons WHERE id=%s', (person_id,))
    row = cur.fetchone()
    if not row:
        cur.close(); conn.close()
        return jsonify({'error': 'Person not found'}), 404
    name = row[0]
    cur.execute(
        'INSERT INTO attendance (person_id, name, date, check_in, check_out) VALUES (%s,%s,%s,%s,%s)',
        (person_id, name, date_str, ci_dt, co_dt)
    )
    conn.commit()
    rid = cur.lastrowid
    cur.close(); conn.close()
    return jsonify({'success': True, 'id': rid, 'name': name})


@app.route('/api/attendance/<int:rid>', methods=['PUT'])
@login_required
def update_attendance(rid):
    data     = request.get_json(force=True)
    ci_str   = data.get('check_in', '')
    co_str   = data.get('check_out', '')
    date_str = data.get('date', '')
    if not ci_str or not date_str:
        return jsonify({'error': 'date and check_in are required'}), 400
    try:
        ci_dt = datetime.strptime(date_str + ' ' + ci_str, '%Y-%m-%d %H:%M')
        co_dt = datetime.strptime(date_str + ' ' + co_str, '%Y-%m-%d %H:%M') if co_str else None
    except ValueError:
        return jsonify({'error': 'Invalid date/time format'}), 400
    if co_dt and co_dt <= ci_dt:
        return jsonify({'error': 'Check-out must be after check-in'}), 400
    conn = get_conn()
    cur  = conn.cursor()
    cur.execute(
        'UPDATE attendance SET date=%s, check_in=%s, check_out=%s WHERE id=%s',
        (date_str, ci_dt, co_dt, rid)
    )
    conn.commit()
    cur.close(); conn.close()
    return jsonify({'success': True})


@app.route('/api/attendance/<int:rid>', methods=['DELETE'])
@login_required
def delete_attendance(rid):
    conn = get_conn()
    cur  = conn.cursor()
    cur.execute('DELETE FROM attendance WHERE id=%s', (rid,))
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


@app.route('/api/stats/department')
@login_required
def get_department_stats():
    today           = date.today()
    check_in_start  = get_time_setting('check_in_start',  DEFAULT_CHECK_IN_START)
    check_out_start = get_time_setting('check_out_start', DEFAULT_CHECK_OUT_START)
    check_in_start_dt   = datetime.combine(today, check_in_start)
    on_time_deadline_dt = check_in_start_dt + timedelta(minutes=CHECK_IN_GRACE_MINUTES)

    conn = get_conn()
    cur  = conn.cursor()
    cur.execute('SELECT id, name FROM persons ORDER BY name')
    persons = cur.fetchall()

    # First check-in and last check-out per person (business hours only)
    cur.execute(
        'SELECT person_id, MIN(check_in) AS first_in, MAX(check_out) AS last_out '
        'FROM attendance WHERE date=%s AND check_in >= %s GROUP BY person_id',
        (today, check_in_start_dt)
    )
    att_map = {row[0]: (row[1], row[2]) for row in cur.fetchall()}
    cur.close()
    conn.close()

    now_dt   = datetime.now()
    now_mins = now_dt.hour * 60 + now_dt.minute
    records, on_time_cnt, late_cnt, absent_cnt = [], 0, 0, 0

    for pid, name in persons:
        if pid in att_map:
            ci_dt, co_dt = att_map[pid]
            status = 'on_time' if ci_dt <= on_time_deadline_dt else 'late'
            if status == 'on_time': on_time_cnt += 1
            else:                   late_cnt    += 1
            ci_mins = ci_dt.hour * 60 + ci_dt.minute
            co_mins = (co_dt.hour * 60 + co_dt.minute) if co_dt else now_mins
        else:
            status = 'absent'; absent_cnt += 1
            ci_dt = co_dt = None
            ci_mins = co_mins = None

        records.append({
            'name':           name,
            'status':         status,
            'check_in':       ci_dt.strftime('%H:%M') if ci_dt else None,
            'check_out':      co_dt.strftime('%H:%M') if co_dt else None,
            'check_in_mins':  ci_mins,
            'check_out_mins': co_mins,
        })

    return jsonify({
        'records': records,
        'summary': {'on_time': on_time_cnt, 'late': late_cnt, 'absent': absent_cnt},
        'check_in_start_mins':   check_in_start.hour  * 60 + check_in_start.minute,
        'check_out_start_mins':  check_out_start.hour * 60 + check_out_start.minute,
        'on_time_deadline_mins': on_time_deadline_dt.hour * 60 + on_time_deadline_dt.minute,
    })


@app.route('/api/attendance/history')
@login_required
def get_attendance_history():
    name = request.args.get('name', '').strip()
    if not name:
        return jsonify({'found': False})

    check_in_start      = get_time_setting('check_in_start',  DEFAULT_CHECK_IN_START)
    check_out_start     = get_time_setting('check_out_start', DEFAULT_CHECK_OUT_START)
    deadline_t = (datetime.combine(date.today(), check_in_start)
                  + timedelta(minutes=CHECK_IN_GRACE_MINUTES)).time()

    conn = get_conn()
    cur  = conn.cursor()
    cur.execute(
        'SELECT id, name FROM persons WHERE name LIKE %s ORDER BY name LIMIT 1',
        ('%' + name + '%',)
    )
    person = cur.fetchone()
    if not person:
        cur.close(); conn.close()
        return jsonify({'found': False})

    pid, person_name = person

    # Per-day: first check-in and last check-out (business hours only)
    cur.execute(
        'SELECT date, MIN(check_in) AS ci, MAX(check_out) AS co '
        'FROM attendance WHERE person_id=%s AND TIME(check_in) >= %s '
        'GROUP BY date ORDER BY date DESC LIMIT 60',
        (pid, check_in_start)
    )
    rows = cur.fetchall()
    cur.close(); conn.close()

    on_time_cnt = late_cnt = 0
    records     = []
    ci_mins_all = []
    co_mins_all = []
    dur_mins_all= []
    dow_buckets = {i: [] for i in range(7)}   # 0=Mon … 6=Sun
    present_dates = set()

    for d, ci, co in rows:
        ci_t = ci.time().replace(second=0, microsecond=0)
        status = 'on_time' if ci_t <= deadline_t else 'late'
        if status == 'on_time': on_time_cnt += 1
        else:                   late_cnt    += 1

        ci_m = ci.hour * 60 + ci.minute
        ci_mins_all.append(ci_m)
        dow_buckets[d.weekday()].append(ci_m)
        present_dates.add(d)

        if co:
            co_m = co.hour * 60 + co.minute
            co_mins_all.append(co_m)
            dur_mins_all.append(co_m - ci_m)

        records.append({
            'date':          d.strftime('%Y-%m-%d'),
            'day':           d.strftime('%a'),
            'check_in':      ci.strftime('%H:%M'),
            'check_out':     co.strftime('%H:%M') if co else None,
            'duration':      calc_duration(ci, co),
            'status':        status,
            'check_in_mins': ci_m,
        })

    # Averages & percentiles
    def avg(lst):  return int(sum(lst) / len(lst)) if lst else None
    def pct(lst, p):
        s = sorted(lst); i = int(len(s) * p / 100)
        return s[min(i, len(s)-1)]

    avg_ci   = avg(ci_mins_all)
    avg_co   = avg(co_mins_all)
    avg_dur  = avg(dur_mins_all)
    range_ci = {'from': pct(ci_mins_all, 25), 'to': pct(ci_mins_all, 75)} if len(ci_mins_all) >= 4 else None

    # Day-of-week avg check-in (Mon–Sun)
    day_names = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun']
    dow_avg   = {day_names[i]: avg(dow_buckets[i]) for i in range(7)}

    # Current consecutive-day streak (from today backwards)
    streak    = 0
    check_day = date.today()
    while check_day in present_dates:
        streak   += 1
        check_day = check_day - timedelta(days=1)

    return jsonify({
        'found':   True,
        'person':  person_name,
        'summary': {
            'on_time':       on_time_cnt,
            'late':          late_cnt,
            'total_present': len(records),
        },
        'insights': {
            'avg_check_in_mins':  avg_ci,
            'avg_check_out_mins': avg_co,
            'avg_duration_mins':  avg_dur,
            'usual_range_ci':     range_ci,
            'current_streak':     streak,
        },
        'dow_pattern':           dow_avg,
        'records':               records,
        'check_in_start_mins':   check_in_start.hour  * 60 + check_in_start.minute,
        'check_out_start_mins':  check_out_start.hour * 60 + check_out_start.minute,
        'on_time_deadline_mins': int(deadline_t.hour * 60 + deadline_t.minute),
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


@app.route('/report')
@login_required
def report_page():
    return render_template('report.html')


@app.route('/api/attendance/report')
@login_required
def attendance_report_api():
    import calendar as cal_mod
    month = request.args.get('month', '')
    if not month:
        month = date.today().strftime('%Y-%m')
    try:
        year, m = map(int, month.split('-'))
    except ValueError:
        return jsonify({'error': 'Invalid month format, use YYYY-MM'}), 400

    _, days_in_month = cal_mod.monthrange(year, m)
    check_in_start = get_time_setting('check_in_start', DEFAULT_CHECK_IN_START)
    deadline_t = (datetime.combine(date.today(), check_in_start)
                  + timedelta(minutes=CHECK_IN_GRACE_MINUTES)).time()

    conn = get_conn()
    cur  = conn.cursor()
    cur.execute('SELECT id, name, department FROM persons ORDER BY name')
    persons = cur.fetchall()

    start_d = f'{month}-01'
    end_d   = f'{month}-{days_in_month:02d}'
    cur.execute(
        'SELECT person_id, date, MIN(check_in), MAX(check_out) '
        'FROM attendance WHERE date >= %s AND date <= %s '
        'GROUP BY person_id, date',
        (start_d, end_d)
    )
    att_rows = cur.fetchall()
    cur.close(); conn.close()

    att_map = {}
    for pid, d, ci, co in att_rows:
        ci_t = ci.time().replace(second=0, microsecond=0)
        status = 'on_time' if ci_t <= deadline_t else 'late'
        att_map.setdefault(pid, {})[d.strftime('%Y-%m-%d')] = {
            'check_in': ci.strftime('%H:%M'),
            'check_out': co.strftime('%H:%M') if co else None,
            'status': status,
        }

    days = [f'{month}-{i:02d}' for i in range(1, days_in_month + 1)]
    # Working days only (Mon–Fri)
    work_days = [d for d in days
                 if date(int(d[:4]), int(d[5:7]), int(d[8:])).weekday() < 5]
    work_day_count = len(work_days)

    report_persons = []
    for pid, name, dept in persons:
        person_days = att_map.get(pid, {})
        present  = sum(1 for d in work_days if d in person_days)
        on_time  = sum(1 for d in work_days if d in person_days and person_days[d]['status'] == 'on_time')
        report_persons.append({
            'id':         pid,
            'name':       name,
            'department': dept or '',
            'days':       {d: person_days.get(d) for d in days},
            'summary':    {
                'present':    present,
                'on_time':    on_time,
                'late':       present - on_time,
                'absent':     work_day_count - present,
                'work_days':  work_day_count,
            },
        })

    return jsonify({
        'month':      month,
        'days':       days,
        'work_days':  work_day_count,
        'persons':    report_persons,
        'deadline':   f'{deadline_t.hour:02d}:{deadline_t.minute:02d}',
    })


if __name__ == '__main__':
    init_db()
    print('\n  Face Attendance System  (MySQL + Auth)')
    print('  Running at http://localhost:5000\n')
    app.run(debug=True, host='0.0.0.0', port=5000)
