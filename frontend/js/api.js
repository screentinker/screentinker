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
  getContent: () => request('/content'),
  getContentItem: (id) => request(`/content/${id}`),
  deleteContent: (id) => request(`/content/${id}`, { method: 'DELETE' }),
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

  // Admin - Users
  getUsers: () => request('/auth/users'),
  deleteUser: (id) => request(`/auth/users/${id}`, { method: 'DELETE' }),
  assignPlan: (user_id, plan_id) => request('/subscription/assign', {
    method: 'POST',
    body: JSON.stringify({ user_id, plan_id })
  }),
};
