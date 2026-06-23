// server.js
// -------------------------------------------------------------
// Backend para Empaque — Rendimiento por bonchador (PRESTIGE P2)
// Formatos de escaneo:
//   • Bonchador + tallos: B16-T20
//   • Variedad + grado : V01-60
//   • Lámina           : L1, L2, L3 ...
//
// Guarda en DB:
//   worker, worker_name, tallos, variedad_id, grado_cm, lamina_id, lamina_nombre
//
// Requisito en DB:
//   ALTER TABLE public.scans
//   ADD COLUMN IF NOT EXISTS lamina_id character varying(20);
//   ADD COLUMN IF NOT EXISTS worker_name character varying(120);
//   ADD COLUMN IF NOT EXISTS lamina_nombre character varying(120);
//
// Incluye SSE para actualizaciones en tiempo real.
// -------------------------------------------------------------

const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const path = require("path");

// FORZAR ZONA HORARIA COLOMBIA
process.env.TZ = "America/Bogota";

const app = express();
app.use(cors());
app.use(express.json());

// -----------------------------
// Conexión a Postgres
// -----------------------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

async function ensureSchema() {
  await pool.query(`
    ALTER TABLE public.scans
    ADD COLUMN IF NOT EXISTS worker_name character varying(120),
    ADD COLUMN IF NOT EXISTS lamina_nombre character varying(120),
    ADD COLUMN IF NOT EXISTS scan_batch_id character varying(80),
    ADD COLUMN IF NOT EXISTS scan_batch_index integer
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS scans_batch_unique_idx
    ON public.scans (scan_batch_id, scan_batch_index)
    WHERE scan_batch_id IS NOT NULL
  `);
}

// -----------------------------
// Configuración y estado
// -----------------------------
const WORKER_MIN = 1;
const WORKER_MAX = 12;

// Mapa en memoria de nombres de bonchadores (p.ej. { B16: "Juan" })
let workerNameMap = {};

function getWorkerNameSnapshot(workerCode) {
  const code = String(workerCode || "").trim().toUpperCase();
  const name = String(workerNameMap[code] || "").trim();
  return name || code;
}

// Conjunto de clientes SSE conectados
const clients = new Set();

// Servir estáticos
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/* ==========================================================
   RUTAS DE API
   ========================================================== */

// Lista de bonchadores con nombres
app.get("/api/workers", (req, res) => {
  const workers = [];
  for (let i = WORKER_MIN; i <= WORKER_MAX; i++) {
    const code = `B${String(i).padStart(2, "0")}`;
    workers.push({ code, name: workerNameMap[code] || code });
  }
  res.json(workers);
});

// Guardar/actualizar nombre de bonchador (en memoria)
app.post("/api/workers", (req, res) => {
  const { code, name } = req.body || {};
  if (!code || !name) {
    return res.status(400).json({ error: "Faltan datos" });
  }

  workerNameMap[String(code).toUpperCase()] = String(name).trim();
  res.json({ ok: true });
});

// Traer escaneos recientes (con nombre de variedad por JOIN y nombre de lámina por JOIN)
app.get("/api/scans", async (req, res) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 200;

    const query = `
      SELECT 
        s.id,
        s.ts, 
        s.worker, 
        s.worker_name,
        s.tallos, 
        s.variedad_id, 
        s.grado_cm,
        s.lamina_id,
        s.raw_a,
        s.raw_b,
        COALESCE(v.nombre, s.variedad_id) AS variedad_nombre,
        COALESCE(s.lamina_nombre, l.nombre, s.lamina_id) AS lamina_nombre
      FROM scans s
      LEFT JOIN variedades v ON s.variedad_id = v.id
      LEFT JOIN lamina l ON s.lamina_id = l.id
      ORDER BY s.ts DESC 
      LIMIT $1
    `;

    const result = await pool.query(query, [limit]);

    const finalData = result.rows.map((row) => ({
      ...row,
      worker_name: row.worker_name || (row.worker ? getWorkerNameSnapshot(row.worker) : null),
    }));

    res.json(finalData);
  } catch (err) {
    console.error("GET /api/scans error:", err);
    res.status(500).json({ error: "Error en DB" });
  }
});

// Pendientes (si aún no llevas estado de pendientes, devolvemos vacío)
app.get("/api/pendingAll", (req, res) => {
  res.json({});
});

/* ==========================================================
   LÓGICA DE PARSEOS
   ========================================================== */

