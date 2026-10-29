import * as assert from 'assert';

// `changedFilesProvider.ts` imports `vscode` at module load time. Stub it
// before requiring the module — same pattern as the other unit tests.
const Module = require('module');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request: string, ...rest: unknown[]) {
  if (request === 'vscode') {
    return require.resolve('./_vscode-stub-full');
  }
  return originalResolve.call(this, request, ...rest);
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const stub = require('./_vscode-stub-full');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ChangedFilesProvider } = require('../../src/changedFilesProvider');

type Msg = Record<string, unknown>;

/** Enough of GitService for a target to be set and a list to be produced. */
const fakeGit = {
  gitDir: async (repoRoot: string) => `${repoRoot}/.git`,
  listChangedPaths: async () => [{ relPath: 'src/a.ts', status: 'M' as const }],
  listUntrackedPaths: async () => [],
  listWorktrees: async () => [],
};

function setup(): { provider: any; posted: Msg[] } {
  const posted: Msg[] = [];
  const memento = {
    store: new Map<string, unknown>(),
    get(key: string) {
      return this.store.get(key);
    },
    async update(key: string, value: unknown) {
      this.store.set(key, value);
    },
  };
  const provider = new ChangedFilesProvider(fakeGit, memento, stub.Uri.file('/ext'));
  provider.resolveWebviewView({
    webview: {
      options: {},
      html: '',
      cspSource: 'vscode-webview://test',
      onDidReceiveMessage: () => ({ dispose() {} }),
      postMessage: (m: Msg) => {
        posted.push(m);
        return Promise.resolve(true);
      },
    },
    visible: true,
    onDidDispose: () => ({ dispose() {} }),
    onDidChangeVisibility: () => ({ dispose() {} }),
  });
  return { provider, posted };
}

function lastFilesMessage(posted: Msg[]): Msg {
  const files = posted.filter((m) => m.type === 'files');
  assert.ok(files.length > 0, 'expected a files message');
  return files[files.length - 1];
}

const TARGET = { ref: 'a'.repeat(40), display: 'upstream/master', branch: 'upstream/master' };

describe('ChangedFilesProvider target messages', () => {
  it('names the target repo so a cross-repo pin is visible in the view', async () => {
    const { provider, posted } = setup();
    await provider.setTarget(TARGET, '/repo/.claude/worktrees/agent-mvp-step3');
    const msg = lastFilesMessage(posted);
    assert.strictEqual(msg.repoLabel, 'agent-mvp-step3');
    assert.strictEqual(msg.repoPath, '/repo/.claude/worktrees/agent-mvp-step3');
    assert.strictEqual(msg.targetLabel, 'upstream/master');
    provider.dispose();
  });

  // path.basename('/') is '' — the label must never come through blank.
  it('falls back to the root itself when the repo root has no basename', async () => {
    const { provider, posted } = setup();
    await provider.setTarget(TARGET, '/');
    assert.strictEqual(lastFilesMessage(posted).repoLabel, '/');
    provider.dispose();
  });

  it('drops the repo once the target is cleared', async () => {
    const { provider, posted } = setup();
    await provider.setTarget(TARGET, '/repo');
    await provider.clearTarget();
    const msg = lastFilesMessage(posted);
    assert.strictEqual(msg.hasTarget, false);
    assert.strictEqual(msg.repoLabel, undefined);
    provider.dispose();
  });

  it('re-labels when the target moves to another repo', async () => {
    const { provider, posted } = setup();
    await provider.setTarget(TARGET, '/repo');
    await provider.setTarget(TARGET, '/repo/.claude/worktrees/wt');
    const msg = lastFilesMessage(posted);
    assert.strictEqual(msg.repoLabel, 'wt');
    assert.strictEqual(msg.repoPath, '/repo/.claude/worktrees/wt');
    provider.dispose();
  });
});

