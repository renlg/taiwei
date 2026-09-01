import { join } from 'node:path';
import { osUserForGuest } from '../tenant-os.js';
import { cleanupDeployment, deploymentPreflight, inspectDeployment, validateDeploymentInput } from '../deployments.js';
import { HttpError, json, readJson } from '../http.js';
import type { RouteContext } from './route-context.js';

/** Handles /api/deployments*, /api/tenant-accounts*, and /api/auth/gitea-user. */
export async function handleDeploymentRoutes(ctx: RouteContext): Promise<boolean> {
  const { runtime, request, response, method, pathname, scope } = ctx;
  const { options, taiweiPaths, requireDeployments } = runtime;
  const { auth, deploymentIdentity, deploymentWorkspaceDirectories, deploymentGuestProjectsRoots } = scope;

  if (method === 'GET' && pathname === '/api/deployments') {
    const repository = await requireDeployments();
    const requestedOwner = new URL(request.url ?? '/', 'http://localhost').searchParams.get('ownerHash')?.trim();
    const allowedOwner = auth.role === 'guest' ? await deploymentIdentity() : requestedOwner;
    if (auth.role === 'guest' && requestedOwner && requestedOwner !== allowedOwner) throw new HttpError(403, '不能查看其他用户的部署');
    const records = await repository.listDeployments();
    json(response, 200, allowedOwner ? records.filter((record) => record.ownerHash === allowedOwner) : records);
    return true;
  }
  if (method === 'POST' && pathname === '/api/deployments') {
    const repository = await requireDeployments();
    const body = await readJson(request);
    if (auth.role === 'guest') {
      const submittedOwner = body && typeof body === 'object' && !Array.isArray(body) && typeof (body as { ownerHash?: unknown }).ownerHash === 'string'
        ? (body as { ownerHash: string }).ownerHash.trim() : '';
      if (submittedOwner && submittedOwner !== await deploymentIdentity()) throw new HttpError(403, '不能注册或更新其他用户的部署');
    }
    const workspaceDirectories = await deploymentWorkspaceDirectories();
    const guestProjectsRoots = await deploymentGuestProjectsRoots();
    const input = validateDeploymentInput(body, join(taiweiPaths.home, 'projects'), workspaceDirectories, guestProjectsRoots);
    if (auth.role === 'guest' && input.ownerHash !== await deploymentIdentity()) throw new HttpError(403, '不能注册或更新其他用户的部署');
    json(response, 200, await repository.upsertDeployment(input));
    return true;
  }
  if (method === 'GET' && pathname === '/api/deployments/doctor') {
    const repository = await requireDeployments();
    const requestedOwner = new URL(request.url ?? '/', 'http://localhost').searchParams.get('ownerHash')?.trim();
    const allowedOwner = auth.role === 'guest' ? await deploymentIdentity() : requestedOwner;
    if (auth.role === 'guest' && requestedOwner && requestedOwner !== allowedOwner) throw new HttpError(403, '不能对账其他用户的部署');
    const records = (await repository.listDeployments()).filter((record) => !allowedOwner || record.ownerHash === allowedOwner);
    const inspect = options.deploymentInspect ?? inspectDeployment;
    json(response, 200, await Promise.all(records.map((record) => inspect(record))));
    return true;
  }
  const deploymentDeleteRoute = pathname.match(/^\/api\/deployments\/([^/]+)$/);
  if (method === 'DELETE' && deploymentDeleteRoute) {
    const repository = await requireDeployments();
    let name: string;
    try { name = decodeURIComponent(deploymentDeleteRoute[1]); }
    catch { throw new HttpError(400, '部署名称编码无效'); }
    const ownerHash = new URL(request.url ?? '/', 'http://localhost').searchParams.get('ownerHash')?.trim();
    const force = new URL(request.url ?? '/', 'http://localhost').searchParams.get('force') === '1';
    if (!ownerHash) throw new HttpError(400, 'ownerHash is required');
    if (auth.role === 'guest' && ownerHash !== await deploymentIdentity()) throw new HttpError(403, '不能清理其他用户的部署');
    const record = await repository.getDeployment(name, ownerHash);
    if (!record) throw new HttpError(404, 'Deployment not found');
    const preflight = await deploymentPreflight(record);
    const workspaceDirectories = await deploymentWorkspaceDirectories();
    const guestProjectsRoots = await deploymentGuestProjectsRoots();
    const cleanup = options.deploymentCleanup ?? cleanupDeployment;
    const steps = await cleanup(record, {
      projectsRoot: join(taiweiPaths.home, 'projects'), skillsRoot: taiweiPaths.skills, workspaceDirectories, guestProjectsRoots, force,
    });
    const ok = steps.every((step) => step.status !== 'failed');
    if (ok) await repository.markCleaned(record.id);
    json(response, 200, { ok, steps, preflight, deployment: ok ? await repository.getDeployment(name, ownerHash) : record });
    return true;
  }
  if (method === 'GET' && pathname === '/api/auth/gitea-user') {
    if (!auth.token || !auth.username) {
      json(response, 401, { error: 'unauthorized' });
      return true;
    }
    let giteaUsername: string;
    if (auth.role === 'admin') {
      giteaUsername = 'admin';
    } else {
      const osUser = await osUserForGuest(auth.username);
      if (!osUser) throw new HttpError(403, 'no gitea account provisioned');
      giteaUsername = osUser;
    }
    json(response, 200, { giteaUsername }, { 'x-gitea-user': giteaUsername });
    return true;
  }
  if (method === 'GET' && pathname === '/api/tenant-accounts') {
    if (!runtime.tenantAccounts) throw new HttpError(503, 'Tenant account database is unavailable');
    json(response, 200, { accounts: await runtime.tenantAccounts.store.listAccounts() });
    return true;
  }
  const tenantAccountRoute = pathname.match(/^\/api\/tenant-accounts\/([^/]+)$/);
  if (method === 'DELETE' && tenantAccountRoute) {
    if (!runtime.tenantAccounts) throw new HttpError(503, 'Tenant account database is unavailable');
    let username: string;
    try { username = decodeURIComponent(tenantAccountRoute[1]).trim(); }
    catch { throw new HttpError(400, 'Invalid tenant username encoding'); }
    if (!username) throw new HttpError(400, 'Tenant username is required');
    if (!await runtime.tenantAccounts.store.getByUsername(username)) throw new HttpError(404, `Tenant account not found: ${username}`);
    await runtime.tenantAccounts.deleteTenantAccount(username);
    json(response, 200, { ok: true });
    return true;
  }
  return false;
}
