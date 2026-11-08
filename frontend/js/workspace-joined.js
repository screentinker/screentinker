/*
 * The cached user (localStorage 'user') is only rewritten by /me. A user who just got their first
 * workspace still has accessible_workspaces: [] cached, and route() would bounce the reload straight
 * back to #/no-workspace. Mark the list "not loaded" (route() then waits for /me) and set the new
 * current workspace. Used by the accept-invite flow and views/no-workspace.js.
 */
export function markWorkspaceJoined(workspaceId) {
  try {
    const u = JSON.parse(localStorage.getItem('user') || 'null');
    if (!u) return;
    delete u.accessible_workspaces;
    if (workspaceId) u.current_workspace_id = workspaceId;
    localStorage.setItem('user', JSON.stringify(u));
  } catch { /* nothing cached: nothing to correct */ }
}
