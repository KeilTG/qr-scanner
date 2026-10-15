import asyncio
import hashlib
import hmac
import io
import os
import re
import secrets
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

import asyncpg
import segno
from fastapi import Depends, FastAPI, Header, HTTPException, Request, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parent
STATIC = ROOT.parent / "static"
DATABASE_URL = os.environ.get("DATABASE_URL", "postgresql://fk:fk@localhost:5432/fk")
SESSION_DAYS = 30
COOKIE = "fk_session"

ROLES = ("specialist", "site_admin", "college_admin", "system_admin")
ROLE_NAMES = {
    "specialist": "Специалист МК",
    "site_admin": "Администратор площадки",
    "college_admin": "Администратор колледжа",
    "system_admin": "Администратор системы",
}
CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # без похожих O/0, I/1
CODE_RE = re.compile(r"FK-[A-Z0-9]{6,12}")


# ---------------------------------------------------------------- БД

pool: asyncpg.Pool


async def connect_with_retry() -> asyncpg.Pool:
    # Postgres в Docker может стартовать дольше приложения
    for attempt in range(30):
        try:
            return await asyncpg.create_pool(DATABASE_URL, min_size=1, max_size=10)
        except (OSError, asyncpg.PostgresError) as e:
            print(f"БД недоступна ({e}), повтор {attempt + 1}/30…", flush=True)
            await asyncio.sleep(2)
    raise RuntimeError("Не удалось подключиться к PostgreSQL: " + DATABASE_URL)


async def bootstrap_admin() -> None:
    if await pool.fetchval("SELECT 1 FROM users WHERE role = 'system_admin' AND is_active"):
        return
    login = os.environ.get("ADMIN_LOGIN", "admin").strip().lower()
    password = os.environ.get("ADMIN_PASSWORD") or secrets.token_urlsafe(9)
    await pool.execute(
        """INSERT INTO users (login, password_hash, full_name, role) VALUES ($1, $2, 'Администратор системы', 'system_admin')
           ON CONFLICT (login) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = 'system_admin',
               college_id = NULL, site_id = NULL, is_active = true""",
        login, hash_password(password),
    )
    print("=" * 60, flush=True)
    print(f"Создан администратор системы: логин «{login}», пароль «{password}»", flush=True)
    print("=" * 60, flush=True)


@asynccontextmanager
async def lifespan(_: FastAPI):
    global pool
    pool = await connect_with_retry()
    await pool.execute((ROOT / "schema.sql").read_text(encoding="utf-8"))
    await pool.execute("DELETE FROM sessions WHERE expires_at < now()")
    await bootstrap_admin()
    yield
    await pool.close()


app = FastAPI(title="ФК — QR", lifespan=lifespan)


def rows(records) -> list[dict]:
    return [dict(r) for r in records]


# ---------------------------------------------------------------- Пароли и сессии

def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 200_000)
    return f"pbkdf2_sha256$200000${salt.hex()}${digest.hex()}"


def check_password(password: str, stored: str) -> bool:
    try:
        _, iterations, salt, digest = stored.split("$")
        calc = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), int(iterations))
        return hmac.compare_digest(calc.hex(), digest)
    except ValueError:
        return False


async def current_user(request: Request) -> dict:
    token = request.cookies.get(COOKIE)
    if not token:
        raise HTTPException(401, "Требуется вход")
    user = await pool.fetchrow(
        """SELECT u.id, u.login, u.full_name, u.role, u.college_id, u.site_id
           FROM sessions s JOIN users u ON u.id = s.user_id
           WHERE s.token = $1 AND s.expires_at > now() AND u.is_active""",
        token,
    )
    if not user:
        raise HTTPException(401, "Сессия истекла, войдите снова")
    return dict(user)


def require_role(*allowed: str):
    async def dep(user: dict = Depends(current_user)) -> dict:
        if user["role"] not in allowed:
            raise HTTPException(403, "Недостаточно прав")
        return user
    return dep


ADMINS = ("site_admin", "college_admin", "system_admin")
COLLEGE_ADMINS = ("college_admin", "system_admin")


