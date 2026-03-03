const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");

const app = express();
app.use(express.json({ limit: "50mb" }));

// ---------- CONFIG (Render Env Vars) ----------
const PORT = process.env.PORT || 3000;

// Supabase upload (NECESSÁRIO para gerar video_url)
const SUPABASE_URL = process.env.SUPABASE_URL; // ex: https://xxxxx.supabase.co
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY; // segredo (não poste)
const FINAL_BUCKET = process.env.FINAL_BUCKET || "final-videos"; // bucket public
// --------------------------------------------

// Health checks
app.get("/", (req, res) => res.send("OK"));
app.get("/health", (req, res) => res.json({ ok: true }));

// Util: download stream -> file
async function downloadToFile(url, filePath) {
  const r = await axios({ url, responseType: "stream", timeout: 60000 });
  await new Promise((resolve, reject) => {
    const w = fs.createWriteStream(filePath);
    r.data.pipe(w);
    w.on("finish", resolve);
    w.on("error", reject);
  });
}

// Util: ensure dir
function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

// Upload MP4 to Supabase Storage (bucket must be public)
async function uploadMp4ToSupabase(localFilePath, objectPath) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY não configurados no Render");
  }

  const uploadUrl = `${SUPABASE_URL}/storage/v1/object/${FINAL_BUCKET}/${objectPath}`;
  const fileBuffer = fs.readFileSync(localFilePath);

  await axios.post(uploadUrl, fileBuffer, {
    headers: {
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "video/mp4",
      "x-upsert": "true",
    },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    timeout: 120000,
  });

  // Public URL (bucket precisa ser public)
  return `${SUPABASE_URL}/storage/v1/object/public/${FINAL_BUCKET}/${objectPath}`;
}

// Call Lovable webhook
async function callWebhook(webhook_url, webhook_secret, payload) {
  await axios.post(webhook_url, payload, {
    headers: {
      "Content-Type": "application/json",
      "x-webhook-secret": webhook_secret,
    },
    timeout: 20000,
  });
}

/**
 * FFmpeg: cria um vídeo vertical 1080x1920 a partir de vários clipes.
 * - reescala e corta para 9:16
 * - concatena
 * - coloca narração
 * - queima legenda (opcional)
 */
function buildFfmpegCommand({ clipsTxtPath, audioPath, subtitlePath, outputPath, burnSubtitles }) {
  // Para paths no Windows/Render, escapar barras para o filtro subtitles
  const subFilter = burnSubtitles && subtitlePath
    ? `,subtitles='${subtitlePath.replace(/\\/g, "\\\\").replace(/:/g, "\\:")}'`
    : "";

  // Pipeline:
  // - concat demuxer: lê lista de arquivos local
  // - força 30fps, escala/crop para 1080x1920
  // - áudio AAC
  // - -shortest para terminar com o áudio
  const vf = `fps=30,scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920${subFilter}`;

  return `ffmpeg -y -f concat -safe 0 -i "${clipsTxtPath}" -i "${audioPath}" ` +
         `-vf "${vf}" -map 0:v:0 -map 1:a:0 ` +
         `-c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac -b:a 192k -shortest "${outputPath}"`;
}

