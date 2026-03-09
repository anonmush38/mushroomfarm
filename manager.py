"""
MushroomFarm Manager — Application de gestion du backend
Lance un serveur Flask local et ouvre l'interface dans le navigateur.
Compilable en .exe avec PyInstaller.
"""

import os
import sys
import json
import time
import sqlite3
import shutil
import subprocess
import threading
import webbrowser
import zipfile
import datetime
import platform
from pathlib import Path

# Flask
from flask import Flask, render_template, jsonify, request, send_file

try:
    import psutil
    HAS_PSUTIL = True
except ImportError:
    HAS_PSUTIL = False

# ── Paths ─────────────────────────────────────────────────────────────────────
if getattr(sys, 'frozen', False):
    BASE_DIR = Path(sys.executable).parent
else:
    BASE_DIR = Path(__file__).parent

BACKEND_DIR  = BASE_DIR / "mnt" / "user-data" / "outputs" / "mushroom-backend"
DB_PATH      = BACKEND_DIR / "data" / "mushroom_farm.db"
SYNC_DB_PATH = BASE_DIR / "data" / "players_sync.db"
BACKUP_DIR   = BASE_DIR / "backups"
LOG_PATH     = BASE_DIR / "manager.log"
CONFIG_PATH  = BASE_DIR / "manager_config.json"

MANAGER_PORT = 8765  # Port du manager UI
BACKEND_PORT = 3000  # Port du backend Node.js

# ── Logging ───────────────────────────────────────────────────────────────────
def log(msg, level="INFO"):
    ts = datetime.datetime.now().strftime("%H:%M:%S")
    line = f"[{ts}] [{level}] {msg}"
    print(line)
    try:
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except:
        pass

# ── Config ────────────────────────────────────────────────────────────────────
DEFAULT_CONFIG = {
    "backend_port": 3000,
    "auto_start_backend": False,  # Désactivé — mode standalone
    "auto_backup": True,
    "backup_interval_hours": 24,
    "max_backups": 10,
    "theme": "dark",
    "last_backup": None,
}

def load_config():
    if CONFIG_PATH.exists():
        try:
            with open(CONFIG_PATH) as f:
                c = json.load(f)
                return {**DEFAULT_CONFIG, **c}
        except:
            pass
    return DEFAULT_CONFIG.copy()

def save_config(cfg):
    with open(CONFIG_PATH, "w") as f:
        json.dump(cfg, f, indent=2)

# ── Backend Node.js process ───────────────────────────────────────────────────
backend_process = None
backend_status  = {"running": False, "pid": None, "started_at": None, "uptime": 0}

