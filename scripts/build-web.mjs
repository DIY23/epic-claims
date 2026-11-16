#!/usr/bin/env node
/**
 * Builds the dashboard into dist/public with esbuild.
 * No bundler config to maintain, no runtime CDN: the dashboard is local-only.
 */
import { build, context } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outdir = path.join(root, 'dist', 'public');
const watch = process.argv.includes('--watch');

fs.mkdirSync(outdir, { recursive: true });

const options = {
  entryPoints: [path.join(root, 'web', 'src', 'main.tsx')],
  bundle: true,
  format: 'esm',
  target: ['safari16'],
  outfile: path.join(outdir, 'app.js'),
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': watch ? '"development"' : '"production"' },
  logLevel: 'info',
};

fs.copyFileSync(path.join(root, 'web', 'index.html'), path.join(outdir, 'index.html'));
fs.copyFileSync(path.join(root, 'web', 'src', 'styles.css'), path.join(outdir, 'styles.css'));

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log(`watching ${path.join(root, 'web', 'src')} -> ${outdir}`);
} else {
  await build(options);
  console.log(`dashboard built: ${outdir}`);
}
