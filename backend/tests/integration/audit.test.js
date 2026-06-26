const app = require('../../src/app');
const pool = require('../../src/config/db');
const { v4: uuidv4 } = require('uuid');
const argon2 = require('argon2');
const {
  SEEDED_ADMIN_EMAIL,
  SEEDED_ADMIN_PASSWORD,
  resetSeededAdminPassword,
  parseSetCookie,
  mergeCookies,
} = require('./helpers');

describe('Audit Integration Tests', () => {
  let adminToken;
  let adminCsrfToken;
  let adminCookies = {};

  let internToken;
  let internCsrfToken;
  let internCookies = {};

  const internId = uuidv4();
  const internEmail = `intern-${internId}@example.com`;
  const internPassword = 'InternPassword123!';

  let adminUserId;

  beforeAll(async () => {
    await app.ready();
    await resetSeededAdminPassword();

    // Find admin user ID
    const adminUserRes = await pool.query(
      'SELECT id FROM users WHERE email = $1',
      [SEEDED_ADMIN_EMAIL]
    );
    adminUserId = adminUserRes.rows[0].id;

    // Create Intern User in database
    const internHash = await argon2.hash(internPassword);
    await pool.query(
      `INSERT INTO users (id, email, password_hash, role, full_name)
       VALUES ($1, $2, $3, 'INTERN', 'Test Intern')`,
      [internId, internEmail, internHash]
    );

    // Insert mock audit logs
    // 1. Admin login action
    await pool.query(
      `INSERT INTO audit_logs (id, user_id, action, resource_type, resource_id, ip_address, user_agent, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        uuidv4(),
        adminUserId,
        'LOGIN',
        'auth',
        adminUserId,
        '192.168.1.1',
        'Mozilla/5.0',
        JSON.stringify({ admin: true }),
      ]
    );

    // 2. Intern login action
    await pool.query(
      `INSERT INTO audit_logs (id, user_id, action, resource_type, resource_id, ip_address, user_agent, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        uuidv4(),
        internId,
        'LOGIN',
        'auth',
        internId,
        '10.0.0.1',
        'Chrome/100',
        JSON.stringify({ intern: true }),
      ]
    );

    // 3. System action (null user_id)
    await pool.query(
      `INSERT INTO audit_logs (id, user_id, action, resource_type, resource_id, ip_address, user_agent, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        uuidv4(),
        null,
        'SYSTEM_UPDATE',
        'system',
        null,
        '127.0.0.1',
        'InternOpsCron',
        JSON.stringify({ task: 'cleanup' }),
      ]
    );

    // Login Admin
    const adminCsrfRes = await app.inject({
      method: 'GET',
      url: '/api/auth/csrf-token',
    });
    adminCsrfToken = JSON.parse(adminCsrfRes.body).csrfToken;
    mergeCookies(
      adminCookies,
      parseSetCookie(adminCsrfRes.headers['set-cookie'])
    );
    mergeCookies(adminCookies, adminCsrfRes.cookies);

    const adminLoginRes = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      cookies: adminCookies,
      headers: {
        'X-CSRF-Token': adminCsrfToken,
        'Content-Type': 'application/json',
      },
      payload: {
        email: SEEDED_ADMIN_EMAIL,
        password: SEEDED_ADMIN_PASSWORD,
      },
    });
    adminToken = JSON.parse(adminLoginRes.body).accessToken;
    mergeCookies(
      adminCookies,
      parseSetCookie(adminLoginRes.headers['set-cookie'])
    );

    // Login Intern
    const internCsrfRes = await app.inject({
      method: 'GET',
      url: '/api/auth/csrf-token',
    });
    internCsrfToken = JSON.parse(internCsrfRes.body).csrfToken;
    mergeCookies(
      internCookies,
      parseSetCookie(internCsrfRes.headers['set-cookie'])
    );
    mergeCookies(internCookies, internCsrfRes.cookies);

    const internLoginRes = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      cookies: internCookies,
      headers: {
        'X-CSRF-Token': internCsrfToken,
        'Content-Type': 'application/json',
      },
      payload: {
        email: internEmail,
        password: internPassword,
      },
    });
    internToken = JSON.parse(internLoginRes.body).accessToken;
    mergeCookies(
      internCookies,
      parseSetCookie(internLoginRes.headers['set-cookie'])
    );
  });

  afterAll(async () => {
    await pool.query(
      'DELETE FROM audit_logs WHERE user_id = $1 OR user_id = $2 OR (user_id IS NULL AND action = $3)',
      [adminUserId, internId, 'SYSTEM_UPDATE']
    );
    await pool.query('DELETE FROM users WHERE id = $1', [internId]);
    await app.close();
  });

  // ─── Authentication ────────────────────────────────────────────────────────

  describe('GET /api/audit authentication', () => {
    it('should reject unauthenticated request', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/audit',
      });
      expect(res.statusCode).toBe(401);
    });
  });

  // ─── Admin ─────────────────────────────────────────────────────────────────

  describe('GET /api/audit as Admin', () => {
    it('should return all audit logs with pagination metadata', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/audit',
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data).toBeDefined();
      expect(body.total).toBeGreaterThanOrEqual(3);
      expect(body.page).toBe(1);
      expect(body.limit).toBe(50);
    });

    it('should not strip ip_address or user_agent for admin', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/audit',
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      const internLog = body.data.find((log) => log.user_id === internId);
      expect(internLog).toBeDefined();
      expect(internLog.ip_address).toBe('10.0.0.1');
      expect(internLog.user_agent).toBe('Chrome/100');
    });

    it('should support pagination parameters', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/audit?limit=2&page=1',
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.length).toBe(2);
      expect(body.limit).toBe(2);
      expect(body.page).toBe(1);
    });

    // FIX: Zod uses .max(100) which REJECTS values over 100 — expects 400, not 200.
    // If you want silent clamping instead, change the schema to .transform(v => Math.min(v, 100))
    // and flip this test to expect 200 with body.limit === 100.
    it('should reject limit over 100', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/audit?limit=200',
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(400);
    });

    it('should accept limit of exactly 100', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/audit?limit=100',
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.limit).toBe(100);
    });

    it('should reject non-numeric limit', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/audit?limit=abc',
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(400);
    });

    it('should reject page less than 1', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/audit?page=0',
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(400);
    });

    it('should filter by userId', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/audit?userId=${internId}`,
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.every((log) => log.user_id === internId)).toBe(true);
      expect(body.total).toBe(1);
    });

    it('should reject invalid UUID for userId', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/audit?userId=not-a-uuid',
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(400);
    });

    it('should filter by resourceType', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/audit?resourceType=system',
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.every((log) => log.resource_type === 'system')).toBe(
        true
      );
    });

    it('should return empty data array (not error) when no logs match filters', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/audit?resourceType=nonexistent_type',
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data).toEqual([]);
      expect(body.total).toBe(0);
    });

    it('should combine userId and resourceType filters', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/audit?userId=${internId}&resourceType=auth`,
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(
        body.data.every(
          (log) => log.user_id === internId && log.resource_type === 'auth'
        )
      ).toBe(true);
      expect(body.total).toBe(1);
    });
  });

  // ─── Non-Admin (Intern) ────────────────────────────────────────────────────

  describe('GET /api/audit as Non-Admin (Intern)', () => {
    it("should only return the intern's own audit logs", async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/audit',
        headers: { Authorization: `Bearer ${internToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.every((log) => log.user_id === internId)).toBe(true);
      expect(body.total).toBe(1);
    });

    // FIX: renamed from "coerce/overwrite" — the code ignores the param entirely for non-admins,
    // it does not coerce it. The behaviour is correct; the name was misleading.
    it('should ignore userId param for non-admins and always return only own logs', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/audit?userId=${adminUserId}`,
        headers: { Authorization: `Bearer ${internToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      // Must contain only intern's own logs, never admin's
      expect(body.data.every((log) => log.user_id === internId)).toBe(true);
      expect(body.data.some((log) => log.user_id === adminUserId)).toBe(false);
      expect(body.total).toBe(1);
    });

    // FIX: removed the confused dead-branch comment. The original test was actually
    // checking that own logs are NOT stripped — which is correct and worth keeping,
    // just with a clear name.
    it("should not strip ip_address or user_agent from intern's own logs", async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/audit',
        headers: { Authorization: `Bearer ${internToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      const ownLog = body.data.find((log) => log.user_id === internId);
      expect(ownLog).toBeDefined();
      expect(ownLog.ip_address).toBe('10.0.0.1');
      expect(ownLog.user_agent).toBe('Chrome/100');
    });

    // NEW: intern can filter their own logs by resourceType
    it('should allow intern to filter their own logs by resourceType', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/audit?resourceType=auth',
        headers: { Authorization: `Bearer ${internToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.every((log) => log.user_id === internId)).toBe(true);
      expect(body.data.every((log) => log.resource_type === 'auth')).toBe(true);
      expect(body.total).toBe(1);
    });

    // NEW: intern filtering by a resourceType they have no logs for returns empty, not admin's logs
    it('should return empty results when intern filters by resourceType with no matching own logs', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/audit?resourceType=system',
        headers: { Authorization: `Bearer ${internToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      // System log has user_id = null, so intern must not see it
      expect(body.data).toEqual([]);
      expect(body.total).toBe(0);
    });

    // NEW: pagination still works for non-admins
    it('should support pagination for non-admin users', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/audit?limit=10&page=1',
        headers: { Authorization: `Bearer ${internToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.page).toBe(1);
      expect(body.limit).toBe(10);
      expect(body.data.every((log) => log.user_id === internId)).toBe(true);
    });
  });
});
