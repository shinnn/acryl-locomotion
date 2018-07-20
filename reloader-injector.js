'use strict';

const {Parser} = require('htmlparser2');

const PAGE_RELOAD_SIGNAL = '0';
const CSS_RELOAD_SIGNAL = '1';

const {version} = './package.json';

module.exports = class RealoderInjector {
  constructor(options = {}) {
    if (options.url) {
      this.url = encodeURI(decodeURI(options.url));
      return;
    }

    this.url = 'http://localhost:3000/sse';
  }

  inject(res) {
    const write = res.write.bind(res);
    const end = res.end.bind(res);
    const setHeader = res.setHeader.bind(res);
    const writeHead = res.writeHead.bind(res);
    const html = `<script type="module" src="${this.scriptUrl}"></script>`;
    const buffers = [];
    let willEnd = false;
    let len = 0;

  	const parserCallbacks = {
  		onopentag(tagName) {
        if (!parser) {
          return;
        }

  			if (tagName !== 'head') {
  				return;
  			}

  			const insertionIndex = parser.endIndex + 1;
  			const str = Buffer.concat(buffers.map(Buffer.from), len).toString();

        const originalContentLength = parseInt(res.getHeader('content-length'), 0);

        if (originalContentLength) {
          res.setHeader('content-length', originalContentLength + Buffer.byteLength(html));
        }

        const buffer = Buffer.from(`${str.slice(0, insertionIndex)}${html}${str.slice(insertionIndex, len)}`);

        buffers.splice(0, buffers.length, buffer);
        len = buffer.length;

  			parser.end();
  		},
  		onend() {
  			parser = null;
  		}
    };
    let parser = new Parser(parserCallbacks);
    let isHtml = false;

    res.setHeader = (headerName, headerValue) => {
      if (headerName.toLowerCase() === 'content-type') {
        if (headerValue.includes('text/html')) {
          isHtml = true;
        } else {
          res.write = write;
          res.end = end;
          res.setHeader = setHeader;
        }
      }

      setHeader(headerName, headerValue);
    }

    res.write = (data, ...restArgs) => {
      const [encoding] = restArgs;

      if (isHtml && encoding && typeof encoding !== 'function' && !/utf\-?8/.test(encoding)) {
        res.emit('error', 'HTML must be UTF-8.');
        return;
      }

      if (parser) {
        len += data.length;
        buffers.push(data);

        if (willEnd) {
          parser.parseComplete(data);
        } else {
          parser.write(data);
          return;
        }
      }

      if (willEnd) {
        end(Buffer.concat(buffers.map(Buffer.from), len + data.length), ...restArgs);
        return;
      }

      write(data, ...restArgs);
    };

    res.end = (data, ...restArgs) => {
      willEnd = true;
      res.write(data || Buffer.alloc(0), ...restArgs);
    };
  }

  get script() {
    return `'use strict';

const eventSource = new EventSource('${this.url}');
const handlerOptions = {
  once: true,
  passive: true
};

eventSource.onmessage = ({data}) => {
  if (data.length !== 1) {
    return;
  }

  const code = data.charCodeAt(0);

  if (code === ${PAGE_RELOAD_SIGNAL.charCodeAt(0)}) {
    location.reload();
    return;
  }

  if (code !== ${CSS_RELOAD_SIGNAL.charCodeAt(0)}) {
    return;
  }

  for (const {disabled, href, ownerNode} of document.styleSheets) {
    if (!(ownerNode && href)) {
      continue;
    }

    const url = new URL(href);

    if (url.host !== location.host) {
      continue;
    }

    url.searchParams.set('reload_timing', performance.now());

    if (disabled) {
      ownerNode.href = url.toString();
      continue;
    }

    const replacer = ownerNode.cloneNode();
    replacer.addEventListener('load', () => ownerNode.remove(), handlerOptions);
    replacer.href = url.toString();

    ownerNode.after(replacer);
  }
};
`;
  }

  get scriptUrl() {
    return `${this.url}/init.js`;
  }

  sendScript(response) {
    response.writeHead(200, {
      'content-type': 'application/javascript',
      'content-length': this.script.length
    });

    response.end(this.script);

    return response;
  }
}

Object.defineProperty(module.exports, 'PAGE_RELOAD_SIGNAL', {
	value: PAGE_RELOAD_SIGNAL,
	enumerable: true
});

Object.defineProperty(module.exports, 'CSS_RELOAD_SIGNAL', {
	value: CSS_RELOAD_SIGNAL,
	enumerable: true
});
