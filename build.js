#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { minify: minifyHtml } = require('html-minifier-terser');
const { minify: minifyJs } = require('terser');
const CleanCSS = require('clean-css');

const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist');
const TMP = path.join(ROOT, '.tmp-build');
const SRC_HTML = path.join(ROOT, 'index.html');

const GLOBALS_RESERVADOS = [
  'abrirPopup',
  'fecharPopup',
  'capturarUTMs',
  'obterUTMs',
  'AOS',
];

function log(msg) {
  console.log(`  ${msg}`);
}

function bytes(n) {
  if (n < 1024) return `${n} B`;
  return `${(n / 1024).toFixed(1)} KB`;
}

function rmrf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function extractInlineStyle(html) {
  const match = html.match(/<style>([\s\S]*?)<\/style>/i);
  if (!match) throw new Error('Nenhum <style> inline encontrado em index.html');
  return match[1].trim();
}

function extractAppScript(html) {
  const matches = [...html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/gi)];
  const app = matches.find((m) => !m[2].includes('tailwind.config'));
  if (!app) throw new Error('Script da aplicação não encontrado em index.html');
  return app[2].trim();
}

function copyDir(src, dest) {
  if (!fs.existsSync(src)) return;
  mkdirp(dest);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

function transformHtml(html) {
  let out = html;

  out = out.replace(/(src|href|srcset)="img\//g, '$1="assets/');

  out = out.replace(/\n?\s*<script src="https:\/\/cdn\.tailwindcss\.com"><\/script>/, '');
  out = out.replace(/\n?\s*<script>\s*tailwind\.config\s*=[\s\S]*?<\/script>/, '');

  out = out.replace(
    /<style>[\s\S]*?<\/style>/i,
    '<link rel="stylesheet" href="css/style.css">'
  );

  out = out.replace(
    /(<script src="https:\/\/unpkg\.com\/aos@[^"]+"><\/script>)\s*<script>[\s\S]*?<\/script>/i,
    '$1\n    <script src="js/main.js"></script>'
  );

  if (out.includes('cdn.tailwindcss.com') || out.includes('tailwind.config')) {
    throw new Error('Falha ao remover o Tailwind CDN do HTML de produção');
  }
  if (out.includes('<style>')) {
    throw new Error('CSS inline ainda presente no HTML de produção');
  }
  if (!out.includes('href="css/style.css"') || !out.includes('src="js/main.js"')) {
    throw new Error('Caminhos de css/style.css ou js/main.js não foram injetados');
  }

  return out;
}

async function main() {
  console.log('\n▶ Build de produção — Desafio 3X\n');

  if (!fs.existsSync(SRC_HTML)) {
    throw new Error('index.html não encontrado na raiz do projeto');
  }

  const sourceHtml = fs.readFileSync(SRC_HTML, 'utf8');
  const customCss = extractInlineStyle(sourceHtml);
  const appJs = extractAppScript(sourceHtml);

  log('Limpando dist/ e .tmp-build/');
  rmrf(DIST);
  rmrf(TMP);
  mkdirp(path.join(DIST, 'css'));
  mkdirp(path.join(DIST, 'js'));
  mkdirp(path.join(DIST, 'assets'));
  mkdirp(TMP);

  log('Copiando assets (img/ → dist/assets/)');
  copyDir(path.join(ROOT, 'img'), path.join(DIST, 'assets'));

  const inputCssPath = path.join(TMP, 'input.css');
  const compiledCssPath = path.join(TMP, 'tailwind.css');
  fs.writeFileSync(
    inputCssPath,
    `/* generated — não editar */\n@tailwind base;\n@tailwind components;\n@tailwind utilities;\n\n${customCss}\n`
  );

  log('Gerando CSS Tailwind purgado');
  const tailwindBin = path.join(ROOT, 'node_modules', '.bin', 'tailwindcss');
  execFileSync(
    tailwindBin,
    ['-c', path.join(ROOT, 'tailwind.config.js'), '-i', inputCssPath, '-o', compiledCssPath, '--minify'],
    { cwd: ROOT, stdio: 'inherit' }
  );

  const compiledCss = fs.readFileSync(compiledCssPath, 'utf8');
  const cssOut = new CleanCSS({ level: 2 }).minify(compiledCss);
  if (cssOut.errors.length) {
    throw new Error(`clean-css: ${cssOut.errors.join('; ')}`);
  }
  const cssRewritten = cssOut.styles.replace(/url\((['"]?)img\//g, 'url($1../assets/');
  const cssPath = path.join(DIST, 'css', 'style.css');
  fs.writeFileSync(cssPath, cssRewritten);

  log('Minificando e ofuscando JavaScript');
  const jsResult = await minifyJs(appJs, {
    compress: {
      drop_console: false,
      passes: 2,
    },
    mangle: {
      reserved: GLOBALS_RESERVADOS,
    },
    format: { comments: false },
  });
  if (jsResult.error) throw jsResult.error;
  const jsPath = path.join(DIST, 'js', 'main.js');
  fs.writeFileSync(jsPath, jsResult.code);

  log('Reescrevendo caminhos e minificando HTML');
  const htmlTransformed = transformHtml(sourceHtml);
  const htmlMin = await minifyHtml(htmlTransformed, {
    collapseWhitespace: true,
    conservativeCollapse: false,
    removeComments: true,
    removeRedundantAttributes: false,
    removeOptionalTags: false,
    collapseBooleanAttributes: false,
    minifyCSS: false,
    minifyJS: false,
    keepClosingSlash: true,
    caseSensitive: true,
    processConditionalComments: false,
  });
  const htmlPath = path.join(DIST, 'index.html');
  fs.writeFileSync(htmlPath, htmlMin);

  rmrf(TMP);

  const htmlSize = fs.statSync(htmlPath).size;
  const cssSize = fs.statSync(cssPath).size;
  const jsSize = fs.statSync(jsPath).size;
  const assets = fs.existsSync(path.join(DIST, 'assets'))
    ? fs.readdirSync(path.join(DIST, 'assets'))
    : [];

  console.log('\n✔ dist/ pronta para upload\n');
  console.log(`    dist/index.html     ${bytes(htmlSize)}`);
  console.log(`    dist/css/style.css  ${bytes(cssSize)}`);
  console.log(`    dist/js/main.js     ${bytes(jsSize)}`);
  console.log(`    dist/assets/        ${assets.join(', ') || '(vazio)'}`);
  console.log('');
}

main().catch((err) => {
  console.error('\n✖ Build falhou:', err.message);
  process.exit(1);
});
