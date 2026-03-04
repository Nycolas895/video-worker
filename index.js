const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const app = express();
app.use(express.json({ limit: "50mb" }));

// ---------- CONFIG (Render Env Vars) ----------
const PORT = process.env.PORT || 3000;

// Supabase upload
const SUPABASE_URL = process.env.SUPABASE_URL; // ex: https://xxxxx.supabase.co
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY; // segredo
const FINAL_BUCKET = process.env.FINAL_BUCKET || "final-videos"; // bucket public

// Performance defaults (Render free)
const DEFAULT_WIDTH = parseInt(process.env.DEFAULT_WIDTH || "480", 10);   // 480x854 é leve
const DEFAULT_HEIGHT = parseInt(process.env.DEFAULT_HEIGHT || "854", 10);
const DEFAULT_FPS = parseInt(process.env.DEFAULT_FPS || "24", 10);

// Quantidade de clipes (por enquanto 1 para garantir que funcione)
const MAX_CLIPS = parseInt(process.env.MAX_CLIPS || "1", 10);
// --------------------------------------------

// Health checks
app.get("/", (req, res) => res.send("OK"));
app.get("/health", (req, res) => res.json({ ok: true }));

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

// Util: download stream -> file (sem colocar tudo na RAM)
async function downloadToFile(url, filePath) {
  const r = await axios({
    url,
    responseType: "stream",
    timeout: 120000,
    // alguns hosts bloqueiam sem user-agent
    headers: { "User-Agent": "video-worker/1.0" },
  });

  await new Promise((resolve, reject) => {
    const w = fs.createWriteStream(filePath);
    r.data.pipe(w);
    w.on("finish", resolve);
    w.on("error", reject);
  });
}

// Upload MP4 to Supabase Storage via STREAM (sem estourar RAM)
async function uploadMp4ToSupabase(localFilePath, objectPath) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY não configurados no Render");
  }

  const uploadUrl = `${SUPABASE_URL}/storage/v1/object/${FINAL_BUCKET}/${objectPath}`;

  const stat = fs.statSync(localFilePath);
  const stream = fs.createReadStream(localFilePath);

  // PUT é o mais comum no Storage API
  await axios.put(uploadUrl, stream, {
    headers: {
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "video/mp4",
      "Content-Length": stat.size,
      "x-upsert": "true",
    },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    timeout: 300000, // 5 min pro upload
  });

  // bucket precisa ser public
  return `${SUPABASE_URL}/storage/v1/object/public/${FINAL_BUCKET}/${objectPath}`;
}

async function callWebhook(webhook_url, webhook_secret, payload) {
  await axios.post(webhook_url, payload, {
    headers: {
      "Content-Type": "application/json",
      "x-webhook-secret": webhook_secret,
    },
    timeout: 30000,
  });
}

/**
 * FFmpeg leve:
 * - baixa 1 clipe
 * - LOOPA o clipe até acabar o áudio (-stream_loop -1)
 * - reescala e crop pra 9:16
 * - -shortest termina junto com o áudio
 */
function runFfmpegLoopSingleClip({ clipPath, audioPath, outputPath, width, height, fps }) {
  return new Promise((resolve, reject) => {
    const vf = `fps=${fps},scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},format=yuv420p`;

    const args = [
      "-y",
      "-hide_banner",
      "-loglevel", "info",

      "-stream_loop", "-1",
      "-i", clipPath,
      "-i", audioPath,

      "-vf", vf,

      "-map", "0:v:0",
      "-map", "1:a:0",

      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-crf", "30",

      "-c:a", "aac",
      "-b:a", "128k",

      "-movflags", "+faststart",
      "-shortest",
      outputPath,
    ];

    console.log("[ffmpeg] cmd:", `ffmpeg ${args.join(" ")}`);

    const p = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });

    p.stdout.on("data", (d) => console.log("[ffmpeg][out]", d.toString().trim()));
    p.stderr.on("data", (d) => console.log("[ffmpeg][err]", d.toString().trim()));

    p.on("error", (err) => reject(err));
    p.on("close", (code) => {
      if (code === 0) return resolve();
      reject(new Error(`ffmpeg saiu com code ${code}`));
    });
  });
}

app.post("/render", async (req, res) => {
  const body = req.body || {};

  const job_id = body.job_id;
  const webhook_url = body.webhook_url;
  const webhook_secret = body.webhook_secret;
  const audio_url = body.audio_url;
  const broll_urls = body.broll_urls;
  const output_config = body.output_config || {};

  // Vamos ignorar burn_subtitles por enquanto no free (muito pesado)
  // Se quiser ativar depois, dá, mas primeiro vamos fazer gerar vídeo.
  const width = Number(output_config.width || DEFAULT_WIDTH);
  const height = Number(output_config.height || DEFAULT_HEIGHT);
  const fps = Number(output_config.fps || DEFAULT_FPS);

  console.log("[/render] RECEBI JOB:", job_id);
  console.log("[/render] broll_urls:", Array.isArray(broll_urls) ? broll_urls.length : "INVALID");
  console.log("[/render] webhook_url:", webhook_url);
  console.log("[/render] config:", { width, height, fps, MAX_CLIPS });

  if (!job_id || !webhook_url || !webhook_secret || !audio_url || !Array.isArray(broll_urls) || broll_urls.length === 0) {
    console.log("[/render] ERRO: payload incompleto");
    return res.status(400).json({
      error: "Campos obrigatórios: job_id, webhook_url, webhook_secret, audio_url, broll_urls[]",
    });
  }

  // ✅ responde IMEDIATO
  res.json({ status: "accepted", job_id });

  // ✅ background
  (async () => {
    // Use /tmp (mais seguro no Render)
    const workDir = path.join("/tmp", "video-worker", job_id);
    ensureDir(workDir);

    const audioPath = path.join(workDir, "audio.mp3");
    const clipPath = path.join(workDir, "clip.mp4");
    const outputPath = path.join(workDir, "output.mp4");

    try {
      console.log(`[job ${job_id}] baixando áudio...`);
      await downloadToFile(audio_url, audioPath);

      // Por enquanto 1 clipe para garantir que funciona
      const clipUrl = broll_urls[0];
      console.log(`[job ${job_id}] baixando 1 clipe...`);
      await downloadToFile(clipUrl, clipPath);

      console.log(`[job ${job_id}] iniciando ffmpeg (leve, 1 clipe loop)...`);
      await runFfmpegLoopSingleClip({ clipPath, audioPath, outputPath, width, height, fps });
      console.log(`[job ${job_id}] ffmpeg finalizou ✅`);

      console.log(`[job ${job_id}] upload Supabase...`);
      const objectPath = `final/${job_id}.mp4`;
      const video_url = await uploadMp4ToSupabase(outputPath, objectPath);
      console.log(`[job ${job_id}] upload OK:`, video_url);

      console.log(`[job ${job_id}] chamando webhook completed...`);
      await callWebhook(webhook_url, webhook_secret, { job_id, status: "completed", video_url });
      console.log(`[job ${job_id}] webhook completed enviado ✅`);
    } catch (e) {
      console.log(`[job ${job_id}] FALHOU:`, e?.message || e);

      try {
        console.log(`[job ${job_id}] chamando webhook failed...`);
        await callWebhook(webhook_url, webhook_secret, { job_id, status: "failed", error: e?.message || String(e) });
        console.log(`[job ${job_id}] webhook failed enviado ✅`);
      } catch (err2) {
        console.log("[webhook] ERRO ao enviar failed:", err2.response?.status, err2.response?.data || err2.message);
      }
    }
  })();
});

app.listen(PORT, () => console.log("Worker rodando na porta", PORT));