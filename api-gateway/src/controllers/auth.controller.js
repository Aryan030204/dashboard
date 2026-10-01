const AuthService = require('../services/auth.service');
const logger = require('../utils/logger');
const TokenService = require('../services/token.service');
const GlobalUser = require('../models/GlobalUser.model');
const crypto = require('crypto');
const AdminUserService = require('../services/adminUser.service');
const AdminDomainRuleService = require('../services/adminDomainRule.service');
const ClientSettingsService = require('../services/clientSettings.service');
const {
    recordAuthLogin,
    recordAuthRefresh,
    captureError,
} = require('../observability');
const { isElevatedRole } = require('../services/rbac.service');

const RAW_COOKIE_SAMESITE = (process.env.COOKIE_SAMESITE || 'lax').toString().trim().toLowerCase();
const COOKIE_SAMESITE = (RAW_COOKIE_SAMESITE === 'none' || RAW_COOKIE_SAMESITE === 'lax' || RAW_COOKIE_SAMESITE === 'strict')
    ? RAW_COOKIE_SAMESITE
    : 'lax';

const COOKIE_SECURE = COOKIE_SAMESITE === 'none' ? true : process.env.NODE_ENV === 'production';

//fixed cookie options for refresh token cookie (httpOnly, secure in prod, sameSite based on env var, 7 day expiry)
const COOKIE_OPTIONS = {
    httpOnly: true,
    secure: COOKIE_SECURE,
    sameSite: COOKIE_SAMESITE,
    path: '/', // ensure refresh cookie is sent on /api/auth/* via proxy
    maxAge: 7 * 24 * 60 * 60 * 1000
};

logger.info('AuthController', 'Cookie config initialized', { samesite: COOKIE_SAMESITE, secure: COOKIE_SECURE });

exports.login = async (req, res) => {
    try {
        const { email } = req.body;
        logger.info('AuthController', 'Login request received', { email, ip: req.ip });

        const result = await AuthService.login(req.body.email, req.body.password, req.headers['user-agent']);
        recordAuthLogin('success');

        logger.info('AuthController', 'Login success, setting cookie', {
            origin: req.headers.origin,
            cookieOptions: COOKIE_OPTIONS,
            hasRefreshToken: !!result.refreshToken
        });

        res.cookie('refresh_token', result.refreshToken, COOKIE_OPTIONS);
        logger.info('AuthController', 'Login response sent', { email });
        res.json({
            access_token: result.accessToken,
            user: result.user
        });
    } catch (err) {
        recordAuthLogin(err.message === 'Invalid credentials' ? 'invalid_credentials' : 'error');
        if (err.message !== 'Invalid credentials') {
            captureError(err, req, { type: 'auth_login' });
        }
        logger.error('AuthController', 'Login error', { error: err.message });
        if (err.message === 'Invalid credentials') return res.status(401).json({ error: 'Invalid credentials' });
        if (err.message === 'User suspended') return res.status(403).json({ error: 'User suspended' });
        if (err.message === 'No active brand memberships') return res.status(403).json({ error: 'No active brand memberships' });
        res.status(500).json({ error: 'Internal Server Error' });
    }
};

exports.signup = async (req, res) => {
    try {
        const { email, password, primary_brand_id, role } = req.body || {};
        if (!email || !password || !primary_brand_id) {
            return res.status(400).json({ error: 'email, password, primary_brand_id required' });
        }

        const result = await AuthService.signup({
            email,
            password,
            primaryBrandId: primary_brand_id,
            role
        });

        res.cookie('refresh_token', result.refreshToken, COOKIE_OPTIONS);
        logger.info('AuthController', 'Signup success', { email, brand: primary_brand_id });
        res.status(201).json({
            access_token: result.accessToken,
            user: {
                id: result.user._id,
                email: result.user.email,
                name: result.user.name,
                role: result.user.role,
                primary_brand_id: result.user.primary_brand_id,
                brand_memberships: result.user.brand_memberships,
                status: result.user.status,
            }
        });
    } catch (err) {
        logger.error('AuthController', 'Signup error', { error: err.message });
        if (err.message === 'User already exists') return res.status(409).json({ error: 'User already exists' });
        if (err.message === 'Missing required fields') return res.status(400).json({ error: 'Missing required fields' });
        res.status(500).json({ error: 'Internal Server Error' });
    }
};

