import { createAsyncThunk, createSlice } from '@reduxjs/toolkit';
import { login, logout, me, getClientSettings } from '../../lib/api.js';

function normalizeUser(user) {
  if (!user) return null;
  const memberships = Array.isArray(user.brand_memberships) ? user.brand_memberships : [];
  const normalizedRole = (user.role || '').toLowerCase();
  const hasAuthorRole = normalizedRole === 'author' || normalizedRole === 'super_admin' || normalizedRole === 'admin';
  return {
    ...user,
    isAuthor: hasAuthorRole,
    brandKey: user.primary_brand_id || memberships[0]?.brand_id || '',
  };
}

export const fetchCurrentUser = createAsyncThunk('auth/fetchCurrentUser', async (_, { rejectWithValue }) => {
  const r = await me();
  if (r.unavailable) return rejectWithValue({ unavailable: true });
  if (!r.authenticated) return { user: null };
  if (!r.user) return rejectWithValue('Missing user payload');
  return { user: normalizeUser(r.user), expiresAt: r.expiresAt };
});

export const loginUser = createAsyncThunk('auth/loginUser', async ({ email, password }, { rejectWithValue }) => {
  const r = await login(email, password);
  if (r.error) {
    if (r.unavailable) return rejectWithValue({ unavailable: true });
    const msg = r.data?.error || 'Login failed';
    return rejectWithValue(msg);
  }
  return { user: normalizeUser(r.data?.user || null) };
});

export const logoutUser = createAsyncThunk('auth/logoutUser', async () => {
  await logout();
  return { user: null };
});

export const fetchClientSettings = createAsyncThunk('auth/fetchClientSettings', async (_, { rejectWithValue }) => {
  const r = await getClientSettings();
  // Keep the last-known value on a transient fetch error instead of
  // flipping the banner off every time a single poll fails.
  if (r.error) return rejectWithValue(null);
  return { dashboardBannerEnabled: !!r.dashboardBannerEnabled };
});

const initialState = {
  user: null,
  expiresAt: null,
  initialized: false,
  meStatus: 'idle',
  loginStatus: 'idle',
  loginError: null,
  logoutStatus: 'idle',
  maintenanceMode: false,
  dashboardBannerEnabled: false,
};

const authSlice = createSlice({
  name: 'auth',
  initialState,
  reducers: {
    setUser(state, action) {
      state.user = action.payload || null;
    },
    clearAuthState(state) {
      state.user = null;
      state.expiresAt = null;
      state.initialized = true;
      state.meStatus = 'idle';
      state.loginStatus = 'idle';
      state.loginError = null;
      state.logoutStatus = 'idle';
      state.maintenanceMode = false;
    },
    resetAuthState() {
      return initialState;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchCurrentUser.pending, (state) => {
        state.meStatus = 'loading';
        state.maintenanceMode = false;
      })
      .addCase(fetchCurrentUser.fulfilled, (state, action) => {
        state.meStatus = 'succeeded';
        state.initialized = true;
        state.user = action.payload?.user || null;
        state.expiresAt = action.payload?.expiresAt || null;
        state.maintenanceMode = false;
      })
      .addCase(fetchCurrentUser.rejected, (state, action) => {
        state.meStatus = 'failed';
        state.initialized = true;
        state.user = null;
        state.maintenanceMode = Boolean(action.payload?.unavailable);
      })
      .addCase(loginUser.pending, (state) => {
        state.loginStatus = 'loading';
        state.loginError = null;
      })
      .addCase(loginUser.fulfilled, (state, action) => {
        state.loginStatus = 'succeeded';
        state.user = action.payload?.user || null;
        state.loginError = null;
        state.maintenanceMode = false;
      })
      .addCase(loginUser.rejected, (state, action) => {
        state.loginStatus = 'failed';
        state.maintenanceMode = Boolean(action.payload?.unavailable);
        state.loginError = action.payload?.unavailable ? null : (action.payload || 'Login failed');
      })
      .addCase(logoutUser.pending, (state) => {
        state.logoutStatus = 'loading';
      })
      .addCase(logoutUser.fulfilled, (state) => {
        state.logoutStatus = 'succeeded';
        state.user = null;
        state.loginStatus = 'idle';
        state.loginError = null;
        state.maintenanceMode = false;
      })
      .addCase(logoutUser.rejected, (state) => {
        state.logoutStatus = 'failed';
        state.user = null;
      })
      .addCase(fetchClientSettings.fulfilled, (state, action) => {
        state.dashboardBannerEnabled = !!action.payload?.dashboardBannerEnabled;
      });
  },
});

export const { setUser, clearAuthState, resetAuthState } = authSlice.actions;
export default authSlice.reducer;
