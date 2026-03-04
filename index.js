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
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const FINAL_BUCKET = process.env.FINAL_BUCKET || "final-videos";

// Performance defaults
const DEFAULT_WIDTH = parseInt(process.env.DEFAULT_WIDTH || "480", 10);
const DEFAULT_HEIGHT = parseInt(process.env.DEFAULT_HEIGHT || "854", 10);
const DEFAULT_FPS = parseInt(process.env.DEFAULT_FPS || "24", 10);

const MAX_CLIPS = parseInt(process.env.MAX_CLIPS || "1", 10);
// --------------------------------------------

// Health checks
app.get("/", (req, res) => res.send("OK"));
app.get("/health", (req, res) => res.json({ ok: true }));

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

// Download de arquivos
async function downloadToFile(url, filePath) {
  const r = await axios({
    url,
    responseType: "stream",
    timeout: 120000,
    headers: { "User-Agent": "video-worker/1.0" },
  });

  await new Promise((resolve, reject) => {
    const w = fs.createWriteStream(filePath);
    r.data.pipe(w);
    w.on("finish", resolve);
    w.on("error", reject);
  });
}

// Upload para o Supabase
async function uploadMp4ToSupabase(localFilePath, objectPath) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY não configurados");
  }

  const uploadUrl = `${SUPABASE_URL}/storage/v1/object/${FINAL_BUCKET}/${objectPath}`;
  const stat = fs.statSync(localFilePath);
  const stream = fs.createReadStream(localFilePath);

  await axios.put(uploadUrl, stream, {
    headers: {
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "video/mp4",
      "Content-Length": stat.size,
      "x-upsert": "true",
    },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    timeout: 300000,
  });

  return `${SUPABASE_URL}/storage/v1/object/public/${FINAL_BUCKET}/${objectPath}`;
}

// Webhook
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
 * FFmpeg leve com suporte a legendas
 */
function runFfmpegLoopSingleClip({ clipPath, audioPath, outputPath, width, height, fps, subtitlePath }) {
  return new Promise((resolve, reject) => {
    // Começamos o filtro de vídeo (escala e corte)
    let vf = `fps=${fps},scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},format=yuv420p`;

    // Se existir uma legenda baixada, adicionamos ao filtro de vídeo!
    if (subtitlePath) {
      vf += `,subtitles=${subtitlePath}`;
    }

    const args = [
      "-y",
      "-hide_banner",
      "-loglevel", "info",

      "-stream_loop", "-1",
      "-i", clipPath,
      "-i", audioPath,

      "-vf", vf, // Aplica os filtros (com ou sem legenda)

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
  
  // Pegando as possíveis legendas do Lovable (ele pode mandar como link ou como texto puro)
  const subtitle_url = body.subtitle_url || output_config.subtitle_url;
  const subtitle_text = body.subtitle_text || output_config.subtitle_text;

  const width = Number(output_config.width || DEFAULT_WIDTH);
  const height = Number(output_config.height || DEFAULT_HEIGHT);
  const fps = Number(output_config.fps || DEFAULT_FPS);

  if (!job_id || !webhook_url || !webhook_secret || !audio_url || !Array.isArray(broll_urls) || broll_urls.length === 0) {
    return res.status(400).json({ error: "Campos obrigatórios ausentes" });
  }

  // Responde imediatamente ao Lovable
  res.json({ status: "accepted", job_id });

  // Processo em background
  (async () => {
    const workDir = path.join("/tmp", "video-worker", job_id);
    ensureDir(workDir);

    const audioPath = path.join(workDir, "audio.mp3");
    const clipPath = path.join(workDir, "clip.mp4");
    const outputPath = path.join(workDir, "output.mp4");
    const srtPath = path.join(workDir, "subs.srt");
    
    let activeSubtitlePath = null;

    try {
      console.log(`[job ${job_id}] baixando áudio...`);
      await downloadToFile(audio_url, audioPath);

      const clipUrl = broll_urls[0];
      console.log(`[job ${job_id}] baixando 1 clipe...`);
      await downloadToFile(clipUrl, clipPath);

      // --- TRATAMENTO DAS LEGENDAS ---
      if (subtitle_url) {
        console.log(`[job ${job_id}] baixando arquivo de legenda...`);
        await downloadToFile(subtitle_url, srtPath);
        activeSubtitlePath = srtPath;
      } else if (subtitle_text) {
        console.log(`[job ${job_id}] salvando texto de legenda...`);
        fs.writeFileSync(srtPath, subtitle_text);
        activeSubtitlePath = srtPath;
      }

      console.log(`[job ${job_id}] iniciando ffmpeg (com suporte a legenda)...`);
      await runFfmpegLoopSingleClip({ 
          clipPath, 
          audioPath, 
          outputPath, 
          width, 
          height, 
          fps, 
          subtitlePath: activeSubtitlePath // Passando a legenda pro FFmpeg
      });
      console.log(`[job ${job_id}] ffmpeg finalizou ✅`);

      console.log(`[job ${job_id}] upload Supabase...`);
      const objectPath = `final/${job_id}.mp4`;
      const video_url = await uploadMp4ToSupabase(outputPath, objectPath);
      console.log(`[job ${job_id}] upload OK:`, video_url);

      await callWebhook(webhook_url, webhook_secret, { job_id, status: "completed", video_url });
      
    } catch (e) {
      console.log(`[job ${job_id}] FALHOU:`, e?.message || e);
      try {
        await callWebhook(webhook_url, webhook_secret, { job_id, status: "failed", error: e?.message || String(e) });
      } catch (err2) {
        console.log("[webhook] ERRO ao enviar failed");
      }
    }
  })();
});

app.listen(PORT, () => console.log("Worker rodando na porta", PORT));