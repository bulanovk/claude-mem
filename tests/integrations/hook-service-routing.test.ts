import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Host installers bake an absolute `bun <script> hook <platform> <event>`
// command. Hooks run the thin hook-service.cjs when it sits beside
// worker-service.cjs, so they do not parse the whole worker bundle.
const INTEGRATIONS = path.resolve(import.meta.dir, '../../src/services/integrations');

describe('installer hook script routing', () => {
  let tmp: string;
  let pluginRoot: string;
  let workspace: string;
  let originalCwd: string;
  let savedPluginRoot: string | undefined;

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'hook-routing-')));
    pluginRoot = path.join(tmp, 'plugin');
    workspace = path.join(tmp, 'workspace');
    mkdirSync(path.join(pluginRoot, 'scripts'), { recursive: true });
    mkdirSync(path.join(workspace, '.cursor'), { recursive: true });
    writeFileSync(path.join(pluginRoot, 'scripts', 'worker-service.cjs'), '');
    savedPluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
    process.env.CLAUDE_PLUGIN_ROOT = pluginRoot;
    originalCwd = process.cwd();
    process.chdir(workspace);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (savedPluginRoot === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
    else process.env.CLAUDE_PLUGIN_ROOT = savedPluginRoot;
    rmSync(tmp, { recursive: true, force: true });
  });

  const addHookService = () => writeFileSync(path.join(pluginRoot, 'scripts', 'hook-service.cjs'), '');
  const cursorHooksPath = () => path.join(workspace, '.cursor', 'hooks.json');
  const cursorCommands = (): string[] => {
    const config = JSON.parse(readFileSync(cursorHooksPath(), 'utf-8'));
    return Object.values<any[]>(config.hooks).flat().map((hook) => hook.command);
  };

  it('getHookScriptAbsolutePath prefers hook-service.cjs and falls back to worker-service.cjs', async () => {
    const { getHookScriptAbsolutePath } = await import(`${INTEGRATIONS}/install-paths.js`);
    expect(getHookScriptAbsolutePath()).toBe(path.join(pluginRoot, 'scripts', 'worker-service.cjs'));
    addHookService();
    expect(getHookScriptAbsolutePath()).toBe(path.join(pluginRoot, 'scripts', 'hook-service.cjs'));
  });

  it('Cursor falls back to worker-service.cjs when hook-service.cjs is absent', async () => {
    const { installCursorHooks } = await import(`${INTEGRATIONS}/CursorHooksInstaller.js`);
    expect(await installCursorHooks('project')).toBe(0);
    const commands = cursorCommands();
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      expect(command).toContain('worker-service.cjs');
      expect(command).not.toContain('hook-service.cjs');
    }
  });

  it('Cursor installs hook-service.cjs and replaces older worker-service entries without duplicates', async () => {
    const { installCursorHooks, uninstallCursorHooks } = await import(`${INTEGRATIONS}/CursorHooksInstaller.js`);
    const userHook = { command: './my-audit.sh' };
    expect(await installCursorHooks('project')).toBe(0);
    const before = JSON.parse(readFileSync(cursorHooksPath(), 'utf-8'));
    before.hooks.stop.push(userHook);
    writeFileSync(cursorHooksPath(), JSON.stringify(before));
    const entryCount = cursorCommands().length;

    addHookService();
    expect(await installCursorHooks('project')).toBe(0);
    expect(await installCursorHooks('project')).toBe(0);

    const commands = cursorCommands();
    expect(commands.length).toBe(entryCount);
    const ours = commands.filter((command) => command.includes('hook cursor'));
    expect(ours.length).toBe(entryCount - 1);
    for (const command of ours) {
      expect(command).toContain('hook-service.cjs');
      expect(command).not.toContain('worker-service.cjs');
    }
    expect(commands).toContain(userHook.command);

    expect(uninstallCursorHooks('project')).toBe(0);
    const left = JSON.parse(readFileSync(cursorHooksPath(), 'utf-8'));
    expect(Object.values<any[]>(left.hooks).flat()).toEqual([userHook]);
  });

  it('Windsurf install and uninstall treat both script names as claude-mem entries', () => {
    addHookService();
    const home = path.join(tmp, 'home');
    const hooksDir = path.join(home, '.codeium', 'windsurf');
    const hooksJsonPath = path.join(hooksDir, 'hooks.json');
    mkdirSync(hooksDir, { recursive: true });
    const userEntry = { command: 'my own hook', show_output: false };
    writeFileSync(hooksJsonPath, JSON.stringify({
      hooks: {
        pre_user_prompt: [
          userEntry,
          { command: '"bun" "/old/scripts/worker-service.cjs" hook windsurf session-init', show_output: false },
        ],
      },
    }));

    const script = `
      console.log = () => {};
      console.error = () => {};
      const mod = await import(${JSON.stringify(path.join(INTEGRATIONS, 'WindsurfHooksInstaller.js'))});
      const file = ${JSON.stringify(hooksJsonPath)};
      const { readFileSync } = await import('node:fs');
      const installCode = await mod.installWindsurfHooks();
      const installed = JSON.parse(readFileSync(file, 'utf-8'));
      const uninstallCode = mod.uninstallWindsurfHooks();
      const after = JSON.parse(readFileSync(file, 'utf-8'));
      process.stdout.write(JSON.stringify({ installCode, installed, uninstallCode, after }));
    `;
    const output = execFileSync(process.execPath, ['-e', script], {
      cwd: workspace,
      encoding: 'utf-8',
      env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_PLUGIN_ROOT: pluginRoot },
    });
    const result = JSON.parse(output);
    expect(result.installCode).toBe(0);
    const prompts: Array<{ command: string }> = result.installed.hooks.pre_user_prompt;
    const ours = prompts.filter((hook) => hook.command.includes('hook windsurf'));
    expect(ours).toHaveLength(1);
    expect(ours[0]!.command).toContain('hook-service.cjs');
    expect(ours[0]!.command).not.toContain('worker-service.cjs');
    expect(prompts).toContainEqual(userEntry);
    expect(result.uninstallCode).toBe(0);
    expect(result.after.hooks.pre_user_prompt).toEqual([userEntry]);
  });

  it('Antigravity emits the hook script it is given for every event', async () => {
    const { buildAntigravityHooksConfig } = await import(`${INTEGRATIONS}/AntigravityCliHooksInstaller.js`);
    const hookService = path.join(pluginRoot, 'scripts', 'hook-service.cjs');
    const config = buildAntigravityHooksConfig('/usr/bin/bun', hookService);
    const commands = JSON.stringify(config).match(/"command":"[^"]*"/g) ?? [];
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      expect(command).toContain('hook-service.cjs');
      expect(command).toContain('hook antigravity-cli');
    }
  });
});
