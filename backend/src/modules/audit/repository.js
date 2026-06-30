const pool = require('../../config/db');

async function getAuditLogs(limit, offset, filters = {}) {
  const { userId, resourceType } = filters;
  const conditions = [];
  const params = [];

  if (userId) {
    params.push(userId);
    conditions.push(`al.user_id = $${params.length}`);
  }

  if (resourceType) {
    params.push(resourceType);
    conditions.push(`al.resource_type = $${params.length}`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // Get total count matching the filters
  const totalResult = await pool.query(
    `SELECT COUNT(*) FROM audit_logs al ${whereClause}`,
    params
  );

  // Add limit and offset params for the records query
  params.push(limit);
  const limitIndex = params.length;
  params.push(offset);
  const offsetIndex = params.length;

  const logs = await pool.query(
    `
    SELECT al.*, u.full_name AS actor_name, u.email AS actor_email
    FROM audit_logs al
    LEFT JOIN users u ON al.user_id = u.id
    ${whereClause}
    ORDER BY al.created_at DESC
    LIMIT $${limitIndex} OFFSET $${offsetIndex}
    `,
    params
  );

  return {
    records: logs.rows,
    total: Number(totalResult.rows[0].count),
  };
}

async function logEvent(data) {
  const {
    userId,
    action,
    resourceType,
    resourceId,
    details,
    oldValue,
    newValue,
    ipAddress,
    userAgent,
  } = data || {};
  await pool.query(
    `INSERT INTO audit_logs (user_id, action, resource_type, resource_id, details, old_value, new_value, ip_address, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      userId || null,
      action,
      resourceType || null,
      resourceId || null,
      details ? JSON.stringify(details) : null,
      oldValue ? JSON.stringify(oldValue) : null,
      newValue ? JSON.stringify(newValue) : null,
      ipAddress || null,
      userAgent || null,
    ]
  );
}

async function performAdminCleanup() {
  const notifications = require('../notifications/repository'); // Lazy load
  if (notifications && typeof notifications.notifyAdmin === 'function') {
    await notifications.notifyAdmin(
      'Administrative audit cleanup has been completed.'
    );
  }
}

module.exports = {
  getAuditLogs,
  logEvent,
  performAdminCleanup,
};
