import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import mysql from "mysql2/promise";
import multer from "multer";
import fs from "fs";
import path from "path";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Static (index.html, uploads, formularseiten)
app.use(express.static("public"));

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
});

// ---------- Helpers ----------
const ensureDir = (p) => {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
};

const publicDir = path.resolve("public");
const uploadsDir = path.join(publicDir, "uploads");
const uploadsMusikerDir = path.join(uploadsDir, "musiker");
const uploadsFormationDir = path.join(uploadsDir, "formation");
const tmpDir = path.join(uploadsDir, "_tmp");

ensureDir(uploadsMusikerDir);
ensureDir(uploadsFormationDir);
ensureDir(tmpDir);

// Multer: erst in tmp speichern, danach nach <id> umbenennen
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, tmpDir),
    filename: (req, file, cb) => {
      // unique temp name
      const ext = path.extname(file.originalname || "");
      cb(null, `${Date.now()}-${Math.random().toString(16).slice(2)}${ext}`);
    },
  }),
  limits: {
    fileSize: 25 * 1024 * 1024, // 25MB (für mp3/bild ok; falls nötig erhöhen)
  },
});

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

// ---------- Health ----------
app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, db: true });
  } catch (e) {
    res.status(500).json({ ok: false, db: false, message: e?.message, code: e?.code });
  }
});

// ---------- Lookups für Formulare ----------
app.get("/api/lookups/formationen", async (req, res) => {
  const [rows] = await pool.query(
    "SELECT id, name FROM formation ORDER BY name"
  );
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

// ---------- GET Musiker / Formation (wie bei dir) ----------
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

// ---------- POST Musiker (multipart + Foto + Instrumente + Mitgliedschaften) ----------
app.post(
  "/api/musiker",
  upload.single("foto"),
  async (req, res) => {
    try {
      const {
        vorname,
        nachname,
        geburtsdatum,
        todesdatum,
        biografie,
        instrument_ids,   // JSON string: [1,2,3]
        formationen       // JSON string: [{formation_id, eintrittsdatum, austrittsdatum}]
      } = req.body;

      if (!vorname || !nachname || !geburtsdatum) {
        return res.status(400).json({ error: "vorname, nachname, geburtsdatum sind Pflicht" });
      }

      const instruments = instrument_ids ? JSON.parse(instrument_ids) : [];
      const memberships = formationen ? JSON.parse(formationen) : [];

      const result = await withTx(async (conn) => {
        // 1) Musiker insert ohne foto_path (kommt nach rename)
        const [r] = await conn.query(
          `
          INSERT INTO musiker (vorname, nachname, geburtsdatum, todesdatum, biografie, foto_path)
          VALUES (?, ?, ?, ?, ?, NULL)
          `,
          [vorname, nachname, geburtsdatum, safeDateOrNull(todesdatum), biografie || null]
        );
        const musikerId = r.insertId;

        // 2) Foto speichern (falls vorhanden)
        let fotoPath = null;
        if (req.file) {
          const ext = path.extname(req.file.originalname || "") || ".jpg";
          const finalRel = `uploads/musiker/${musikerId}${ext}`;
          const finalAbs = path.join(publicDir, finalRel);
          fs.renameSync(req.file.path, finalAbs);
          fotoPath = finalRel;

          await conn.query("UPDATE musiker SET foto_path = ? WHERE id = ?", [fotoPath, musikerId]);
        }

        // 3) Instrumente n:m
        for (const instId of instruments) {
          if (!instId) continue;
          await conn.query(
            "INSERT IGNORE INTO musiker_instrument (musiker_id, instrument_id) VALUES (?, ?)",
            [musikerId, Number(instId)]
          );
        }

        // 4) Mitgliedschaften
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
  }
);

// ---------- POST Formation (multipart + Bild+mp3 + Genres + Mitglieder) ----------
app.post(
  "/api/formation",
  upload.fields([
    { name: "foto", maxCount: 1 },
    { name: "mp3", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const {
        name,
        gruendungsdatum,
        aufloesungsdatum,
        biografie,
        genre_ids,     // JSON string: [1,2]
        mitglieder     // JSON string: [{musiker_id, eintrittsdatum, austrittsdatum}]
      } = req.body;

      if (!name || !gruendungsdatum) {
        return res.status(400).json({ error: "name, gruendungsdatum sind Pflicht" });
      }

      const genres = genre_ids ? JSON.parse(genre_ids) : [];
      const members = mitglieder ? JSON.parse(mitglieder) : [];

      const filesFoto = req.files?.foto?.[0] || null;
      const filesMp3 = req.files?.mp3?.[0] || null;

      const result = await withTx(async (conn) => {
        // 1) Formation insert ohne paths
        const [r] = await conn.query(
          `
          INSERT INTO formation (name, gruendungsdatum, aufloesungsdatum, biografie, foto_path, mp3_path)
          VALUES (?, ?, ?, ?, NULL, NULL)
          `,
          [name, gruendungsdatum, safeDateOrNull(aufloesungsdatum), biografie || null]
        );
        const formationId = r.insertId;

        // 2) Foto speichern
        let fotoPath = null;
        if (filesFoto) {
          const ext = path.extname(filesFoto.originalname || "") || ".jpg";
          const finalRel = `uploads/formation/${formationId}${ext}`;
          const finalAbs = path.join(publicDir, finalRel);
          fs.renameSync(filesFoto.path, finalAbs);
          fotoPath = finalRel;
          await conn.query("UPDATE formation SET foto_path = ? WHERE id = ?", [fotoPath, formationId]);
        }

        // 3) MP3 speichern
        let mp3Path = null;
        if (filesMp3) {
          const ext = path.extname(filesMp3.originalname || "") || ".mp3";
          const finalRel = `uploads/formation/${formationId}${ext}`;
          const finalAbs = path.join(publicDir, finalRel);
          fs.renameSync(filesMp3.path, finalAbs);
          mp3Path = finalRel;
          await conn.query("UPDATE formation SET mp3_path = ? WHERE id = ?", [mp3Path, formationId]);
        }

        // 4) Genres n:m
        for (const gId of genres) {
          if (!gId) continue;
          await conn.query(
            "INSERT IGNORE INTO formation_genre (formation_id, genre_id) VALUES (?, ?)",
            [formationId, Number(gId)]
          );
        }

        // 5) Mitglieder (mitgliedschaft)
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

// ---------- Start ----------
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const HOST = "0.0.0.0";
app.listen(PORT, HOST, () => {
  console.log(`Server läuft auf http://${HOST}:${PORT}`);
});