const API_BASE = '/api';

function getAuthHeaders() {
  const token = localStorage.getItem('token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function request(url, options = {}) {
  const res = await fetch(API_BASE + url, {
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders(), ...options.headers },
    ...options,
  });
  if (res.status === 401) {
    // Token expired or invalid - redirect to login
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    window.location.hash = '#/login';
    window.location.reload();
    throw new Error('Session expired');
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Request failed');
  }
  return res.json();
}

export const api = {
  // Devices
  getDevices: () => request('/devices'),
  getDevice: (id) => request(`/devices/${id}`),
  updateDevice: (id, data) => request(`/devices/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteDevice: (id) => request(`/devices/${id}`, { method: 'DELETE' }),

  // Provisioning
  pairDevice: (pairing_code, name) => request('/provision/pair', {
    method: 'POST',
    body: JSON.stringify({ pairing_code, name })
  }),

  // Content
  getContent: (folderId) => {
    if (folderId === undefined) return request('/content');
    const q = folderId === null ? 'root' : encodeURIComponent(folderId);
    return request(`/content?folder_id=${q}`);
  },
  getContentItem: (id) => request(`/content/${id}`),
  deleteContent: (id) => request(`/content/${id}`, { method: 'DELETE' }),
  updateContent: (id, data) => request(`/content/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  moveContent: (id, folderId) => request(`/content/${id}`, {
    method: 'PUT',
    body: JSON.stringify({ folder_id: folderId })
  }),

  // Folders
  getFolders: () => request('/folders'),
  createFolder: (name, parentId) => request('/folders', {
    method: 'POST',
    body: JSON.stringify({ name, parent_id: parentId || null })
  }),
  renameFolder: (id, name) => request(`/folders/${id}`, {
    method: 'PUT',
    body: JSON.stringify({ name })
  }),
  moveFolder: (id, parentId) => request(`/folders/${id}`, {
    method: 'PUT',
    body: JSON.stringify({ parent_id: parentId || null })
  }),
  deleteFolder: (id) => request(`/folders/${id}`, { method: 'DELETE' }),
  uploadContent: async (file, onProgress) => {
    const formData = new FormData();
    formData.append('file', file);

    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${API_BASE}/content`);
      const token = localStorage.getItem('token');
      if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      if (onProgress) {
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
        };
      }
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(JSON.parse(xhr.responseText));
        } else {
          reject(new Error('Upload failed'));
        }
      };
      xhr.onerror = () => reject(new Error('Upload failed'));
      xhr.send(formData);
    });
  },

  addRemoteContent: (url, name, mime_type) => request('/content/remote', {
    method: 'POST',
    body: JSON.stringify({ url, name, mime_type })
  }),

  addYoutubeContent: (url, name) => request('/content/youtube', {
    method: 'POST',
    body: JSON.stringify({ url, name })
  }),

  // Assignments
  getAssignments: (deviceId) => request(`/assignments/device/${deviceId}`),
  addAssignment: (deviceId, data) => request(`/assignments/device/${deviceId}`, {
    method: 'POST',
    body: JSON.stringify(data)
  }),
  updateAssignment: (id, data) => request(`/assignments/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteAssignment: (id) => request(`/assignments/${id}`, { method: 'DELETE' }),
  reorderAssignments: (deviceId, order) => request(`/assignments/device/${deviceId}/reorder`, {
    method: 'POST',
    body: JSON.stringify({ order })
  }),

  // Widgets
  getWidgets: () => request('/widgets'),

  // Device Groups
  getGroups: () => request('/groups'),
  createGroup: (name, color) => request('/groups', { method: 'POST', body: JSON.stringify({ name, color }) }),
  deleteGroup: (id) => request(`/groups/${id}`, { method: 'DELETE' }),
  getGroupDevices: (id) => request(`/groups/${id}/devices`),
  addDeviceToGroup: (groupId, device_id) => request(`/groups/${groupId}/devices`, { method: 'POST', body: JSON.stringify({ device_id }) }),
  removeDeviceFromGroup: (groupId, deviceId) => request(`/groups/${groupId}/devices/${deviceId}`, { method: 'DELETE' }),
  sendGroupCommand: (groupId, type, payload) => request(`/groups/${groupId}/command`, { method: 'POST', body: JSON.stringify({ type, payload }) }),

  // Video walls
  getWalls: () => request('/walls'),
  createWall: (data) => request('/walls', { method: 'POST', body: JSON.stringify(data) }),
  setWallDevices: (id, devices) => request(`/walls/${id}/devices`, { method: 'PUT', body: JSON.stringify({ devices }) }),
  updateWall: (id, data) => request(`/walls/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteWall: (id) => request(`/walls/${id}`, { method: 'DELETE' }),

  // Playlists
  getPlaylists: () => request('/playlists'),
  createPlaylist: (name, description) => request('/playlists', { method: 'POST', body: JSON.stringify({ name, description }) }),
  getPlaylist: (id) => request(`/playlists/${id}`),
  updatePlaylist: (id, data) => request(`/playlists/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deletePlaylist: (id) => request(`/playlists/${id}`, { method: 'DELETE' }),
  getPlaylistItems: (id) => request(`/playlists/${id}/items`),
  addPlaylistItem: (id, data) => request(`/playlists/${id}/items`, { method: 'POST', body: JSON.stringify(data) }),
  updatePlaylistItem: (id, itemId, data) => request(`/playlists/${id}/items/${itemId}`, { method: 'PUT', body: JSON.stringify(data) }),
  deletePlaylistItem: (id, itemId) => request(`/playlists/${id}/items/${itemId}`, { method: 'DELETE' }),
  reorderPlaylistItems: (id, order) => request(`/playlists/${id}/items/reorder`, { method: 'POST', body: JSON.stringify({ order }) }),
  // #74/#75 per-item schedule blocks
  getItemSchedules: (id, itemId) => request(`/playlists/${id}/items/${itemId}/schedules`),
  setItemSchedules: (id, itemId, blocks) => request(`/playlists/${id}/items/${itemId}/schedules`, { method: 'PUT', body: JSON.stringify({ blocks }) }),
  assignPlaylistToDevice: (playlistId, device_id) => request(`/playlists/${playlistId}/assign`, { method: 'POST', body: JSON.stringify({ device_id }) }),
  publishPlaylist: (id) => request(`/playlists/${id}/publish`, { method: 'POST' }),
  discardPlaylistDraft: (id) => request(`/playlists/${id}/discard`, { method: 'POST' }),

  // Device Groups - Playlist
  groupAssignPlaylist: (groupId, playlist_id) => request(`/groups/${groupId}/assign-playlist`, { method: 'POST', body: JSON.stringify({ playlist_id }) }),

  // API Tokens (personal access tokens, workspace-scoped)
  getTokens: () => request('/tokens'),
  createToken: (data) => request('/tokens', { method: 'POST', body: JSON.stringify(data) }),
  revokeToken: (id) => request('/tokens/' + id, { method: 'DELETE' }),

  // Current user
  getMe: () => request('/auth/me'),
  updateMe: (data) => request('/auth/me', { method: 'PUT', body: JSON.stringify(data) }),
  switchWorkspace: (workspaceId) => request('/auth/switch-workspace', { method: 'POST', body: JSON.stringify({ workspace_id: workspaceId }) }),
  renameWorkspace: (id, data) => request(`/workspaces/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),

  // Workspace members + invites (slice 2A read-only)
  getWorkspaceMembers: (id) => request(`/workspaces/${id}/members`),
  getWorkspaceInvites: (id) => request(`/workspaces/${id}/invites`),

  // Workspace member/invite mutations (slice 2B). All admin-only server-side
  // (canAdminWorkspace gate). Server returns translated English error messages
  // mapped to i18n keys via mapMutationError() in workspace-members.js.
  inviteWorkspaceMember: (workspaceId, data) => request(`/workspaces/${workspaceId}/invites`, { method: 'POST', body: JSON.stringify(data) }),
  cancelWorkspaceInvite: (workspaceId, inviteId) => request(`/workspaces/${workspaceId}/invites/${inviteId}`, { method: 'DELETE' }),
  updateWorkspaceMemberRole: (workspaceId, userId, role) => request(`/workspaces/${workspaceId}/members/${userId}`, { method: 'PUT', body: JSON.stringify({ role }) }),
  removeWorkspaceMember: (workspaceId, userId) => request(`/workspaces/${workspaceId}/members/${userId}`, { method: 'DELETE' }),

  // Slice 2C - accept a workspace invite by id (post-auth flow)
  acceptInvite: (inviteId) => request(`/auth/accept-invite/${inviteId}`, { method: 'POST' }),

  // Admin-provisioned user creation (#10). data: { email, name, password,
  // workspaceId, role, mustChangePassword }
  adminCreateUser: (data) => request('/admin/users', { method: 'POST', body: JSON.stringify(data) }),
  adminCreateOrg: (name) => request('/admin/orgs', { method: 'POST', body: JSON.stringify({ name }) }),
  adminListOrgs: () => request('/admin/orgs'),
  adminDeleteOrg: (id) => request(`/admin/orgs/${id}`, { method: 'DELETE' }),
  adminDeleteWorkspace: (id) => request(`/admin/workspaces/${id}`, { method: 'DELETE' }),
  aiGetSettings: () => request('/ai/settings'),
  aiSaveSettings: (data) => request('/ai/settings', { method: 'PUT', body: JSON.stringify(data) }),
  aiGenerateDesign: (prompt) => request('/ai/generate-design', { method: 'POST', body: JSON.stringify({ prompt }) }),
  aiListModels: (base_url, api_key) => request('/ai/models', { method: 'POST', body: JSON.stringify({ base_url, api_key }) }),

  // Instance-level default branding (#15, platform admin).
  adminGetBranding: () => request('/admin/branding'),
  adminSetBranding: (data) => request('/admin/branding', { method: 'PUT', body: JSON.stringify(data) }),

  // Per-user workspace membership management (platform Users page modal).
  adminGetUserWorkspaces: (id) => request(`/admin/users/${id}/workspaces`),
  adminAddUserWorkspace: (id, workspaceId, role) => request(`/admin/users/${id}/workspaces`, { method: 'POST', body: JSON.stringify({ workspaceId, role }) }),
  adminSetUserWorkspaceRole: (id, workspaceId, role) => request(`/admin/users/${id}/workspaces/${workspaceId}`, { method: 'PUT', body: JSON.stringify({ role }) }),
  adminRemoveUserWorkspace: (id, workspaceId) => request(`/admin/users/${id}/workspaces/${workspaceId}`, { method: 'DELETE' }),

  // Admin - Users
  getUsers: () => request('/auth/users'),
  deleteUser: (id) => request(`/auth/users/${id}`, { method: 'DELETE' }),
  resetUserPassword: (id, password) => request(`/auth/users/${id}/password`, {
    method: 'PUT',
    body: JSON.stringify({ password }),
  }),
  assignPlan: (user_id, plan_id) => request('/subscription/assign', {
    method: 'POST',
    body: JSON.stringify({ user_id, plan_id })
  }),
};
