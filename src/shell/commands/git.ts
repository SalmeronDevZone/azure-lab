// git simulado conectado a Azure Repos.
import type { CommandDef, CmdCtx, Session } from '../interp';
import type { GitCommit, LocalRepo } from '../../engine/types';
import { C, eprintln, parseFlags, println } from './util';
import { getState, changed } from '../../engine/store';
import { commitId, filesAt, isAncestor, parseRepoUrl, receivePush, TEMPLATES } from '../../engine/services/devops';
import { nowIso, shortHash } from '../../engine/util';

type Repo = LocalRepo & { remoteRefs?: Record<string, string>; tags?: Record<string, string>; merging?: { theirs: string } | null };

function repoMap(sess: Session): Record<string, Repo> {
  if (sess.kind === 'cloudshell') return getState().gitLocal as Record<string, Repo>;
  const a = sess as any;
  a.__git ??= {};
  return a.__git;
}

function findRepo(sess: Session): Repo | null {
  const map = repoMap(sess);
  let dir = sess.cwd;
  for (;;) {
    if (map[dir]) return map[dir];
    if (dir === '/' || !dir) return null;
    dir = dir.split('/').slice(0, -1).join('/') || '/';
  }
}

const NOT_REPO = 'fatal: not a git repository (or any of the parent directories): .git';

function readGitConfig(sess: Session, repo: Repo | null, key: string): string | undefined {
  if (repo && key === 'user.name' && repo.userName) return repo.userName;
  if (repo && key === 'user.email' && repo.userEmail) return repo.userEmail;
  const p = `${sess.home}/.gitconfig`;
  if (!sess.fs.isFile(p)) return undefined;
  const [section, name] = key.split('.');
  let cur = '';
  for (const line of sess.fs.readFile(p).split('\n')) {
    const sm = /^\s*\[(\w+)\]/.exec(line);
    if (sm) {
      cur = sm[1];
      continue;
    }
    const m = /^\s*(\w+)\s*=\s*(.*)$/.exec(line);
    if (m && cur === section && m[1] === name) return m[2].trim();
  }
  return undefined;
}

function writeGitConfig(sess: Session, key: string, value: string) {
  const p = `${sess.home}/.gitconfig`;
  const [section, name] = key.split('.');
  const lines = sess.fs.isFile(p) ? sess.fs.readFile(p).split('\n').filter((l) => l !== '') : [];
  let idx = lines.findIndex((l) => l.trim() === `[${section}]`);
  if (idx < 0) {
    lines.push(`[${section}]`);
    idx = lines.length - 1;
  }
  let j = idx + 1;
  let replaced = false;
  for (; j < lines.length && !/^\s*\[/.test(lines[j]); j++) {
    if (new RegExp(`^\\s*${name}\\s*=`).test(lines[j])) {
      lines[j] = `\t${name} = ${value}`;
      replaced = true;
    }
  }
  if (!replaced) lines.splice(j, 0, `\t${name} = ${value}`);
  sess.fs.writeFile(p, lines.join('\n') + '\n');
}

function work(sess: Session, repo: Repo): Record<string, string> {
  return sess.fs.snapshot(repo.path, (rel) => rel === '.git' || rel.startsWith('.git/'));
}

// ---------------------------------------------------------------- .gitignore

interface IgnoreRule {
  base: string;
  neg: boolean;
  dirOnly: boolean;
  re: RegExp;
  source: string;
  line: number;
  pattern: string;
}

/** Patrón de .gitignore a expresión regular: * no cruza carpetas, ** sí, ? es un carácter. */
function ignoreGlob(p: string): string {
  let out = '';
  for (let i = 0; i < p.length; i++) {
    if (p.startsWith('**/', i)) {
      out += '(?:.*/)?';
      i += 2;
    } else if (p.startsWith('**', i)) {
      out += '.*';
      i += 1;
    } else if (p[i] === '*') out += '[^/]*';
    else if (p[i] === '?') out += '[^/]';
    else out += p[i].replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return out;
}

/** Reglas de todos los .gitignore del árbol de trabajo (los más profundos, al final: tienen prioridad). */
export function ignoreRules(w: Record<string, string>): IgnoreRule[] {
  const files = Object.keys(w)
    .filter((k) => k === '.gitignore' || k.endsWith('/.gitignore'))
    .sort((a, b) => a.split('/').length - b.split('/').length);
  const rules: IgnoreRule[] = [];
  for (const f of files) {
    const base = f.split('/').slice(0, -1).join('/');
    w[f].split('\n').forEach((raw, i) => {
      let p = raw.replace(/\r$/, '').replace(/\s+$/, '');
      if (!p || p.startsWith('#')) return;
      const neg = p.startsWith('!');
      if (neg) p = p.slice(1);
      if (p.startsWith('\\')) p = p.slice(1);
      const dirOnly = p.endsWith('/');
      if (dirOnly) p = p.slice(0, -1);
      const anchored = p.includes('/');
      p = p.replace(/^\//, '');
      rules.push({ base, neg, dirOnly, re: new RegExp(anchored ? `^${ignoreGlob(p)}$` : `^(?:.*/)?${ignoreGlob(p)}$`), source: f, line: i + 1, pattern: raw.trim() });
    });
  }
  return rules;
}

/**
 * Regla que ignora una ruta, o null. Como en git: gana la última regla que coincide, y si una carpeta está
 * ignorada, todo lo que contiene también (una negación no puede "rescatar" un fichero de una carpeta ignorada).
 */
export function ignoredBy(rules: IgnoreRule[], rel: string, isDir = false): IgnoreRule | null {
  const parts = rel.split('/');
  for (let i = 1; i <= parts.length; i++) {
    const sub = parts.slice(0, i).join('/');
    const dir = i < parts.length || isDir;
    let last: IgnoreRule | null = null;
    for (const r of rules) {
      if (r.base && !sub.startsWith(r.base + '/')) continue;
      if (r.dirOnly && !dir) continue;
      if (r.re.test(r.base ? sub.slice(r.base.length + 1) : sub)) last = r;
    }
    if (last && !last.neg) return last;
  }
  return null;
}

/** Ruta que muestra git para algo ignorado: la carpeta ignorada más alta (node_modules/) o el fichero. */
function ignoredDisplay(rules: IgnoreRule[], rel: string): string {
  const parts = rel.split('/');
  for (let i = 1; i < parts.length; i++) {
    const sub = parts.slice(0, i).join('/');
    if (ignoredBy(rules, sub, true)) return sub + '/';
  }
  return rel;
}

function headId(repo: Repo): string | null {
  return repo.branches[repo.head] ?? null;
}

function headTree(repo: Repo): Record<string, string> {
  const id = headId(repo);
  return id ? repo.commits[id]?.tree ?? {} : {};
}

function indexTree(repo: Repo): Record<string, string> {
  return repo.staged ? (Object.fromEntries(Object.entries(repo.staged).filter(([, v]) => v !== null)) as Record<string, string>) : headTree(repo);
}

function diffKeys(a: Record<string, string>, b: Record<string, string>) {
  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  for (const k of Object.keys(b)) if (!(k in a)) added.push(k);
  else if (a[k] !== b[k]) modified.push(k);
  for (const k of Object.keys(a)) if (!(k in b)) deleted.push(k);
  return { added: added.sort(), modified: modified.sort(), deleted: deleted.sort() };
}

function relToRepo(sess: Session, repo: Repo, p: string): string {
  const abs = sess.resolve(p);
  return abs === repo.path ? '' : abs.slice(repo.path.length + 1);
}

function writeTree(sess: Session, repo: Repo, tree: Record<string, string>) {
  const cur = work(sess, repo);
  for (const k of Object.keys(cur)) if (!(k in tree)) sess.fs.rm(`${repo.path}/${k}`);
  for (const [k, v] of Object.entries(tree)) {
    const p = `${repo.path}/${k}`;
    sess.fs.mkdir(p.split('/').slice(0, -1).join('/'), true);
    sess.fs.writeFile(p, v);
  }
}

function newRepo(path: string, branch = 'main'): Repo {
  return { path, head: branch, branches: { [branch]: null }, commits: {}, staged: null, remotes: {}, upstream: {}, remoteRefs: {}, tags: {}, merging: null };
}

function reachable(repo: Repo, from: string | null): GitCommit[] {
  const out: GitCommit[] = [];
  const seen = new Set<string>();
  const stack = from ? [from] : [];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id) || !repo.commits[id]) continue;
    seen.add(id);
    out.push(repo.commits[id]);
    stack.push(...repo.commits[id].parents);
  }
  return out.sort((a, b) => (a.date < b.date ? 1 : -1));
}

