/**
 * Backend minimo para el plugin "Stories" de Vencord.
 *
 * Guarda historias con: autor, link de catbox.moe, tipo (imagen/video),
 * visibilidad (everyone | best_friends | custom) y expiracion (12h/24h).
 * Un cron interno borra las historias caducadas cada minuto.
 *
 * IMPORTANTE: esto NO valida amistades de Discord por si mismo (no tenemos
 * el token del bot ni tu lista real de amigos en el servidor). La logica de
 * "solo mis amigos de Discord la ven" vive en el PLUGIN: el cliente que pide
 * las historias manda su propia lista de IDs de amigos y el backend filtra
 * usando esa lista + las reglas de bloqueo/mejores-amigos guardadas por autor.
 */

const express = require("express");
const cors = require("cors");
const low = require("lowdb");
const FileSync = require("lowdb/adapters/FileSync");
const { v4: uuidv4 } = require("uuid");

const adapter = new FileSync("db.json");
const db = low(adapter);
db.defaults({ stories: [], userSettings: {} }).write();

const app = express();
app.use(cors());
app.use(express.json());

const HOUR_MS = 60 * 60 * 1000;

// ---------- Ajustes de usuario (mejores amigos / bloqueados por defecto) ----------

// GET /settings/:userId
app.get("/settings/:userId", (req, res) => {
  const settings = db.get("userSettings").get(req.params.userId).value() || {
    bestFriends: [],
    blocked: [],
  };
  res.json(settings);
});

// PUT /settings/:userId  { bestFriends: [id,...], blocked: [id,...] }
app.put("/settings/:userId", (req, res) => {
  const { bestFriends = [], blocked = [] } = req.body;
  db.set(`userSettings.${req.params.userId}`, { bestFriends, blocked }).write();
  res.json({ ok: true });
});

// ---------- Historias ----------

// POST /story
// body: { authorId, authorName, mediaUrl, mediaType: "image"|"video",
//         visibility: "everyone"|"best_friends"|"custom",
//         allowList: [id,...]   (solo si visibility === "custom")
//         durationHours: 12|24 }
app.post("/story", (req, res) => {
  const {
    authorId,
    authorName,
    mediaUrl,
    mediaType = "image",
    visibility = "everyone",
    allowList = [],
    durationHours = 24,
  } = req.body;

  if (!authorId || !mediaUrl) {
    return res.status(400).json({ error: "authorId y mediaUrl son obligatorios" });
  }
  if (!/^https:\/\/(files\.catbox\.moe|litter\.catbox\.moe)\//.test(mediaUrl)) {
    return res.status(400).json({ error: "Solo se permiten links de catbox.moe" });
  }

  const now = Date.now();
  const story = {
    id: uuidv4(),
    authorId,
    authorName,
    mediaUrl,
    mediaType,
    visibility,
    allowList,
    createdAt: now,
    expiresAt: now + Number(durationHours) * HOUR_MS,
  };

  db.get("stories").push(story).write();
  res.json(story);
});

// GET /story/note/:storyId  -- notas propias del dueño sobre su historia (texto libre, ej. titulo)
app.patch("/story/:id/note", (req, res) => {
  const { note } = req.body;
  const story = db.get("stories").find({ id: req.params.id }).value();
  if (!story) return res.status(404).json({ error: "No encontrada" });
  db.get("stories").find({ id: req.params.id }).assign({ note }).write();
  res.json({ ok: true });
});

// DELETE /story/:id  (borrar manualmente, solo el autor deberia llamarlo)
app.delete("/story/:id", (req, res) => {
  db.get("stories").remove({ id: req.params.id }).write();
  res.json({ ok: true });
});

/**
 * GET /stories?viewerId=XXX&friendIds=id1,id2,id3
 *
 * Devuelve, agrupadas por autor, todas las historias vigentes que el
 * viewerId puede ver segun:
 *  - el autor tiene que estar en friendIds (mandado por el propio cliente,
 *    que es quien conoce tu lista real de amigos de Discord)
 *  - visibility "everyone": visible para cualquier amigo
 *  - visibility "best_friends": visible solo si viewerId esta en la lista
 *    bestFriends que el autor guardo en /settings
 *  - visibility "custom": visible solo si viewerId esta en allowList de la historia
 *  - el autor puede bloquear a alguien (settings.blocked): si viewerId esta
 *    bloqueado, nunca ve nada de ese autor, pase lo que pase
 */
app.get("/stories", (req, res) => {
  const { viewerId, friendIds = "" } = req.query;
  const friendSet = new Set(String(friendIds).split(",").filter(Boolean));

  const now = Date.now();
  const active = db.get("stories").filter((s) => s.expiresAt > now).value();

  const visible = active.filter((s) => {
    if (s.authorId === viewerId) return true; // siempre ves las tuyas
    if (!friendSet.has(s.authorId)) return false; // no sois amigos

    const settings = db.get("userSettings").get(s.authorId).value() || {
      bestFriends: [],
      blocked: [],
    };
    if (settings.blocked && settings.blocked.includes(viewerId)) return false;

    if (s.visibility === "everyone") return true;
    if (s.visibility === "best_friends") {
      return settings.bestFriends && settings.bestFriends.includes(viewerId);
    }
    if (s.visibility === "custom") {
      return s.allowList && s.allowList.includes(viewerId);
    }
    return false;
  });

  const grouped = {};
  for (const s of visible) {
    grouped[s.authorId] = grouped[s.authorId] || [];
    grouped[s.authorId].push(s);
  }

  res.json(grouped);
});

// Limpieza de historias caducadas cada minuto
setInterval(() => {
  const now = Date.now();
  db.get("stories")
    .remove((s) => s.expiresAt <= now)
    .write();
}, 60 * 1000);

const PORT = process.env.PORT || 4562;
app.listen(PORT, () => console.log(`Stories backend escuchando en :${PORT}`));
