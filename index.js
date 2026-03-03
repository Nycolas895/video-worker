const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");

const app = express();
app.use(express.json({ limit: "50mb" }));

app.get("/", (req, res) => res.send("OK"));
app.get("/health", (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;

/**
 * Baixa um arquivo por URL para um caminho local
 */
async function downloadToFile(url, filePath) {
  const r = await axios({ url, responseType: "stream" });
  await new Promise((resolve, reject) => {
    const w = fs.createWriteStream(filePath);
    r.data.pipe(w);
    w.on("finish", resolve);
    w.on("error", reject);
  });
}

/**
 * Faz callback pro webhook do Lovable
 */
async function callWebhook(webhook_url, webhook_secret, payload) {
  // Muitos webhooks esperam o segredo em header
  // Se o seu "video-webhook" estiver validando de outro jeito, ajustamos depois.
  await axios.post(webhook_url, payload, {
    headers: {
      "Content-Type": "application/json",
      "x-webhook-secret": webhook_secret,
    },
    timeout: 15000,
  });
}

app.post("/render", async (req, res) => {
  const {
    job_id,
    webhook_url,
    webhook_secret,
    audio_url,
    broll_urls,
    subtitle_url, // pode vir ou não no MVP
  } = req.body || {};

  if (!job_id || !webhook_url || !webhook_secret || !audio_url || !Array.isArray(broll_urls) || broll_urls.length === 0) {
    return res.status(400).json({
      error: "Campos obrigatórios: job_id, webhook_url, webhook_secret, audio_url, broll_urls[]",
    });
  }

  // ✅ RESPONDE IMEDIATO (evita timeout do Lovable)
  res.json({ status: "accepted", job_id });

  // ✅ PROCESSA EM BACKGROUND
  (async () => {
    const workDir = path.join(__dirname, "tmp", job_id);
    fs.mkdirSync(workDir, { recursive: true });

    const audioPath = path.join(workDir, "audio.mp3");
    const videoPath = path.join(workDir, "broll.mp4");
    const subtitlePath = path.join(workDir, "subs.srt");
    const outputPath = path.join(workDir, "output.mp4");

    try {
      // Baixar assets
      await downloadToFile(audio_url, audioPath);
      await downloadToFile(broll_urls[0], videoPath); // MVP: usa só 1 clip
      if (subtitle_url) {
        await downloadToFile(subtitle_url, subtitlePath);
      }

      // Montagem simples (MVP)
      // Se tiver legenda: queimar com subtitles (libass precisa estar ok no ffmpeg)
      const baseCmd = subtitle_url
        ? `ffmpeg -y -i "${videoPath}" -i "${audioPath}" -vf "subtitles='${subtitlePath.replace(/\\/g, "\\\\")}'" -map 0:v:0 -map 1:a:0 -c:v libx264 -preset veryfast -c:a aac -shortest "${outputPath}"`
        : `ffmpeg -y -i "${videoPath}" -i "${audioPath}" -map 0:v:0 -map 1:a:0 -c:v libx264 -preset veryfast -c:a aac -shortest "${outputPath}"`;

      await new Promise((resolve, reject) => {
        exec(baseCmd, (err, stdout, stderr) => {
          if (err) return reject(new Error(stderr || err.message));
          resolve();
        });
      });

      // ⚠️ AGORA precisamos de um video_url público.
      // Opção MVP (sem upload automático): você pode adaptar o "video-webhook"
      // para aceitar upload do arquivo ou usar Supabase signed upload.
      //
      // Por enquanto vamos mandar "completed" sem video_url pra ver se o webhook recebe.
      // Depois a gente implementa o upload pro Supabase e manda video_url.

      await callWebhook(webhook_url, webhook_secret, {
        job_id,
        status: "completed",
        // video_url: "PUBLIC_URL_AQUI"
      });

    } catch (e) {
      try {
        await callWebhook(webhook_url, webhook_secret, {
          job_id,
          status: "failed",
          error: e.message,
        });
      } catch (_) {
        // se o webhook falhar, não tem muito o que fazer aqui
      }
    }
  })();
});

app.listen(PORT, () => console.log("Worker rodando na porta", PORT));