'use strict';

const {join} = require('path');

const SRC = join(__dirname, 'src');
const DEST = join(__dirname, 'dest');

'use strict';

const opn = require('opn');
const polka = require('polka');
const sane = require('sane');
const serveStatic = require('serve-static');

const ReloaderInjector = require('./reloader-injector');
const reloaderInjector = new ReloaderInjector();

function sendEvent(res, data) {
  data = `${data}\n\n`;

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    'content-length': Buffer.byteLength(data)
  });

  res.end(data);
}

const sseQueue = new Set();

(async () => {
  await polka()
  .use((req, res, next) => {
    reloaderInjector.inject(res);
    next();
  })
  .use(serveStatic(DEST, {}))
  .get('sse', (req, res) => sseQueue.add(res))
  .get('sse/init.js', (req, res) => reloaderInjector.sendScript(res))
  .listen(3000);

  await opn('http://localhost:3000');
})();

sane('.', {watchman: true}).on('change', path => {
  if (path.endsWith('.html')) {
    for (const res of sseQueue) {
      sendEvent(res, 'retry: 100\ndata: 0');
      sseQueue.delete(res);
    }

    return;
  }

  if (path.endsWith('.css')) {
    for (const res of sseQueue) {
      sendEvent(res, 'retry: 100\ndata: 1');
      sseQueue.delete(res);
    }
  }
});