exports.refresh = async (req, res) => {
    try {
        logger.info('AuthController', 'Refresh request received', { ip: req.ip });
        const refreshToken = req.cookies.refresh_token;

        if (!refreshToken) {
            logger.warn('AuthController', 'Refresh failed - No refresh_token found', {
                cookies: Object.keys(req.cookies || {}),
                ip: req.ip
            });
            recordAuthRefresh('missing_token');
            return res.status(401).json({ error: 'Refresh token required' });
        }

        const result = await AuthService.refresh(refreshToken);
        recordAuthRefresh('success');

        logger.info('AuthController', 'Refresh success, setting cookie', {
            origin: req.headers.origin,
            cookieOptions: COOKIE_OPTIONS
        });

        res.cookie('refresh_token', result.refreshToken, COOKIE_OPTIONS);
        logger.info('AuthController', 'Refresh success');
        res.json({
            access_token: result.accessToken
        });
    } catch (err) {
        const refreshResult =
            err.message === 'Token reused - Security Alert' || err.message === 'Token reuse detected'
                ? 'token_reuse'
                : err.message === 'Invalid token' || err.message === 'Token expired'
                    ? 'invalid_token'
                    : 'error';
        recordAuthRefresh(refreshResult);
        if (refreshResult === 'token_reuse' || refreshResult === 'error') {
            captureError(err, req, { type: 'auth_refresh', result: refreshResult });
        }
        logger.error('AuthController', 'Refresh error', { error: err.message });
        res.clearCookie('refresh_token', { ...COOKIE_OPTIONS, maxAge: 0 });
        // "Revoked token -> 401", "Expired token -> 401", "User suspended -> 403"
        if (err.message === 'Token reuse detected' || err.message === 'Token reused - Security Alert') return res.status(401).json({ error: 'Token revoked' });
        if (err.message === 'Invalid token' || err.message === 'Token expired') return res.status(401).json({ error: 'Token invalid or expired' });
        if (err.message === 'User suspended' || err.message === 'Membership suspended') return res.status(403).json({ error: 'User access denied' });

        res.status(401).json({ error: 'Unauthorized' }); // Fallback
    }
};

exports.logout = async (req, res) => {
    try {
        logger.info('AuthController', 'Logout request received');
        const refreshToken = req.cookies.refresh_token;
        if (refreshToken) {
            await AuthService.logout(refreshToken);
        }

        logger.info('AuthController', 'Logout clearing cookie', { cookieOptions: { ...COOKIE_OPTIONS, maxAge: 0 } });
        res.clearCookie('refresh_token', { ...COOKIE_OPTIONS, maxAge: 0 });
        logger.info('AuthController', 'Logout success');
        res.status(200).json({ message: 'Logged out' });
    } catch (err) {
        logger.error('AuthController', 'Logout error', { error: err.message });
        res.status(500).json({ error: 'Logout failed' });
    }
};

exports.logoutAllSelf = async (req, res) => {
    try {
        logger.info('AuthController', 'Logout All Self request received');
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ error: 'Access token required' });

        const decoded = require('../services/token.service').verifyAccessToken(token);
        logger.info('AuthController', 'Logout All Self for user', { userId: decoded.sub });
        await AuthService.revokeAllRefreshTokensForUser(decoded.sub);

        res.clearCookie('refresh_token', { ...COOKIE_OPTIONS, maxAge: 0 });
        logger.info('AuthController', 'Logout All Self success');
        res.status(200).json({ message: 'Logged out from all devices' });

    } catch (err) {
        logger.error('AuthController', 'Logout All Self error', { error: err.message });
        res.status(401).json({ error: 'Unauthorized' });
    }
};