app.post("/render", async (req, res) => {
  const body = req.body || {};

  const job_id = body.job_id;
  const webhook_url = body.webhook_url;
  const webhook_secret = body.webhook_secret;
  const audio_url = body.audio_url;
  const broll_urls = body.broll_urls;
  const subtitle_url = body.subtitle_url || null;
  const output_config = body.output_config || {};

  const burn_subtitles = output_config.burn_subtitles === true; // padrão false se não vier

  // Logs de entrada (aparecem no Render)
  console.log("[/render] RECEBI JOB:", job_id);
  console.log("[/render] broll_urls:", Array.isArray(broll_urls) ? broll_urls.length : "INVALID");
  console.log("[/render] subtitle_url:", subtitle_url ? "YES" : "NO");
  console.log("[/render] webhook_url:", webhook_url);

  // validação
  if (!job_id || !webhook_url || !webhook_secret || !audio_url || !Array.isArray(broll_urls) || broll_urls.length === 0) {
    console.log("[/render] ERRO: payload incompleto");
    return res.status(400).json({
      error: "Campos obrigatórios: job_id, webhook_url, webhook_secret, audio_url, broll_urls[]",
    });
  }

  // ✅ Responde IMEDIATO (evita timeout do assemble-video)
  console.log("[/render] RESPONDI accepted:", job_id);
  res.json({ status: "accepted", job_id });

  // ✅ Processa em background
  (async () => {
    const workDir = path.join(__dirname, "tmp", job_id);
    ensureDir(workDir);

    const audioPath = path.join(workDir, "audio.mp3");
    const subtitlePath = path.join(workDir, "subs.srt");
    const outputPath = path.join(workDir, "output.mp4");
    const clipsDir = path.join(workDir, "clips");
    ensureDir(clipsDir);

    // arquivo de concat (ffmpeg concat demuxer)
    const clipsTxtPath = path.join(workDir, "clips.txt");

    try {
      console.log("[job] baixando áudio...");
      await downloadToFile(audio_url, audioPath);

      // baixa alguns clipes (MVP: até 10, mas você pode aumentar)
      const maxClips = Math.min(10, broll_urls.length);
      console.log(`[job] baixando ${maxClips} clipes...`);

      const localClips = [];
      for (let i = 0; i < maxClips; i++) {
        const clipUrl = broll_urls[i];
        const clipPath = path.join(clipsDir, `clip_${i}.mp4`);
        await downloadToFile(clipUrl, clipPath);
        localClips.push(clipPath);
      }

      // legenda
      if (subtitle_url && burn_subtitles) {
        console.log("[job] baixando legendas...");
        await downloadToFile(subtitle_url, subtitlePath);
      }

      // cria clips.txt
      // formato: file 'path'
      const txt = localClips.map(p => `file '${p.replace(/\\/g, "/")}'`).join("\n");
      fs.writeFileSync(clipsTxtPath, txt, "utf8");

      console.log("[ffmpeg] iniciando render...");
      const cmd = buildFfmpegCommand({
        clipsTxtPath,
        audioPath,
        subtitlePath,
        outputPath,
        burnSubtitles: burn_subtitles && !!subtitle_url,
      });

      await new Promise((resolve, reject) => {
        exec(cmd, (err, stdout, stderr) => {
          if (err) {
            console.log("[ffmpeg] ERRO:", stderr || err.message);
            return reject(new Error(stderr || err.message));
          }
          resolve();
        });
      });

      console.log("[ffmpeg] finalizou:", outputPath);

      // Upload para Supabase -> URL pública
      console.log("[upload] enviando para Supabase Storage...");
      const objectPath = `final/${job_id}.mp4`;
      const video_url = await uploadMp4ToSupabase(outputPath, objectPath);

      console.log("[upload] OK, video_url:", video_url);

      // Callback sucesso
      console.log("[webhook] chamando completed...");
      await callWebhook(webhook_url, webhook_secret, {
        job_id,
        status: "completed",
        video_url,
      });
      console.log("[webhook] completed enviado com sucesso ✅");

    } catch (e) {
      console.log("[job] FALHOU:", job_id, e.message);

      // Callback erro
      try {
        console.log("[webhook] chamando failed...");
        await callWebhook(webhook_url, webhook_secret, {
          job_id,
          status: "failed",
          error: e.message,
        });
        console.log("[webhook] failed enviado ✅");
      } catch (err2) {
        console.log("[webhook] ERRO ao enviar failed:", err2.response?.status, err2.response?.data || err2.message);
      }
    }
  })();
});

app.listen(PORT, () => {
  console.log("Worker rodando na porta", PORT);
});