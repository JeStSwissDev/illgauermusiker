import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import mysql from "mysql2/promise";
import multer from "multer";
import fs from "fs";
import path from "path";
import session from "express-session";
import { fileURLToPath } from "url";

dotenv.config();

const APP_VERSION = process.env.APP_VERSION || "dev";
const APP_STARTED_AT = new Date().toISOString();

console.log("=================================");
console.log("Musikarchiv gestartet");
console.log("Version:", APP_VERSION);
console.log("Startzeit:", APP_STARTED_AT);
console.log("DB_HOST:", process.env.DB_HOST || "(nicht gesetzt)");
console.log("DB_PORT:", process.env.DB_PORT || "(default 3306)");
console.log("DB_NAME:", process.env.DB_NAME || "(nicht gesetzt)");
console.log("DB_USER:", process.env.DB_USER || "(nicht gesetzt)");
console.log("=================================");

const app = express();
app.use(cors());
app.use(express.json());

app.use(session({
  secret: process.env.SESSION_SECRET || "change-me",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: false,
    maxAge: 1000 * 60 * 60 * 8
  }
}));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function requireAuthPage(req, res, next) {
  if (req.session?.isAuthenticated) return next();
  return res.redirect("/login.html");
}

function requireAuthApi(req, res, next) {
  if (req.session?.isAuthenticated) return next();
  return res.status(401).json({ ok: false, error: "Nicht eingeloggt" });
}

app.get("/add-musiker.html", requireAuthPage, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "add-musiker.html"));
});

app.get("/add-formation.html", requireAuthPage, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "add-formation.html"));
});

app.get("/add-genre.html", requireAuthPage, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "add-genre.html"));
});

app.get("/add-instrument.html", requireAuthPage, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "add-instrument.html"));
});

app.use(express.static(path.join(__dirname, "public")));

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
});

const ensureDir = (p) => {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
};

function safeDateOrNull(s) {
  if (s === undefined || s === null) return null;
  const t = String(s).trim();
  return t === "" ? null : t;
}

async function withTx(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

const publicDir = path.join(__dirname, "public");
const uploadsDir = path.join(publicDir, "uploads");
const uploadsMusikerDir = path.join(uploadsDir, "musiker");
const uploadsFormationDir = path.join(uploadsDir, "formation");
const tmpDir = path.join(uploadsDir, "_tmp");

ensureDir(uploadsMusikerDir);
ensureDir(uploadsFormationDir);
ensureDir(tmpDir);

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, tmpDir),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || "");
      cb(null, `${Date.now()}-${Math.random().toString(16).slice(2)}${ext}`);
    },
  }),
  limits: {
    fileSize: 25 * 1024 * 1024,
  },
});

app.get("/api/version", (req, res) => {
  res.json({
    version: APP_VERSION,
    startedAt: APP_STARTED_AT,
  });
});

app.post("/api/login", (req, res) => {
  const password = String(req.body?.password || "");
  const expected = process.env.ADMIN_PASSWORD || "";

  if (!expected) {
    return res.status(500).json({ ok: false, error: "ADMIN_PASSWORD nicht gesetzt" });
  }

  if (password !== expected) {
    return res.status(401).json({ ok: false, error: "Falsches Passwort" });
  }

  req.session.isAuthenticated = true;
  res.json({ ok: true });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

app.get("/api/me", (req, res) => {
  res.json({ authenticated: !!req.session?.isAuthenticated });
});

app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, db: true });
  } catch (e) {
    res.status(500).json({
      ok: false,
      db: false,
      message: e?.message,
      code: e?.code,
    });
  }
});

app.get("/api/debug", (req, res) => {
  res.json({ cwd: process.cwd(), dirname: __dirname });
});

app.get("/api/lookups/formationen", async (req, res) => {
  const [rows] = await pool.query("SELECT id, name FROM formation ORDER BY name");
  res.json(rows);
});

app.get("/api/lookups/musiker", async (req, res) => {
  const [rows] = await pool.query(
    "SELECT id, vorname, nachname FROM musiker ORDER BY nachname, vorname"
  );
  res.json(rows);
});

app.get("/api/lookups/instrumente", async (req, res) => {
  const [rows] = await pool.query("SELECT id, name FROM instrument ORDER BY name");
  res.json(rows);
});

app.get("/api/lookups/genres", async (req, res) => {
  const [rows] = await pool.query("SELECT id, name FROM genre ORDER BY name");
  res.json(rows);
});

app.get("/api/genre", async (req, res) => {
  const [rows] = await pool.query("SELECT id, name FROM genre ORDER BY name");
  res.json(rows);
});

