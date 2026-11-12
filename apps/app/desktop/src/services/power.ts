import { app, powerSaveBlocker } from 'electron';
import Store from 'electron-store';
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as path from 'node:path';
import * as os from 'node:os';
import type { DesktopPowerStatus } from '../../../common/desktop-power';
import { handleTrustedIpc, onTrustedIpc } from '../security/trusted-ipc';
import { retainLoopbackForPower } from './loopback';
import { PowerActivity } from './power-activity';

export class DesktopPower {
  private store = new Store<{ preventSleep: boolean; closedLid: boolean }>({
    name: 'openagent-power', defaults: { preventSleep: true, closedLid: false },
  });
  private active = false;
  private blocker: number | null = null;
  private disposed = false;
  private helper: ChildProcessWithoutNullStreams | null = null;
  private helperOutput = '';
  private lidStatus: DesktopPowerStatus['lidStatus'] = 'unsupported';
  private refresh: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval>;
  readonly activity = new PowerActivity(retainLoopbackForPower, active => { this.active = active; this.update(); });

  private get nativePath(): string {
    return app.isPackaged ? path.join(path.dirname(process.execPath), 'openagent-power-client')
      : path.join(app.getAppPath(), 'native-build', process.arch, 'openagent-power-client');
  }
  private get mac(): boolean { return process.platform === 'darwin' && Number(os.release().split('.')[0]) >= 22; }

  constructor() {
    if (this.mac) this.lidStatus = 'setup-required';
    void this.refreshNative();
    this.timer = setInterval(() => {
      if (this.helper) this.renew();
      else if (this.store.get('closedLid')) void this.refreshNative().then(() => this.update());
    }, 10_000);
    this.timer.unref();
  }

  status(): DesktopPowerStatus {
    return { preventSleep: this.store.get('preventSleep'), closedLid: this.store.get('closedLid'),
      active: this.active, blocking: this.blocker !== null && powerSaveBlocker.isStarted(this.blocker), lidStatus: this.lidStatus };
  }

  private native(mode: '--status' | '--register'): Promise<any> {
    return new Promise((resolve, reject) => {
      execFile(this.nativePath, [mode], { timeout: mode === '--register' ? 120_000 : 8_000, maxBuffer: 16_384 }, (error, stdout) => {
        if (error) { reject(new Error('macOS power service unavailable')); return; }
        try { resolve(JSON.parse(stdout)); } catch { reject(new Error('Invalid power service response')); }
      });
    });
  }

  private refreshNative(): Promise<void> {
    if (!this.mac || this.disposed) return Promise.resolve();
    if (this.refresh) return this.refresh;
    this.refresh = this.native('--status').then(value => {
      if (!this.disposed && ['ready', 'setup-required', 'approval-required'].includes(value.status)) this.lidStatus = value.status;
    }).catch(() => { if (!this.disposed) this.lidStatus = 'error'; })
      .finally(() => { this.refresh = null; });
    return this.refresh;
  }

  async preferences(input: { preventSleep?: boolean; closedLid?: boolean }): Promise<DesktopPowerStatus> {
    if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).some(key => !['preventSleep', 'closedLid'].includes(key))
        || Object.values(input).some(value => typeof value !== 'boolean')) throw new Error('Invalid power preference');
    if (input.closedLid === true) {
      if (!this.mac) throw new Error('Closed-lid operation requires macOS 13 or later');
      // Registration is only reachable from this explicit settings action,
      // never from session activity, startup or a remote tool invocation.
      const value = await this.native('--register');
      if (!['ready', 'approval-required'].includes(value.status)) throw new Error('Approve the OpenAgent power service in macOS settings');
      this.lidStatus = value.status;
    }
    if (this.disposed) return this.status();
    if (input.preventSleep !== undefined) this.store.set('preventSleep', input.preventSleep);
    if (input.closedLid !== undefined) this.store.set('closedLid', input.closedLid);
    this.update();
    return this.status();
  }

  private update(): void {
    const wanted = !this.disposed && this.active && this.store.get('preventSleep');
    this.updateBlocker();
    if (wanted && this.store.get('closedLid') && ['ready', 'active', 'paused'].includes(this.lidStatus)) {
      if (!this.helper) this.startHelper();
      this.renew();
    } else this.stopHelper();
  }

  private updateBlocker(): void {
    const wanted = !this.disposed && this.active && this.store.get('preventSleep')
      && !(this.store.get('closedLid') && this.lidStatus === 'paused');
    if (wanted && this.blocker === null) this.blocker = powerSaveBlocker.start('prevent-app-suspension');
    if (!wanted && this.blocker !== null) { powerSaveBlocker.stop(this.blocker); this.blocker = null; }
  }

  private startHelper(): void {
    const helper = this.helper = spawn(this.nativePath, ['--client'], { stdio: 'pipe' });
    this.helperOutput = '';
    helper.stderr.on('data', () => {});
    helper.stdin.on('error', () => { if (this.helper === helper) this.stopHelper(); });
    helper.stdout.on('data', chunk => {
      if (this.helper !== helper) return;
      this.helperOutput += chunk.toString('utf8');
      if (this.helperOutput.length > 16_384) { this.lidStatus = 'error'; this.stopHelper(); return; }
      let end: number;
      while ((end = this.helperOutput.indexOf('\n')) >= 0) {
        const line = this.helperOutput.slice(0, end); this.helperOutput = this.helperOutput.slice(end + 1);
        try {
          const result = JSON.parse(line);
          this.lidStatus = result.ok === true ? (result.safetyPaused ? 'paused' : result.active ? 'active' : 'ready') : 'error';
          this.updateBlocker();
          if (result.ok !== true) { this.stopHelper(); return; }
        } catch { this.lidStatus = 'error'; this.stopHelper(); return; }
      }
    });
    const failed = () => {
      if (this.helper !== helper) return;
      this.helper = null; this.lidStatus = 'error';
    };
    helper.on('error', failed); helper.on('exit', failed);
  }

  private renew(): void {
    this.helper?.stdin.write(JSON.stringify({ active: !this.disposed && this.active && this.store.get('preventSleep') && this.store.get('closedLid') }) + '\n');
  }

  private stopHelper(): void {
    const helper = this.helper; this.helper = null;
    if (helper) { helper.stdin.end(); helper.kill(); }
    if (this.lidStatus === 'active' || this.lidStatus === 'paused') this.lidStatus = 'ready';
  }

  dispose(): void {
    this.disposed = true; clearInterval(this.timer);
    this.activity.dispose(); this.update(); this.stopHelper();
  }
}

export function registerPowerHandlers(power: DesktopPower): void {
  handleTrustedIpc('power:status', () => power.status());
  handleTrustedIpc('power:preferences', (_event, input) => power.preferences(input));
  onTrustedIpc('power:activity', (event, accountId, active) => {
    if ((accountId === null || (typeof accountId === 'string' && accountId.length <= 256)) && typeof active === 'boolean')
      power.activity.report(event.sender.id, accountId, active);
  });
  app.on('web-contents-created', (_event, contents) => {
    const id = contents.id;
    contents.once('destroyed', () => power.activity.releaseOwner(id));
    contents.on('render-process-gone', () => power.activity.releaseOwner(id));
  });
}