function author(sess: Session, repo: Repo, io: CmdCtx['io']): string | null {
  const name = readGitConfig(sess, repo, 'user.name') ?? (sess.kind === 'agent' ? 'Azure Pipelines' : undefined);
  const email = readGitConfig(sess, repo, 'user.email') ?? (sess.kind === 'agent' ? 'build@dev.azure.com' : undefined);
  if (!name || !email) {
    eprintln(io, `Author identity unknown\n\n*** Please tell me who you are.\n\nRun\n\n  git config --global user.email "you@example.com"\n  git config --global user.name "Your Name"\n\nto set your account's default identity.\nOmit --global to set the identity only in this repository.\n\nfatal: unable to auto-detect email address (got '${sess.user}@cc-${shortHash(sess.user, 8)}.(none)')`);
    return null;
  }
  return `${name} <${email}>`;
}

function doCommit(sess: Session, repo: Repo, tree: Record<string, string>, message: string, who: string, extraParent?: string): GitCommit {
  const parent = headId(repo);
  const c: GitCommit = { id: commitId(message + who), message, author: who, date: nowIso(), parents: [parent, extraParent].filter(Boolean) as string[], tree: { ...tree } };
  repo.commits[c.id] = c;
  repo.branches[repo.head] = c.id;
  repo.staged = null;
  repo.merging = null;
  changed();
  return c;
}

function cloneFrom(sess: Session, io: CmdCtx['io'], url: string, dir?: string): number {
  let files: Record<string, string> = {};
  let commits: Record<string, GitCommit> = {};
  let branches: Record<string, string> = {};
  let defaultBranch = 'main';
  let name = url.replace(/\.git$/, '').split('/').pop() ?? 'repo';
  const gh = /github\.com\/azure-lab\/([\w-]+)/i.exec(url);
  const target = parseRepoUrl(url);
  if (target) {
    commits = JSON.parse(JSON.stringify(target.repo.commits));
    branches = { ...target.repo.branches };
    defaultBranch = target.repo.defaultBranch;
    files = filesAt(target.repo, defaultBranch);
    name = target.repo.name;
  } else if (gh && TEMPLATES[gh[1]]) {
    const c: GitCommit = { id: commitId(gh[1]), message: 'Initial commit', author: 'Azure Lab <lab@azurelab.dev>', date: nowIso(), parents: [], tree: TEMPLATES[gh[1]].files };
    commits = { [c.id]: c };
    branches = { main: c.id };
    files = c.tree;
    name = gh[1];
  } else {
    eprintln(io, `Cloning into '${dir ?? name}'...\nremote: TF401019: The Git repository with name or identifier ${name} does not exist or you do not have permissions for the operation you are attempting.\nfatal: repository '${url}' not found`);
    return 128;
  }
  const path = sess.resolve(dir ?? decodeURIComponent(name));
  if (sess.fs.exists(path) && Object.keys(sess.fs.snapshot(path)).length) {
    eprintln(io, `fatal: destination path '${dir ?? name}' already exists and is not an empty directory.`);
    return 128;
  }
  println(io, `Cloning into '${dir ?? decodeURIComponent(name)}'...`);
  sess.fs.mkdir(path, true);
  sess.fs.mkdir(`${path}/.git`, true);
  sess.fs.writeFile(`${path}/.git/HEAD`, `ref: refs/heads/${defaultBranch}\n`);
  const repo = newRepo(path, defaultBranch);
  repo.commits = commits;
  repo.branches = { [defaultBranch]: branches[defaultBranch] ?? null };
  repo.remotes = { origin: url };
  repo.upstream = { [defaultBranch]: `origin/${defaultBranch}` };
  repo.remoteRefs = Object.fromEntries(Object.entries(branches).map(([b, id]) => [`origin/${b}`, id]));
  repoMap(sess)[path] = repo;
  if (!Object.keys(files).length) eprintln(io, 'warning: You appear to have cloned an empty repository.');
  else {
    const n = Object.keys(files).length * 3;
    println(io, `remote: Azure Repos\nremote: Found ${n} objects to send. (12 ms)\nReceiving objects: 100% (${n}/${n}), done.\nResolving deltas: 100% (2/2), done.`);
  }
  writeTree(sess, repo, files);
  changed();
  return 0;
}