# ---------------------------------------------------------------- Права доступа

def can_access_site(user: dict, site: dict) -> bool:
    if user["role"] == "system_admin":
        return True
    if user["role"] == "college_admin":
        return site["college_id"] == user["college_id"]
    return site["id"] == user["site_id"]


def site_scope(user: dict, alias: str, params: list) -> str:
    """SQL-условие «площадка alias доступна пользователю»; параметры добавляются в params."""
    if user["role"] == "system_admin":
        return "TRUE"
    if user["role"] == "college_admin":
        params.append(user["college_id"])
        return f"{alias}.college_id = ${len(params)}"
    params.append(user["site_id"])
    return f"{alias}.id = ${len(params)}"


async def get_site(site_id: int, user: dict) -> dict:
    site = await pool.fetchrow(
        "SELECT s.*, c.name AS college_name FROM sites s JOIN colleges c ON c.id = s.college_id WHERE s.id = $1",
        site_id,
    )
    if not site:
        raise HTTPException(404, "Площадка не найдена")
    if not can_access_site(user, dict(site)):
        raise HTTPException(403, "Нет доступа к этой площадке")
    return dict(site)


def can_manage(actor: dict, role: str, site: dict | None, college_id: int | None) -> bool:
    """Может ли actor создавать/менять пользователя с ролью role на площадке site / в колледже college_id."""
    if actor["role"] == "system_admin":
        return True
    if actor["role"] == "college_admin":
        return role in ("site_admin", "specialist") and site is not None and site["college_id"] == actor["college_id"]
    if actor["role"] == "site_admin":
        return role == "specialist" and site is not None and site["id"] == actor["site_id"]
    return False


# ---------------------------------------------------------------- Авторизация

class LoginIn(BaseModel):
    login: str
    password: str


@app.post("/api/auth/login")
async def login(data: LoginIn, request: Request, response: Response):
    user = await pool.fetchrow("SELECT * FROM users WHERE login = $1", data.login.strip().lower())
    if not user or not check_password(data.password, user["password_hash"]):
        raise HTTPException(401, "Неверный логин или пароль")
    if not user["is_active"]:
        raise HTTPException(403, "Учётная запись отключена")
    token = secrets.token_urlsafe(32)
    expires = datetime.now(timezone.utc) + timedelta(days=SESSION_DAYS)
    await pool.execute("INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, $3)", token, user["id"], expires)
    response.set_cookie(COOKIE, token, max_age=SESSION_DAYS * 86400, httponly=True, samesite="lax",
                        secure=request.url.scheme == "https")
    return {"ok": True}


@app.post("/api/auth/logout")
async def logout(request: Request, response: Response):
    token = request.cookies.get(COOKIE)
    if token:
        await pool.execute("DELETE FROM sessions WHERE token = $1", token)
    response.delete_cookie(COOKIE)
    return {"ok": True}


@app.get("/api/me")
async def me(user: dict = Depends(current_user)):
    college = site = None
    if user["college_id"]:
        college = dict(await pool.fetchrow("SELECT id, name FROM colleges WHERE id = $1", user["college_id"]))
    if user["site_id"]:
        site = dict(await pool.fetchrow("SELECT id, name, floor, room FROM sites WHERE id = $1", user["site_id"]))
    return {**user, "role_name": ROLE_NAMES[user["role"]], "college": college, "site": site}


class PasswordIn(BaseModel):
    old_password: str
    new_password: str = Field(min_length=6)


@app.post("/api/me/password")
async def change_own_password(data: PasswordIn, request: Request, user: dict = Depends(current_user)):
    stored = await pool.fetchval("SELECT password_hash FROM users WHERE id = $1", user["id"])
    if not check_password(data.old_password, stored):
        raise HTTPException(400, "Текущий пароль неверный")
    await pool.execute("UPDATE users SET password_hash = $1 WHERE id = $2", hash_password(data.new_password), user["id"])
    await pool.execute("DELETE FROM sessions WHERE user_id = $1 AND token <> $2", user["id"], request.cookies.get(COOKIE))
    return {"ok": True}


