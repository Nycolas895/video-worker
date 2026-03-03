const express = require("express");
const { exec } = require("child_process");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());

app.get("/", (req, res) => res.send("OK"));
app.get("/health", (req, res) => res.json({ ok: true }));

app.post("/render", async (req, res) => {
  try {
    const { job_id, audio_url, broll_urls } = req.body;

    const audioPath = path.join(__dirname, "audio.mp3");
    const videoPath = path.join(__dirname, "video.mp4");

    // Baixar áudio
    const audioResponse = await axios({ url: audio_url, responseType: "stream" });
    audioResponse.data.pipe(fs.createWriteStream(audioPath));

    // Baixar primeiro vídeo b-roll (MVP simples)
    const videoResponse = await axios({ url: broll_urls[0], responseType: "stream" });
    videoResponse.data.pipe(fs.createWriteStream(videoPath));

    // Esperar downloads
    await new Promise(resolve => setTimeout(resolve, 3000));

    const outputPath = path.join(__dirname, "output.mp4");

    const command = `
      ffmpeg -i ${videoPath} -i ${audioPath} -c:v copy -c:a aac -shortest ${outputPath}
    `;

    exec(command, async (error) => {
      if (error) {
        return res.status(500).json({ error: "FFmpeg error" });
      }

      res.json({
        status: "completed",
        job_id,
        message: "Video rendered (local test)"
      });
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(3000, () => {
  console.log("Worker rodando na porta 3000");
});