app.get("/api/instrument", async (req, res) => {
  const [rows] = await pool.query("SELECT id, name FROM instrument ORDER BY name");
  res.json(rows);
});

app.post("/api/genre", requireAuthApi, async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    if (!name) return res.status(400).json({ ok: false, error: "name ist Pflicht" });

    const [r] = await pool.query("INSERT INTO genre (name) VALUES (?)", [name]);
    res.status(201).json({ ok: true, genre: { id: r.insertId, name } });
  } catch (e) {
    if (e?.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ ok: false, error: "Genre existiert bereits" });
    }
    res.status(500).json({ ok: false, message: e?.message, code: e?.code });
  }
});

app.post("/api/instrument", requireAuthApi, async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    if (!name) return res.status(400).json({ ok: false, error: "name ist Pflicht" });

    const [r] = await pool.query("INSERT INTO instrument (name) VALUES (?)", [name]);
    res.status(201).json({ ok: true, instrument: { id: r.insertId, name } });
  } catch (e) {
    if (e?.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ ok: false, error: "Instrument existiert bereits" });
    }
    res.status(500).json({ ok: false, message: e?.message, code: e?.code });
  }
});

app.get("/api/musiker/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "Ungültige ID" });

  const [musikerRows] = await pool.query("SELECT * FROM musiker WHERE id = ?", [id]);
  if (musikerRows.length === 0) return res.status(404).json({ error: "Musiker nicht gefunden" });

  const [instrumente] = await pool.query(
    `
    SELECT i.id, i.name
    FROM musiker_instrument mi
    JOIN instrument i ON i.id = mi.instrument_id
    WHERE mi.musiker_id = ?
    ORDER BY i.name
    `,
    [id]
  );

  const [formationen] = await pool.query(
    `
    SELECT f.id, f.name, f.gruendungsdatum, f.aufloesungsdatum,
           ms.eintrittsdatum, ms.austrittsdatum
    FROM mitgliedschaft ms
    JOIN formation f ON f.id = ms.formation_id
    WHERE ms.musiker_id = ?
    ORDER BY f.name
    `,
    [id]
  );

  const [machtMusikMit] = await pool.query(
    `
    SELECT DISTINCT m2.id, m2.vorname, m2.nachname
    FROM mitgliedschaft ms1
    JOIN mitgliedschaft ms2 ON ms1.formation_id = ms2.formation_id
    JOIN musiker m2 ON ms2.musiker_id = m2.id
    WHERE ms1.musiker_id = ?
      AND m2.id <> ?
    ORDER BY m2.nachname, m2.vorname
    `,
    [id, id]
  );

  res.json({ ...musikerRows[0], instrumente, formationen, machtMusikMit });
});

app.get("/api/formation/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "Ungültige ID" });

  const [formationRows] = await pool.query("SELECT * FROM formation WHERE id = ?", [id]);
  if (formationRows.length === 0) return res.status(404).json({ error: "Formation nicht gefunden" });

  const [genres] = await pool.query(
    `
    SELECT g.id, g.name
    FROM formation_genre fg
    JOIN genre g ON g.id = fg.genre_id
    WHERE fg.formation_id = ?
    ORDER BY g.name
    `,
    [id]
  );

  const [mitglieder] = await pool.query(
    `
    SELECT m.id, m.vorname, m.nachname,
           ms.eintrittsdatum, ms.austrittsdatum
    FROM mitgliedschaft ms
    JOIN musiker m ON m.id = ms.musiker_id
    WHERE ms.formation_id = ?
    ORDER BY m.nachname, m.vorname
    `,
    [id]
  );

  res.json({ ...formationRows[0], genres, mitglieder });
});

