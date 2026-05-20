require('dotenv').config();

const express = require('express');
const multer  = require('multer');
const pdf     = require('pdf-parse');
const Groq = require('groq-sdk');
const path    = require('path');

const app = express();

// ── Multer: memory storage, PDF only, 20 MB cap ──
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    file.mimetype === 'application/pdf'
      ? cb(null, true)
      : cb(new Error('Only PDF files are accepted.'));
  },
});

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const MAX_CHARS = 80_000;

// ── Static frontend ──
app.use(express.static(path.join(__dirname, 'public')));

// ── POST /api/analyze ──
app.post('/api/analyze', upload.single('pdf'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No PDF file received.' });
  }

  try {
    // Extract text
    const parsed = await pdf(req.file.buffer);
    let text = parsed.text.trim();

    if (!text) {
      return res.status(422).json({
        error: 'No readable text found in this PDF. It may be a scanned image.',
      });
    }

    const truncated = text.length > MAX_CHARS;
    if (truncated) text = text.slice(0, MAX_CHARS);

    // Call Groq
    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        {
          role: 'system',
          content: 'You are a focused study assistant. Extract only what matters for exams. Be concise.',
        },
        {
          role: 'user',
          content:
`Analyze this study material and respond using EXACTLY this format — no deviations:

SUMMARY_START
• [key concept]
• [key concept]
[8–12 bullets total, each a distinct important concept]
SUMMARY_END

QUESTIONS_START
Q1: [exam question]
A1: [clear answer]

Q2: [exam question]
A2: [clear answer]

Q3: [exam question]
A3: [clear answer]

Q4: [exam question]
A4: [clear answer]

Q5: [exam question]
A5: [clear answer]
QUESTIONS_END

Material:

${text}`,
        },
      ],
    });

    const raw = completion.choices[0].message.content;

    // Parse summary
    const summaryBlock = (raw.match(/SUMMARY_START\s*([\s\S]*?)\s*SUMMARY_END/) || [])[1] || '';
    const bullets = summaryBlock
      .split('\n')
      .map(l => l.replace(/^[•\-*]\s*/, '').trim())
      .filter(Boolean);

    // Parse Q&A
    const questionsBlock = (raw.match(/QUESTIONS_START\s*([\s\S]*?)\s*QUESTIONS_END/) || [])[1] || '';
    const questions = [];

    const rx = /Q(\d+):\s*([\s\S]*?)\nA\1:\s*([\s\S]*?)(?=\n\nQ\d+:|$)/g;
    let m;
    while ((m = rx.exec(questionsBlock)) !== null) {
      questions.push({ q: m[2].trim(), a: m[3].trim() });
    }

    // Fallback line-by-line parse
    if (!questions.length) {
      let cur = null;
      for (const line of questionsBlock.split('\n').filter(Boolean)) {
        if (/^Q\d+:/.test(line)) {
          cur = { q: line.replace(/^Q\d+:\s*/, ''), a: '' };
          questions.push(cur);
        } else if (/^A\d+:/.test(line) && cur) {
          cur.a = line.replace(/^A\d+:\s*/, '');
          cur = null;
        }
      }
    }

    res.json({ bullets, questions, truncated });

  } catch (err) {
    console.error(err);
    const status = err.status ?? 500;
    res.status(status).json({ error: err.message || 'Something went wrong.' });
  }
});

// ── Multer + general error handler ──
app.use((err, _req, res, _next) => {
  if (err?.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: 'PDF exceeds the 20 MB limit.' });
  }
  res.status(400).json({ error: err?.message || 'Bad request.' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`PDF Study Tool running on port ${PORT}`));