def start_backend():
    global backend_process, backend_status
    if backend_status["running"]:
        return {"ok": False, "msg": "Déjà en cours d'exécution"}

    node_exe = shutil.which("node")
    if not node_exe:
        return {"ok": False, "msg": "Node.js introuvable. Installe Node.js >= 18."}

    server_js = BACKEND_DIR / "src" / "server.js"
    if not server_js.exists():
        log(f"[INFO] Backend Node.js non disponible (server.js introuvable) — fonctionnement en mode standalone.")
        return {"ok": False, "msg": f"Backend Node.js non disponible (mode standalone)"}

    env_file = BACKEND_DIR / ".env"
    if not env_file.exists():
        example = BACKEND_DIR / ".env.example"
        if example.exists():
            shutil.copy(example, env_file)
            log("Fichier .env créé depuis .env.example")

    env = os.environ.copy()
    env["NODE_ENV"] = "production"
    env["PORT"]     = str(BACKEND_PORT)
    env["DB_PATH"]  = str(DB_PATH)

    try:
        backend_process = subprocess.Popen(
            [node_exe, str(server_js)],
            cwd=str(BACKEND_DIR),
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        time.sleep(1.5)
        if backend_process.poll() is None:
            backend_status = {
                "running": True,
                "pid": backend_process.pid,
                "started_at": datetime.datetime.now().isoformat(),
                "uptime": 0,
            }
            log(f"Backend démarré (PID {backend_process.pid})")
            # Stream logs in background
            threading.Thread(target=_stream_logs, daemon=True).start()
            return {"ok": True, "pid": backend_process.pid}
        else:
            out = backend_process.stdout.read() if backend_process.stdout else ""
            return {"ok": False, "msg": f"Le processus s'est arrêté immédiatement:\n{out[:500]}"}
    except Exception as e:
        return {"ok": False, "msg": str(e)}

backend_log_buffer = []  # dernières 200 lignes

def _stream_logs():
    global backend_status
    if not backend_process or not backend_process.stdout:
        return
    for line in backend_process.stdout:
        line = line.rstrip()
        if line:
            backend_log_buffer.append({"t": time.time(), "msg": line})
            if len(backend_log_buffer) > 200:
                backend_log_buffer.pop(0)
    backend_status["running"] = False
    log("Backend arrêté (fin du flux)")

def stop_backend():
    global backend_process, backend_status
    if not backend_status["running"] or not backend_process:
        return {"ok": False, "msg": "Backend non actif"}
    try:
        backend_process.terminate()
        backend_process.wait(timeout=5)
    except:
        try:
            backend_process.kill()
        except:
            pass
    backend_status = {"running": False, "pid": None, "started_at": None, "uptime": 0}
    log("Backend arrêté manuellement")
    return {"ok": True}

def get_uptime():
    if backend_status["running"] and backend_status["started_at"]:
        start = datetime.datetime.fromisoformat(backend_status["started_at"])
        delta = datetime.datetime.now() - start
        h, r = divmod(int(delta.total_seconds()), 3600)
        m, s = divmod(r, 60)
        return f"{h:02d}:{m:02d}:{s:02d}"
    return "—"

# ── Database stats ────────────────────────────────────────────────────────────
def get_db_stats():
    # Utiliser SYNC_DB_PATH (joueurs Telegram) en priorité
    db = SYNC_DB_PATH if SYNC_DB_PATH.exists() else DB_PATH
    if not db.exists():
        return {"error": "Base de données introuvable", "users": 0, "top_players": [], "pending_withdrawals": []}
    try:
        conn = sqlite3.connect(str(db))
        cur = conn.cursor()
        stats = {}

        # Compter les joueurs
        try:
            cur.execute("SELECT COUNT(*) FROM users")
            stats["users"] = cur.fetchone()[0]
        except:
            stats["users"] = 0

        # Compter les cartes
        try:
            cur.execute("SELECT SUM(card_count) FROM game_state")
            stats["cards"] = cur.fetchone()[0] or 0
        except:
            stats["cards"] = 0

        # Compter les transactions (approximatif)
        stats["transactions"] = 0
        stats["withdraw_requests"] = 0
        stats["wallets"] = stats["users"]
        stats["game_state"] = stats["users"]

        # DB size
        stats["db_size_mb"] = round(db.stat().st_size / 1024 / 1024, 2)

        # Top players depuis SYNC_DB
        try:
            cur.execute("""
                SELECT u.username,
                       COALESCE(gs.myco, 0),
                       COALESCE(gs.ton, 0),
                       COALESCE(gs.total_harvested, 0)
                FROM game_state gs JOIN users u ON u.id = gs.user_id
                ORDER BY gs.total_harvested DESC LIMIT 5
            """)
            stats["top_players"] = [
                {"username": r[0], "myco": round(r[1], 0), "ton": round(r[2], 2), "harvested": r[3]}
                for r in cur.fetchall()
            ]
        except:
            stats["top_players"] = []

        # Pas de retraits dans SYNC_DB
        stats["pending_withdrawals"] = []

        # Joueurs actifs (7 derniers jours)
        try:
            since = int(time.time()) - 7 * 86400
            cur.execute("SELECT COUNT(*) FROM users WHERE last_login > ?", (since,))
            stats["users_new7d"] = cur.fetchone()[0]
        except:
            stats["users_new7d"] = 0

        # Total MYCO distribué
        try:
            cur.execute("SELECT SUM(myco) FROM game_state")
            stats["total_myco"] = cur.fetchone()[0] or 0
        except:
            stats["total_myco"] = 0

        # Recent registrations (last 7 days)
        try:
            since = int(time.time()) - 7 * 86400
            cur.execute("SELECT COUNT(*) FROM users WHERE created_at > ?", (since,))
            stats["new_users_7d"] = cur.fetchone()[0]
        except:
            stats["new_users_7d"] = 0

        conn.close()
        return stats
    except Exception as e:
        return {"error": str(e)}

# ── Backup ────────────────────────────────────────────────────────────────────
def create_backup(note="manual"):
    BACKUP_DIR.mkdir(exist_ok=True)
    ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    zip_path = BACKUP_DIR / f"backup_{ts}_{note}.zip"
    try:
        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
            if DB_PATH.exists():
                z.write(DB_PATH, "mushroom_farm.db")
            cfg = BACKEND_DIR / ".env"
            if cfg.exists():
                z.write(cfg, ".env")
        size_kb = round(zip_path.stat().st_size / 1024, 1)
        log(f"Backup créé: {zip_path.name} ({size_kb} KB)")
        # Cleanup old backups
        cfg = load_config()
        all_backups = sorted(BACKUP_DIR.glob("backup_*.zip"), key=lambda p: p.stat().st_mtime)
        while len(all_backups) > cfg.get("max_backups", 10):
            all_backups[0].unlink()
            all_backups.pop(0)
        cfg["last_backup"] = datetime.datetime.now().isoformat()
        save_config(cfg)
        return {"ok": True, "file": str(zip_path), "size_kb": size_kb}
    except Exception as e:
        return {"ok": False, "msg": str(e)}

def list_backups():
    BACKUP_DIR.mkdir(exist_ok=True)
    backups = []
    for p in sorted(BACKUP_DIR.glob("backup_*.zip"), key=lambda x: x.stat().st_mtime, reverse=True):
        backups.append({
            "name": p.name,
            "size_kb": round(p.stat().st_size / 1024, 1),
            "date": datetime.datetime.fromtimestamp(p.stat().st_mtime).strftime("%d/%m/%Y %H:%M"),
            "path": str(p),
        })
    return backups

def restore_backup(filename):
    zip_path = BACKUP_DIR / filename
    if not zip_path.exists():
        return {"ok": False, "msg": "Fichier introuvable"}
    if backend_status["running"]:
        return {"ok": False, "msg": "Arrête le backend avant de restaurer"}
    try:
        DB_PATH.parent.mkdir(exist_ok=True)
        with zipfile.ZipFile(zip_path, "r") as z:
            if "mushroom_farm.db" in z.namelist():
                z.extract("mushroom_farm.db", str(DB_PATH.parent))
        log(f"Backup restauré: {filename}")
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "msg": str(e)}

