'use strict';
// Montage commun des tests de déploiement : service Projets réel, faux service de déploiement, faux GitHub, vrai Git local (dépôt « distant » nu).
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');
const { createProjects } = require('../../projects.cjs');
const { createDeployerClient } = require('../../deployer-client.cjs');
const { fakeDeployer, TOKEN } = require('./fake-deployer.js');

const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.org', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.org' };
const git = (args, options = {}) => new Promise((resolve, reject) => execFile('git', args, { env: GIT_ENV, ...options }, (error, stdout, stderr) => error ? reject(Object.assign(error, { stderr: String(stderr) })) : resolve(String(stdout))));

const settle = (ms = 40) => new Promise(r => setTimeout(r, ms));
async function until(check, ms = 4000) { const end = Date.now() + ms; for (;;) { const value = await check(); if (value) return value; if (Date.now() > end) throw new Error('délai dépassé'); await settle(15); } }

// github : faux fournisseur (status, createRepo) ; chaque dépôt créé devient un dépôt nu local cloné ensuite par le faux espace de travail.
function fakeGithub(root, { available = true, account = 'ggzdev', failCreate = '' } = {}) {
  const f = { available, account, failCreate, rejectPush: false, created: [], remotes: new Map(), status: async () => f.available ? { available: true, account: f.account } : { available: false, reason: 'Le GitHub CLI n’est pas connecté à GitHub (test).' },
    async createRepo({ owner, name, isPrivate }) {
      if (f.failCreate) throw new Error(f.failCreate);
      const bare = path.join(root, 'remotes', owner + '-' + name + '.git'); fs.mkdirSync(path.dirname(bare), { recursive: true });
      execFileSync('git', ['init', '--bare', '-q', '-b', 'main', bare], { env: GIT_ENV });
      if (f.rejectPush) { fs.mkdirSync(path.join(bare, 'hooks'), { recursive: true }); fs.writeFileSync(path.join(bare, 'hooks', 'pre-receive'), '#!/bin/sh\necho "remote: Permission to ggzdev/atelier-neuf.git denied to ggzdev." >&2\nexit 1\n', { mode: 0o755 }); }
      f.created.push({ owner, name, isPrivate }); f.remotes.set(name, bare);
      return { owner, name, web: `https://github.com/${owner}/${name}`, url: `https://github.com/${owner}/${name}.git` };
    } };
  return f;
}
function fakeWorkspaces(root, github) {
  const clones = [];
  const target = repo => path.join(root, 'dev', repo.split('/').pop().replace(/\.git$/, ''));
  return { clones, root, git, target,
    clone: async repo => {
      clones.push(repo); const name = repo.split('/').pop(), dest = target(repo);
      if (/introuvable/.test(repo)) throw new Error('remote: Repository not found.');
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      let bare = github.remotes.get(name);
      if (!bare) { bare = path.join(root, 'remotes', 'existing-' + name + '.git'); fs.mkdirSync(path.dirname(bare), { recursive: true }); execFileSync('git', ['init', '--bare', '-q', '-b', 'main', bare], { env: GIT_ENV }); github.remotes.set(name, bare); }
      await git(['clone', '-q', bare, dest]);
      return { path: dest, reused: false };
    } };
}

async function setup(t, { deployer: deployerOptions, client = {}, github: githubOptions, log = () => {}, projects: projectOptions = {} } = {}) {
  const service = await fakeDeployer(deployerOptions);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-deploy-'));
  const logs = [];
  const github = fakeGithub(dir, githubOptions), workspaces = fakeWorkspaces(dir, github);
  const deployer = createDeployerClient({ baseUrl: service.url, token: TOKEN, ...client });
  const make = () => createProjects({ dataDir: path.join(dir, 'data'), discover: async () => null, reconcileEvery: 3600000, directEnabled: false, workspaces, deployer, github, log: m => { logs.push(m); log(m); }, ...projectOptions });
  let projects = make();
  t.after(() => { projects.close(); service.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  // Même chemin que l'interface web : projects.handle avec une requête simulée.
  const ui = async (route, method = 'GET', body) => {
    const res = { status: 0, headers: {}, chunks: [], writeHead(s, h) { this.status = s; this.headers = h || {}; }, end(v) { if (v) this.chunks.push(Buffer.from(v)); this.done?.(); }, on() { return this; }, once() { return this; } };
    const finished = new Promise(r => { res.done = r; });
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = { method, headers: {}, async *[Symbol.asyncIterator]() { if (data) yield data; } };
    projects.handle(req, res, new URL('http://localhost/api/projects/' + route), (r, s, v) => { r.writeHead(s, { 'Content-Type': 'application/json' }); r.end(JSON.stringify(v)); });
    await finished;
    const raw = Buffer.concat(res.chunks).toString('utf8');
    return { status: res.status, raw, body: raw ? JSON.parse(raw) : {} };
  };
  const state = async () => (await ui('state')).body;
  const get = async id => (await state()).projects.find(p => p.id === id);
  const SETTINGS = { url: 'https://site.ggz.ovh', type: 'ha-static', config: { src_dir: 'dist', ha_subdir: 'maison/site' } };
  const create = async (name, extra = {}, deployment = SETTINGS) => {
    const r = await ui('projects', 'POST', { name, context: { repository: 'https://github.com/ggzdev/' + name.toLowerCase().replace(/\W+/g, '-') }, ...(deployment ? { deployment } : {}), ...extra });
    await settle(); return r;
  };
  return { ui, state, get, create, service, github, workspaces, dir, logs, deployer, SETTINGS,
    restart: () => { projects.close(); projects = make(); return projects; }, projects: () => projects };
}
module.exports = { setup, settle, until, git, GIT_ENV, TOKEN };