# ---------------------------------------------------------------- Участник

async def participant_by_token(token: str | None) -> dict:
    if not token:
        raise HTTPException(401, "Нет токена участника")
    p = await pool.fetchrow("SELECT * FROM participants WHERE secret = $1", token)
    if not p:
        raise HTTPException(404, "Участник не найден")
    return dict(p)


@app.post("/api/participant/register")
async def participant_register():
    for _ in range(10):
        code = "FK-" + "".join(secrets.choice(CODE_ALPHABET) for _ in range(8))
        secret = secrets.token_urlsafe(24)
        try:
            await pool.execute("INSERT INTO participants (code, secret) VALUES ($1, $2)", code, secret)
            return {"code": code, "secret": secret}
        except asyncpg.UniqueViolationError:
            continue
    raise HTTPException(500, "Не удалось создать код участника")


@app.get("/api/participant/me")
async def participant_me(x_participant_token: str | None = Header(default=None)):
    p = await participant_by_token(x_participant_token)
    visits = await pool.fetch(
        """SELECT s.name, s.floor, s.room, c.name AS college_name, v.scanned_at, v.points, v.awarded_at
           FROM visits v JOIN sites s ON s.id = v.site_id JOIN colleges c ON c.id = s.college_id
           WHERE v.participant_id = $1 ORDER BY v.scanned_at DESC""",
        p["id"],
    )
    return {
        "code": p["code"], "full_name": p["full_name"], "institution": p["institution"],
        "total_points": sum(v["points"] for v in visits), "visits": rows(visits),
    }


@app.get("/api/participant/qr.svg")
async def participant_qr(t: str):
    p = await participant_by_token(t)
    buf = io.BytesIO()
    segno.make(p["code"], error="m").save(buf, kind="svg", scale=10, border=2, dark="#000", light="#fff")
    return Response(buf.getvalue(), media_type="image/svg+xml", headers={"Cache-Control": "private, max-age=86400"})


# ---------------------------------------------------------------- Сканирование и баллы

class ScanIn(BaseModel):
    code: str
    site_id: int | None = None


VISIT_SELECT = """
    SELECT v.id, v.site_id, v.participant_id, p.code, p.full_name, p.institution, v.scanned_at, v.points,
           v.awarded_at, v.awarded_by, v.scanned_by,
           COALESCE(NULLIF(sb.full_name, ''), sb.login) AS scanned_by_name,
           COALESCE(NULLIF(ab.full_name, ''), ab.login) AS awarded_by_name
    FROM visits v
    JOIN participants p ON p.id = v.participant_id
    LEFT JOIN users sb ON sb.id = v.scanned_by
    LEFT JOIN users ab ON ab.id = v.awarded_by
"""


async def site_for_action(user: dict, site_id: int | None) -> dict:
    # Специалист и админ площадки всегда работают на своей площадке
    if user["role"] in ("specialist", "site_admin"):
        site_id = user["site_id"]
    if not site_id:
        raise HTTPException(400, "Выберите площадку")
    return await get_site(site_id, user)


@app.post("/api/scan")
async def scan(data: ScanIn, user: dict = Depends(current_user)):
    site = await site_for_action(user, data.site_id)
    m = CODE_RE.search(data.code.strip().upper())
    if not m:
        raise HTTPException(400, "Это не QR-код участника")
    p = await pool.fetchrow("SELECT id FROM participants WHERE code = $1", m.group(0))
    if not p:
        raise HTTPException(404, "Участник с таким QR-кодом не зарегистрирован")
    inserted = await pool.fetchval(
        """INSERT INTO visits (site_id, participant_id, scanned_by) VALUES ($1, $2, $3)
           ON CONFLICT (site_id, participant_id) DO NOTHING RETURNING id""",
        site["id"], p["id"], user["id"],
    )
    visit = await pool.fetchrow(VISIT_SELECT + " WHERE v.site_id = $1 AND v.participant_id = $2", site["id"], p["id"])
    return {"visit": dict(visit), "already_visited": inserted is None, "needs_info": not visit["full_name"]}