exports.me = async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ error: 'Access token required' });

        const payload = TokenService.verifyAccessToken(token);
        const rawUser = await GlobalUser.findById(payload.sub);
        const user = await AuthService.filterUserToActiveTenants(rawUser);
        if (!user) return res.status(401).json({ error: 'Unauthorized' });

        return res.json({
            user: {
                id: user._id,
                email: user.email,
                name: user.name,
                role: user.role,
                primary_brand_id: user.primary_brand_id,
                brand_memberships: user.brand_memberships,
                status: user.status,
                custom_role_id: user.custom_role_id || null,
            },
            expiresAt: payload.exp ? payload.exp * 1000 : null,
        });
    } catch (err) {
        logger.error('AuthController', 'Me error', { error: err.message });
        return res.status(401).json({ error: 'Unauthorized' });
    }
};

function requireAdminOrAuthor(req) {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) throw new Error('unauthorized');
    const payload = TokenService.verifyAccessToken(token);
    if (!payload || !isElevatedRole(payload.role)) {
        throw new Error('forbidden');
    }
    return payload;
}

exports.adminUpsertUser = async (req, res) => {
    try {
        requireAdminOrAuthor(req);
        const { name, email, role, brand_ids, primary_brand_id, status, permissions, custom_role_id, create_only } = req.body || {};
        const user = await AdminUserService.upsertUser({ name, email, role, brand_ids, primary_brand_id, status, permissions, customRoleId: custom_role_id, createOnly: create_only === true });
        return res.status(200).json({
            user: {
                id: user._id,
                email: user.email,
                name: user.name,
                role: user.role,
                status: user.status,
                primary_brand_id: user.primary_brand_id,
                brand_memberships: user.brand_memberships,
                custom_role_id: user.custom_role_id || null,
            }
        });
    } catch (err) {
        if (err.message === 'unauthorized') return res.status(401).json({ error: 'Unauthorized' });
        if (err.message === 'forbidden') return res.status(403).json({ error: 'Forbidden' });
        if (err.message === 'email required' || err.message === 'invalid email format' || err.message === 'invalid role' || err.message === 'brand_user requires exactly one brand' || err.message === 'no brands available for super admin' || err.message === 'invalid custom role') return res.status(400).json({ error: err.message });
        if (err.message === 'duplicate email exists') return res.status(409).json({ error: err.message });
        if (err.name === 'ValidationError') return res.status(400).json({ error: err.message });
        logger.error('AuthController', 'Admin upsert user error', { error: err.message });
        return res.status(500).json({ error: 'Failed to upsert user' });
    }
};

exports.adminDeleteUser = async (req, res) => {
    try {
        requireAdminOrAuthor(req);
        const emailParam = req.params.email || req.body?.email;
        if (!emailParam) return res.status(400).json({ error: 'email required' });
        const deleted = await AdminUserService.deleteUserByEmail(emailParam);
        if (deleted === 0) return res.status(404).json({ error: 'User not found' });
        return res.status(200).json({ message: 'User deleted' });
    } catch (err) {
        if (err.message === 'unauthorized') return res.status(401).json({ error: 'Unauthorized' });
        if (err.message === 'forbidden') return res.status(403).json({ error: 'Forbidden' });
        logger.error('AuthController', 'Admin delete user error', { error: err.message });
        return res.status(500).json({ error: 'Failed to delete user' });
    }
};

exports.adminListUsers = async (req, res) => {
    try {
        requireAdminOrAuthor(req);
        const users = await AdminUserService.listUsers();
        return res.status(200).json({ users });
    } catch (err) {
        if (err.message === 'unauthorized') return res.status(401).json({ error: 'Unauthorized' });
        if (err.message === 'forbidden') return res.status(403).json({ error: 'Forbidden' });
        logger.error('AuthController', 'Admin list users error', { error: err.message });
        return res.status(500).json({ error: 'Failed to list users' });
    }
};

