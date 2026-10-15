-- Схема БД приложения ФК. Выполняется при каждом старте сервера, поэтому всё через IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS colleges (
    id          serial PRIMARY KEY,
    name        text NOT NULL UNIQUE,
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- Площадка = мастер-класс: название, этаж, кабинет
CREATE TABLE IF NOT EXISTS sites (
    id          serial PRIMARY KEY,
    college_id  integer NOT NULL REFERENCES colleges(id) ON DELETE CASCADE,
    name        text NOT NULL,
    floor       text NOT NULL DEFAULT '',
    room        text NOT NULL DEFAULT '',
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- Сотрудники (все роли, кроме участника)
CREATE TABLE IF NOT EXISTS users (
    id             serial PRIMARY KEY,
    login          text NOT NULL UNIQUE,
    password_hash  text NOT NULL,
    full_name      text NOT NULL DEFAULT '',
    role           text NOT NULL CHECK (role IN ('system_admin', 'college_admin', 'site_admin', 'specialist')),
    college_id     integer REFERENCES colleges(id) ON DELETE CASCADE,
    site_id        integer REFERENCES sites(id) ON DELETE CASCADE,
    is_active      boolean NOT NULL DEFAULT true,
    created_by     integer REFERENCES users(id) ON DELETE SET NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    -- админ колледжа и ниже всегда относятся к колледжу
    CHECK (role = 'system_admin' OR college_id IS NOT NULL),
    -- админ площадки и специалист всегда привязаны к площадке, остальные — нет
    CHECK ((role IN ('site_admin', 'specialist')) = (site_id IS NOT NULL))
);

-- Участник: code — публичный (лежит в QR), secret — личный токен доступа к своей странице
CREATE TABLE IF NOT EXISTS participants (
    id           serial PRIMARY KEY,
    code         text NOT NULL UNIQUE,
    secret       text NOT NULL UNIQUE,
    full_name    text NOT NULL DEFAULT '',
    institution  text NOT NULL DEFAULT '',
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Посещение площадки участником. Одна площадка — одно посещение — максимум 1 балл.
CREATE TABLE IF NOT EXISTS visits (
    id              serial PRIMARY KEY,
    site_id         integer NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    participant_id  integer NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
    scanned_by      integer REFERENCES users(id) ON DELETE SET NULL,
    scanned_at      timestamptz NOT NULL DEFAULT now(),
    points          integer NOT NULL DEFAULT 0 CHECK (points IN (0, 1)),
    awarded_by      integer REFERENCES users(id) ON DELETE SET NULL,
    awarded_at      timestamptz,
    UNIQUE (site_id, participant_id)
);

CREATE TABLE IF NOT EXISTS sessions (
    token       text PRIMARY KEY,
    user_id     integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  timestamptz NOT NULL DEFAULT now(),
    expires_at  timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS sites_college_idx ON sites(college_id);
CREATE INDEX IF NOT EXISTS users_site_idx ON users(site_id);
CREATE INDEX IF NOT EXISTS users_college_idx ON users(college_id);
CREATE INDEX IF NOT EXISTS visits_participant_idx ON visits(participant_id);
CREATE INDEX IF NOT EXISTS visits_awarded_by_idx ON visits(awarded_by);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
