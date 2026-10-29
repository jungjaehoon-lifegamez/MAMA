/**
 * The update leg's daemons boot with Telegram enabled (the writer's install), and boot asks the
 * Bot API for the bot before it runs. Two halves, both for the leg only:
 *
 * - `node fake-telegram.cjs serve <port-file>`: a Bot API on 127.0.0.1 that answers getMe, a long
 *   poll with no updates, and every other method with ok. Its own process, because the leg's
 *   steps run synchronously.
 * - `--require fake-telegram.cjs` (NODE_OPTIONS in start.sh): sends the daemon's requests for
 *   api.telegram.org there; MAMA_FAKE_TELEGRAM_PORT names the port.
 */
const http = require('node:http');

if (process.argv[2] === 'serve') {
  const { writeFileSync } = require('node:fs');
  let messageId = 1;
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      const method = /\/bot[^/]+\/(\w+)/.exec(request.url ?? '')?.[1] ?? '';
      const reply = (result) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true, result }));
      };
      if (method === 'getMe') {
        reply({
          id: 1,
          is_bot: true,
          first_name: 'upgrade check',
          username: 'upgrade_check_bot',
          can_read_all_group_messages: true,
        });
      } else if (method === 'getUpdates') {
        setTimeout(() => reply([]), 1_000);
      } else if (method === 'sendMessage') {
        reply({ message_id: messageId++, date: Math.floor(Date.now() / 1000), chat: { id: 1 } });
      } else {
        reply(true);
      }
    });
  });
  server.listen(0, '127.0.0.1', () =>
    writeFileSync(process.argv[3], String(server.address().port))
  );
} else {
  const https = require('node:https');
  const port = Number(process.env.MAMA_FAKE_TELEGRAM_PORT);
  const original = https.request;
  https.request = function request(options, ...rest) {
    const target =
      typeof options === 'string' || options instanceof URL ? new URL(options) : options;
    if ((target.hostname ?? target.host) !== 'api.telegram.org') {
      return original.call(this, options, ...rest);
    }
    const local =
      typeof options === 'string' || options instanceof URL
        ? {
            method: 'GET',
            path: `${target.pathname}${target.search}`,
          }
        : { ...options };
    // An https agent cannot carry a plain request.
    return http.request(
      {
        ...local,
        protocol: 'http:',
        hostname: '127.0.0.1',
        host: '127.0.0.1',
        port,
        agent: undefined,
      },
      ...rest.filter((value) => typeof value === 'function')
    );
  };
}