# ── System info ───────────────────────────────────────────────────────────────
def get_system_info():
    info = {
        "os": platform.system(),
        "os_version": platform.version()[:60],
        "python": platform.python_version(),
        "node": None,
        "cpu_percent": None,
        "ram_percent": None,
        "disk_free_gb": None,
    }
    node = shutil.which("node")
    if node:
        try:
            r = subprocess.run([node, "--version"], capture_output=True, text=True, timeout=3)
            info["node"] = r.stdout.strip()
        except:
            pass
    if HAS_PSUTIL:
        try:
            info["cpu_percent"]  = psutil.cpu_percent(interval=0.2)
            info["ram_percent"]  = psutil.virtual_memory().percent
            disk = psutil.disk_usage(str(BASE_DIR))
            info["disk_free_gb"] = round(disk.free / 1024**3, 1)
            if backend_process and backend_status["running"]:
                proc = psutil.Process(backend_process.pid)
                info["backend_cpu"] = proc.cpu_percent(interval=0.1)
                info["backend_ram_mb"] = round(proc.memory_info().rss / 1024**2, 1)
        except:
            pass
    return info

# ── npm install helper ────────────────────────────────────────────────────────
def run_npm_install():
    node_modules = BACKEND_DIR / "node_modules"
    if node_modules.exists():
        return {"ok": True, "msg": "node_modules déjà présent"}
    npm = shutil.which("npm")
    if not npm:
        return {"ok": False, "msg": "npm introuvable"}
    try:
        r = subprocess.run(
            [npm, "install", "--production"],
            cwd=str(BACKEND_DIR),
            capture_output=True, text=True, timeout=120
        )
        if r.returncode == 0:
            return {"ok": True, "msg": "Dépendances installées avec succès"}
        return {"ok": False, "msg": r.stderr[:500]}
    except Exception as e:
        return {"ok": False, "msg": str(e)}