// Bonchador: B16-T20
function parseWorker(code) {
  const up = String(code || "").trim().toUpperCase();
  const m = up.match(/^B(\d{1,2})-T(\d{1,3})$/);
  if (!m) return null;

  const n = parseInt(m[1], 10);
  const tallos = parseInt(m[2], 10);

  if (!(n >= WORKER_MIN && n <= WORKER_MAX)) return null;
  if (!Number.isFinite(tallos) || tallos <= 0) return null;

  return {
    code: `B${String(n).padStart(2, "0")}`, // B01, B02... B12
    tallos,
    raw: up,
  };
}

// Producto: V01-60
// Variedad: V01, V02, V12...
function parseVariedad(code) {
  const up = String(code || "").trim().toUpperCase();
  const m = up.match(/^V(\d{1,2})$/);
  if (!m) return null;

  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n) || n <= 0) return null;

  return {
    variedad_id: `V${String(n).padStart(2, "0")}`,
    raw: up,
  };
}

// Grado: G40, G50, G60...
function parseGrado(code) {
  const up = String(code || "").trim().toUpperCase();

  // Grados numéricos: G60 o 60
  const mNum = up.match(/^G?(\d{1,3})$/);
  if (mNum) {
    const grado_cm = parseInt(mNum[1], 10);

    if (!Number.isFinite(grado_cm) || grado_cm <= 0) return null;

    return {
      grado_cm: String(grado_cm),
      raw: `G${grado_cm}`,
    };
  }

  // Grados de texto permitidos
  const textosPermitidos = ["NACIONAL", "BAJAS", "PENDIENTE"];

  if (textosPermitidos.includes(up)) {
    return {
      grado_cm: up,
      raw: up,
    };
  }

  return null;
}

// Lámina: L1, L2, L3...
function parseLamina(code) {
  const up = String(code || "").trim().toUpperCase();
  const m = up.match(/^L(\d{1,3})$/);
  if (!m) return null;

  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n) || n <= 0) return null;

  return {
    id: `L${n}`,
    raw: up,
  };
}

function parseCombinedScan(code) {
  const up = String(code || "").trim().toUpperCase();
  const m = up.match(/^(B\d{1,2})-T(\d{1,3})-G?(\d{1,3}|NACIONAL|BAJAS|PENDIENTE)-(L\d{1,3})-(V\d{1,2})$/);
  if (!m) return null;

  const wObj = parseWorker(`${m[1]}-T${m[2]}`);
  const gObj = parseGrado(m[3]);
  const lObj = parseLamina(m[4]);
  const vObj = parseVariedad(m[5]);

  if (!(wObj && gObj && lObj && vObj)) return null;

  return { wObj, vObj, gObj, lObj };
}

/* ==========================================================
   VALIDACIONES DE CATÁLOGOS
   ========================================================== */

async function getVariedadById(variedadId) {
  const result = await pool.query(
    `
    SELECT id, nombre
    FROM variedades
    WHERE id = $1
    LIMIT 1
    `,
    [variedadId]
  );

  return result.rows[0] || null;
}

async function getLaminaActiva(laminaId) {
  const result = await pool.query(
    `
    SELECT id, nombre, activo
    FROM lamina
    WHERE UPPER(id) = $1
    LIMIT 1
    `,
    [String(laminaId || "").toUpperCase()]
  );

  if (!result.rows[0]) return null;
  if (!result.rows[0].activo) return { ...result.rows[0], invalida: true };

  return result.rows[0];
}

app.get("/api/variedades", async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT id, nombre
      FROM variedades
      ORDER BY id ASC
      `
    );

    res.json(result.rows);
  } catch (err) {
    console.error("GET /api/variedades error:", err);
    res.status(500).json({ error: "Error en DB" });
  }
});

app.get("/api/variedades/:id", async (req, res) => {
  try {
    const vObj = parseVariedad(req.params.id);
    if (!vObj) {
      return res.status(400).json({ error: "Variedad inválida" });
    }

    const variedad = await getVariedadById(vObj.variedad_id);
    if (!variedad) {
      return res.status(404).json({ error: "Variedad no encontrada" });
    }

    res.json(variedad);
  } catch (err) {
    console.error("GET /api/variedades/:id error:", err);
    res.status(500).json({ error: "Error en DB" });
  }
});

app.get("/api/laminas", async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT id, nombre, activo
      FROM lamina
      ORDER BY id ASC
      `
    );

    res.json(result.rows);
  } catch (err) {
    console.error("GET /api/laminas error:", err);
    res.status(500).json({ error: "Error en DB" });
  }
});

