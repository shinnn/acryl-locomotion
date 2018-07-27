'use strict';

const {join} = require('path');
const {promisify} = require('util');
const {writeFile} = require('fs').promises;

const SRC = 'src';
const DEST = 'dest';
const src = (...args) => join(__dirname, SRC, ...args);
const dest = (...args) => join(__dirname, DEST, ...args);

const autoprefixer = require('autoprefixer');
const {CLIEngine} = require('eslint');
const {compileFile} = require('marko/compiler');
const minimatch = require('minimatch');
const openInChrome = require('open-in-chrome');
const polka = require('polka');
const postcss = require('postcss');
const pSettle = require('p-settle');
const {render} = require('node-sass');
const requireFromString = require('require-from-string');
const sane = require('sane');
const sassPackageImprter = require('sass-package-importer');
const serveStatic = require('serve-static');

const compileMarkoFile = promisify(compileFile);
const renderSass = promisify(render);
const ReloaderInjector = require('./reloader-injector');
const reloaderInjector = new ReloaderInjector();

async function renderMarkoFileToString(path) {
	return requireFromString(await compileMarkoFile(path)).renderToString();
}

function sendEvent(res, data) {
	data = `${data}\n\n`;

	res.writeHead(200, {
		'content-type': 'text/event-stream',
		'cache-control': ['no-cache', 'no-store', 'must-revalidate'],
		'content-length': Buffer.byteLength(data)
	});

	res.end(data);
}

async function css() {
	const file = src('styles', 'main.scss');
	const to = dest('styles.css');

	const rendered = (await postcss([autoprefixer()]).process((await renderSass({
		file,
		importer: sassPackageImprter
	})).css, {from: file, to})).css;

	return writeFile(to, rendered);
}

async function html() {
	return writeFile(dest('index.html'), await renderMarkoFileToString(src('index.marko')));
}

async function js() {
	const cli = new CLIEngine();
	const {results, errorCount} = cli.executeOnFiles([__filename]);
	const report = cli.getFormatter('codeframe')(results);

	if (report) {
		console.log(cli.getFormatter('codeframe')(results));
	}

	if (errorCount !== 0) {
		throw new Error('ESLint reported more than one error.');
	}
}

const sseQueue = new Set();

(async () => {
	const errors = (await pSettle([
		css(),
		html(),
		js()
	])).filter(({isRejected}) => isRejected).map(({reason}) => reason);

	if (errors.length !== 0) {
		throw errors;
	}

	await polka()
	.use((req, res, next) => {
		reloaderInjector.inject(res);
		next();
	})
	.use(serveStatic(DEST))
	.get('sse', (req, res) => sseQueue.add(res))
	.get('sse/init.js', (req, res) => reloaderInjector.sendScript(res))
	.listen(3000);

	await openInChrome('http://localhost:3000', {app: 'canary'});

	sane('.', {watchman: true}).on('change', async path => {
		try {
			if (minimatch(path, `${DEST}/*.css`)) {
				for (const res of sseQueue) {
					sendEvent(res, 'retry: 100\ndata: 1');
					sseQueue.delete(res);
				}

				return;
			}

			if (minimatch(path, `${DEST}/*.html`)) {
				for (const res of sseQueue) {
					sendEvent(res, 'retry: 100\ndata: 0');
					sseQueue.delete(res);
				}
				return;
			}

			if (minimatch(path, `${SRC}/styles/*.scss`)) {
				await css();
				return;
			}

			if (minimatch(path, `${SRC}/*.marko`)) {
				await html();
				return;
			}

			if (minimatch(path, `${SRC}/*.js`)) {
				await js();
				return;
			}
		} catch (err) {
			console.error(err.stack);
		}
	});
})().catch(err => {
	for (const error of [].concat(err)) {
		console.error(error.stack);
	}

	process.exit(1);
});
