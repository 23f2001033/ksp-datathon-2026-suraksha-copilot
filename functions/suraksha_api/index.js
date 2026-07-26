'use strict';

/**
 * Zoho Catalyst Advanced I/O function entrypoint.
 *
 * Catalyst invokes an exported Express app / (req, res) handler for Advanced I/O
 * Node functions. We export the same app used for local development, so there is
 * a single code path. Set ANTHROPIC_API_KEY (and optionally SURAKSHA_MODEL) as
 * Catalyst Environment Variables.
 */

const { createApp } = require('./app');

module.exports = createApp();
