import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import * as tar from 'tar';

export interface Fixture {
  baseUrl: string;
  server: http.Server;
  /** Mutable switches the tests flip. */
  corruptChecksum: boolean;
  withChecksums: boolean;
  badSignature: boolean;
  signature: boolean;
  publicKey: string;
  close: () => Promise<void>;
}

interface PackageSpec {
  version: string;
  prerelease: boolean;
}

const PACKAGES: PackageSpec[] = [
  { version: '1.1.0', prerelease: false },
  { version: '1.2.0-beta.1', prerelease: true },
];

/**
 * Builds real release tarballs and serves them (plus the GitHub releases API)
 * from a local HTTP server, so the updater is exercised end to end: download,
 * checksum, signature, extraction, validation — no mocking of the transport.
 */
export async function buildReleaseFixture(dir: string): Promise<Fixture> {
  const dist = path.join(dir, 'fixture');
  fs.mkdirSync(dist, { recursive: true });

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const rawPublicKey = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');

  const sha = (file: string): string => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

  // Each release: <pkg>/ with package.json + dist/cli/index.js, archived with a
  // single top-level directory (the updater strips it).
  const tarballs: Record<string, string> = {};
  for (const pkg of PACKAGES) {
    const staging = path.join(dist, `stage-${pkg.version}`);
    const root = path.join(staging, `epic-claims-${pkg.version}`);
    fs.mkdirSync(path.join(root, 'dist', 'cli'), { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'epic-claims', version: pkg.version }, null, 2));
    fs.writeFileSync(path.join(root, 'dist', 'cli', 'index.js'), `// epic-claims ${pkg.version}\nconsole.log('${pkg.version}');\n`);
    const file = path.join(dist, `epic-claims-${pkg.version}.tar.gz`);
    await tar.c({ gzip: true, file, cwd: staging }, [`epic-claims-${pkg.version}`]);
    tarballs[pkg.version] = file;
  }

  const fixture: Fixture = {
    baseUrl: '',
    server: null as unknown as http.Server,
    corruptChecksum: false,
    withChecksums: true,
    badSignature: false,
    signature: false,
    publicKey: rawPublicKey,
    close: async () => {
      await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
    },
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');

    if (url.pathname === '/repos/DIY23/epic-claims/releases') {
      const releases = PACKAGES.map((pkg) => ({
        tag_name: `v${pkg.version}`,
        name: `v${pkg.version}`,
        prerelease: pkg.prerelease,
        draft: false,
        published_at: '2026-11-16T00:00:00Z',
        body: `Release ${pkg.version}`,
        html_url: `${fixture.baseUrl}/releases/${pkg.version}`,
        assets: [
          {
            name: `epic-claims-${pkg.version}.tar.gz`,
            browser_download_url: `${fixture.baseUrl}/download/epic-claims-${pkg.version}.tar.gz`,
            size: fs.statSync(tarballs[pkg.version]!).size,
            content_type: 'application/gzip',
            download_count: 0,
          },
          ...(fixture.withChecksums
            ? [{ name: 'SHA256SUMS', browser_download_url: `${fixture.baseUrl}/download/SHA256SUMS`, size: 0, content_type: 'text/plain', download_count: 0 }]
            : []),
          ...(fixture.signature
            ? [{ name: 'SHA256SUMS.sig', browser_download_url: `${fixture.baseUrl}/download/SHA256SUMS.sig`, size: 0, content_type: 'text/plain', download_count: 0 }]
            : []),
        ],
      }));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(releases));
      return;
    }

    if (url.pathname === '/download/SHA256SUMS') {
      const lines = PACKAGES.map((pkg) => {
        const real = sha(tarballs[pkg.version]!);
        const value = fixture.corruptChecksum && pkg.version === '1.1.0' ? 'f'.repeat(64) : real;
        return `${value}  epic-claims-${pkg.version}.tar.gz`;
      });
      const body = `${lines.join('\n')}\n`;
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(body);
      return;
    }

    if (url.pathname === '/download/SHA256SUMS.sig') {
      const lines = PACKAGES.map((pkg) => {
        const real = sha(tarballs[pkg.version]!);
        const value = fixture.corruptChecksum && pkg.version === '1.1.0' ? 'f'.repeat(64) : real;
        return `${value}  epic-claims-${pkg.version}.tar.gz`;
      });
      const body = `${lines.join('\n')}\n`;
      const signature = crypto.sign(null, Buffer.from(body), privateKey).toString('base64');
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(fixture.badSignature ? `${signature.slice(0, 20)}AAAA` : signature);
      return;
    }

    const download = /^\/download\/(epic-claims-.+\.tar\.gz)$/.exec(url.pathname);
    if (download?.[1]) {
      const file = path.join(dist, download[1]);
      if (!fs.existsSync(file)) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/gzip' });
      fs.createReadStream(file).pipe(res);
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ message: 'Not Found' }));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  fixture.baseUrl = `http://127.0.0.1:${port}`;
  fixture.server = server;
  return fixture;
}
