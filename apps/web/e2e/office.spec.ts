import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const shotsDir = path.join(repoRoot, 'apps/web/test-results/shots');

async function waitHttp(url: string, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

test.describe('NEXUS Office UI E2E', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-ui-e2e-'));
  const masterKey = crypto.randomBytes(32).toString('base64');
  const queuePrefix = `nexus-ui-${crypto.randomBytes(4).toString('hex')}`;
  const mockPort = 4015;
  const procs: ChildProcess[] = [];

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    fs.mkdirSync(shotsDir, { recursive: true });

    // 1. Clean Postgres tables so first-time bootstrap runs cleanly
    const pgUrl = process.env.DATABASE_URL || 'postgres://nexus:nexus@127.0.0.1:5432/nexus';
    const pgMod = await import('pg');
    const Client = pgMod.default?.Client ?? pgMod.Client;
    const c = new Client({ connectionString: pgUrl });
    await c.connect();
    await c.query(
      'drop schema public cascade; create schema public;',
    );
    await c.end();

    // 2. Start mock-llm
    const mock = spawn(process.execPath, [path.join(repoRoot, 'scripts/mock-llm.mjs')], {
      env: { ...process.env, MOCK_LLM_PORT: String(mockPort), MOCK_LLM_DELAY_MS: '400' },
      stdio: 'pipe',
      detached: true,
    });
    procs.push(mock);
    await waitHttp(`http://127.0.0.1:${mockPort}/v1/models`, 15_000);

    // 3. Start NEXUS server on :4000
    const server = spawn('npm', ['run', 'start', '-w', '@nexus/server'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PORT: '4000',
        HOST: '127.0.0.1',
        WEB_ORIGIN: 'http://127.0.0.1:3000,http://localhost:3000',
        DATABASE_URL: pgUrl,
        REDIS_URL: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
        NEXUS_MASTER_KEY: masterKey,
        NEXUS_DATA_DIR: tmpDir,
        NEXUS_RUN_WORKER: 'true',
        NEXUS_QUEUE_PREFIX: queuePrefix,
        SANDBOX_BROWSER_WORKER_DIR: path.join(repoRoot, 'sandbox/browser-worker'),
        EGRESS_PORT: '0',
      },
      stdio: 'pipe',
      detached: true,
    });
    procs.push(server);
    await waitHttp('http://127.0.0.1:4000/api/health', 45_000);

    // 4. Start Next.js web app on :3000
    const web = spawn('npm', ['run', 'start', '-w', '@nexus/web'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PORT: '3000',
        HOSTNAME: '127.0.0.1',
        API_URL: 'http://127.0.0.1:4000',
      },
      stdio: 'pipe',
      detached: true,
    });
    procs.push(web);
    await waitHttp('http://127.0.0.1:3000', 45_000);
  });

  test.afterAll(async () => {
    for (const p of procs) {
      if (p.pid && p.exitCode === null) {
        try { process.kill(-p.pid, 'SIGTERM'); } catch { /* already exited */ }
      }
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('bootstraps, configures mock provider, runs mission, resolves approval, and shows report', async ({ page }) => {
    await page.goto('/');

    // 1. Bootstrap CEO account
    await expect(page.getByRole('heading', { name: 'Create CEO workspace' })).toBeVisible();
    await page.getByLabel('Workspace name').fill('NEXUS Studio');
    await page.getByLabel('Your name').fill('CEO');
    await page.getByLabel('Email').fill('ceo@nexus.local');
    await page.getByLabel('Password').fill('correct-horse-battery');
    await page.getByRole('button', { name: 'Create workspace & enter office' }).click();

    // 2. Office canvas renders & WebSocket connects
    const canvas = page.locator('#scene');
    await expect(canvas).toBeVisible();
    const box = await canvas.boundingBox();
    expect(box?.width).toBeGreaterThan(300);
    expect(box?.height).toBeGreaterThan(250);
    await expect(page.locator('.ws-pill.live')).toBeVisible();

    // Unconfigured agents show Setup needed
    await expect(page.getByRole('button', { name: /setup needed/i })).toBeVisible();
    await page.screenshot({ path: path.join(shotsDir, '01-office-initial.png') });

    // 3. Configure mock provider in Workforce
    await page.getByRole('button', { name: 'Workforce' }).click();
    await page.getByLabel('Provider').selectOption('openai');
    await page.getByLabel('Label').fill('Mock LLM');
    await page.getByLabel('Base URL (optional)').fill(`http://127.0.0.1:${mockPort}/v1`);
    await page.getByLabel(/API Key/).fill('mock-key-123456');
    await page.getByRole('button', { name: 'Add credential' }).click();

    await expect(page.getByText('Mock LLM', { exact: true })).toBeVisible();
    // Test the credential
    const modelInput = page.locator('.cred-row input.input').first();
    await modelInput.fill('nexus-mock');
    await page.getByRole('button', { name: 'Test', exact: true }).click();
    await expect(page.getByText(/OK \(nexus-mock\)/)).toBeVisible();

    // Assign to all 5 agents
    await page.getByRole('button', { name: 'Assign to all 5' }).click();
    await expect(page.getByText('Ready').first()).toBeVisible();
    await page.getByRole('button', { name: 'Back to office' }).click();

    // 4. Launch the physiotherapy mission
    await page.getByRole('button', { name: 'Run mission' }).click();

    // Wait for task graph nodes and robot state changes
    await expect(page.locator('.graph-svg .node')).toHaveCount(5, { timeout: 30_000 });
    await expect(page.locator('.feed-list li').first()).toBeVisible();

    // 5. Wait for LEDGER's approval card to appear, screenshot, and approve
    const approvalDialog = page.locator('.approval[role="dialog"]');
    await expect(approvalDialog).toBeVisible({ timeout: 90_000 });
    await expect(approvalDialog).toContainText(/Kickoff|kickoff/i);
    await page.screenshot({ path: path.join(shotsDir, '02-mission-approval.png') });

    await approvalDialog.getByRole('button', { name: 'Approve' }).click();
    await expect(approvalDialog).toBeHidden();

    // 6. Wait for mission completion and ATLAS final report
    const reportRegion = page.getByRole('region', { name: 'Mission report' });
    await expect(reportRegion).toBeVisible({ timeout: 180_000 });
    await expect(reportRegion).toContainText('Mission report');
    await expect(page.locator('.graph-svg .node.completed')).toHaveCount(5);
    await page.screenshot({ path: path.join(shotsDir, '03-mission-complete-report.png') });

    // 7. Verify Projects sheet & Site preview iframe
    await reportRegion.getByRole('button', { name: /Open deliverables/i }).click();
    await expect(page.getByRole('button', { name: /site\/index\.html/ })).toBeVisible();
    await page.getByRole('button', { name: 'Site preview' }).click();
    await expect(page.locator('iframe.preview-frame')).toBeVisible();
    await page.screenshot({ path: path.join(shotsDir, '04-projects-preview.png') });

    // 8. Verify Insights sheet shows "unpriced" for unknown model nexus-mock
    await page.getByRole('button', { name: 'Insights' }).click();
    await expect(page.getByText('unpriced').first()).toBeVisible();
    await page.screenshot({ path: path.join(shotsDir, '05-insights.png') });
  });
});
