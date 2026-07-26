'use strict';

/**
 * Local development server. Loads .env from the project root and serves the same
 * Express app that the Catalyst function exports. Not used in the Catalyst
 * deployment (index.js is the entrypoint there).
 */

const path = require('path');
try {
  require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
} catch {
  // dotenv is a devDependency; ignore if absent (env can be set another way).
}

const { createApp } = require('./app');

const port = process.env.PORT || 3000;
const app = createApp({ serveClient: true });

app.listen(port, () => {
  const llm = process.env.ANTHROPIC_API_KEY ? 'ON (Anthropic)' : 'OFF (offline heuristic mode)';
  console.log(`Suraksha Copilot API listening on http://localhost:${port}`);
  console.log(`  Model: ${process.env.SURAKSHA_MODEL || 'claude-opus-4-8'} | LLM: ${llm}`);
  console.log(`  Try: GET /health   POST /ask {question,userId}`);
});