const git: CommandDef = {
  summary: 'Control de versiones',
  async fn(argv, ctx) {
    const { sess, io } = ctx;
    let args = argv.slice(1);
    if (args[0] === '-C') {
      const saved = sess.cwd;
      sess.cwd = sess.resolve(args[1]);
      try {
        return await git.fn(['git', ...args.slice(2)], ctx);
      } finally {
        sess.cwd = saved;
      }
    }
    const sub = args[0];
    args = args.slice(1);
    if (!sub || sub === '--help' || sub === 'help') {
      println(io, 'usage: git <command> [<args>]\n\nstart a working area\n   clone, init\nwork on the current change\n   add, mv, restore, rm\nexamine the history and state\n   diff, log, show, status\ngrow, mark and tweak your common history\n   branch, commit, merge, reset, switch, tag, checkout\ncollaborate\n   fetch, pull, push, remote');
      return sub ? 0 : 1;
    }
    if (sub === '--version' || sub === 'version') {
      println(io, 'git version 2.46.1');
      return 0;
    }
    if (sub === 'config') {
      const { flags, rest } = parseFlags(args);
      const repo = findRepo(sess);
      if (flags.has('list') || flags.has('l')) {
        const p = `${sess.home}/.gitconfig`;
        if (sess.fs.isFile(p)) {
          let section = '';
          for (const line of sess.fs.readFile(p).split('\n')) {
            const sm = /^\s*\[(\w+)\]/.exec(line);
            if (sm) section = sm[1];
            const m = /^\s*(\w+)\s*=\s*(.*)$/.exec(line);
            if (m) println(io, `${section}.${m[1]}=${m[2]}`);
          }
        }
        if (repo?.remotes.origin) println(io, `remote.origin.url=${repo.remotes.origin}`);
        return 0;
      }
      const [key, value] = rest;
      if (!key) {
        eprintln(io, 'usage: git config [<options>]');
        return 1;
      }
      if (value === undefined) {
        const v = readGitConfig(sess, repo, key);
        if (v === undefined) return 1;
        println(io, v);
        return 0;
      }
      if (!flags.has('global') && repo && (key === 'user.name' || key === 'user.email')) {
        if (key === 'user.name') repo.userName = value;
        else repo.userEmail = value;
      } else writeGitConfig(sess, key, value);
      changed();
      return 0;
    }
    if (sub === 'clone') {
      const pos = args.filter((a) => !a.startsWith('-'));
      if (!pos[0]) {
        eprintln(io, 'fatal: You must specify a repository to clone.');
        return 129;
      }
      return cloneFrom(sess, io, pos[0], pos[1]);
    }
    if (sub === 'init') {
      const { opts, rest } = parseFlags(args, ['b', 'initial-branch']);
      const path = sess.resolve(rest[0] ?? '.');
      sess.fs.mkdir(path, true);
      const map = repoMap(sess);
      const existed = !!map[path];
      if (!existed) map[path] = newRepo(path, opts.b ?? opts['initial-branch'] ?? 'main');
      sess.fs.mkdir(`${path}/.git`, true);
      sess.fs.writeFile(`${path}/.git/HEAD`, `ref: refs/heads/${map[path].head}\n`);
      println(io, `${existed ? 'Reinitialized existing' : 'Initialized empty'} Git repository in ${path}/.git/`);
      changed();
      return 0;
    }
    const repo = findRepo(sess);
    if (!repo) {
      eprintln(io, NOT_REPO);
      return 128;
    }
    switch (sub) {
      case 'status': {
        const short = args.includes('-s') || args.includes('--short');
        const h = headTree(repo);
        const idx = indexTree(repo);
        const w = work(sess, repo);
        const staged = diffKeys(h, idx);
        const tracked = Object.fromEntries(Object.entries(w).filter(([k]) => k in idx));
        const unstaged = diffKeys(idx, { ...tracked });
        const deletedWork = Object.keys(idx).filter((k) => !(k in w));
        const rules = ignoreRules(w);
        const untracked = Object.keys(w).filter((k) => !(k in idx) && !ignoredBy(rules, k)).sort();
        const ignored = args.includes('--ignored') ? [...new Set(Object.keys(w).filter((k) => !(k in idx) && ignoredBy(rules, k)).map((k) => ignoredDisplay(rules, k)))].sort() : [];
        if (short) {
          for (const f of staged.added) println(io, `${C.green('A')}  ${f}`);
          for (const f of staged.modified) println(io, `${C.green('M')}  ${f}`);
          for (const f of staged.deleted) println(io, `${C.green('D')}  ${f}`);
          for (const f of unstaged.modified) println(io, ` ${C.red('M')} ${f}`);
          for (const f of deletedWork) println(io, ` ${C.red('D')} ${f}`);
          for (const f of untracked) println(io, `${C.red('??')} ${f}`);
          for (const f of ignored) println(io, `${C.red('!!')} ${f}`);
          return 0;
        }
        println(io, `On branch ${repo.head}`);
        const up = repo.upstream[repo.head];
        if (up && repo.remoteRefs?.[up]) {
          const local = headId(repo);
          const remote = repo.remoteRefs[up];
          const ahead = local ? reachable(repo, local).filter((c) => !reachable(repo, remote).some((r) => r.id === c.id)).length : 0;
          println(io, ahead ? `Your branch is ahead of '${up}' by ${ahead} commit${ahead > 1 ? 's' : ''}.\n  (use "git push" to publish your local commits)` : `Your branch is up to date with '${up}'.`);
        }
        if (repo.merging) println(io, 'You have unmerged paths.\n  (fix conflicts and run "git commit")');
        if (!headId(repo)) println(io, '\nNo commits yet');
        const anyStaged = staged.added.length + staged.modified.length + staged.deleted.length;
        if (anyStaged) {
          println(io, `\nChanges to be committed:\n  (use "git restore --staged <file>..." to unstage)`);
          for (const f of staged.added) println(io, C.green(`\tnew file:   ${f}`));
          for (const f of staged.modified) println(io, C.green(`\tmodified:   ${f}`));
          for (const f of staged.deleted) println(io, C.green(`\tdeleted:    ${f}`));
        }
        if (unstaged.modified.length || deletedWork.length) {
          println(io, `\nChanges not staged for commit:\n  (use "git add <file>..." to update what will be committed)\n  (use "git restore <file>..." to discard changes in working directory)`);
          for (const f of unstaged.modified) println(io, C.red(`\tmodified:   ${f}`));
          for (const f of deletedWork) println(io, C.red(`\tdeleted:    ${f}`));
        }
        if (untracked.length) {
          println(io, `\nUntracked files:\n  (use "git add <file>..." to include in what will be committed)`);
          for (const f of untracked) println(io, C.red(`\t${f}`));
        }
        if (ignored.length) {
          println(io, `\nIgnored files:\n  (use "git add -f <file>..." to include in what will be committed)`);
          for (const f of ignored) println(io, C.red(`\t${f}`));
        }
        if (!anyStaged && !unstaged.modified.length && !deletedWork.length && !untracked.length) println(io, headId(repo) ? '\nnothing to commit, working tree clean' : '\nnothing to commit (create/copy files and use "git add" to track)');
        else if (!anyStaged) println(io, '\nno changes added to commit (use "git add" and/or "git commit -a")');
        return 0;
      }
      case 'add': {
        const all = args.includes('-A') || args.includes('--all') || args.includes('.');
        const paths = args.filter((a) => !a.startsWith('-'));
        if (!paths.length && !all) {
          eprintln(io, 'Nothing specified, nothing added.\nhint: Maybe you wanted to say \'git add .\'?');
          return 0;
        }
        const w = work(sess, repo);
        const idx: Record<string, string | null> = { ...indexTree(repo) };
        const force = args.includes('-f') || args.includes('--force');
        const rules = ignoreRules(w);
        const refused: string[] = [];
        const targets = all && (paths.length === 0 || paths.includes('.')) && sess.cwd === repo.path ? [''] : paths.map((p) => relToRepo(sess, repo, p));
        let matched = false;
        for (const t of targets) {
          const prefix = t === '' ? '' : t + '/';
          for (const [k, v] of Object.entries(w)) if (t === '' || k === t || k.startsWith(prefix) || new RegExp('^' + t.replace(/\./g, '\\.').replace(/\*/g, '[^/]*') + '$').test(k)) {
            // Lo ignorado no se añade salvo que ya esté versionado o se fuerce con -f; si lo pides por su nombre, git avisa.
            if (!force && !(k in idx) && ignoredBy(rules, k)) {
              if (k === t || t === ignoredDisplay(rules, k).replace(/\/$/, '')) refused.push(ignoredDisplay(rules, k).replace(/\/$/, ''));
              continue;
            }
            idx[k] = v;
            matched = true;
          }
          for (const k of Object.keys(idx)) if ((t === '' || k === t || k.startsWith(prefix)) && !(k in w)) {
            delete idx[k];
            matched = true;
          }
        }
        if (!matched && !refused.length && paths.length && !paths.every((p) => sess.fs.exists(sess.resolve(p)))) {
          eprintln(io, `fatal: pathspec '${paths[0]}' did not match any files`);
          return 128;
        }
        repo.staged = idx;
        changed();
        if (refused.length) {
          eprintln(io, `The following paths are ignored by one of your .gitignore files:\n${[...new Set(refused)].join('\n')}\n${C.yellow('hint: Use -f if you really want to add them.')}\n${C.yellow('hint: Turn this message off by running')}\n${C.yellow('hint: "git config advice.addIgnoredFile false"')}`);
          return 1;
        }
        return 0;
      }
      case 'rm': {
        const cached = args.includes('--cached');
        const recursive = args.some((a) => a === '-r' || /^-[a-z]*r/.test(a));
        const idx: Record<string, string | null> = { ...indexTree(repo) };
        for (const p of args.filter((a) => !a.startsWith('-'))) {
          const rel = relToRepo(sess, repo, p).replace(/\/$/, '');
          const inside = Object.keys(idx).filter((k) => k.startsWith(rel + '/'));
          if (!(rel in idx) && !inside.length) {
            eprintln(io, `fatal: pathspec '${p}' did not match any files`);
            return 128;
          }
          if (!(rel in idx) && !recursive) {
            eprintln(io, `fatal: not removing '${rel}' recursively without -r`);
            return 128;
          }
          for (const k of rel in idx ? [rel] : inside) {
            delete idx[k];
            if (!cached) sess.fs.rm(`${repo.path}/${k}`);
            println(io, `rm '${k}'`);
          }
        }
        repo.staged = idx;
        changed();
        return 0;
      }
      case 'check-ignore': {
        const verbose = args.includes('-v') || args.includes('--verbose');
        const noIndex = args.includes('--no-index');
        const w = work(sess, repo);
        const rules = ignoreRules(w);
        const idx = indexTree(repo);
        let any = false;
        for (const p of args.filter((a) => !a.startsWith('-'))) {
          const rel = relToRepo(sess, repo, p).replace(/\/$/, '');
          // Un fichero ya versionado no lo protege el .gitignore: check-ignore no lo muestra.
          if (!noIndex && rel in idx) continue;
          const rule = ignoredBy(rules, rel, sess.fs.isDir(sess.resolve(p)));
          if (!rule) continue;
          any = true;
          println(io, verbose ? `${rule.source}:${rule.line}:${rule.pattern}\t${p}` : p);
        }
        return any ? 0 : 1;
      }
      case 'commit': {
        const { flags, opts } = parseFlags(args, ['m', 'message']);
        const msgs: string[] = [];
        for (let i = 0; i < args.length; i++) if (args[i] === '-m' || args[i] === '--message') msgs.push(args[++i]);
        else if (/^-[a-z]*m$/.test(args[i])) msgs.push(args[++i]);
        const message = msgs.join('\n\n') || opts.m;
        if (flags.has('a') || args.some((a) => /^-[a-z]*a/.test(a))) {
          const w = work(sess, repo);
          const idx: Record<string, string | null> = { ...indexTree(repo) };
          for (const k of Object.keys(idx)) if (k in w) idx[k] = w[k];
          else delete idx[k];
          repo.staged = idx;
        }
        if (!message) {
          eprintln(io, 'Aborting commit due to empty commit message.\n(Usa: git commit -m "mensaje")');
          return 1;
        }
        const who = author(sess, repo, io);
        if (!who) return 128;
        const tree = indexTree(repo);
        if (!repo.merging && headId(repo) && JSON.stringify(tree) === JSON.stringify(headTree(repo)) && !flags.has('allow-empty')) {
          println(io, `On branch ${repo.head}\nnothing to commit, working tree clean`);
          return 1;
        }
        const conflicted = Object.entries(tree).filter(([, v]) => v.includes('<<<<<<< HEAD')).map(([k]) => k);
        if (conflicted.length) {
          eprintln(io, `error: Committing is not possible because you have unmerged files.\nhint: Fix them up in the work tree, and then use 'git add <file>'\n${conflicted.map((f) => `U\t${f}`).join('\n')}`);
          return 128;
        }
        const first = !headId(repo);
        const d = diffKeys(headTree(repo), tree);
        const c = doCommit(sess, repo, tree, message, who, repo.merging?.theirs);
        println(io, `[${repo.head}${first ? ' (root-commit)' : ''} ${c.id.slice(0, 7)}] ${message.split('\n')[0]}\n ${d.added.length + d.modified.length + d.deleted.length} file${d.added.length + d.modified.length + d.deleted.length === 1 ? '' : 's'} changed`);
        for (const f of d.added) println(io, ` create mode 100644 ${f}`);
        for (const f of d.deleted) println(io, ` delete mode 100644 ${f}`);
        return 0;
      }
      case 'log': {
        const { flags, opts } = parseFlags(args, ['n', 'max-count']);
        const n = Number(opts.n ?? opts['max-count'] ?? (args.find((a) => /^-\d+$/.test(a))?.slice(1)) ?? 1000);
        // git log -- <ruta>: sólo los commits que tocaron esa ruta (también sirve para ficheros ya borrados).
        const dd = args.indexOf('--');
        const paths = dd >= 0 ? args.slice(dd + 1).map((p) => relToRepo(sess, repo, p).replace(/\/$/, '')) : [];
        const touches = (c: GitCommit) => {
          const prev = c.parents[0] ? repo.commits[c.parents[0]]?.tree ?? {} : {};
          return paths.some((p) => [...new Set([...Object.keys(c.tree), ...Object.keys(prev)])].some((k) => (k === p || k.startsWith(p + '/')) && c.tree[k] !== prev[k]));
        };
        const all = reachable(repo, headId(repo));
        const list = (paths.length ? all.filter(touches) : all).slice(0, n);
        if (paths.length && !list.length && all.length) return 0;
        if (!list.length) {
          eprintln(io, `fatal: your current branch '${repo.head}' does not have any commits yet`);
          return 128;
        }
        const refsFor = (id: string) => {
          const r = Object.entries(repo.branches).filter(([, v]) => v === id).map(([b]) => (b === repo.head ? `HEAD -> ${b}` : b));
          for (const [rr, v] of Object.entries(repo.remoteRefs ?? {})) if (v === id) r.push(rr);
          return r.length ? ` (${r.join(', ')})` : '';
        };
        for (const c of list) {
          if (flags.has('oneline')) println(io, `${C.yellow(c.id.slice(0, 7))}${C.cyan(refsFor(c.id))} ${c.message.split('\n')[0]}`);
          else println(io, `${C.yellow(`commit ${c.id}`)}${C.cyan(refsFor(c.id))}${c.parents.length > 1 ? `\nMerge: ${c.parents.map((p) => p.slice(0, 7)).join(' ')}` : ''}\nAuthor: ${c.author}\nDate:   ${new Date(c.date).toString()}\n\n    ${c.message.split('\n').join('\n    ')}\n`);
        }
        return 0;
      }
      case 'diff': {
        const staged = args.includes('--staged') || args.includes('--cached');
        const stat = args.includes('--stat');
        const a = staged ? headTree(repo) : indexTree(repo);
        const bAll = staged ? indexTree(repo) : work(sess, repo);
        const b = staged ? bAll : Object.fromEntries(Object.entries(bAll).filter(([k]) => k in a));
        const d = diffKeys(a, b);
        for (const f of [...d.modified, ...d.added, ...d.deleted]) {
          if (stat) {
            println(io, ` ${f} | ${Math.abs((b[f] ?? '').split('\n').length - (a[f] ?? '').split('\n').length) || 1} ${C.green('+')}${C.red('-')}`);
            continue;
          }
          println(io, C.bold(`diff --git a/${f} b/${f}\n--- ${f in a ? 'a/' + f : '/dev/null'}\n+++ ${f in b ? 'b/' + f : '/dev/null'}`));
          const la = (a[f] ?? '').split('\n');
          const lb = (b[f] ?? '').split('\n');
          println(io, C.cyan(`@@ -1,${la.length} +1,${lb.length} @@`));
          const max = Math.max(la.length, lb.length);
          for (let i = 0; i < max; i++) {
            if (la[i] === lb[i]) {
              if (la[i] !== undefined && la[i] !== '') println(io, ` ${la[i]}`);
              continue;
            }
            if (la[i] !== undefined) println(io, C.red(`-${la[i]}`));
            if (lb[i] !== undefined) println(io, C.green(`+${lb[i]}`));
          }
        }
        return 0;
      }
      case 'branch': {
        const del = args.includes('-d') || args.includes('-D');
        const showAll = args.includes('-a') || args.includes('-r');
        const name = args.find((a) => !a.startsWith('-'));
        if (del && name) {
          if (name === repo.head) {
            eprintln(io, `error: Cannot delete branch '${name}' checked out at '${repo.path}'`);
            return 1;
          }
          if (!(name in repo.branches)) {
            eprintln(io, `error: branch '${name}' not found.`);
            return 1;
          }
          const id = repo.branches[name];
          delete repo.branches[name];
          println(io, `Deleted branch ${name} (was ${id?.slice(0, 7)}).`);
          changed();
          return 0;
        }
        if (name && !args.includes('-m')) {
          if (name in repo.branches) {
            eprintln(io, `fatal: a branch named '${name}' already exists`);
            return 128;
          }
          if (!headId(repo)) {
            eprintln(io, `fatal: not a valid object name: '${repo.head}'`);
            return 128;
          }
          repo.branches[name] = headId(repo);
          changed();
          return 0;
        }
        if (args.includes('-m') && name) {
          repo.branches[name] = repo.branches[repo.head];
          delete repo.branches[repo.head];
          repo.head = name;
          changed();
          return 0;
        }
        for (const b of Object.keys(repo.branches).sort()) println(io, b === repo.head ? `* ${C.green(b)}` : `  ${b}`);
        if (showAll) for (const r of Object.keys(repo.remoteRefs ?? {}).sort()) println(io, `  ${C.red(`remotes/${r}`)}`);
        return 0;
      }
      case 'checkout':
      case 'switch': {
        const create = args.includes('-b') || args.includes('-c') || args.includes('-B');
        const dd = args.indexOf('--');
        if (sub === 'checkout' && dd >= 0) {
          const idx = indexTree(repo);
          for (const p of args.slice(dd + 1)) {
            const rel = relToRepo(sess, repo, p);
            if (idx[rel] !== undefined) sess.fs.writeFile(`${repo.path}/${rel}`, idx[rel]);
          }
          changed();
          return 0;
        }
        const name = args.find((a) => !a.startsWith('-'));
        if (!name) {
          eprintln(io, 'fatal: missing branch or commit argument');
          return 128;
        }
        const w = work(sess, repo);
        const dirty = diffKeys(indexTree(repo), Object.fromEntries(Object.entries(w).filter(([k]) => k in indexTree(repo))));
        if (create) {
          if (name in repo.branches && !args.includes('-B')) {
            eprintln(io, `fatal: a branch named '${name}' already exists`);
            return 128;
          }
          repo.branches[name] = headId(repo);
          repo.head = name;
          println(io, `Switched to a new branch '${name}'`);
          changed();
          return 0;
        }
        if (!(name in repo.branches)) {
          const rr = repo.remoteRefs?.[`origin/${name}`];
          if (rr) {
            repo.branches[name] = rr;
            repo.upstream[name] = `origin/${name}`;
            println(io, `branch '${name}' set up to track 'origin/${name}'.`);
          } else {
            eprintln(io, `error: pathspec '${name}' did not match any file(s) known to git`);
            return 1;
          }
        }
        if (name === repo.head) {
          println(io, `Already on '${name}'`);
          return 0;
        }
        if (dirty.modified.length) {
          eprintln(io, `error: Your local changes to the following files would be overwritten by checkout:\n\t${dirty.modified.join('\n\t')}\nPlease commit your changes or stash them before you switch branches.\nAborting`);
          return 1;
        }
        const untracked = Object.fromEntries(Object.entries(w).filter(([k]) => !(k in indexTree(repo))));
        repo.head = name;
        repo.staged = null;
        writeTree(sess, repo, { ...headTree(repo), ...untracked });
        println(io, `Switched to branch '${name}'`);
        changed();
        return 0;
      }
      case 'merge': {
        const name = args.find((a) => !a.startsWith('-'));
        const theirs = name ? repo.branches[name] ?? repo.remoteRefs?.[name] : undefined;
        if (!theirs) {
          eprintln(io, `merge: ${name} - not something we can merge`);
          return 1;
        }
        return mergeInto(sess, io, repo, theirs, name!);
      }
      case 'remote': {
        const op = args[0];
        if (!op || op === '-v') {
          for (const [n, u] of Object.entries(repo.remotes)) {
            if (op === '-v') println(io, `${n}\t${u} (fetch)\n${n}\t${u} (push)`);
            else println(io, n);
          }
          return 0;
        }
        if (op === 'add') {
          if (repo.remotes[args[1]]) {
            eprintln(io, `error: remote ${args[1]} already exists.`);
            return 3;
          }
          repo.remotes[args[1]] = args[2];
          changed();
          return 0;
        }
        if (op === 'remove' || op === 'rm') {
          delete repo.remotes[args[1]];
          changed();
          return 0;
        }
        if (op === 'set-url') {
          repo.remotes[args[1]] = args[2];
          changed();
          return 0;
        }
        if (op === 'show') {
          println(io, `* remote ${args[1] ?? 'origin'}\n  Fetch URL: ${repo.remotes[args[1] ?? 'origin']}\n  Push  URL: ${repo.remotes[args[1] ?? 'origin']}\n  HEAD branch: main`);
          return 0;
        }
        return 1;
      }
      case 'push': {
        const force = args.includes('-f') || args.includes('--force');
        const setUp = args.includes('-u') || args.includes('--set-upstream');
        const pos = args.filter((a) => !a.startsWith('-'));
        const remote = pos[0] ?? 'origin';
        let branch = pos[1] ?? repo.head;
        if (branch.includes(':')) branch = branch.split(':')[1];
        const url = repo.remotes[remote];
        if (!url) {
          eprintln(io, `fatal: '${remote}' does not appear to be a git repository\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.`);
          return 128;
        }
        if (!pos[1] && !repo.upstream[repo.head] && !setUp) {
          eprintln(io, `fatal: The current branch ${repo.head} has no upstream branch.\nTo push the current branch and set the remote as upstream, use\n\n    git push --set-upstream ${remote} ${repo.head}\n`);
          return 128;
        }
        const head = repo.branches[branch];
        if (!head) {
          eprintln(io, `error: src refspec ${branch} does not match any\nerror: failed to push some refs to '${url}'`);
          return 1;
        }
        const target = parseRepoUrl(url);
        if (!target) {
          eprintln(io, /github\.com/.test(url) ? `remote: Permission to ${url} denied.\nfatal: unable to access '${url}': The requested URL returned error: 403` : `fatal: repository '${url}' not found`);
          return 128;
        }
        const s = getState();
        const who = s.me.displayName;
        const res = receivePush(target.project, target.repo, branch, repo.commits, head, force, who);
        const n = reachable(repo, head).length;
        println(io, `Enumerating objects: ${n * 3}, done.\nCounting objects: 100% (${n * 3}/${n * 3}), done.\nDelta compression using up to 2 threads\nWriting objects: 100% (${n * 3}/${n * 3}), ${(n * 0.7).toFixed(2)} KiB | 1.2 MiB/s, done.\nTotal ${n * 3} (delta 0), reused 0 (delta 0), pack-reused 0 (from 0)\nremote: Analyzing objects... (${n * 3}/${n * 3}) (5 ms)\nremote: Validating commits... (${n}/${n}) done (1 ms)\nremote: Storing packfile... done (12 ms)\nremote: Storing index... done (8 ms)\nTo ${url}`);
        if (!res.ok) {
          eprintln(io, res.message);
          return 1;
        }
        println(io, res.message);
        repo.remoteRefs = { ...(repo.remoteRefs ?? {}), [`${remote}/${branch}`]: head };
        if (setUp) {
          repo.upstream[branch] = `${remote}/${branch}`;
          println(io, `branch '${branch}' set up to track '${remote}/${branch}'.`);
        }
        for (const r of res.triggered) println(io, C.dim(`remote: (Azure Lab) El pipeline "${r.pipelineName}" se ha puesto en cola: ejecución ${r.buildNumber}`));
        changed();
        return 0;
      }
      case 'fetch':
      case 'pull': {
        const remote = args.filter((a) => !a.startsWith('-'))[0] ?? 'origin';
        const url = repo.remotes[remote];
        if (!url) {
          eprintln(io, `fatal: '${remote}' does not appear to be a git repository`);
          return 128;
        }
        const target = parseRepoUrl(url);
        if (!target) {
          eprintln(io, `fatal: repository '${url}' not found`);
          return 128;
        }
        Object.assign(repo.commits, JSON.parse(JSON.stringify(target.repo.commits)));
        const before = { ...(repo.remoteRefs ?? {}) };
        repo.remoteRefs = { ...Object.fromEntries(Object.entries(target.repo.branches).map(([b, id]) => [`${remote}/${b}`, id])) };
        for (const [k, v] of Object.entries(repo.remoteRefs)) if (before[k] !== v) println(io, `From ${url}\n   ${(before[k] ?? '0000000').slice(0, 7)}..${v.slice(0, 7)}  ${k.split('/')[1]}     -> ${k}`);
        changed();
        if (sub === 'fetch') return 0;
        const branch = args.filter((a) => !a.startsWith('-'))[1] ?? repo.head;
        const theirs = repo.remoteRefs[`${remote}/${branch}`];
        if (!theirs) {
          eprintln(io, `fatal: couldn't find remote ref ${branch}`);
          return 1;
        }
        return mergeInto(sess, io, repo, theirs, `${remote}/${branch}`);
      }
      case 'reset': {
        const hard = args.includes('--hard');
        const ref = args.find((a) => !a.startsWith('-'));
        if (!hard && ref && !/^HEAD/.test(ref) && !(ref in repo.branches)) {
          const idx: Record<string, string | null> = { ...indexTree(repo) };
          const h = headTree(repo);
          const rel = relToRepo(sess, repo, ref);
          if (h[rel] !== undefined) idx[rel] = h[rel];
          else delete idx[rel];
          repo.staged = idx;
          changed();
          return 0;
        }
        let target = headId(repo);
        if (ref && ref in repo.branches) target = repo.branches[ref];
        else if (ref?.startsWith('origin/')) target = repo.remoteRefs?.[ref] ?? target;
        else if (ref && /^HEAD~(\d+)$/.test(ref)) for (let i = 0; i < Number(ref.slice(5)) && target; i++) target = repo.commits[target].parents[0] ?? null;
        else if (ref && repo.commits[ref]) target = ref;
        else if (ref && Object.keys(repo.commits).find((c) => c.startsWith(ref))) target = Object.keys(repo.commits).find((c) => c.startsWith(ref))!;
        repo.branches[repo.head] = target;
        repo.staged = null;
        repo.merging = null;
        if (hard) {
          writeTree(sess, repo, headTree(repo));
          println(io, `HEAD is now at ${target?.slice(0, 7)} ${target ? repo.commits[target].message.split('\n')[0] : ''}`);
        }
        changed();
        return 0;
      }
      case 'restore': {
        const stagedOnly = args.includes('--staged');
        const idx: Record<string, string | null> = { ...indexTree(repo) };
        for (const p of args.filter((a) => !a.startsWith('-'))) {
          const rel = relToRepo(sess, repo, p);
          if (stagedOnly) {
            const h = headTree(repo);
            if (h[rel] !== undefined) idx[rel] = h[rel];
            else delete idx[rel];
          } else if (idx[rel] !== undefined && idx[rel] !== null) sess.fs.writeFile(`${repo.path}/${rel}`, idx[rel]!);
        }
        if (stagedOnly) repo.staged = idx;
        changed();
        return 0;
      }
      case 'rev-parse': {
        if (args.includes('--abbrev-ref')) println(io, repo.head);
        else if (args.includes('--show-toplevel')) println(io, repo.path);
        else {
          const id = headId(repo);
          if (!id) {
            eprintln(io, "fatal: ambiguous argument 'HEAD': unknown revision or path not in the working tree.");
            return 128;
          }
          println(io, args.includes('--short') ? id.slice(0, 7) : id);
        }
        return 0;
      }
      case 'show': {
        const ref = args.find((a) => !a.startsWith('-'));
        const id = ref ? (repo.branches[ref] ?? Object.keys(repo.commits).find((c) => c.startsWith(ref))) : headId(repo);
        const c = id ? repo.commits[id] : undefined;
        if (!c) {
          eprintln(io, `fatal: bad revision '${ref ?? 'HEAD'}'`);
          return 128;
        }
        println(io, `${C.yellow(`commit ${c.id}`)}\nAuthor: ${c.author}\nDate:   ${new Date(c.date).toString()}\n\n    ${c.message}\n`);
        const d = diffKeys(c.parents[0] ? repo.commits[c.parents[0]]?.tree ?? {} : {}, c.tree);
        for (const f of d.added) println(io, C.green(`A\t${f}`));
        for (const f of d.modified) println(io, C.yellow(`M\t${f}`));
        for (const f of d.deleted) println(io, C.red(`D\t${f}`));
        return 0;
      }
      case 'tag': {
        const name = args.find((a) => !a.startsWith('-'));
        repo.tags = repo.tags ?? {};
        if (!name) {
          for (const t of Object.keys(repo.tags).sort()) println(io, t);
          return 0;
        }
        repo.tags[name] = headId(repo) ?? '';
        changed();
        return 0;
      }
      case 'stash':
        eprintln(io, 'git stash no está disponible en el simulador; haz commit en una rama temporal.');
        return 1;
    }
    eprintln(io, `git: '${sub}' is not a git command. See 'git --help'.`);
    return 1;
  },
};