exports.getClientSettings = async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ error: 'Access token required' });
        TokenService.verifyAccessToken(token);

        const settings = await ClientSettingsService.getSettings();
        return res.status(200).json({ settings });
    } catch (err) {
        logger.error('AuthController', 'Get client settings error', { error: err.message });
        return res.status(401).json({ error: 'Unauthorized' });
    }
};

exports.adminUpdateClientSettings = async (req, res) => {
    try {
        requireAdminOrAuthor(req);
        const { dashboard_banner_enabled } = req.body || {};
        const settings = await ClientSettingsService.updateSettings({
            dashboardBannerEnabled: dashboard_banner_enabled,
        });
        return res.status(200).json({ settings });
    } catch (err) {
        if (err.message === 'unauthorized') return res.status(401).json({ error: 'Unauthorized' });
        if (err.message === 'forbidden') return res.status(403).json({ error: 'Forbidden' });
        logger.error('AuthController', 'Admin update client settings error', { error: err.message });
        return res.status(500).json({ error: 'Failed to update client settings' });
    }
};

exports.adminUpsertDomainRule = async (req, res) => {
    try {
        requireAdminOrAuthor(req);
        const rule = await AdminDomainRuleService.upsertRule(req.body || {});
        return res.status(200).json({ rule });
    } catch (err) {
        if (err.message === 'unauthorized') return res.status(401).json({ error: 'Unauthorized' });
        if (err.message === 'forbidden') return res.status(403).json({ error: 'Forbidden' });
        if (err.message === 'invalid domain' || err.message === 'invalid role' || err.message === 'primary_brand_id required' || err.message === 'brand_user requires exactly one brand' || err.message === 'no brands available for super admin') {
            return res.status(400).json({ error: err.message });
        }
        if (err.name === 'ValidationError') return res.status(400).json({ error: err.message });
        logger.error('AuthController', 'Admin upsert domain rule error', { error: err.message });
        return res.status(500).json({ error: 'Failed to upsert domain rule' });
    }
};

exports.adminListDomainRules = async (req, res) => {
    try {
        requireAdminOrAuthor(req);
        const rules = await AdminDomainRuleService.listRules();
        return res.status(200).json({ rules });
    } catch (err) {
        if (err.message === 'unauthorized') return res.status(401).json({ error: 'Unauthorized' });
        if (err.message === 'forbidden') return res.status(403).json({ error: 'Forbidden' });
        logger.error('AuthController', 'Admin list domain rules error', { error: err.message });
        return res.status(500).json({ error: 'Failed to list domain rules' });
    }
};

exports.adminDeleteDomainRule = async (req, res) => {
    try {
        requireAdminOrAuthor(req);
        const domain = req.params.domain;
        if (!domain) return res.status(400).json({ error: 'domain required' });
        const deleted = await AdminDomainRuleService.deleteRule(domain);
        if (!deleted) return res.status(404).json({ error: 'Not found' });
        return res.status(200).json({ deleted: true });
    } catch (err) {
        if (err.message === 'unauthorized') return res.status(401).json({ error: 'Unauthorized' });
        if (err.message === 'forbidden') return res.status(403).json({ error: 'Forbidden' });
        logger.error('AuthController', 'Admin delete domain rule error', { error: err.message });
        return res.status(500).json({ error: 'Failed to delete domain rule' });
    }
};

// ---------- Google OAuth ----------
function buildState(params = {}) {
    const json = JSON.stringify(params);
    return Buffer.from(json).toString('base64url');
}

function parseState(state) {
    try {
        const json = Buffer.from(state, 'base64url').toString('utf8');
        return JSON.parse(json);
    } catch {
        return {};
    }
}

exports.googleStart = async (req, res) => {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const redirectUri = process.env.GOOGLE_REDIRECT_URI;
    if (!clientId || !redirectUri) {
        return res.status(500).json({ error: 'Google OAuth not configured' });
    }
    const brand_id = req.query.brand_id || req.query.brand || undefined;
    const redirect = req.query.redirect || req.query.next || undefined;
    const state = buildState({ brand_id, redirect });
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'openid email profile');
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');
    url.searchParams.set('state', state);
    return res.redirect(url.toString());
};