describe('ChangedFilesProvider view mode', () => {
  function setupWith(seed: Record<string, unknown>): { provider: any; posted: Msg[]; store: Map<string, unknown> } {
    const posted: Msg[] = [];
    const store = new Map<string, unknown>(Object.entries(seed));
    const memento = {
      get: (key: string) => store.get(key),
      update: async (key: string, value: unknown) => {
        store.set(key, value);
      },
    };
    const provider = new ChangedFilesProvider(fakeGit, memento, stub.Uri.file('/ext'));
    provider.resolveWebviewView({
      webview: {
        options: {},
        html: '',
        cspSource: 'vscode-webview://test',
        onDidReceiveMessage: () => ({ dispose() {} }),
        postMessage: (m: Msg) => {
          posted.push(m);
          return Promise.resolve(true);
        },
      },
      visible: true,
      onDidDispose: () => ({ dispose() {} }),
      onDidChangeVisibility: () => ({ dispose() {} }),
    });
    return { provider, posted, store };
  }

  it('defaults to the tree layout', () => {
    const { provider } = setupWith({});
    assert.strictEqual(provider.getViewMode(), 'tree');
    provider.dispose();
  });

  it('restores a persisted layout and ignores garbage in workspaceState', () => {
    const list = setupWith({ 'gitdiff.changedFiles.viewMode': 'list' });
    assert.strictEqual(list.provider.getViewMode(), 'list');
    list.provider.dispose();
    const junk = setupWith({ 'gitdiff.changedFiles.viewMode': { nope: 1 } });
    assert.strictEqual(junk.provider.getViewMode(), 'tree');
    junk.provider.dispose();
  });

  it('persists a toggle, tells the webview, and fires the change event', async () => {
    const { provider, posted, store } = setupWith({});
    const fired: string[] = [];
    provider.onDidChangeViewMode((m: string) => fired.push(m));
    await provider.setViewMode('list');
    assert.strictEqual(provider.getViewMode(), 'list');
    assert.strictEqual(store.get('gitdiff.changedFiles.viewMode'), 'list');
    assert.deepStrictEqual(fired, ['list']);
    assert.deepStrictEqual(posted.filter((m) => m.type === 'viewMode'), [
      { type: 'viewMode', viewMode: 'list' },
    ]);
    // Setting the same mode again is a no-op: no message, no event.
    await provider.setViewMode('list');
    assert.deepStrictEqual(fired, ['list']);
    assert.strictEqual(posted.filter((m) => m.type === 'viewMode').length, 1);
    provider.dispose();
  });
});