@app.get("/api/sites/{site_id}/visits")
async def site_visits(site_id: int, user: dict = Depends(current_user)):
    await get_site(site_id, user)
    return rows(await pool.fetch(VISIT_SELECT + " WHERE v.site_id = $1 ORDER BY v.scanned_at DESC", site_id))


async def visit_for_user(visit_id: int, user: dict) -> dict:
    visit = await pool.fetchrow("SELECT * FROM visits WHERE id = $1", visit_id)
    if not visit:
        raise HTTPException(404, "Посещение не найдено")
    await get_site(visit["site_id"], user)
    return dict(visit)


@app.post("/api/visits/{visit_id}/award")
async def award(visit_id: int, user: dict = Depends(current_user)):
    await visit_for_user(visit_id, user)
    updated = await pool.fetchval(
        "UPDATE visits SET points = 1, awarded_by = $2, awarded_at = now() WHERE id = $1 AND points = 0 RETURNING id",
        visit_id, user["id"],
    )
    if not updated:
        raise HTTPException(409, "Балл этому участнику на площадке уже начислен")
    return dict(await pool.fetchrow(VISIT_SELECT + " WHERE v.id = $1", visit_id))


@app.delete("/api/visits/{visit_id}/award")
async def revoke_award(visit_id: int, user: dict = Depends(require_role(*ADMINS))):
    await visit_for_user(visit_id, user)
    await pool.execute("UPDATE visits SET points = 0, awarded_by = NULL, awarded_at = NULL WHERE id = $1", visit_id)
    return dict(await pool.fetchrow(VISIT_SELECT + " WHERE v.id = $1", visit_id))


class ParticipantIn(BaseModel):
    full_name: str = Field(min_length=1, max_length=200)
    institution: str = Field(default="", max_length=300)


@app.patch("/api/participants/{participant_id}")
async def update_participant(participant_id: int, data: ParticipantIn, user: dict = Depends(current_user)):
    params: list = [participant_id]
    allowed = await pool.fetchval(
        f"""SELECT 1 FROM visits v JOIN sites s ON s.id = v.site_id
            WHERE v.participant_id = $1 AND {site_scope(user, 's', params)} LIMIT 1""",
        *params,
    )
    if not allowed:
        raise HTTPException(403, "Участник не посещал ваши площадки")
    await pool.execute(
        "UPDATE participants SET full_name = $2, institution = $3, updated_at = now() WHERE id = $1",
        participant_id, data.full_name.strip(), data.institution.strip(),
    )
    return {"ok": True}


# ---------------------------------------------------------------- Колледжи

class CollegeIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)


@app.get("/api/colleges")
async def list_colleges(user: dict = Depends(current_user)):
    params: list = []
    where = "TRUE"
    if user["role"] != "system_admin":
        params.append(user["college_id"])
        where = "c.id = $1"
    return rows(await pool.fetch(
        f"""SELECT c.id, c.name, c.created_at,
                   (SELECT count(*) FROM sites s WHERE s.college_id = c.id) AS sites,
                   (SELECT count(*) FROM users u WHERE u.college_id = c.id AND u.role = 'college_admin') AS admins
            FROM colleges c WHERE {where} ORDER BY c.name""",
        *params,
    ))


@app.post("/api/colleges")
async def create_college(data: CollegeIn, user: dict = Depends(require_role("system_admin"))):
    try:
        return dict(await pool.fetchrow("INSERT INTO colleges (name) VALUES ($1) RETURNING *", data.name.strip()))
    except asyncpg.UniqueViolationError:
        raise HTTPException(409, "Колледж с таким названием уже есть")


@app.patch("/api/colleges/{college_id}")
async def rename_college(college_id: int, data: CollegeIn, user: dict = Depends(require_role("system_admin"))):
    row = await pool.fetchrow("UPDATE colleges SET name = $2 WHERE id = $1 RETURNING *", college_id, data.name.strip())
    if not row:
        raise HTTPException(404, "Колледж не найден")
    return dict(row)


# ---------------------------------------------------------------- Площадки

class SiteIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    floor: str = Field(default="", max_length=50)
    room: str = Field(default="", max_length=50)
    college_id: int | None = None


SITE_SELECT = """
    SELECT s.id, s.college_id, s.name, s.floor, s.room, s.created_at, c.name AS college_name,
           (SELECT count(*) FROM users u WHERE u.site_id = s.id AND u.role = 'specialist') AS specialists,
           (SELECT count(*) FROM users u WHERE u.site_id = s.id AND u.role = 'site_admin') AS admins,
           (SELECT count(*) FROM visits v WHERE v.site_id = s.id) AS visits,
           (SELECT COALESCE(sum(v.points), 0) FROM visits v WHERE v.site_id = s.id) AS points
    FROM sites s JOIN colleges c ON c.id = s.college_id
"""


@app.get("/api/sites")
async def list_sites(college_id: int | None = None, user: dict = Depends(current_user)):
    params: list = []
    where = site_scope(user, "s", params)
    if college_id and user["role"] == "system_admin":
        params.append(college_id)
        where += f" AND s.college_id = ${len(params)}"
    return rows(await pool.fetch(SITE_SELECT + f" WHERE {where} ORDER BY c.name, s.name", *params))


@app.get("/api/sites/{site_id}")
async def site_detail(site_id: int, user: dict = Depends(current_user)):
    await get_site(site_id, user)
    return dict(await pool.fetchrow(SITE_SELECT + " WHERE s.id = $1", site_id))


@app.post("/api/sites")
async def create_site(data: SiteIn, user: dict = Depends(require_role(*COLLEGE_ADMINS))):
    college_id = user["college_id"] if user["role"] == "college_admin" else data.college_id
    if not college_id or not await pool.fetchval("SELECT 1 FROM colleges WHERE id = $1", college_id):
        raise HTTPException(400, "Выберите колледж")
    row = await pool.fetchrow(
        "INSERT INTO sites (college_id, name, floor, room) VALUES ($1, $2, $3, $4) RETURNING id",
        college_id, data.name.strip(), data.floor.strip(), data.room.strip(),
    )
    return dict(await pool.fetchrow(SITE_SELECT + " WHERE s.id = $1", row["id"]))


@app.patch("/api/sites/{site_id}")
async def update_site(site_id: int, data: SiteIn, user: dict = Depends(require_role(*COLLEGE_ADMINS))):
    await get_site(site_id, user)
    await pool.execute("UPDATE sites SET name = $2, floor = $3, room = $4 WHERE id = $1",
                       site_id, data.name.strip(), data.floor.strip(), data.room.strip())
    return dict(await pool.fetchrow(SITE_SELECT + " WHERE s.id = $1", site_id))


@app.delete("/api/sites/{site_id}")
async def delete_site(site_id: int, user: dict = Depends(require_role(*COLLEGE_ADMINS))):
    await get_site(site_id, user)
    if await pool.fetchval("SELECT 1 FROM visits WHERE site_id = $1 LIMIT 1", site_id):
        raise HTTPException(409, "На площадке уже есть посещения — удалить нельзя")
    await pool.execute("DELETE FROM sites WHERE id = $1", site_id)
    return {"ok": True}


@app.get("/api/sites/{site_id}/report")
async def site_report(site_id: int, user: dict = Depends(require_role(*ADMINS))):
    """Специалисты площадки с числом начисленных баллов + все посещения (участники и их баллы)."""
    site = await get_site(site_id, user)
    staff = await pool.fetch(
        """SELECT u.id, u.login, u.full_name, u.role, u.is_active,
                  count(v.id) AS points
           FROM users u LEFT JOIN visits v ON v.awarded_by = u.id AND v.site_id = $1 AND v.points > 0
           WHERE u.site_id = $1
              OR u.id IN (SELECT awarded_by FROM visits WHERE site_id = $1 AND awarded_by IS NOT NULL)
           GROUP BY u.id
           ORDER BY (u.role = 'specialist') DESC, points DESC, u.full_name""",
        site_id,
    )
    visits = await pool.fetch(VISIT_SELECT + " WHERE v.site_id = $1 ORDER BY v.scanned_at DESC", site_id)
    return {"site": site, "staff": rows(staff), "visits": rows(visits)}


