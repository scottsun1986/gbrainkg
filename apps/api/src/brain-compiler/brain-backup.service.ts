import { Injectable, Logger } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

@Injectable()
export class BrainBackupService {
  private readonly logger = new Logger(BrainBackupService.name);
  private readonly enabled = process.env.BRAIN_BACKUP_ENABLED === 'true';
  private readonly giteaUrl = (process.env.BRAIN_BACKUP_GITEA_URL || '').replace(/\/$/, '');
  private readonly giteaToken = process.env.BRAIN_BACKUP_GITEA_TOKEN || '';
  private readonly minIntervalMs = Number(process.env.BRAIN_BACKUP_INTERVAL_MS || 300000);
  private readonly lastPushMap = new Map<string, number>();
  private giteaUsername: string | null = null;

  private async getUsername(): Promise<string> {
    if (this.giteaUsername) return this.giteaUsername;
    const res = await fetch(`${this.giteaUrl}/api/v1/user`, {
      headers: { 'Authorization': `token ${this.giteaToken}` }
    });
    if (!res.ok) {
      throw new Error(`Failed to fetch Gitea user: ${res.statusText}`);
    }
    const data = (await res.json()) as { login: string };
    this.giteaUsername = data.login;
    return this.giteaUsername;
  }

  private async ensureGiteaRepoExists(sourceKey: string, username: string): Promise<void> {
    const res = await fetch(`${this.giteaUrl}/api/v1/repos/${username}/${sourceKey}`, {
      headers: { 'Authorization': `token ${this.giteaToken}` }
    });

    if (res.status === 404) {
      const createRes = await fetch(`${this.giteaUrl}/api/v1/user/repos`, {
        method: 'POST',
        headers: {
          'Authorization': `token ${this.giteaToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          name: sourceKey,
          private: true
        })
      });
      if (!createRes.ok) {
        throw new Error(`Failed to create repo: ${await createRes.text()}`);
      }
      this.logger.log(`Created new Gitea repo for ${sourceKey}`);
    } else if (!res.ok) {
      throw new Error(`Failed to check repo existence: ${await res.text()}`);
    }
  }

  async ensureRemote(repoPath: string, sourceKey: string): Promise<void> {
    if (!this.enabled || !this.giteaUrl || !this.giteaToken) return;

    try {
      const username = await this.getUsername();
      await this.ensureGiteaRepoExists(sourceKey, username);

      const parsedUrl = new URL(this.giteaUrl);
      const authUrl = `${parsedUrl.protocol}//oauth2:${this.giteaToken}@${parsedUrl.host}${parsedUrl.pathname}/${username}/${sourceKey}.git`;

      try {
        await execFileAsync('git', ['remote', 'remove', 'backup'], { cwd: repoPath });
      } catch (e) {
        // Ignore error if remote doesn't exist
      }
      
      await execFileAsync('git', ['remote', 'add', 'backup', authUrl], { cwd: repoPath });
    } catch (error: any) {
      this.logger.error(`Failed to ensure remote for ${sourceKey}: ${error.message}`);
      throw error;
    }
  }

  async pushBackup(repoPath: string, sourceKey: string): Promise<void> {
    if (!this.enabled || !this.giteaUrl || !this.giteaToken) return;

    try {
      const lastPush = this.lastPushMap.get(sourceKey) || 0;
      const now = Date.now();
      if (now - lastPush < this.minIntervalMs) {
        return; // Rate limited
      }

      await this.ensureRemote(repoPath, sourceKey);
      await execFileAsync('git', ['push', 'backup', '--all', '--force'], { cwd: repoPath });
      
      this.lastPushMap.set(sourceKey, now);
      this.logger.log(`Successfully backed up ${sourceKey} to Gitea`);
    } catch (error: any) {
      // Swallowing the error to ensure backup failure doesn't block compilation
      this.logger.error(`Failed to push backup for ${sourceKey}: ${error.message}`);
    }
  }

  async schedulePeriodicBackup(): Promise<void> {
    // Can be wired into a cron or BullMQ job
    if (!this.enabled) return;
    this.logger.log('Periodic backup schedule check executed');
  }
}