# ── Flask app ─────────────────────────────────────────────────────────────────
app = Flask(__name__, template_folder="templates", static_folder="static")
app.secret_key = "mf_manager_local_key"

@app.route("/")
def index():
    return render_template("index.html")

@app.route("/game")
def game():
    for name in ["mushroom-farm.html", "mushroom-farm_22.html"]:
        p = BASE_DIR / name
        if p.exists():
            with open(p, "r", encoding="utf-8") as f:
                return f.read(), 200, {
                    "Content-Type": "text/html; charset=utf-8",
                    "Cache-Control": "no-cache, no-store, must-revalidate",
                    "Pragma": "no-cache",
                    "Expires": "0"
                }
    return "Fichier jeu introuvable dans " + str(BASE_DIR), 404

@app.route("/jeu")
def jeu():
    for name in ["mushroom-farm.html", "mushroom-farm_22.html"]:
        p = BASE_DIR / name
        if p.exists():
            with open(p, "r", encoding="utf-8") as f:
                return f.read(), 200, {
                    "Content-Type": "text/html; charset=utf-8",
                    "Cache-Control": "no-cache, no-store, must-revalidate",
                    "Pragma": "no-cache",
                    "Expires": "0"
                }
    return "Fichier jeu introuvable dans " + str(BASE_DIR), 404

@app.route("/static-files/<path:filename>")
def static_files(filename):
    """Sert les images et fichiers statiques depuis le dossier du jeu."""
    import mimetypes
    p = BASE_DIR / filename
    if not p.exists():
        return "Fichier introuvable", 404
    mime, _ = mimetypes.guess_type(str(p))
    return send_file(str(p), mimetype=mime or "application/octet-stream")

@app.after_request
def add_cors(response):
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    return response

@app.route("/api/status")
def api_status():
    return jsonify({
        "backend": {**backend_status, "uptime": get_uptime(), "port": BACKEND_PORT},
        "logs": backend_log_buffer[-30:],
        "system": get_system_info(),
    })

@app.route("/api/db")
def api_db():
    return jsonify(get_db_stats())

@app.route("/api/backend/start", methods=["POST"])
def api_start():
    return jsonify({"ok": True, "msg": "Mode standalone — backend Node.js non requis. Le jeu tourne directement sur Render ✅"})

@app.route("/api/backend/stop", methods=["POST"])
def api_stop():
    return jsonify({"ok": True, "msg": "Mode standalone actif."})

@app.route("/api/backup/create", methods=["POST"])
def api_backup():
    note = request.json.get("note", "manual") if request.json else "manual"
    return jsonify(create_backup(note))

@app.route("/api/backup/list")
def api_backup_list():
    return jsonify(list_backups())

@app.route("/api/backup/restore", methods=["POST"])
def api_backup_restore():
    filename = request.json.get("filename") if request.json else None
    if not filename:
        return jsonify({"ok": False, "msg": "filename requis"})
    return jsonify(restore_backup(filename))

@app.route("/api/backup/download/<filename>")
def api_backup_download(filename):
    p = BACKUP_DIR / filename
    if not p.exists():
        return jsonify({"error": "introuvable"}), 404
    return send_file(str(p), as_attachment=True)

@app.route("/api/npm-install", methods=["POST"])
def api_npm_install():
    return jsonify(run_npm_install())

@app.route("/api/config", methods=["GET", "POST"])
def api_config():
    if request.method == "POST":
        cfg = load_config()
        cfg.update(request.json or {})
        save_config(cfg)
        return jsonify({"ok": True})
    return jsonify(load_config())

