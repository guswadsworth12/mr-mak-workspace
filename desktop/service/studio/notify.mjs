// Phone alerts through ntfy (https://ntfy.sh or a self-hosted server).
// STUDIO_NTFY_URL is the full topic URL, for example https://ntfy.sh/scott-studio-x7k2
// or http://ntfy.home.lan/studio. STUDIO_NTFY_TOKEN is optional (access token).
export class Notifier {
  constructor(env = {}) {
    this.configure(env);
  }
  configure(env = {}) {
    const raw = String(env.STUDIO_NTFY_URL || process.env.STUDIO_NTFY_URL || '').trim();
    this.token = String(env.STUDIO_NTFY_TOKEN || process.env.STUDIO_NTFY_TOKEN || '').trim();
    this.target = null;
    try {
      const url = new URL(raw);
      const topic = url.pathname.replace(/^\/+|\/+$/g, '');
      if (/^https?:$/.test(url.protocol) && /^[\w-]{1,64}$/.test(topic)) this.target = { server: `${url.protocol}//${url.host}`, topic };
    } catch { /* Not configured. */ }
  }
  get configured() { return !!this.target; }
  async send({ title, message, priority = 3, tags = [], click = null }) {
    if (!this.target) return { sent: false, reason: 'not configured' };
    const payload = { topic: this.target.topic, title: String(title).slice(0, 250), message: String(message || title).slice(0, 3500), priority, tags };
    if (click) payload.click = click;
    try {
      const response = await fetch(this.target.server, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(8000),
      });
      return { sent: response.ok, status: response.status };
    } catch (error) { return { sent: false, reason: error.message }; }
  }
}