exports.googleCallback = async (req, res) => {
    try {
        const code = req.query.code;
        const stateRaw = req.query.state;
        const { brand_id, redirect } = parseState(stateRaw || '');

        if (!code) return res.status(400).json({ error: 'Missing code' });
        const clientId = process.env.GOOGLE_CLIENT_ID;
        const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
        const redirectUri = process.env.GOOGLE_REDIRECT_URI;
        if (!clientId || !clientSecret || !redirectUri) {
            return res.status(500).json({ error: 'Google OAuth not configured' });
        }

        // Exchange code for tokens
        const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                code,
                client_id: clientId,
                client_secret: clientSecret,
                redirect_uri: redirectUri,
                grant_type: 'authorization_code'
            })
        });
        if (!tokenRes.ok) {
            const text = await tokenRes.text();
            logger.error('AuthController', 'Google token exchange failed', { status: tokenRes.status, text });
            return res.status(401).json({ error: 'Google auth failed' });
        }
        const tokenJson = await tokenRes.json();
        const idToken = tokenJson.id_token;
        if (!idToken) return res.status(401).json({ error: 'Google auth failed' });

        // Validate id_token using tokeninfo (Google verifies signature/audience)
        const infoRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
        if (!infoRes.ok) {
            const text = await infoRes.text();
            logger.error('AuthController', 'Google tokeninfo failed', { status: infoRes.status, text });
            return res.status(401).json({ error: 'Google auth failed' });
        }
        const info = await infoRes.json();
        if (info.aud !== clientId) {
            logger.error('AuthController', 'Google aud mismatch', { aud: info.aud });
            return res.status(401).json({ error: 'Google auth failed' });
        }
        if (info.email_verified !== 'true' && info.email_verified !== true) {
            return res.status(403).json({ error: 'Email not verified' });
        }

        const profile = {
            email: info.email,
            name: info.name,
            sub: info.sub,
            brandId: brand_id
        };
        console.log('Google profile:', profile);

        let result;
        try {
            result = await AuthService.loginWithGoogle(profile);
        } catch (err) {
            if (err.message === 'User not allowed') {
                // Attempt domain-rule-based provision on the fly
                const provisionedUser = await AuthService.provisionUserByDomainRule(profile.email);
                console.log('Provisioned user via domain rule:', provisionedUser);
                if (!provisionedUser) return res.status(403).json({ error: 'User not allowed' });
                const tokens = await AuthService.issueTokensForUser(provisionedUser, 'google-oauth');
                console.log('Issued tokens for provisioned user');
                result = { ...tokens, user: provisionedUser };
            } else {
                console.error('AuthController', 'Google login error', { error: err.message, stack: err.stack });
                throw err;
            }
        }

        logger.info('AuthController', 'Google login success, setting cookie', {
            origin: req.headers.origin,
            cookieOptions: COOKIE_OPTIONS,
            hasRefreshToken: !!result.refreshToken
        });

        res.cookie('refresh_token', result.refreshToken, COOKIE_OPTIONS);
        const payload = {
            access_token: result.accessToken,
            user: {
                id: result.user._id,
                email: result.user.email,
                name: result.user.name,
                role: result.user.role,
                primary_brand_id: result.user.primary_brand_id,
                brand_memberships: result.user.brand_memberships,
                status: result.user.status,
            }
        };

        if (redirect) {
            const redirectUrl = new URL(redirect);
            redirectUrl.searchParams.set('access_token', payload.access_token);
            redirectUrl.searchParams.set('email', payload.user.email);
            return res.redirect(redirectUrl.toString());
        }

        return res.json(payload);
    } catch (err) {
        logger.error('AuthController', 'Google callback error', { error: err.message, stack: err.stack });
        return res.status(500).json({ error: 'Google auth failed' });
    }
};