@app.route("/api/sync", methods=["POST", "OPTIONS"])
def api_sync():
    if request.method == "OPTIONS":
        return "", 204
    data = request.json or {}
    player    = str(data.get("player", "Unknown"))[:32]
    telegram_id = str(data.get("telegram_id", ""))[:32]
    myco      = float(data.get("myco", 0))
    ton       = float(data.get("ton", 0))
    harvested = float(data.get("total_harvested", 0))
    address   = str(data.get("address", ""))[:64]
    lang      = str(data.get("lang", "fr"))[:8]
    cards     = int(data.get("card_count", 0))
    try:
        SYNC_DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(SYNC_DB_PATH))
        cur  = conn.cursor()
        cur.executescript("""
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                address TEXT, lang TEXT DEFAULT 'fr',
                telegram_id TEXT,
                is_active INTEGER DEFAULT 1,
                created_at INTEGER, last_login INTEGER
            );
            CREATE TABLE IF NOT EXISTS game_state (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER UNIQUE,
                myco REAL DEFAULT 0, ton REAL DEFAULT 0,
                total_harvested REAL DEFAULT 0, card_count INTEGER DEFAULT 0
            );
        """)
        now = int(time.time())
        cur.execute("""
            INSERT INTO users (username, address, lang, telegram_id, created_at, last_login)
            VALUES (?,?,?,?,?,?)
            ON CONFLICT(username) DO UPDATE SET
                last_login=excluded.last_login, address=excluded.address, telegram_id=excluded.telegram_id
        """, (player, address, lang, telegram_id, now, now))
        cur.execute("SELECT id FROM users WHERE username=?", (player,))
        row = cur.fetchone()
        if row:
            cur.execute("""
                INSERT INTO game_state (user_id, myco, ton, total_harvested, card_count)
                VALUES (?,?,?,?,?)
                ON CONFLICT(user_id) DO UPDATE SET
                    myco=excluded.myco, ton=excluded.ton,
                    total_harvested=excluded.total_harvested, card_count=excluded.card_count
            """, (row[0], myco, ton, harvested, cards))
        conn.commit()
        conn.close()
        log(f"Sync: {player} MYCO={myco:.0f} TON={ton:.2f}")
    except Exception as e:
        log(f"Erreur sync: {e}", "ERROR")
    return jsonify({"ok": True})

@app.route("/api/logs")
def api_logs():
    return jsonify({"logs": backend_log_buffer[-100:]})

@app.route("/api/db/users")
def api_db_users():
    if not SYNC_DB_PATH.exists():
        return jsonify([])
    try:
        conn = sqlite3.connect(str(SYNC_DB_PATH))
        conn.row_factory = sqlite3.Row
        cur = conn.cursor()
        cur.execute("PRAGMA table_info(users)")
        u_cols = [r[1] for r in cur.fetchall()]
        cur.execute("PRAGMA table_info(game_state)")
        gs_cols = [r[1] for r in cur.fetchall()]
        lang_s   = "COALESCE(u.lang,'fr')"         if "lang"            in u_cols  else "'fr'"
        addr_s   = "COALESCE(u.address,'')"         if "address"         in u_cols  else "''"
        active_s = "COALESCE(u.is_active,1)"        if "is_active"       in u_cols  else "1"
        login_s  = "u.last_login"                   if "last_login"      in u_cols  else "u.created_at"
        myco_s   = "COALESCE(gs.myco,0)"            if "myco"            in gs_cols else "0"
        ton_s    = "COALESCE(gs.ton,0)"             if "ton"             in gs_cols else "0"
        harv_s   = "COALESCE(gs.total_harvested,0)" if "total_harvested" in gs_cols else "0"
        cards_s  = "COALESCE(gs.card_count,0)"      if "card_count"      in gs_cols else "0"
        cur.execute(f"""
            SELECT u.id, u.username,
                   {lang_s} as lang, {addr_s} as address,
                   u.created_at, {login_s} as last_login,
                   {active_s} as is_active,
                   {myco_s} as myco, {ton_s} as ton,
                   {harv_s} as total_harvested, {cards_s} as card_count
            FROM users u LEFT JOIN game_state gs ON gs.user_id=u.id
            ORDER BY u.created_at DESC LIMIT 100
        """)
        users = [dict(r) for r in cur.fetchall()]
        conn.close()
        return jsonify(users)
    except Exception as e:
        return jsonify({"error": str(e)})

@app.route("/api/db/withdrawals")
def api_db_withdrawals():
    if not DB_PATH.exists():
        return jsonify([])
    try:
        conn = sqlite3.connect(str(DB_PATH))
        conn.row_factory = sqlite3.Row
        cur = conn.cursor()
        cur.execute("""
            SELECT wr.*, u.username FROM withdraw_requests wr
            JOIN users u ON u.id=wr.user_id
            ORDER BY wr.created_at DESC LIMIT 50
        """)
        rows = [dict(r) for r in cur.fetchall()]
        conn.close()
        return jsonify(rows)
    except Exception as e:
        return jsonify({"error": str(e)})

