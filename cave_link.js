/**
 * CaveLink — Vayu's connection to a CAVEHTTPServer.
 *
 * Mirrors the canonical frontend↔CAVE shapes — SEAM-CONTRACT C5, Lane 1
 * (the GENERIC agent lane every new chat surface uses; NOT the Conductor lane):
 *   publish:   POST {base_url}/cave_agents/{agent}/send  {message, ingress?, priority?}
 *   subscribe: GET  {base_url}/events   (SSE; each frame = {type, data, timestamp},
 *              type = "<agent>:<event>", demux key = data.agent. Read `type`,
 *              never `event_type` — see cave/core/mixins/sse.py:22.)
 *   roster:    GET  {base_url}/cave_agents  → {name: className}
 *
 * Degrades gracefully: if CAVE isn't up, reconnects with backoff and stays
 * quiet. Vayu works standalone; this link lights up when CAVE does.
 */

const http = require('http');
const https = require('https');

class CaveLink {
  /**
   * @param {object} opts
   * @param {string} opts.baseUrl   e.g. http://localhost:8765
   * @param {boolean} opts.enabled
   * @param {function} opts.log     appendRuntimeLog
   * @param {function} opts.onEvent called with each parsed SSE payload
   */
  constructor({ baseUrl, enabled, log, onEvent }) {
    this.baseUrl = String(baseUrl || 'http://localhost:8765').replace(/\/$/, '');
    this.enabled = enabled !== false;
    this.log = log || (() => {});
    this.onEvent = onEvent || (() => {});
    this._req = null;
    this._stopped = false;
    this._backoffMs = 5000;
    this._reconnectTimer = null;
  }

  _mod() {
    return this.baseUrl.startsWith('https') ? https : http;
  }

  start() {
    if (!this.enabled) {
      this.log('cave: link disabled in automations.yaml');
      return this;
    }
    this._stopped = false;
    this._connect();
    return this;
  }

  stop() {
    this._stopped = true;
    clearTimeout(this._reconnectTimer);
    if (this._req) {
      try { this._req.destroy(); } catch (e) { /* already gone */ }
      this._req = null;
    }
  }

  _connect() {
    if (this._stopped) return;
    const url = `${this.baseUrl}/events`;
    let buffer = '';

    const req = this._mod().get(url, { headers: { Accept: 'text/event-stream' } }, (res) => {
      if (res.statusCode !== 200) {
        this.log(`cave: /events responded ${res.statusCode}`);
        res.resume();
        this._scheduleReconnect();
        return;
      }
      this.log('cave: subscribed to /events');
      this._backoffMs = 5000; // healthy connection resets backoff

      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        // SSE frames are separated by a blank line
        let sep;
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data:')) continue;
            const raw = line.slice(5).trim();
            if (!raw || raw === '[DONE]') continue;
            try {
              this.onEvent(JSON.parse(raw));
            } catch (e) {
              // non-JSON keepalives are fine to ignore
            }
          }
        }
      });
      res.on('end', () => this._scheduleReconnect());
      res.on('error', () => this._scheduleReconnect());
    });

    req.on('error', (e) => {
      // ECONNREFUSED while CAVE is down is expected — stay quiet, retry
      this._scheduleReconnect();
    });
    this._req = req;
  }

  _scheduleReconnect() {
    if (this._stopped) return;
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(() => this._connect(), this._backoffMs);
    this._backoffMs = Math.min(this._backoffMs * 2, 60000);
  }

  /**
   * GET the live, authoritative agent registry from CAVE: {name: className}.
   * Returns {} (not throwing) if CAVE is unreachable — callers must degrade
   * gracefully, same philosophy as the rest of this class.
   */
  async listAgents() {
    if (!this.enabled) return {};
    try {
      const resp = await fetch(`${this.baseUrl}/cave_agents`);
      if (!resp.ok) {
        this.log(`cave: /cave_agents responded ${resp.status}`);
        return {};
      }
      return await resp.json();
    } catch (e) {
      this.log(`cave: listAgents failed ${e.message}`);
      return {};
    }
  }

  /** POST an utterance to a named CAVE agent's inbox. */
  async sendToAgent(agent, message) {
    if (!this.enabled) {
      this.log('cave: sendToAgent skipped (link disabled)');
      return { routed: false, error: 'cave link disabled' };
    }
    if (!agent) return { routed: false, error: 'no agent name' };

    const url = `${this.baseUrl}/cave_agents/${encodeURIComponent(agent)}/send`;
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, ingress: 'frontend', priority: 0 }),
      });
      const body = await resp.json().catch(() => ({}));
      this.log(`cave: sent to agent "${agent}" → ${resp.status} routed=${body.routed}`);
      return body;
    } catch (e) {
      this.log(`cave: sendToAgent "${agent}" failed ${e.message}`);
      return { routed: false, error: e.message };
    }
  }
}

module.exports = { CaveLink };
