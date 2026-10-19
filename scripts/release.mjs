// Publish a GitHub release for the version in package.json, with the Windows installer attached.
//   node scripts/release.mjs            build the installer, tag vX.Y.Z, create the release, upload
//   node scripts/release.mjs --no-build reuse release/Vectra-CAD-Setup-X.Y.Z.exe
//   node scripts/release.mjs --draft    create it as a draft (publish later on GitHub)
// Release notes are the "## X.Y.Z" section of CHANGELOG.md.
// Token: $GITHUB_TOKEN, else the github.com login stored for git (Git Credential Manager).
import { execFileSync, execSync } from 'node:child_process';
import { readFileSync, statSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';

const REPO = 'JaySPX05/vectra-cad';
const args = new Set(process.argv.slice(2));
const root = join(import.meta.dirname, '..');
const sh = (cmd) => execSync(cmd, { cwd: root, encoding: 'utf8' }).trim();
const fail = (msg) => { console.error('release: ' + msg); process.exit(1); };

const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const tag = `v${version}`;

// notes from the changelog
const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
const m = new RegExp(`^## ${version.replace(/\./g, '\\.')}\\b[^\\n]*\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, 'm').exec(changelog);
if (!m) fail(`CHANGELOG.md has no "## ${version}" section. Add the release notes first.`);
const title = changelog.match(new RegExp(`^## ${version.replace(/\./g, '\\.')}[^\\n]*`, 'm'))[0].replace(/^## /, '');
const notes = m[1].trim();

// the release must describe committed, pushed code
if (sh('git status --porcelain')) fail('commit your changes first (the working tree is not clean).');
if (sh('git rev-parse --abbrev-ref HEAD') !== 'main') fail('release from the main branch.');
sh('git fetch -q origin');
if (sh('git rev-parse HEAD') !== sh('git rev-parse origin/main')) fail('push main first (local and origin/main differ).');

const token = process.env.GITHUB_TOKEN || (() => {
  const out = execFileSync('git', ['credential', 'fill'], { cwd: root, input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  return /^password=(.*)$/m.exec(out)?.[1];
})();
if (!token) fail('no GitHub token: set GITHUB_TOKEN or sign in with `git push` once.');
const api = async (url, opts = {}) => {
  const res = await fetch(url.startsWith('http') ? url : `https://api.github.com/repos/${REPO}${url}`, {
    ...opts, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', ...(opts.headers ?? {}) },
  });
  const body = res.status === 204 ? null : await res.json();
  if (!res.ok) fail(`${opts.method ?? 'GET'} ${url}: ${res.status} ${JSON.stringify(body)}`);
  return body;
};

const existing = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/${tag}`, { headers: { Authorization: `Bearer ${token}` } });
if (existing.ok) fail(`release ${tag} already exists. Bump the version (npm version minor --no-git-tag-version) for new features.`);

if (!args.has('--no-build')) {
  console.log('building the installer…');
  execSync('npm run dist:win', { cwd: root, stdio: 'inherit' });
}
const exe = join(root, 'release', `Vectra-CAD-Setup-${version}.exe`);
if (!existsSync(exe)) fail(`${exe} not found (run without --no-build).`);

// tag the released commit
if (!sh(`git tag --list ${tag}`)) sh(`git tag -a ${tag} -m "Vectra CAD ${version}"`);
sh(`git push -q origin ${tag}`);

const rel = await api('/releases', {
  method: 'POST',
  body: JSON.stringify({ tag_name: tag, name: `Vectra CAD ${title}`, body: notes, draft: args.has('--draft'), prerelease: version.startsWith('0.0.') }),
});
console.log(`uploading ${basename(exe)} (${(statSync(exe).size / 1048576).toFixed(1)} MB)…`);
const up = rel.upload_url.replace(/\{.*\}$/, '') + '?name=' + encodeURIComponent(basename(exe));
await api(up, { method: 'POST', body: readFileSync(exe), headers: { 'Content-Type': 'application/octet-stream' } });
console.log(`released ${tag}: ${rel.html_url}`);