@app.route("/api/db/withdrawal/<req_id>/process", methods=["POST"])
def api_process_withdrawal(req_id):
    data = request.json or {}
    status = data.get("status")  # 'completed' | 'rejected'
    tx_hash = data.get("tx_hash", "")
    if status not in ("completed", "rejected"):
        return jsonify({"ok": False, "msg": "Status invalide"})
    try:
        conn = sqlite3.connect(str(DB_PATH))
        cur = conn.cursor()
        cur.execute("SELECT * FROM withdraw_requests WHERE id=?", (req_id,))
        req_row = cur.fetchone()
        if not req_row:
            conn.close()
            return jsonify({"ok": False, "msg": "Demande introuvable"})
        cols = [d[0] for d in cur.description]
        wr = dict(zip(cols, req_row))
        if wr["status"] != "pending":
            conn.close()
            return jsonify({"ok": False, "msg": "Déjà traitée"})
        now = int(time.time())
        cur.execute("UPDATE withdraw_requests SET status=?, tx_hash=?, processed_at=? WHERE id=?",
                    (status, tx_hash, now, req_id))
        if status == "rejected":
            cur_col = wr["currency"]
            cur.execute(
                f"UPDATE wallets SET balance=balance+?, locked=locked-? WHERE user_id=? AND currency=?",
                (wr["amount"], wr["amount"], wr["user_id"], cur_col)
            )
            if cur_col == "TON":
                cur.execute("UPDATE game_state SET ton=ton+? WHERE user_id=?", (wr["amount"], wr["user_id"]))
            else:
                cur.execute("UPDATE game_state SET myco=myco+? WHERE user_id=?", (wr["amount"], wr["user_id"]))
        else:
            cur.execute("UPDATE wallets SET locked=locked-? WHERE user_id=? AND currency=?",
                        (wr["amount"], wr["user_id"], wr["currency"]))
        conn.commit()
        conn.close()
        log(f"Retrait {req_id[:8]}... {status} par admin")
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"ok": False, "msg": str(e)})

# ── Auto-backup thread ────────────────────────────────────────────────────────
def auto_backup_thread():
    while True:
        time.sleep(3600)
        cfg = load_config()
        if not cfg.get("auto_backup"):
            continue
        last = cfg.get("last_backup")
        interval_h = cfg.get("backup_interval_hours", 24)
        if last:
            elapsed_h = (datetime.datetime.now() - datetime.datetime.fromisoformat(last)).total_seconds() / 3600
            if elapsed_h < interval_h:
                continue
        create_backup("auto")

# ── Startup ───────────────────────────────────────────────────────────────────
def open_browser():
    time.sleep(1.2)
    webbrowser.open(f"http://localhost:{MANAGER_PORT}")


BOT_TOKEN = os.environ.get("BOT_TOKEN", "")
GAME_URL_PUBLIC = os.environ.get("GAME_URL", "https://mushroomfarm-majn.onrender.com/game")

ADMIN_ID = 6846065758

def tg_send(chat_id, text, keyboard=None):
    import urllib.request as _ureq, json as _json
    payload = {"chat_id": chat_id, "text": text, "parse_mode": "HTML"}
    if keyboard:
        payload["reply_markup"] = keyboard
    try:
        req = _ureq.Request(
            f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage",
            data=_json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"}
        )
        _ureq.urlopen(req)
    except Exception as e:
        print(f"TG error: {e}")

