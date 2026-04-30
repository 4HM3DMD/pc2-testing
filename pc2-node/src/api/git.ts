/**
 * Git Integration API for Agent Development Workflows
 * Provides a structured interface to git operations
 */

import { Response, Router } from 'express';
import { AuthenticatedRequest, authenticate } from './middleware.js';
import { logger } from '../utils/logger.js';
import { execFile, ExecFileOptions } from 'child_process';
import path from 'path';
import fs from 'fs/promises';

const router = Router();

/**
 * Maximum allowed timeout for git operations (5 minutes)
 */
const MAX_GIT_TIMEOUT = 300000;

/**
 * Get user's terminal home directory
 */
function getUserHome(walletAddress: string): string {
  return path.join(process.cwd(), 'data', 'terminal-homes', walletAddress);
}

/**
 * Validate path is within user's home directory
 */
function isPathSafe(userHome: string, targetPath: string): boolean {
  const resolved = path.resolve(userHome, targetPath);
  return resolved.startsWith(userHome);
}

/**
 * Execute git command in user's directory.
 *
 * Wave 5 (A2): argv-only — `args` is passed as separate parameters to the
 * git binary; no shell delegation, no string interpolation. Callers must
 * validate any user-supplied values before adding them to `args`.
 */
async function execGit(
  args: string[],
  cwd: string,
  timeout: number = 60000
): Promise<{ stdout: string; stderr: string }> {
  const options: ExecFileOptions = {
    cwd,
    timeout: Math.min(timeout, MAX_GIT_TIMEOUT),
    maxBuffer: 10 * 1024 * 1024, // 10MB output buffer
    encoding: 'utf8',
    shell: false,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0', // Disable git prompts
      GIT_SSH_COMMAND: 'ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes',
    },
  };

  return await new Promise((resolve, reject) => {
    execFile('git', args, options, (error, stdout, stderr) => {
      // execFile rejects on non-zero exit; we still want to return the output
      // so handlers can inspect stderr/stdout for benign cases like
      // "nothing to commit".
      if (error && (stdout || stderr)) {
        resolve({
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
        });
        return;
      }
      if (error) {
        reject(error);
        return;
      }
      resolve({
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Wave 5 (A2): input validators
// ---------------------------------------------------------------------------
// With shell delegation removed, the only remaining injection vector is
// "argument injection" — passing strings that the git binary will parse as
// flags (e.g. `--upload-pack=evil`). We defend with two layers:
//   1. Reject inputs that begin with `-` at validation time.
//   2. Use the `--` separator before positional arguments so git stops
//      flag parsing.

/** Reject leading-dash, NUL, control chars, and absurdly long inputs. */
function isSafeArg(value: string, maxLen = 1024): boolean {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLen) return false;
  if (value.startsWith('-')) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return false;
  return true;
}

/** Git URL: HTTPS or SSH only, no leading dash, no whitespace. */
function isValidGitUrl(url: string): boolean {
  if (!isSafeArg(url, 2048)) return false;
  if (/\s/.test(url)) return false;
  return url.startsWith('https://') || url.startsWith('git@');
}

/** Branch/tag/ref name: git's own ref-name rules, simplified. */
function isValidRef(ref: string): boolean {
  if (!isSafeArg(ref, 256)) return false;
  if (/\s/.test(ref)) return false;
  if (ref.includes('..') || ref.includes('//')) return false;
  if (/[~^:?*[\\]/.test(ref)) return false;
  if (ref.endsWith('.lock') || ref.endsWith('/') || ref.endsWith('.')) return false;
  return true;
}

/** Remote name: alphanumerics plus `-_.` (no slashes — that's the URL). */
function isValidRemoteName(name: string): boolean {
  if (!isSafeArg(name, 100)) return false;
  return /^[A-Za-z0-9._-]+$/.test(name);
}

/** Relative file path within a repo: no leading dash, no NUL. */
function isValidFilePath(p: string): boolean {
  return isSafeArg(p, 1024);
}

interface GitCloneRequest {
  url: string;
  destination?: string;
  branch?: string;
  depth?: number;
}

/**
 * Clone a git repository
 * POST /api/git/clone
 */
async function handleGitClone(req: AuthenticatedRequest, res: Response): Promise<void> {
  if (!req.user) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const body = req.body as GitCloneRequest;
  const userHome = getUserHome(req.user.wallet_address);

  if (!body.url) {
    res.status(400).json({ error: 'Missing required parameter: url' });
    return;
  }

  // Wave 5 (A2): validate URL — only HTTPS or SSH, no leading dash, no spaces.
  if (!isValidGitUrl(body.url)) {
    res.status(400).json({ error: 'Only HTTPS and SSH git URLs are supported' });
    return;
  }

  // Wave 5 (A2): validate branch — git ref rules, no flag-injection.
  if (body.branch !== undefined && !isValidRef(body.branch)) {
    res.status(400).json({ error: 'Invalid branch name' });
    return;
  }

  // Wave 5 (A2): depth must be a positive integer (sent as JSON number).
  if (body.depth !== undefined && (typeof body.depth !== 'number' || !Number.isInteger(body.depth) || body.depth <= 0)) {
    res.status(400).json({ error: 'depth must be a positive integer' });
    return;
  }

  // Determine destination
  let destination = body.destination || '';
  if (!destination) {
    // Extract repo name from URL
    const urlParts = body.url.split('/');
    const repoName = urlParts[urlParts.length - 1].replace(/\.git$/, '');
    destination = repoName;
  }

  if (!isPathSafe(userHome, destination)) {
    res.status(400).json({ error: 'Invalid destination path' });
    return;
  }

  const fullPath = path.join(userHome, destination);

  // Wave 5 (A2): build argv. Flags first, then `--` separator, then positional
  // args (url, destination). The `--` ensures git won't reparse the URL or
  // path as a flag even if it somehow contains a leading dash.
  const args: string[] = ['clone'];
  if (body.branch) {
    args.push('--branch', body.branch);
  }
  if (body.depth && body.depth > 0) {
    args.push('--depth', String(body.depth));
  }
  args.push('--', body.url, fullPath);

  logger.info('[Git] Cloning repository', {
    url: body.url,
    destination: fullPath,
    wallet: req.user.wallet_address
  });

  try {
    await fs.mkdir(userHome, { recursive: true });
    const result = await execGit(args, userHome, 120000);

    logger.info('[Git] Clone completed', {
      destination: fullPath,
      hasOutput: !!result.stdout || !!result.stderr
    });

    res.json({
      success: true,
      path: destination,
      full_path: fullPath,
      output: result.stderr || result.stdout, // git outputs to stderr
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error('[Git] Clone failed', { error: errorMessage });
    res.status(500).json({
      error: 'Clone failed',
      message: errorMessage
    });
  }
}

interface GitStatusRequest {
  path?: string;
}

/**
 * Get git status
 * POST /api/git/status
 */
async function handleGitStatus(req: AuthenticatedRequest, res: Response): Promise<void> {
  if (!req.user) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const body = req.body as GitStatusRequest;
  const userHome = getUserHome(req.user.wallet_address);
  const repoPath = body.path || '.';

  if (!isPathSafe(userHome, repoPath)) {
    res.status(400).json({ error: 'Invalid path' });
    return;
  }

  const fullPath = path.join(userHome, repoPath);

  try {
    // Wave 5 (A2): argv form — no shell, no quoting needed for the format.
    const statusResult = await execGit(['status', '--porcelain'], fullPath);
    const branchResult = await execGit(['branch', '--show-current'], fullPath);
    const logResult = await execGit(['log', '-1', '--format=%H|%s|%an|%ad', '--date=iso'], fullPath);

    // Parse porcelain status
    const changes = statusResult.stdout
      .trim()
      .split('\n')
      .filter(line => line.length > 0)
      .map(line => ({
        status: line.substring(0, 2).trim(),
        path: line.substring(3),
      }));

    // Parse last commit
    const lastCommitParts = logResult.stdout.trim().split('|');
    const lastCommit = lastCommitParts[0] ? {
      hash: lastCommitParts[0],
      message: lastCommitParts[1] || '',
      author: lastCommitParts[2] || '',
      date: lastCommitParts[3] || '',
    } : null;

    res.json({
      success: true,
      branch: branchResult.stdout.trim(),
      clean: changes.length === 0,
      changes,
      last_commit: lastCommit,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error('[Git] Status failed', { error: errorMessage });
    res.status(500).json({
      error: 'Status failed',
      message: errorMessage
    });
  }
}

interface GitCommitRequest {
  path?: string;
  message: string;
  add_all?: boolean;
  files?: string[];
}

/**
 * Commit changes
 * POST /api/git/commit
 */
async function handleGitCommit(req: AuthenticatedRequest, res: Response): Promise<void> {
  if (!req.user) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const body = req.body as GitCommitRequest;
  const userHome = getUserHome(req.user.wallet_address);
  const repoPath = body.path || '.';

  if (!body.message || typeof body.message !== 'string') {
    res.status(400).json({ error: 'Missing required parameter: message' });
    return;
  }

  // Wave 5 (A2): bound message length. With argv form there's no shell
  // injection risk, but a 100MB message would still exhaust memory.
  if (body.message.length > 10000) {
    res.status(400).json({ error: 'Commit message too long (max 10000 chars)' });
    return;
  }

  // Wave 5 (A2): if individual files are provided, validate each — no leading
  // dash (would be parsed as a flag), no NUL.
  if (body.files !== undefined) {
    if (!Array.isArray(body.files) || body.files.some(f => !isValidFilePath(f))) {
      res.status(400).json({ error: 'files must be an array of valid relative paths' });
      return;
    }
  }

  if (!isPathSafe(userHome, repoPath)) {
    res.status(400).json({ error: 'Invalid path' });
    return;
  }

  const fullPath = path.join(userHome, repoPath);

  try {
    // Wave 5 (A2): argv form — `git add -- <file>...` stops flag parsing so
    // even unvalidated paths can't be reinterpreted as flags. The validator
    // above is the primary defense; `--` is belt-and-suspenders.
    if (body.add_all) {
      await execGit(['add', '-A'], fullPath);
    } else if (body.files && body.files.length > 0) {
      await execGit(['add', '--', ...body.files], fullPath);
    }

    // Wave 5 (A2): `git commit -m <message>` with message as a separate argv
    // entry — no shell parsing, no quote escaping needed.
    const result = await execGit(['commit', '-m', body.message], fullPath);

    // Get new commit hash
    const hashResult = await execGit(['rev-parse', 'HEAD'], fullPath);

    res.json({
      success: true,
      hash: hashResult.stdout.trim(),
      message: body.message,
      output: result.stdout || result.stderr,
    });
  } catch (error: any) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    
    // Check if nothing to commit
    if (errorMessage.includes('nothing to commit')) {
      res.json({
        success: false,
        error: 'Nothing to commit',
        message: 'Working tree clean'
      });
      return;
    }

    logger.error('[Git] Commit failed', { error: errorMessage });
    res.status(500).json({
      error: 'Commit failed',
      message: errorMessage
    });
  }
}

interface GitPushRequest {
  path?: string;
  remote?: string;
  branch?: string;
  force?: boolean;
}

/**
 * Push changes
 * POST /api/git/push
 */
async function handleGitPush(req: AuthenticatedRequest, res: Response): Promise<void> {
  if (!req.user) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const body = req.body as GitPushRequest;
  const userHome = getUserHome(req.user.wallet_address);
  const repoPath = body.path || '.';

  if (!isPathSafe(userHome, repoPath)) {
    res.status(400).json({ error: 'Invalid path' });
    return;
  }

  const fullPath = path.join(userHome, repoPath);
  const remote = body.remote || 'origin';
  const branch = body.branch || '';

  // Wave 5 (A2): validate remote and branch — both flow into argv positions
  // where a leading dash would otherwise be parsed as a git flag.
  if (!isValidRemoteName(remote)) {
    res.status(400).json({ error: 'Invalid remote name' });
    return;
  }
  if (branch && !isValidRef(branch)) {
    res.status(400).json({ error: 'Invalid branch name' });
    return;
  }

  // Wave 5 (A2): argv form. Order: flags first, then `--` separator, then
  // positional refspecs. `--force` belongs before `--`.
  const args: string[] = ['push'];
  if (body.force) {
    args.push('--force');
  }
  args.push('--', remote);
  if (branch) {
    args.push(branch);
  }

  logger.info('[Git] Pushing changes', {
    path: fullPath,
    remote,
    branch: branch || 'current',
    force: !!body.force
  });

  try {
    const result = await execGit(args, fullPath, 120000);

    res.json({
      success: true,
      remote,
      branch: branch || 'current',
      output: result.stderr || result.stdout,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error('[Git] Push failed', { error: errorMessage });
    res.status(500).json({
      error: 'Push failed',
      message: errorMessage
    });
  }
}

interface GitPullRequest {
  path?: string;
  remote?: string;
  branch?: string;
}

/**
 * Pull changes
 * POST /api/git/pull
 */
async function handleGitPull(req: AuthenticatedRequest, res: Response): Promise<void> {
  if (!req.user) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const body = req.body as GitPullRequest;
  const userHome = getUserHome(req.user.wallet_address);
  const repoPath = body.path || '.';

  if (!isPathSafe(userHome, repoPath)) {
    res.status(400).json({ error: 'Invalid path' });
    return;
  }

  const fullPath = path.join(userHome, repoPath);
  const remote = body.remote || 'origin';
  const branch = body.branch || '';

  // Wave 5 (A2): validate remote and branch (see push handler).
  if (!isValidRemoteName(remote)) {
    res.status(400).json({ error: 'Invalid remote name' });
    return;
  }
  if (branch && !isValidRef(branch)) {
    res.status(400).json({ error: 'Invalid branch name' });
    return;
  }

  // Wave 5 (A2): argv form with `--` separator before positional refspecs.
  const args: string[] = ['pull', '--', remote];
  if (branch) {
    args.push(branch);
  }

  try {
    const result = await execGit(args, fullPath, 120000);

    res.json({
      success: true,
      remote,
      branch: branch || 'current',
      output: result.stdout || result.stderr,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error('[Git] Pull failed', { error: errorMessage });
    res.status(500).json({
      error: 'Pull failed',
      message: errorMessage
    });
  }
}

interface GitLogRequest {
  path?: string;
  count?: number;
}

/**
 * Get commit log
 * POST /api/git/log
 */
async function handleGitLog(req: AuthenticatedRequest, res: Response): Promise<void> {
  if (!req.user) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const body = req.body as GitLogRequest;
  const userHome = getUserHome(req.user.wallet_address);
  const repoPath = body.path || '.';
  const count = Math.min(body.count || 10, 100);

  if (!isPathSafe(userHome, repoPath)) {
    res.status(400).json({ error: 'Invalid path' });
    return;
  }

  const fullPath = path.join(userHome, repoPath);

  try {
    // Wave 5 (A2): argv form. `count` is already a bounded integer (1..100)
    // via `Math.min(body.count || 10, 100)` above, so it's safe to interpolate
    // into the `-N` flag.
    const result = await execGit(
      ['log', `-${count}`, '--format=%H|%s|%an|%ae|%ad', '--date=iso'],
      fullPath
    );

    const commits = result.stdout
      .trim()
      .split('\n')
      .filter(line => line.length > 0)
      .map(line => {
        const parts = line.split('|');
        return {
          hash: parts[0],
          message: parts[1] || '',
          author: parts[2] || '',
          email: parts[3] || '',
          date: parts[4] || '',
        };
      });

    res.json({
      success: true,
      count: commits.length,
      commits,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error('[Git] Log failed', { error: errorMessage });
    res.status(500).json({
      error: 'Log failed',
      message: errorMessage
    });
  }
}

interface GitDiffRequest {
  path?: string;
  staged?: boolean;
}

/**
 * Get diff of changes
 * POST /api/git/diff
 */
async function handleGitDiff(req: AuthenticatedRequest, res: Response): Promise<void> {
  if (!req.user) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const body = req.body as GitDiffRequest;
  const userHome = getUserHome(req.user.wallet_address);
  const repoPath = body.path || '.';

  if (!isPathSafe(userHome, repoPath)) {
    res.status(400).json({ error: 'Invalid path' });
    return;
  }

  const fullPath = path.join(userHome, repoPath);
  const args: string[] = body.staged ? ['diff', '--staged'] : ['diff'];

  try {
    const result = await execGit(args, fullPath);

    res.json({
      success: true,
      staged: !!body.staged,
      diff: result.stdout,
      has_changes: result.stdout.trim().length > 0,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error('[Git] Diff failed', { error: errorMessage });
    res.status(500).json({
      error: 'Diff failed',
      message: errorMessage
    });
  }
}

// Register routes
router.post('/clone', authenticate, handleGitClone);
router.post('/status', authenticate, handleGitStatus);
router.post('/commit', authenticate, handleGitCommit);
router.post('/push', authenticate, handleGitPush);
router.post('/pull', authenticate, handleGitPull);
router.post('/log', authenticate, handleGitLog);
router.post('/diff', authenticate, handleGitDiff);

export { router as gitRouter };
