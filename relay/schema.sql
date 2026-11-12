-- LM Mini Player - banco D1 do servidor de salas (rode uma vez no console do D1).
CREATE TABLE IF NOT EXISTS rooms (
  code    TEXT PRIMARY KEY,
  v       INTEGER NOT NULL DEFAULT 0,      -- versao do estado (sobe a cada mudanca)
  state   TEXT NOT NULL DEFAULT 'null',    -- JSON: { vid, list, pos, playing, rate, at, by }
  members TEXT NOT NULL DEFAULT '{}',      -- JSON: { idDaPessoa: ultimaVezVisto }
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