def admin_text():
    stats = get_db_stats()
    if stats.get("error"):
        return "Erreur DB"
    lines = [
        "🍄 <b>MUSHROOM FARM — ADMIN</b>",
        "",
        f"👥 Joueurs : <b>{stats.get('users',0)}</b>",
        f"🟢 Actifs 7j : <b>{stats.get('users_new7d',0)}</b>",
        f"🃏 Cartes : <b>{stats.get('cards',0)}</b>",
        f"💾 DB : <b>{stats.get('db_size_mb',0)} MB</b>",
        "",
    ]
    top = stats.get("top_players", [])
    if top:
        lines.append("🏆 <b>Top joueurs</b>")
        medals = ["🥇","🥈","🥉","4️⃣","5️⃣"]
        for i, p in enumerate(top[:5]):
            lines.append(f"{medals[i]} <b>{p['username']}</b> — {int(p['myco']):,} MYCO | {p['ton']:.2f} TON")
        lines.append("")
    try:
        conn = sqlite3.connect(str(SYNC_DB_PATH))
        cur = conn.cursor()
        cur.execute(
            "SELECT u.username, u.lang, u.is_active, COALESCE(gs.myco,0), COALESCE(gs.ton,0) "
            "FROM users u LEFT JOIN game_state gs ON gs.user_id = u.id "
            "ORDER BY u.last_login DESC LIMIT 20"
        )
        rows = cur.fetchall()
        conn.close()
        if rows:
            lines.append("👥 <b>Joueurs récents</b>")
            for r in rows:
                st = "✅" if r[2] else "🚫"
                lines.append(f"{st} <b>{r[0]}</b> [{r[1]}] — {int(r[3]):,} MYCO | {r[4]:.2f} TON")
    except Exception as e:
        lines.append(f"⚠️ {e}")
    return "\n".join(lines)

@app.route("/telegram/webhook", methods=["POST"])
def telegram_webhook():
    update = request.json or {}
    if "message" in update:
        msg = update["message"]
        chat_id = msg["chat"]["id"]
        user_id = msg["from"]["id"]
        text = msg.get("text", "")
        if text == "/start" and BOT_TOKEN:
            keyboard = {"inline_keyboard": [[{
                "text": "🍄 Jouer à Mushroom Farm",
                "web_app": {"url": GAME_URL_PUBLIC}
            }]]}
            tg_send(chat_id, "🍄 <b>Bienvenue sur Mushroom Farm!</b>\n\nFarme, cultive et gagne des MYCO tokens!", keyboard)
        elif text in ("/admin", "/stats") and BOT_TOKEN:
            if user_id != ADMIN_ID:
                tg_send(chat_id, "🚫 Accès refusé.")
            else:
                tg_send(chat_id, admin_text())
    return jsonify({"ok": True})
@app.route("/api/save", methods=["POST", "OPTIONS"])
def api_save():
    if request.method == "OPTIONS":
        return "", 204
    data = request.json or {}
    player = str(data.get("player", ""))[:32]
    state_json = data.get("state", "{}")
    if not player:
        return jsonify({"ok": False})
    try:
        SYNC_DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(SYNC_DB_PATH))
        cur = conn.cursor()
        cur.execute("""
            CREATE TABLE IF NOT EXISTS saves (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                state TEXT,
                updated_at INTEGER
            )
        """)
        now = int(time.time())
        cur.execute("""
            INSERT INTO saves (username, state, updated_at)
            VALUES (?,?,?)
            ON CONFLICT(username) DO UPDATE SET
                state=excluded.state, updated_at=excluded.updated_at
        """, (player, state_json, now))
        conn.commit()
        conn.close()
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)})

@app.route("/api/load/<username>", methods=["GET"])
def api_load(username):
    try:
        conn = sqlite3.connect(str(SYNC_DB_PATH))
        cur = conn.cursor()
        cur.execute("SELECT state FROM saves WHERE username=?", (username,))
        row = cur.fetchone()
        conn.close()
        if row:
            return jsonify({"ok": True, "state": row[0]})
        return jsonify({"ok": False})
    except:
        return jsonify({"ok": False})
    
if __name__ == "__main__":
    log("=== MushroomFarm Manager démarré ===")
    log(f"Dossier: {BASE_DIR}")

    cfg = load_config()

    # Auto-start backend if configured
    if cfg.get("auto_start_backend") and (BACKEND_DIR / "src" / "server.js").exists():
        log("Démarrage automatique du backend...")
        threading.Thread(target=start_backend, daemon=True).start()

    # Auto-backup thread
    threading.Thread(target=auto_backup_thread, daemon=True).start()

    # Open browser
    threading.Thread(target=open_browser, daemon=True).start()

    log(f"Interface disponible sur http://localhost:{MANAGER_PORT}")
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", MANAGER_PORT)), debug=False, use_reloader=False)