app.get("/api/laminas/:id", async (req, res) => {
  try {
    const lObj = parseLamina(req.params.id);
    if (!lObj) {
      return res.status(400).json({ error: "Lámina inválida" });
    }

    const lamina = await getLaminaActiva(lObj.id);
    if (!lamina) {
      return res.status(404).json({ error: "Lámina no encontrada" });
    }

    if (lamina.invalida) {
      return res.status(400).json({ error: "Lámina inactiva" });
    }

    res.json({
      id: lamina.id,
      nombre: lamina.nombre,
      activo: lamina.activo
    });
  } catch (err) {
    console.error("GET /api/laminas/:id error:", err);
    res.status(500).json({ error: "Error en DB" });
  }
});

/* ==========================================================
   GUARDADO EN DB
   ========================================================== */

async function saveScan(wObj, vObj, gObj, lObj, variedadNombre, laminaNombre, cantidadRamos = 1, scanBatchId = null) {
  const client = await pool.connect();

  try {
    const workerName = getWorkerNameSnapshot(wObj.code);
    const batchId = scanBatchId ? String(scanBatchId).trim().slice(0, 80) : null;

    if (batchId) {
      const existing = await client.query(
        `
        SELECT *
        FROM scans
        WHERE scan_batch_id = $1
        ORDER BY scan_batch_index ASC
        `,
        [batchId]
      );

      if (existing.rows.length) return existing.rows;
    }

    const query = `
      INSERT INTO scans (
        ts,
        worker,
        worker_name,
        tallos,
        variedad_id,
        variedad_nombre,
        grado_cm,
        raw_a,
        raw_b,
        lamina_id,
        lamina_nombre,
        scan_batch_id,
        scan_batch_index
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      RETURNING *
    `;

    const rows = [];
    await client.query("BEGIN");

    for (let i = 0; i < cantidadRamos; i++) {
      const values = [
        new Date(),
        wObj.code,           // B01
        workerName,          // Nombre actual del bonchador
        wObj.tallos,         // 20
        vObj.variedad_id,    // V01
        variedadNombre,
        gObj.grado_cm,       // 60
        wObj.raw,            // B01-T20
        `${vObj.raw}-${gObj.raw}`, // V01-G60
        lObj.id,             // L1
        laminaNombre || lObj.id,
        batchId,
        batchId ? i + 1 : null
      ];

      const result = await client.query(query, values);
      rows.push(result.rows[0]);
    }

    await client.query("COMMIT");
    return rows;

  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {}

    if (err.code === "23505" && scanBatchId) {
      const existing = await client.query(
        `
        SELECT *
        FROM scans
        WHERE scan_batch_id = $1
        ORDER BY scan_batch_index ASC
        `,
        [String(scanBatchId).trim().slice(0, 80)]
      );

      if (existing.rows.length) return existing.rows;
    }

    throw err;
  } finally {
    client.release();
  }
}

/* ==========================================================
   ESCANEO PRINCIPAL
   Espera:
   {
     "worker": "B16-T20",
     "barcode": "V01-60",
     "lamina": "L1"
   }
   ========================================================== */

