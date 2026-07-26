'use strict';

const express = require('express');
const cors = require('cors');

const engine = require('./lib/queryEngine');
const audit = require('./lib/audit');
const { buildOverview } = require('./lib/overview');
const { getUser, USERS, ROLES } = require('./lib/rbac');
const { CRIME_TYPES, DISTRICTS, STATUSES } = require('./lib/semanticLayer');
const { hasLLM, MODEL } = require('./lib/claude');

function buildRouter() {
  const router = express.Router();

  router.get('/health', (req, res) => {
    res.json({ ok: true, service: 'suraksha-copilot', model: MODEL, llm: hasLLM() });
  });

  router.get('/meta', (req, res) => {
    res.json({
      crimeTypes: CRIME_TYPES,
      districts: DISTRICTS,
      statuses: STATUSES,
      roles: ROLES,
      llm: hasLLM(),
      model: MODEL,
      sampleQuestions: [
        'Where are the chain snatching hotspots in Bengaluru over the last 6 months?',
        'Who are the typical victims of chain snatching?',
        'Which areas see cybercrime — residential or commercial?',
        'What time do chain snatchings happen?',
        'Which district has the most cybercrime?',
        'Any early warnings for Bengaluru?',
        'Show the network of Basavaraju Sab',
        'What is the meaning of life?',
      ],
    });
  });

  router.get('/users', (req, res) => {
    res.json(
      Object.values(USERS).map((u) => ({
        id: u.id,
        name: u.name,
        role: u.role,
        district: u.district,
        station_id: u.station_id,
      }))
    );
  });

  router.post('/ask', async (req, res) => {
    const { question, userId, justification, history, template, slots } = req.body || {};
    if (!question || typeof question !== 'string' || !question.trim()) {
      return res.status(400).json({ ok: false, error: 'A "question" string is required.' });
    }
    const user = getUser(userId);
    if (!user) {
      return res.status(400).json({ ok: false, error: 'Unknown or missing "userId".' });
    }
    // Conversation context travels with the request (stateless function).
    // Sanitize: last 6 turns, plain shapes only.
    const safeHistory = Array.isArray(history)
      ? history.slice(-6).flatMap((h) => {
          if (!h || typeof h.question !== 'string' || typeof h.decision !== 'string') return [];
          return [{
            question: h.question.slice(0, 500),
            decision: h.decision.slice(0, 60),
            slots: h.slots && typeof h.slots === 'object' && !Array.isArray(h.slots) ? h.slots : {},
          }];
        })
      : [];
    // Optional direct-template invocation (e.g. clicking a hotspot marker).
    // Only a known template id is honored; the engine re-applies guardrails,
    // RBAC scoping, and the justification gate regardless of this shortcut.
    const safeTemplate = typeof template === 'string' && template.length <= 60 ? template : null;
    const safeSlots = slots && typeof slots === 'object' && !Array.isArray(slots) ? slots : null;
    try {
      const result = await engine.answerQuestion({
        question: question.trim(),
        user,
        justification: justification && String(justification).trim() ? String(justification).trim() : null,
        history: safeHistory,
        template: safeTemplate,
        slots: safeSlots,
      });
      res.json(result);
    } catch (err) {
      console.error('[ask] error:', err);
      res.status(500).json({ ok: false, error: 'Internal error while answering.', detail: err.message });
    }
  });

  router.get('/overview', async (req, res) => {
    const user = getUser(req.query.userId);
    if (!user) {
      return res.status(400).json({ ok: false, error: 'Unknown or missing "userId".' });
    }
    try {
      const overview = await buildOverview(user);
      audit.record({
        user_id: user.id, role: user.role, question: '[dashboard load]',
        tier: 1, decision: 'overview', engine: 'dashboard', executed_sql: null, row_count: 0,
      });
      res.json(overview);
    } catch (err) {
      console.error('[overview] error:', err);
      res.status(500).json({ ok: false, error: 'Internal error building overview.', detail: err.message });
    }
  });

  router.get('/audit/recent', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit || '50', 10) || 50, 200);
    res.json({ entries: audit.recentEntries(limit) });
  });

  router.get('/audit/verify', (req, res) => {
    res.json(audit.verifyChain());
  });

  return router;
}

function createApp(options = {}) {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '256kb' }));

  const router = buildRouter();
  // Mount at root (local dev) and under the Catalyst function path so the same
  // routes work whether invoked directly or via /server/suraksha_api/.
  app.use('/', router);
  app.use('/server/suraksha_api', router);

  // Local dev convenience: serve the static web client from the same origin so
  // `node server.js` runs the whole app. On Catalyst, Web Client Hosting serves
  // the client instead, so this is off in the function deployment.
  if (options.serveClient) {
    const path = require('path');
    app.use(express.static(path.join(__dirname, '..', '..', 'client')));
  }

  return app;
}

module.exports = { createApp };