function mergeInto(sess: Session, io: CmdCtx['io'], repo: Repo, theirs: string, label: string): number {
  const ours = headId(repo);
  if (ours === theirs || (ours && isAncestor({ commits: repo.commits } as any, theirs, ours))) {
    println(io, 'Already up to date.');
    return 0;
  }
  if (!ours || isAncestor({ commits: repo.commits } as any, ours, theirs)) {
    const before = headTree(repo);
    repo.branches[repo.head] = theirs;
    repo.staged = null;
    writeTree(sess, repo, headTree(repo));
    const d = diffKeys(before, headTree(repo));
    println(io, `Updating ${(ours ?? '0000000').slice(0, 7)}..${theirs.slice(0, 7)}\nFast-forward\n${[...d.added, ...d.modified, ...d.deleted].map((f) => ` ${f} | 1 +`).join('\n')}\n ${d.added.length + d.modified.length + d.deleted.length} files changed`);
    changed();
    return 0;
  }
  // fusión de tres vías simplificada
  const findBase = () => {
    const a = new Set(reachable(repo, ours).map((c) => c.id));
    return reachable(repo, theirs).find((c) => a.has(c.id));
  };
  const base = findBase()?.tree ?? {};
  const o = headTree(repo);
  const t = repo.commits[theirs].tree;
  const merged: Record<string, string> = {};
  const conflicts: string[] = [];
  for (const k of new Set([...Object.keys(o), ...Object.keys(t), ...Object.keys(base)])) {
    const vb = base[k];
    const vo = o[k];
    const vt = t[k];
    if (vo === vt) {
      if (vo !== undefined) merged[k] = vo;
    } else if (vo === vb) {
      if (vt !== undefined) merged[k] = vt;
    } else if (vt === vb) {
      if (vo !== undefined) merged[k] = vo;
    } else {
      conflicts.push(k);
      merged[k] = `<<<<<<< HEAD\n${vo ?? ''}=======\n${vt ?? ''}>>>>>>> ${label}\n`;
    }
  }
  writeTree(sess, repo, merged);
  if (conflicts.length) {
    repo.merging = { theirs };
    repo.staged = Object.fromEntries(Object.entries(merged).filter(([k]) => !conflicts.includes(k)));
    println(io, conflicts.map((c) => `Auto-merging ${c}\nCONFLICT (content): Merge conflict in ${c}`).join('\n') + '\nAutomatic merge failed; fix conflicts and then commit the result.');
    changed();
    return 1;
  }
  const who = author(sess, repo, io);
  if (!who) return 128;
  doCommit(sess, repo, merged, `Merge branch '${label}' into ${repo.head}`, who, theirs);
  println(io, `Merge made by the 'ort' strategy.`);
  return 0;
}

export const GIT_COMMANDS: Record<string, CommandDef> = { git };
