#!/usr/bin/env python3
"""Local booking demo: Python 3.9+, SQLite; no external dependencies.

SQLite triggers protect half-open occupied intervals even across processes.
Only public/ is served. The default bind address is loopback; this is not a
production HTTP server. All times use the studio's Europe/Moscow clock.
"""
import argparse
import hashlib
import hmac
import json
import mimetypes
import os
import re
import secrets
import sqlite3
from contextlib import contextmanager
from datetime import date, datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "public"
MOSCOW = timezone(timedelta(hours=3), "Europe/Moscow")
MAX_BODY = 8192
PUBLIC_FIELDS = ("id", "serviceId", "staffId", "date", "time", "duration", "price", "name", "status", "createdAt")
SCHEMA = """
CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY,
  serviceId TEXT NOT NULL,
  staffId TEXT NOT NULL,
  date TEXT NOT NULL,
  time TEXT NOT NULL,
  startMinute INTEGER NOT NULL CHECK(startMinute >= 600),
  endMinute INTEGER NOT NULL CHECK(endMinute <= 1200 AND endMinute > startMinute),
  duration INTEGER NOT NULL,
  price INTEGER NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('confirmed', 'cancelled')),
  createdAt TEXT NOT NULL,
  tokenHash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS booking_availability ON bookings(staffId,date,status,startMinute,endMinute);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS idempotency (
  keyHash TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, response TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS prevent_overlap_insert BEFORE INSERT ON bookings
WHEN NEW.status = 'confirmed' AND EXISTS (
  SELECT 1 FROM bookings b WHERE b.status='confirmed'
  AND b.staffId=NEW.staffId AND b.date=NEW.date
  AND b.startMinute < NEW.endMinute AND b.endMinute > NEW.startMinute
)
BEGIN SELECT RAISE(ABORT, 'booking_overlap'); END;
CREATE TRIGGER IF NOT EXISTS prevent_overlap_update BEFORE UPDATE ON bookings
WHEN NEW.status = 'confirmed' AND EXISTS (
  SELECT 1 FROM bookings b WHERE b.status='confirmed' AND b.id <> NEW.id
  AND b.staffId=NEW.staffId AND b.date=NEW.date
  AND b.startMinute < NEW.endMinute AND b.endMinute > NEW.startMinute
)
BEGIN SELECT RAISE(ABORT, 'booking_overlap'); END;
"""


class APIError(Exception):
    def __init__(self, status, message, code="invalid_request"):
        self.status, self.message, self.code = status, message, code
        super().__init__(message)