app.post("/api/scan", async (req, res) => {
  try {
    const { worker, variedad, grado, lamina } = req.body || {};
    const combinedCode = req.body?.codigo || req.body?.code || req.body?.scan || req.body?.barcode;
    const combined = parseCombinedScan(combinedCode);

    const wObj = combined?.wObj || parseWorker(worker);
    const vObj = combined?.vObj || parseVariedad(variedad);
    const gObj = combined?.gObj || parseGrado(grado);
    const lObj = combined?.lObj || parseLamina(lamina);

    if (!wObj) {
      return res.status(400).json({
        error: "Bonchador inválido. Formato esperado: B01-T20",
      });
    }

    if (!vObj) {
      return res.status(400).json({
        error: "Variedad inválida. Formato esperado: V01",
      });
    }

    if (!gObj) {
      return res.status(400).json({
        error: "Grado inválido. Formato esperado: G60, 60, NACIONAL o BAJAS",
      });
    }

    if (!lObj) {
      return res.status(400).json({
        error: "Lámina inválida. Formato esperado: L1, L2, L3...",
      });
    }

    const variedadDb = await getVariedadById(vObj.variedad_id);

    if (!variedadDb) {
      return res.status(400).json({
        error: `La variedad ${vObj.variedad_id} no existe en la tabla variedades`,
      });
    }

    const laminaDb = await getLaminaActiva(lObj.id);

    if (!laminaDb) {
      return res.status(400).json({
        error: `La lámina ${lObj.id} no existe en la tabla lamina`,
      });
    }

    if (laminaDb.invalida) {
      return res.status(400).json({
        error: `La lámina ${lObj.id} está inactiva`,
      });
    }

    const cantidadRamosRaw = req.body?.cantidad_ramos ?? req.body?.ramos ?? 1;
    const cantidadRamos = Number(cantidadRamosRaw);
    const scanBatchId = req.body?.scan_batch_id || null;

    if (!Number.isInteger(cantidadRamos) || cantidadRamos < 1 || cantidadRamos > 500) {
      return res.status(400).json({
        error: "Cantidad de ramos invalida. Debe ser un numero entre 1 y 500",
      });
    }

    const savedRegs = await saveScan(
      wObj,
      vObj,
      gObj,
      lObj,
      variedadDb.nombre,
      laminaDb.nombre,
      cantidadRamos,
      scanBatchId
    );

    const broadcastRows = savedRegs.map((savedReg) => ({
      ...savedReg,
      variedad_nombre: variedadDb.nombre || vObj.variedad_id,
      worker_name: savedReg.worker_name || getWorkerNameSnapshot(savedReg.worker),
      lamina_nombre: savedReg.lamina_nombre || laminaDb.nombre || lObj.id,
    }));

    for (const reg of broadcastRows) {
      broadcast({ kind: "scan", reg });
    }

    return res.json({
      ok: true,
      reg: broadcastRows[0],
      regs: broadcastRows,
      cantidad_ramos: cantidadRamos,
    });

  } catch (err) {
    console.error("POST /api/scan error:", err);
    res.status(500).json({ error: "Error interno" });
  }
});

app.delete("/api/scans/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({
        ok: false,
        error: "ID inválido"
      });
    }

    const result = await pool.query(
      `
      DELETE FROM scans
      WHERE id = $1
      RETURNING id
      `,
      [id]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        ok: false,
        error: "Registro no encontrado"
      });
    }

    broadcast({
      kind: "delete",
      id
    });

    return res.json({
      ok: true,
      id
    });

  } catch (err) {
    console.error("DELETE /api/scans/:id error:", err);
    return res.status(500).json({
      ok: false,
      error: "Error eliminando registro"
    });
  }
});

app.patch("/api/scans/:id/grade", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const gradoObj = parseGrado(req.body?.grado);

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({
        ok: false,
        error: "ID invalido"
      });
    }

    if (!gradoObj || !["50", "60"].includes(String(gradoObj.grado_cm))) {
      return res.status(400).json({
        ok: false,
        error: "Grado invalido. Use G50 o G60"
      });
    }

    const result = await pool.query(
      `
      UPDATE scans
      SET
        grado_cm = $2,
        raw_b = variedad_id || '-' || $3
      WHERE id = $1
      RETURNING *
      `,
      [id, gradoObj.grado_cm, gradoObj.raw]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        ok: false,
        error: "Registro no encontrado"
      });
    }

    const row = result.rows[0];
    const payload = {
      ...row,
      variedad_nombre: row.variedad_nombre || row.variedad_id,
      worker_name: row.worker_name || getWorkerNameSnapshot(row.worker),
      lamina_nombre: row.lamina_nombre || row.lamina_id,
    };

    broadcast({
      kind: "scan_update",
      reg: payload
    });

    return res.json({
      ok: true,
      reg: payload
    });

  } catch (err) {
    console.error("PATCH /api/scans/:id/grade error:", err);
    return res.status(500).json({
      ok: false,
      error: "Error actualizando grado"
    });
  }
});

/* ==========================================================
   SSE (Server-Sent Events) en /api/stream
   ========================================================== */

function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  clients.forEach((res) => res.write(msg));
}

app.get("/api/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  clients.add(res);

  req.on("close", () => {
    clients.delete(res);
    try {
      res.end();
    } catch {}
  });
});

/* ==========================================================
   ARRANQUE DEL SERVIDOR
   ========================================================== */

const PORT = process.env.PORT || 3000;

async function startServer() {
  await ensureSchema();

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Servidor en puerto ${PORT} (Formatos: Bxx-Tyy, Vxx-gg y Lx)`);
  });
}

startServer().catch((err) => {
  console.error("Error iniciando servidor:", err);
  process.exit(1);
});
