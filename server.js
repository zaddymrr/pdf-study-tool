require('dotenv').config();

const express = require('express');
const Groq    = require('groq-sdk');
const path    = require('path');
const Stripe  = require('stripe');

const app = express();

// ── Stripe ──
// Lazy init so the server still boots if Stripe env vars aren't set yet.
// (The existing /api/analyze endpoint keeps working; only Stripe routes
//  return a helpful error until you add the keys.)
let _stripe = null;
function getStripe() {
  if (_stripe) return _stripe;
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error('STRIPE_SECRET_KEY not set. Add it to your .env file.');
  }
  _stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });
  return _stripe;
}
const PRICE_ID         = process.env.STRIPE_PRICE_ID;           // price_xxx for €9.99/mo recurring
const WEBHOOK_SECRET   = process.env.STRIPE_WEBHOOK_SECRET;     // whsec_xxx
const APP_BASE_URL     = process.env.APP_BASE_URL || 'http://localhost:3000';

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const MAX_CHARS = 80_000;

// ──────────────────────────────────────────────────────────────
// STRIPE WEBHOOK — must use raw body, MUST be mounted BEFORE
// any JSON body parser. Stripe signature verification fails
// otherwise.
// ──────────────────────────────────────────────────────────────
app.post(
  '/api/stripe-webhook',
  express.raw({ type: 'application/json' }),
  (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
      event = getStripe().webhooks.constructEvent(req.body, sig, WEBHOOK_SECRET);
    } catch (err) {
      console.error('Webhook signature verification failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    switch (event.type) {
      case 'checkout.session.completed':
        console.log('✅ checkout.session.completed', event.data.object.id);
        break;
      case 'invoice.paid':
        console.log('✅ invoice.paid', event.data.object.id);
        break;
      case 'customer.subscription.deleted':
        console.log('⚠️  subscription cancelled', event.data.object.id);
        break;
      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    res.json({ received: true });
  }
);

// ── JSON body parser for everything else (after webhook) ──
// Raised to 5 MB because /api/analyze now receives extracted PDF text
// (plain UTF-8) instead of binary multipart. Realistic textbook text
// caps around 1–2 MB; 5 MB is a generous ceiling. Vercel's platform
// limit (~4.5 MB) is still the hard upper bound, but plain text is
// far more compact than the binary PDFs it replaces.
app.use(express.json({ limit: '5mb' }));

// ── Static frontend ──
app.use(express.static(path.join(__dirname, 'public')));

// ──────────────────────────────────────────────────────────────
// POST /api/create-checkout-session
// ──────────────────────────────────────────────────────────────
app.post('/api/create-checkout-session', async (_req, res) => {
  if (!PRICE_ID) {
    return res.status(500).json({ error: 'STRIPE_PRICE_ID not configured.' });
  }

  try {
    const session = await getStripe().checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: PRICE_ID, quantity: 1 }],
      success_url: `${APP_BASE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${APP_BASE_URL}/cancel.html`,
      allow_promotion_codes: true,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('create-checkout-session error:', err);
    res.status(500).json({ error: err.message || 'Failed to create session.' });
  }
});

// ──────────────────────────────────────────────────────────────
// GET /api/verify-session?session_id=cs_xxx
// ──────────────────────────────────────────────────────────────
app.get('/api/verify-session', async (req, res) => {
  const { session_id } = req.query;
  if (!session_id) return res.status(400).json({ paid: false, error: 'Missing session_id' });

  try {
    const session = await getStripe().checkout.sessions.retrieve(session_id);
    const paid = session.payment_status === 'paid' || session.status === 'complete';
    res.json({ paid, customer_id: session.customer || null });
  } catch (err) {
    console.error('verify-session error:', err);
    res.status(400).json({ paid: false, error: err.message });
  }
});

// ──────────────────────────────────────────────────────────────
// POST /api/analyze
// Body: { text: string, truncated?: boolean, pageCount?: number }
//
// Client now extracts the PDF text in-browser via pdf.js and sends
// the extracted text as JSON. This removes the binary upload entirely
// — no multer, no pdf-parse, no Vercel 4.5 MB platform ceiling on
// the actual PDF file. Plain text payloads are ~10–50x smaller than
// the binary they came from.
// ──────────────────────────────────────────────────────────────
app.post('/api/analyze', async (req, res) => {
  try {
    let text = (req.body?.text || '').trim();
    const clientTruncated = !!req.body?.truncated;

    if (!text) {
      return res.status(422).json({
        error: 'No readable text found in this PDF. It may be a scanned image with no text layer.',
      });
    }

    // Defense-in-depth: even if client doesn't truncate, we cap server-side.
    const serverTruncated = text.length > MAX_CHARS;
    if (serverTruncated) text = text.slice(0, MAX_CHARS);
    const truncated = clientTruncated || serverTruncated;

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

// ── General error handler ──
// Always responds with JSON so the frontend's res.json() never chokes.
// Handles express.json() body-too-large (413) cleanly.
app.use((err, _req, res, _next) => {
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({
      error: 'Extracted text is too large for the server. Try a smaller PDF or section.',
    });
  }
  res.status(400).json({ error: err?.message || 'Bad request.' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`PDF Study Tool running on port ${PORT}`));