# ---------------------------------------------------------------- Пользователи

class UserIn(BaseModel):
    login: str = Field(min_length=3, max_length=50, pattern=r"^[A-Za-z0-9_.\-]+$")
    password: str = Field(min_length=6, max_length=100)
    full_name: str = Field(default="", max_length=200)
    role: str
    site_id: int | None = None
    college_id: int | None = None


class UserPatch(BaseModel):
    full_name: str | None = Field(default=None, max_length=200)
    password: str | None = Field(default=None, min_length=6, max_length=100)
    is_active: bool | None = None
    site_id: int | None = None


async def resolve_binding(role: str, site_id: int | None, college_id: int | None) -> tuple[dict | None, int | None]:
    """Площадка и колледж для новой/изменённой роли."""
    if role in ("site_admin", "specialist"):
        site = await pool.fetchrow("SELECT * FROM sites WHERE id = $1", site_id) if site_id else None
        if not site:
            raise HTTPException(400, "Выберите площадку")
        return dict(site), site["college_id"]
    if role == "college_admin":
        if not college_id or not await pool.fetchval("SELECT 1 FROM colleges WHERE id = $1", college_id):
            raise HTTPException(400, "Выберите колледж")
        return None, college_id
    return None, None


@app.get("/api/users")
async def list_users(role: str | None = None, site_id: int | None = None, college_id: int | None = None,
                     user: dict = Depends(require_role(*ADMINS))):
    params: list = []
    cond = []
    if user["role"] == "college_admin":
        params.append(user["college_id"])
        cond.append(f"u.college_id = ${len(params)}")
    elif user["role"] == "site_admin":
        params.append(user["site_id"])
        cond.append(f"u.site_id = ${len(params)}")
    for col, val in (("u.role", role), ("u.site_id", site_id), ("u.college_id", college_id)):
        if val:
            params.append(val)
            cond.append(f"{col} = ${len(params)}")
    where = " AND ".join(cond) or "TRUE"
    return rows(await pool.fetch(
        f"""SELECT u.id, u.login, u.full_name, u.role, u.college_id, u.site_id, u.is_active, u.created_at,
                   c.name AS college_name, s.name AS site_name,
                   (SELECT count(*) FROM visits v WHERE v.awarded_by = u.id AND v.points > 0) AS points_awarded
            FROM users u LEFT JOIN colleges c ON c.id = u.college_id LEFT JOIN sites s ON s.id = u.site_id
            WHERE {where}
            ORDER BY array_position(ARRAY['system_admin','college_admin','site_admin','specialist'], u.role),
                     c.name NULLS FIRST, s.name NULLS FIRST, u.full_name""",
        *params,
    ))


@app.post("/api/users")
async def create_user(data: UserIn, user: dict = Depends(require_role(*ADMINS))):
    if data.role not in ROLES:
        raise HTTPException(400, "Неизвестная роль")
    site, college_id = await resolve_binding(data.role, data.site_id, data.college_id)
    if not can_manage(user, data.role, site, college_id):
        raise HTTPException(403, "Вы не можете создавать пользователей с этой ролью здесь")
    try:
        row = await pool.fetchrow(
            """INSERT INTO users (login, password_hash, full_name, role, college_id, site_id, created_by)
               VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, login, full_name, role, college_id, site_id""",
            data.login.strip().lower(), hash_password(data.password), data.full_name.strip(), data.role,
            college_id, site["id"] if site else None, user["id"],
        )
    except asyncpg.UniqueViolationError:
        raise HTTPException(409, "Такой логин уже занят")
    return dict(row)


