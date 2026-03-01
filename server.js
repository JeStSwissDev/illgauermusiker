import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import mysql from "mysql2/promise";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Statische Dateien (index.html, uploads/* etc.)
app.use(express.static("public"));

// DB Pool
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
});

app.get("/api/health", async (req, res) => {
    try {
      await pool.query("SELECT 1");
      res.json({ ok: true, db: true });
    } catch (e) {
      res.status(500).json({
        ok: false,
        db: false,
        // wichtig: echte Details
        name: e?.name,
        message: e?.message,
        code: e?.code,
        errno: e?.errno,
        sqlState: e?.sqlState,
        sqlMessage: e?.sqlMessage,
        // damit du sofort siehst ob env ankommt
        env: {
          DB_HOST: process.env.DB_HOST,
          DB_USER: process.env.DB_USER,
          DB_NAME: process.env.DB_NAME,
          // Passwort NIE zurückgeben
        },
      });
    }
  });

// Musiker nach ID inkl. Instrumente/Formationen/Mitspieler
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

  res.json({
    ...musikerRows[0],
    instrumente,
    formationen,
    machtMusikMit,
  });
});

// Formation nach ID inkl. Genres/Mitglieder
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

  res.json({
    ...formationRows[0],
    genres,
    mitglieder,
  });
});

// Start
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const HOST = "0.0.0.0";
app.listen(PORT, HOST, () => {
  console.log(`Server läuft auf http://${HOST}:${PORT}`);
});