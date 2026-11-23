CREATE SCHEMA IF NOT EXISTS private;

CREATE TABLE private.app_user (
    id uuid PRIMARY KEY,
    singleton smallint NOT NULL DEFAULT 1 CHECK (singleton = 1),
    auth_subject uuid NOT NULL UNIQUE,
    email varchar(320) NOT NULL UNIQUE CHECK (char_length(btrim(email)) > 0),
    timezone varchar(64) NOT NULL DEFAULT 'Europe/Warsaw' CHECK (timezone = 'Europe/Warsaw'),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (singleton)
);

CREATE TABLE private.product (
    id uuid PRIMARY KEY,
    owner_id uuid NOT NULL REFERENCES private.app_user(id) ON DELETE CASCADE,
    name varchar(160) NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 160),
    basis_unit varchar(2) NOT NULL CHECK (basis_unit IN ('g', 'ml')),
    kcal_per_100 numeric(10,2) NOT NULL CHECK (kcal_per_100 >= 0),
    protein_per_100 numeric(10,2) NOT NULL CHECK (protein_per_100 >= 0),
    fat_per_100 numeric(10,2) NOT NULL CHECK (fat_per_100 >= 0),
    carbs_per_100 numeric(10,2) NOT NULL CHECK (carbs_per_100 >= 0),
    revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
    archived_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (owner_id, id)
);

CREATE TABLE private.meal_template (
    id uuid PRIMARY KEY,
    owner_id uuid NOT NULL REFERENCES private.app_user(id) ON DELETE CASCADE,
    name varchar(160) NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 160),
    revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
    archived_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (owner_id, id)
);

CREATE TABLE private.meal_template_item (
    id uuid PRIMARY KEY,
    owner_id uuid NOT NULL REFERENCES private.app_user(id) ON DELETE CASCADE,
    meal_template_id uuid NOT NULL,
    product_id uuid NOT NULL,
    quantity numeric(10,2) NOT NULL CHECK (quantity > 0),
    position integer NOT NULL CHECK (position >= 0),
    UNIQUE (meal_template_id, position),
    FOREIGN KEY (owner_id, meal_template_id)
        REFERENCES private.meal_template(owner_id, id) ON DELETE CASCADE,
    FOREIGN KEY (owner_id, product_id)
        REFERENCES private.product(owner_id, id)
);

CREATE TABLE private.diary_meal (
    id uuid PRIMARY KEY,
    owner_id uuid NOT NULL REFERENCES private.app_user(id) ON DELETE CASCADE,
    entry_date date NOT NULL,
    category varchar(16) NOT NULL CHECK (category IN ('breakfast', 'lunch', 'dinner', 'snack')),
    name varchar(160) NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 160),
    revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
    deleted_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (owner_id, id)
);

CREATE TABLE private.diary_item (
    id uuid PRIMARY KEY,
    owner_id uuid NOT NULL REFERENCES private.app_user(id) ON DELETE CASCADE,
    diary_meal_id uuid NOT NULL,
    product_id uuid NOT NULL,
    source_product_revision integer NOT NULL CHECK (source_product_revision > 0),
    product_name varchar(160) NOT NULL CHECK (char_length(btrim(product_name)) BETWEEN 1 AND 160),
    basis_unit varchar(2) NOT NULL CHECK (basis_unit IN ('g', 'ml')),
    kcal_per_100 numeric(10,2) NOT NULL CHECK (kcal_per_100 >= 0),
    protein_per_100 numeric(10,2) NOT NULL CHECK (protein_per_100 >= 0),
    fat_per_100 numeric(10,2) NOT NULL CHECK (fat_per_100 >= 0),
    carbs_per_100 numeric(10,2) NOT NULL CHECK (carbs_per_100 >= 0),
    quantity numeric(10,2) NOT NULL CHECK (quantity > 0),
    position integer NOT NULL CHECK (position >= 0),
    UNIQUE (diary_meal_id, position),
    FOREIGN KEY (owner_id, diary_meal_id)
        REFERENCES private.diary_meal(owner_id, id) ON DELETE CASCADE,
    FOREIGN KEY (owner_id, product_id)
        REFERENCES private.product(owner_id, id)
);

CREATE TABLE private.goal_version (
    id uuid PRIMARY KEY,
    owner_id uuid NOT NULL REFERENCES private.app_user(id) ON DELETE CASCADE,
    effective_from date NOT NULL,
    kcal_goal numeric(10,2) NOT NULL CHECK (kcal_goal > 0),
    protein_goal numeric(10,2) NOT NULL CHECK (protein_goal > 0),
    fat_goal numeric(10,2) NOT NULL CHECK (fat_goal > 0),
    carbs_goal numeric(10,2) NOT NULL CHECK (carbs_goal > 0),
    revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (owner_id, effective_from)
);

CREATE INDEX idx_product_owner_name ON private.product(owner_id, name);
CREATE INDEX idx_product_owner_archive ON private.product(owner_id, archived_at);
CREATE INDEX idx_template_owner_archive ON private.meal_template(owner_id, archived_at);
CREATE INDEX idx_template_item_product ON private.meal_template_item(owner_id, product_id);
CREATE INDEX idx_diary_owner_date ON private.diary_meal(owner_id, entry_date, deleted_at);
CREATE INDEX idx_diary_item_product ON private.diary_item(owner_id, product_id);