@app.patch("/api/users/{user_id}")
async def update_user(user_id: int, data: UserPatch, user: dict = Depends(require_role(*ADMINS))):
    target = await pool.fetchrow("SELECT * FROM users WHERE id = $1", user_id)
    if not target:
        raise HTTPException(404, "Пользователь не найден")
    target = dict(target)
    site = dict(await pool.fetchrow("SELECT * FROM sites WHERE id = $1", target["site_id"])) if target["site_id"] else None
    if user["id"] != user_id and not can_manage(user, target["role"], site, target["college_id"]):
        raise HTTPException(403, "Нет прав на этого пользователя")
    if user["id"] == user_id and data.is_active is False:
        raise HTTPException(400, "Нельзя отключить самого себя")

    if data.site_id is not None and data.site_id != target["site_id"]:
        if target["role"] not in ("site_admin", "specialist"):
            raise HTTPException(400, "У этой роли нет площадки")
        new_site, college_id = await resolve_binding(target["role"], data.site_id, None)
        if not can_manage(user, target["role"], new_site, college_id):
            raise HTTPException(403, "Нет прав на эту площадку")
        await pool.execute("UPDATE users SET site_id = $2, college_id = $3 WHERE id = $1", user_id, new_site["id"], college_id)
    if data.full_name is not None:
        await pool.execute("UPDATE users SET full_name = $2 WHERE id = $1", user_id, data.full_name.strip())
    if data.password:
        await pool.execute("UPDATE users SET password_hash = $2 WHERE id = $1", user_id, hash_password(data.password))
        await pool.execute("DELETE FROM sessions WHERE user_id = $1", user_id)
    if data.is_active is not None:
        await pool.execute("UPDATE users SET is_active = $2 WHERE id = $1", user_id, data.is_active)
        if not data.is_active:
            await pool.execute("DELETE FROM sessions WHERE user_id = $1", user_id)
    return {"ok": True}


# ---------------------------------------------------------------- Рейтинг и статистика

@app.get("/api/rating")
async def rating(college_id: int | None = None, user: dict = Depends(require_role(*COLLEGE_ADMINS))):
    if user["role"] == "college_admin":
        college_id = user["college_id"]
    return rows(await pool.fetch(
        """SELECT RANK() OVER (ORDER BY sum(v.points) DESC) AS place,
                  p.id, p.code, p.full_name, p.institution,
                  sum(v.points) AS points, count(v.id) AS sites_visited, max(v.awarded_at) AS last_award
           FROM participants p JOIN visits v ON v.participant_id = p.id JOIN sites s ON s.id = v.site_id
           WHERE $1::int IS NULL OR s.college_id = $1
           GROUP BY p.id
           ORDER BY points DESC, last_award ASC NULLS LAST, p.full_name""",
        college_id,
    ))


@app.get("/api/stats")
async def stats(college_id: int | None = None, user: dict = Depends(require_role(*COLLEGE_ADMINS))):
    if user["role"] == "college_admin":
        college_id = user["college_id"]
    row = await pool.fetchrow(
        """SELECT
             (SELECT count(*) FROM sites s WHERE $1::int IS NULL OR s.college_id = $1) AS sites,
             (SELECT count(*) FROM users u WHERE u.role = 'site_admin' AND ($1::int IS NULL OR u.college_id = $1)) AS site_admins,
             (SELECT count(*) FROM users u WHERE u.role = 'specialist' AND ($1::int IS NULL OR u.college_id = $1)) AS specialists,
             (SELECT count(DISTINCT v.participant_id) FROM visits v JOIN sites s ON s.id = v.site_id
                WHERE $1::int IS NULL OR s.college_id = $1) AS participants,
             (SELECT count(*) FROM visits v JOIN sites s ON s.id = v.site_id
                WHERE $1::int IS NULL OR s.college_id = $1) AS visits,
             (SELECT COALESCE(sum(v.points), 0) FROM visits v JOIN sites s ON s.id = v.site_id
                WHERE $1::int IS NULL OR s.college_id = $1) AS points""",
        college_id,
    )
    return dict(row)


@app.get("/api/health")
async def health():
    await pool.fetchval("SELECT 1")
    return {"ok": True}


# Статика (интерфейс) — последней, чтобы не перекрывать /api
app.mount("/", StaticFiles(directory=STATIC, html=True), name="static")