describe('ChangedFilesProvider reviews', () => {
  const fs = require('fs') as typeof import('fs');
  const os = require('os') as typeof import('os');
  const path = require('path') as typeof import('path');
  let root: string;
  let store: Map<string, unknown>;
  let providers: any[];
  let edit: (event: any) => void;
  let changes: Array<(uri: any) => void>;
  const originalEdit = stub.workspace.onDidChangeTextDocument;
  const originalWatcher = stub.workspace.createFileSystemWatcher;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitdiff-review-'));
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src/a.ts'), 'first');
    store = new Map();
    providers = [];
    changes = [];
    stub.workspace.onDidChangeTextDocument = (cb: typeof edit) => {
      edit = cb;
      return { dispose() {} };
    };
    stub.workspace.createFileSystemWatcher = () => ({
      onDidChange: (cb: any) => { changes.push(cb); return { dispose() {} }; },
      onDidCreate: () => ({ dispose() {} }),
      onDidDelete: () => ({ dispose() {} }),
      dispose() {},
    });
  });
  afterEach(() => {
    for (const provider of providers) provider.dispose();
    stub.workspace.textDocuments = [];
    stub.workspace.onDidChangeTextDocument = originalEdit;
    stub.workspace.createFileSystemWatcher = originalWatcher;
    fs.rmSync(root, { recursive: true, force: true });
  });
  function make(): any {
    const provider = new ChangedFilesProvider({ ...fakeGit }, {
      get: (key: string) => store.get(key),
      update: async (key: string, value: unknown) => { store.set(key, value); },
    }, stub.Uri.file('/ext'));
    providers.push(provider);
    return provider;
  }
  async function check(provider: any, value = true): Promise<void> {
    await provider.onMessage({ type: 'setReviewed', relPath: 'src/a.ts',
      reviewed: value, reviewContext: provider.reviewContext });
    await provider.reviewWrites;
  }
  it('persists a review and validates it on restart; unchanged refresh preserves it', async () => {
    const provider = make();
    await provider.setTarget(TARGET, root);
    await check(provider);
    await provider.refresh();
    assert.ok(provider.verifiedReviews.has('src/a.ts'));
    provider.dispose();
    const restored = make();
    assert.strictEqual(restored.verifiedReviews.size, 0);
    await restored.refresh();
    assert.ok(restored.verifiedReviews.has('src/a.ts'));
    await check(restored, false);
    assert.strictEqual(restored.reviews.size, 0);
  });
  it('rejects persisted reviews when disk content changed while closed', async () => {
    const provider = make();
    await provider.setTarget(TARGET, root);
    await check(provider);
    provider.dispose();
    fs.writeFileSync(path.join(root, 'src/a.ts'), 'other');
    const restored = make();
    await restored.refresh();
    assert.strictEqual(restored.reviews.size, 0);
  });
  it('clears immediately on unsaved edits, even hidden, and undo does not restore it', async () => {
    const provider = make();
    await provider.setTarget(TARGET, root);
    await check(provider);
    edit({ document: { uri: stub.Uri.file(path.join(root, 'src/a.ts')) }, contentChanges: [{}] });
    assert.strictEqual(provider.reviews.size, 0);
    await provider.refresh();
    assert.strictEqual(provider.verifiedReviews.size, 0);
  });
  it('invalidates an in-flight check on an editor edit', async () => {
    const provider = make();
    await provider.setTarget(TARGET, root);
    let finish!: (value: string) => void;
    provider.fingerprint = () => new Promise<string>((resolve) => { finish = resolve; });
    const pending = check(provider);
    edit({ document: { uri: stub.Uri.file(path.join(root, 'src/a.ts')) }, contentChanges: [{}] });
    finish('old');
    await pending;
    assert.strictEqual(provider.reviews.size, 0);
  });
  it('keeps the newest checkbox request when fingerprint reads complete out of order', async () => {
    const provider = make();
    await provider.setTarget(TARGET, root);
    const finishes: Array<(value: string) => void> = [];
    provider.fingerprint = () => new Promise<string>((resolve) => { finishes.push(resolve); });
    const first = check(provider);
    const second = check(provider);
    finishes[0]('old');
    await first;
    assert.ok(provider.reviewWatchers.has('src/a.ts'));
    finishes[1]('new');
    await second;
    assert.strictEqual(provider.reviews.get('src/a.ts').fingerprint, 'new');
  });
  it('clears on external changes without a visible webview', async () => {
    const provider = make();
    await provider.setTarget(TARGET, root);
    await check(provider);
    const uri = stub.Uri.file(path.join(root, 'src/a.ts'));
    for (const cb of changes) cb(uri);
    assert.strictEqual(provider.reviews.size, 0);
  });
  it('clears reviews when a file disappears from the list or becomes a rename', async () => {
    const provider = make();
    await provider.setTarget(TARGET, root);
    await check(provider);
    provider.git.listChangedPaths = async () => [{ relPath: 'src/a.ts', status: 'R', origPath: 'old.ts' }];
    await provider.refresh();
    assert.strictEqual(provider.reviews.size, 0);
    await check(provider);
    assert.ok(provider.verifiedReviews.has('src/a.ts'));
    provider.git.listChangedPaths = async () => [];
    await provider.refresh();
    assert.strictEqual(provider.reviews.size, 0);
  });
  it('leaves unreadable files unchecked and permits reviewing deleted files', async () => {
    const provider = make();
    await provider.setTarget(TARGET, root);
    const abs = path.join(root, 'src/a.ts');
    fs.unlinkSync(abs);
    fs.mkdirSync(abs); // readFile fails on a directory, even when tests run as root.
    await check(provider);
    assert.strictEqual(provider.reviews.size, 0);
    fs.rmdirSync(abs);
    provider.git.listChangedPaths = async () => [{ relPath: 'src/a.ts', status: 'D' }];
    await provider.refresh();
    await check(provider);
    assert.ok(provider.verifiedReviews.has('src/a.ts'));
    fs.writeFileSync(abs, 'restored');
    await provider.refresh();
    assert.strictEqual(provider.reviews.size, 0);
  });
  it('captures dirty document contents and invalidates if the restored contents differ', async () => {
    const provider = make();
    await provider.setTarget(TARGET, root);
    stub.workspace.textDocuments = [{ uri: stub.Uri.file(path.join(root, 'src/a.ts')),
      isDirty: true, getText: () => 'unsaved review' }];
    await check(provider);
    assert.ok(provider.reviews.get('src/a.ts').fingerprint.startsWith('text:'));
    await provider.refresh();
    assert.ok(provider.verifiedReviews.has('src/a.ts'));
    stub.workspace.textDocuments = [];
    await provider.refresh();
    assert.strictEqual(provider.reviews.size, 0);
  });
  it('preserves the same target and clears on a different comparison commit', async () => {
    const provider = make();
    await provider.setTarget(TARGET, root);
    await check(provider);
    await provider.setTarget(TARGET, root);
    assert.ok(provider.verifiedReviews.has('src/a.ts'));
    const staleContext = provider.reviewContext;
    await provider.setTarget({ ref: 'b'.repeat(40), display: 'other' }, root);
    await provider.onMessage({ type: 'setReviewed', relPath: 'src/a.ts', reviewed: true,
      reviewContext: staleContext });
    assert.strictEqual(provider.reviews.size, 0);
  });
});