def digest(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def public_booking(row):
    return {key: row[key] for key in PUBLIC_FIELDS}


class BookingStore:
    def __init__(self, db_path, catalog_path=None, clock=None):
        self.path = str(db_path)
        Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self.catalog = json.loads(Path(catalog_path or PUBLIC / "catalog.json").read_text(encoding="utf-8"))
        self.services = {item["id"]: item for item in self.catalog["services"]}
        self.staff = {item["id"]: item for item in self.catalog["staff"]}
        self.clock = clock or (lambda: datetime.now(MOSCOW))
        with self.connect() as connection:
            connection.execute("PRAGMA journal_mode=WAL")
            connection.executescript(SCHEMA)
            connection.execute("INSERT OR IGNORE INTO settings(key,value) VALUES ('replay_secret',?)", (secrets.token_hex(32),))
            self.replay_secret = bytes.fromhex(connection.execute("SELECT value FROM settings WHERE key='replay_secret'").fetchone()[0])

    @contextmanager
    def connect(self):
        connection = sqlite3.connect(self.path, timeout=15, isolation_level=None)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA busy_timeout=15000")
        try:
            yield connection
        finally:
            connection.close()

    @staticmethod
    def request_key(key):
        if key is not None and (not isinstance(key, str) or not re.fullmatch(r"[A-Za-z0-9_-]{20,128}", key)):
            raise APIError(400, "Idempotency-Key должен содержать 20–128 латинских букв, цифр, _ или -.")
        return digest(key) if key else None

    @staticmethod
    def fingerprint(operation, data):
        return digest(operation + "\n" + json.dumps(data, sort_keys=True, ensure_ascii=False, separators=(",", ":")))

    def replay_token(self, key):
        # The DB stores a server secret and a token hash, never the clear owner token.
        return hmac.new(self.replay_secret, ("booking:" + key).encode(), hashlib.sha256).hexdigest()

    @staticmethod
    def replay(connection, key_hash, fingerprint):
        if key_hash is None:
            return None
        row = connection.execute("SELECT fingerprint,response FROM idempotency WHERE keyHash=?", (key_hash,)).fetchone()
        if row is None:
            return None
        if not hmac.compare_digest(row["fingerprint"], fingerprint):
            raise APIError(409, "Этот ключ повтора уже использован для другого действия или других данных.", "idempotency_conflict")
        return json.loads(row["response"])

    @staticmethod
    def remember(connection, key_hash, fingerprint, response):
        if key_hash:
            connection.execute("INSERT INTO idempotency VALUES (?,?,?)", (key_hash, fingerprint, json.dumps(response, ensure_ascii=False)))

    def today(self):
        return self.clock().astimezone(MOSCOW).date()

    def get_catalog(self):
        return dict(self.catalog, mode="server", today=self.today().isoformat())

    def validate_slot(self, service_id, staff_id, day, time=None):
        if not isinstance(service_id, str) or service_id not in self.services:
            raise APIError(400, "Выберите услугу из каталога.")
        if not isinstance(staff_id, str) or staff_id not in self.staff:
            raise APIError(400, "Выберите сотрудника из каталога.")
        if service_id not in self.staff[staff_id]["services"]:
            raise APIError(400, "Этот сотрудник не оказывает выбранную услугу.")
        if not isinstance(day, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", day):
            raise APIError(400, "Укажите дату в формате ГГГГ-ММ-ДД.")
        try:
            selected = date.fromisoformat(day)
        except ValueError:
            raise APIError(400, "Такой даты нет в календаре.")
        today = self.today()
        if not today < selected <= today + timedelta(days=30):
            raise APIError(400, "Запись доступна с завтрашнего дня на 30 дней вперёд.")
        if time is None:
            return self.services[service_id], None
        if not isinstance(time, str) or not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", time):
            raise APIError(400, "Укажите время в формате ЧЧ:ММ.")
        hour, minute = map(int, time.split(":"))
        start = hour * 60 + minute
        service = self.services[service_id]
        if minute not in (0, 30) or start < 600 or start + service["duration"] > 1200:
            raise APIError(400, "Сеанс должен полностью помещаться в часы работы 10:00–20:00; шаг 30 минут.")
        return service, start

    @staticmethod
    def validate_fields(data, allowed, required):
        if not isinstance(data, dict) or set(data) - allowed or required - set(data):
            raise APIError(400, "Неполные или неизвестные поля запроса.")

    @staticmethod
    def authenticate(row, token, is_admin=False):
        if not is_admin and (not isinstance(token, str) or not hmac.compare_digest(row["tokenHash"], digest(token))):
            raise APIError(403, "Для этой записи нужен её секретный ключ.", "forbidden")

    def slots(self, service_id, staff_id, day, exclude=None, token=None, is_admin=False):
        service, _ = self.validate_slot(service_id, staff_id, day)
        with self.connect() as connection:
            if exclude:
                row = connection.execute("SELECT * FROM bookings WHERE id=?", (exclude,)).fetchone()
                if row is None:
                    raise APIError(404, "Запись не найдена.", "not_found")
                self.authenticate(row, token, is_admin)
            occupied = connection.execute(
                "SELECT startMinute,endMinute FROM bookings WHERE staffId=? AND date=? AND status='confirmed' AND id<>?",
                (staff_id, day, exclude or ""),
            ).fetchall()
        return {"slots": ["%02d:%02d" % divmod(start, 60)
                          for start in range(600, 1201 - service["duration"], 30)
                          if not any(row["startMinute"] < start + service["duration"] and row["endMinute"] > start for row in occupied)]}

    def create(self, data, request_key=None):
        self.validate_fields(data, {"serviceId", "staffId", "date", "time", "name"}, {"serviceId", "staffId", "date", "time", "name"})
        key_hash = self.request_key(request_key)
        fingerprint = self.fingerprint("POST /api/bookings", data)
        if not isinstance(data["name"], str):
            raise APIError(400, "Укажите демонстрационное имя (2–60 символов).")
        name = data["name"].strip()
        if not 2 <= len(name) <= 60 or any(ord(char) < 32 or ord(char) == 127 for char in name):
            raise APIError(400, "Укажите демонстрационное имя (2–60 символов) без управляющих символов.")
        token = self.replay_token(request_key) if key_hash else secrets.token_urlsafe(32)
        booking_id = secrets.token_urlsafe(18)
        created_at = self.clock().astimezone(timezone.utc).isoformat()
        with self.connect() as connection:
            try:
                connection.execute("BEGIN IMMEDIATE")
                replay = self.replay(connection, key_hash, fingerprint)
                if replay is not None:
                    connection.commit()
                    return dict(replay, token=token)
                service, start = self.validate_slot(data["serviceId"], data["staffId"], data["date"], data["time"])
                connection.execute("""INSERT INTO bookings
                    (id,serviceId,staffId,date,time,startMinute,endMinute,duration,price,name,status,createdAt,tokenHash)
                    VALUES (?,?,?,?,?,?,?,?,?,?,'confirmed',?,?)""",
                    (booking_id, service["id"], data["staffId"], data["date"], data["time"], start,
                     start + service["duration"], service["duration"], service["price"], name, created_at, digest(token)))
                row = connection.execute("SELECT * FROM bookings WHERE id=?", (booking_id,)).fetchone()
                self.remember(connection, key_hash, fingerprint, {"booking": public_booking(row)})
                connection.commit()
            except sqlite3.IntegrityError as error:
                connection.rollback()
                if "booking_overlap" in str(error):
                    raise APIError(409, "Это время уже занято. Выберите другое окно.", "conflict")
                raise
        return {"booking": public_booking(row), "token": token}

    def get(self, booking_id, token=None, is_admin=False):
        with self.connect() as connection:
            row = connection.execute("SELECT * FROM bookings WHERE id=?", (booking_id,)).fetchone()
            if row is None:
                raise APIError(404, "Запись не найдена.", "not_found")
            self.authenticate(row, token, is_admin)
            return {"booking": public_booking(row)}

    def update(self, booking_id, data=None, token=None, is_admin=False, cancel=False, request_key=None):
        if not cancel:
            self.validate_fields(data, {"date", "time", "staffId"}, {"date", "time", "staffId"})
        key_hash = self.request_key(request_key)
        fingerprint = self.fingerprint(("DELETE " if cancel else "PATCH ") + booking_id, data if not cancel else {})
        with self.connect() as connection:
            try:
                connection.execute("BEGIN IMMEDIATE")
                row = connection.execute("SELECT * FROM bookings WHERE id=?", (booking_id,)).fetchone()
                if row is None:
                    raise APIError(404, "Запись не найдена.", "not_found")
                self.authenticate(row, token, is_admin)
                replay = self.replay(connection, key_hash, fingerprint)
                if replay is not None:
                    connection.commit()
                    return replay
                if cancel:
                    connection.execute("UPDATE bookings SET status='cancelled' WHERE id=?", (booking_id,))
                else:
                    if row["status"] != "confirmed":
                        raise APIError(409, "Отменённую запись нельзя перенести. Создайте новую.", "conflict")
                    _, start = self.validate_slot(row["serviceId"], data["staffId"], data["date"], data["time"])
                    connection.execute("UPDATE bookings SET staffId=?,date=?,time=?,startMinute=?,endMinute=? WHERE id=?",
                                       (data["staffId"], data["date"], data["time"], start, start + row["duration"], booking_id))
                result = connection.execute("SELECT * FROM bookings WHERE id=?", (booking_id,)).fetchone()
                self.remember(connection, key_hash, fingerprint, {"booking": public_booking(result)})
                connection.commit()
                return {"booking": public_booking(result)}
            except Exception as error:
                connection.rollback()
                if isinstance(error, sqlite3.IntegrityError) and "booking_overlap" in str(error):
                    raise APIError(409, "Это время уже занято. Прежняя запись сохранена.", "conflict")
                raise

    def list_all(self):
        with self.connect() as connection:
            rows = connection.execute("SELECT * FROM bookings ORDER BY date,time,createdAt").fetchall()
            return {"bookings": [public_booking(row) for row in rows]}


class BookingServer(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 64

    def __init__(self, address, store, admin_token=None, public_path=None):
        self.store, self.admin_token = store, admin_token
        self.public_path = Path(public_path or PUBLIC).resolve()
        super().__init__(address, BookingHandler)


class BookingHandler(BaseHTTPRequestHandler):
    server_version = "LiniyaLocal/1.0"
    sys_version = ""

    def log_message(self, format, *args):
        pass  # Do not log names, query strings or credentials.

    def security_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")

    def json_response(self, status, value):
        body = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.security_headers()
        self.end_headers()
        self.wfile.write(body)

    def check_host_and_origin(self):
        port = self.server.server_port
        hosts = {"127.0.0.1:%d" % port, "localhost:%d" % port}
        if port == 80:
            hosts.update(("127.0.0.1", "localhost"))
        host = self.headers.get("Host", "")
        if host not in hosts:
            raise APIError(403, "Разрешён только локальный адрес сервера.", "forbidden")
        origin = self.headers.get("Origin")
        if origin and origin != "http://" + host:
            raise APIError(403, "Запросы с другого сайта запрещены.", "forbidden")
        if self.headers.get("Sec-Fetch-Site") == "cross-site":
            raise APIError(403, "Запросы с другого сайта запрещены.", "forbidden")

    def read_body(self):
        if self.headers.get("Transfer-Encoding"):
            raise APIError(400, "Потоковый запрос не поддерживается.")
        content_type = self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
        if content_type != "application/json":
            raise APIError(415, "Нужен Content-Type application/json.")
        raw_length = self.headers.get("Content-Length", "")
        if not raw_length.isdigit():
            raise APIError(400, "Нужна длина тела запроса.")
        length = int(raw_length)
        if length > MAX_BODY:
            raise APIError(413, "Слишком большой запрос.")
        try:
            body = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise APIError(400, "Повреждённый JSON.")
        if not isinstance(body, dict):
            raise APIError(400, "JSON должен быть объектом.")
        return body

    def is_admin(self):
        configured = self.server.admin_token
        supplied = self.headers.get("Authorization", "")
        return bool(configured and supplied.startswith("Bearer ") and hmac.compare_digest(digest(supplied[7:]), digest(configured)))

    def require_admin(self):
        if not self.server.admin_token:
            raise APIError(503, "Администратор отключён: задайте STUDIO_ADMIN_TOKEN при запуске сервера.", "admin_disabled")
        if not self.is_admin():
            raise APIError(403, "Неверный ключ администратора.", "forbidden")

    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def static_response(self, path, head=False):
        decoded = unquote(path)
        if "\\" in decoded or "\x00" in decoded or any(part.startswith(".") for part in decoded.split("/") if part):
            raise APIError(404, "Страница не найдена.", "not_found")
        target = (self.server.public_path / (decoded.lstrip("/") or "index.html")).resolve()
        if not target.is_relative_to(self.server.public_path) or not target.is_file():
            raise APIError(404, "Страница не найдена.", "not_found")
        body = target.read_bytes()
        content_type = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", content_type + ("; charset=utf-8" if content_type.startswith("text/") or content_type in ("application/json", "application/javascript") else ""))
        self.send_header("Content-Length", str(len(body)))
        self.security_headers()
        self.end_headers()
        if not head:
            self.wfile.write(body)

    def dispatch(self, method):
        try:
            self.check_host_and_origin()
            parsed = urlsplit(self.path)
            path = parsed.path
            store = self.server.store
            if not path.startswith("/api/"):
                if method not in ("GET", "HEAD"):
                    raise APIError(405, "Метод не поддерживается.", "method_not_allowed")
                return self.static_response(path, method == "HEAD")
            if method == "GET" and path == "/api/catalog":
                return self.json_response(200, store.get_catalog())
            if method == "GET" and path == "/api/slots":
                query = parse_qs(parsed.query, keep_blank_values=True)
                if set(query) - {"service", "staff", "date", "exclude"} or any(len(value) != 1 for value in query.values()):
                    raise APIError(400, "Неизвестные или повторяющиеся параметры расписания.")
                return self.json_response(200, store.slots(
                    query.get("service", [None])[0], query.get("staff", [None])[0], query.get("date", [None])[0],
                    query.get("exclude", [None])[0], self.headers.get("X-Booking-Token"), self.is_admin()))
            if method == "GET" and path == "/api/admin/bookings":
                self.require_admin()
                return self.json_response(200, store.list_all())
            request_key = self.headers.get("Idempotency-Key")
            if method == "POST" and path == "/api/bookings":
                return self.json_response(201, store.create(self.read_body(), request_key=request_key))
            match = re.fullmatch(r"/api/bookings/([A-Za-z0-9_-]{24})", path)
            if match:
                booking_id = match.group(1)
                token, admin = self.headers.get("X-Booking-Token"), self.is_admin()
                if method == "GET":
                    return self.json_response(200, store.get(booking_id, token, admin))
                if method == "PATCH":
                    return self.json_response(200, store.update(booking_id, self.read_body(), token, admin, request_key=request_key))
                if method == "DELETE":
                    if self.headers.get("Transfer-Encoding") or self.headers.get("Content-Length", "0") != "0":
                        raise APIError(400, "Удаление не принимает тело запроса.")
                    return self.json_response(200, store.update(booking_id, token=token, is_admin=admin, cancel=True, request_key=request_key))
                raise APIError(405, "Метод не поддерживается.", "method_not_allowed")
            raise APIError(404, "Маршрут не найден.", "not_found")
        except APIError as error:
            self.json_response(error.status, {"error": error.message, "code": error.code})
        except sqlite3.OperationalError:
            self.json_response(503, {"error": "База временно недоступна. Повторите запрос с тем же ключом повтора.", "code": "storage_unavailable"})
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            pass
        except Exception:
            self.json_response(500, {"error": "Не удалось выполнить действие. Повторите запрос с тем же ключом повтора.", "code": "internal_error"})

    def do_GET(self):
        self.dispatch("GET")

    def do_HEAD(self):
        self.dispatch("HEAD")

    def do_POST(self):
        self.dispatch("POST")

    def do_PATCH(self):
        self.dispatch("PATCH")

    def do_DELETE(self):
        self.dispatch("DELETE")

    def do_OPTIONS(self):
        self.dispatch("OPTIONS")


def main():
    parser = argparse.ArgumentParser(description="Учебный локальный сервер студии «линия»; без внешних зависимостей.")
    parser.add_argument("--host", choices=("127.0.0.1", "localhost"), default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--db", type=Path, default=ROOT / "runtime" / "studio.sqlite3")
    args = parser.parse_args()
    admin_token = os.environ.get("STUDIO_ADMIN_TOKEN") or None
    if admin_token is not None and len(admin_token) < 24:
        parser.error("STUDIO_ADMIN_TOKEN должен содержать не менее 24 символов. Не используйте реальный пароль.")
    server = BookingServer((args.host, args.port), BookingStore(args.db), admin_token=admin_token)
    print("Учебная студия: http://%s:%d — локальная SQLite, Ctrl+C для остановки." % (args.host, server.server_port), flush=True)
    print("Кабинет администратора: " + ("включён" if admin_token else "отключён (STUDIO_ADMIN_TOKEN не задан)"), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