app.post("/api/musiker", requireAuthApi, upload.single("foto"), async (req, res) => {
  try {
    const { vorname, nachname, geburtsdatum, todesdatum, biografie, instrument_ids, formationen } =
      req.body;

    if (!vorname || !nachname || !geburtsdatum) {
      return res.status(400).json({ error: "vorname, nachname, geburtsdatum sind Pflicht" });
    }

    const instruments = instrument_ids ? JSON.parse(instrument_ids) : [];
    const memberships = formationen ? JSON.parse(formationen) : [];

    const result = await withTx(async (conn) => {
      const [r] = await conn.query(
        `
        INSERT INTO musiker (vorname, nachname, geburtsdatum, todesdatum, biografie, foto_path)
        VALUES (?, ?, ?, ?, ?, NULL)
        `,
        [vorname, nachname, geburtsdatum, safeDateOrNull(todesdatum), biografie || null]
      );

      const musikerId = r.insertId;

      let fotoPath = null;
      if (req.file) {
        const ext = path.extname(req.file.originalname || "") || ".jpg";
        const finalRel = `uploads/musiker/${musikerId}${ext}`;
        const finalAbs = path.join(publicDir, finalRel);
        fs.renameSync(req.file.path, finalAbs);
        fotoPath = finalRel;
        await conn.query("UPDATE musiker SET foto_path = ? WHERE id = ?", [fotoPath, musikerId]);
      }

      for (const instId of instruments) {
        if (!instId) continue;
        await conn.query(
          "INSERT IGNORE INTO musiker_instrument (musiker_id, instrument_id) VALUES (?, ?)",
          [musikerId, Number(instId)]
        );
      }

      for (const ms of memberships) {
        const formationId = Number(ms.formation_id);
        if (!formationId || !ms.eintrittsdatum) continue;
        await conn.query(
          `
          INSERT INTO mitgliedschaft (musiker_id, formation_id, eintrittsdatum, austrittsdatum)
          VALUES (?, ?, ?, ?)
          `,
          [musikerId, formationId, ms.eintrittsdatum, safeDateOrNull(ms.austrittsdatum)]
        );
      }

      return { id: musikerId, foto_path: fotoPath };
    });

    res.status(201).json({ ok: true, musiker: result });
  } catch (e) {
    res.status(500).json({ ok: false, message: e?.message, code: e?.code });
  }
});

app.post(
  "/api/formation",
  requireAuthApi,
  upload.fields([
    { name: "foto", maxCount: 1 },
    { name: "mp3", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const { name, gruendungsdatum, aufloesungsdatum, biografie, genre_ids, mitglieder } = req.body;

      if (!name || !gruendungsdatum) {
        return res.status(400).json({ error: "name, gruendungsdatum sind Pflicht" });
      }

      const genres = genre_ids ? JSON.parse(genre_ids) : [];
      const members = mitglieder ? JSON.parse(mitglieder) : [];

      const fotoFile = req.files?.foto?.[0] || null;
      const mp3File = req.files?.mp3?.[0] || null;

      const result = await withTx(async (conn) => {
        const [r] = await conn.query(
          `
          INSERT INTO formation (name, gruendungsdatum, aufloesungsdatum, biografie, foto_path, mp3_path)
          VALUES (?, ?, ?, ?, NULL, NULL)
          `,
          [name, gruendungsdatum, safeDateOrNull(aufloesungsdatum), biografie || null]
        );

        const formationId = r.insertId;

        let fotoPath = null;
        if (fotoFile) {
          const ext = path.extname(fotoFile.originalname || "") || ".jpg";
          const finalRel = `uploads/formation/${formationId}${ext}`;
          const finalAbs = path.join(publicDir, finalRel);
          fs.renameSync(fotoFile.path, finalAbs);
          fotoPath = finalRel;
          await conn.query("UPDATE formation SET foto_path = ? WHERE id = ?", [fotoPath, formationId]);
        }

        let mp3Path = null;
        if (mp3File) {
          const ext = path.extname(mp3File.originalname || "") || ".mp3";
          const finalRel = `uploads/formation/${formationId}${ext}`;
          const finalAbs = path.join(publicDir, finalRel);
          fs.renameSync(mp3File.path, finalAbs);
          mp3Path = finalRel;
          await conn.query("UPDATE formation SET mp3_path = ? WHERE id = ?", [mp3Path, formationId]);
        }

        for (const gId of genres) {
          if (!gId) continue;
          await conn.query(
            "INSERT IGNORE INTO formation_genre (formation_id, genre_id) VALUES (?, ?)",
            [formationId, Number(gId)]
          );
        }

        for (const ms of members) {
          const musikerId = Number(ms.musiker_id);
          if (!musikerId || !ms.eintrittsdatum) continue;
          await conn.query(
            `
            INSERT INTO mitgliedschaft (musiker_id, formation_id, eintrittsdatum, austrittsdatum)
            VALUES (?, ?, ?, ?)
            `,
            [musikerId, formationId, ms.eintrittsdatum, safeDateOrNull(ms.austrittsdatum)]
          );
        }

        return { id: formationId, foto_path: fotoPath, mp3_path: mp3Path };
      });

      res.status(201).json({ ok: true, formation: result });
    } catch (e) {
      res.status(500).json({ ok: false, message: e?.message, code: e?.code });
    }
  }
);

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const HOST = "0.0.0.0";
app.listen(PORT, HOST, () => {
  console.log(`Server läuft auf http://${HOST}:${PORT}`);
});