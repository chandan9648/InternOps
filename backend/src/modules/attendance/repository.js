const pool = require('../../config/db');

async function markAttendance(
  userId,
  markedBy,
  date,
  status,
  remarks,
  client = pool
) {
  const res = await client.query(
    `INSERT INTO attendance (user_id, marked_by, date, status, remarks)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (user_id, date)
     DO UPDATE SET status=$4, marked_by=$2, remarks=$5, updated_at=NOW()
     RETURNING *`,
    [userId, markedBy, date, status, remarks || null]
  );

  return res.rows[0];
}

async function getAttendance(userId, { from, to, page = 1, limit = 30 } = {}) {
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 30, 1), 100);
  const safePage = Math.max(parseInt(page, 10) || 1, 1);
  const offset = (safePage - 1) * safeLimit;

  const where = ['user_id=$1', 'a.deleted_at IS NULL'];
  const params = [userId];

  if (from) {
    params.push(from);
    where.push(`date >= $${params.length}`);
  }

  if (to) {
    params.push(to);
    where.push(`date <= $${params.length}`);
  }

  const whereClause = where.join(' AND ');

  const countRes = await pool.query(
    `SELECT COUNT(*)::int AS total FROM attendance a WHERE ${whereClause}`,
    params
  );

  const total = countRes.rows[0].total;

  params.push(safeLimit, offset);

  const res = await pool.query(
    `SELECT a.*, m.full_name AS marked_by_name
     FROM attendance a
     LEFT JOIN users m ON m.id = a.marked_by
     WHERE ${whereClause}
     ORDER BY a.date DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  return { records: res.rows, total, page: safePage, limit: safeLimit };
}

async function getMonthlyStats(userId, month, year) {
  // SARGable date-range form: avoid EXTRACT() on a date column, which would
  // force a sequential scan. With the date range we can use a btree index.
  const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  const endDate = `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`;

  const res = await pool.query(
    `SELECT status, COUNT(*) as count
     FROM attendance
     WHERE user_id = $1
       AND date >= $2
       AND date <  $3
       AND deleted_at IS NULL
     GROUP BY status`,
    [userId, startDate, endDate]
  );

  return res.rows;
}

async function bulkMark(entries, markedBy, client = pool) {
  const out = [];

  for (const e of entries) {
    const r = await client.query(
      `INSERT INTO attendance (user_id, marked_by, date, status, remarks)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (user_id, date)
       DO UPDATE SET status=$4, marked_by=$2, remarks=$5, updated_at=NOW()
       RETURNING *`,
      [e.user_id, markedBy, e.date, e.status, e.remarks || null]
    );

    out.push(r.rows[0]);
  }

  return out;
}

// Returns the set of target ids that fall inside managerId's transitive
// subordinate chain. Replaces per-entry checkHierarchyAccess calls
// (a 1+N query pattern) with a single recursive CTE.
async function listHierarchySubordinates(managerId, targetIds) {
  if (!Array.isArray(targetIds) || targetIds.length === 0) {
    return new Set();
  }

  const res = await pool.query(
    `WITH RECURSIVE chain AS (
       SELECT id, manager_id, 0 AS depth FROM users WHERE id = $1 AND deleted_at IS NULL
       UNION ALL
       SELECT u.id, u.manager_id, chain.depth + 1
       FROM users u
       INNER JOIN chain ON u.manager_id = chain.id
       WHERE u.deleted_at IS NULL AND chain.depth < 100
     )
     SELECT id FROM chain WHERE id = ANY($2::uuid[])`,
    [managerId, targetIds]
  );

  return new Set(res.rows.map((r) => r.id));
}

// Add this to your repository.js
async function getAuthorizedSubordinates(managerId) {
  const res = await pool.query(
    `WITH RECURSIVE subordinates AS (
       SELECT id, full_name, email, role, 0 AS depth FROM users WHERE manager_id = $1 AND deleted_at IS NULL
       UNION ALL
       SELECT u.id, u.full_name, u.email, u.role, s.depth + 1
       FROM users u
       INNER JOIN subordinates s ON u.manager_id = s.id
       WHERE u.deleted_at IS NULL AND s.depth < 100
     )
     SELECT id, full_name, email, role FROM subordinates`,
    [managerId]
  );
  return res.rows;
}

// Fetch a single attendance record by its PK only if the requester is the
// owner or an authorised manager in the transitive hierarchy chain.
async function getAttendanceById(attendanceId, requesterId) {
  const res = await pool.query(
    `SELECT a.*, u.manager_id AS owner_manager_id
     FROM attendance a
     JOIN users u ON u.id = a.user_id
     WHERE a.id = $1 AND a.deleted_at IS NULL`,
    [attendanceId]
  );

  if (res.rowCount === 0) return null;

  const record = res.rows[0];

  // Self-ownership: requester owns this record.
  if (record.user_id === requesterId) return record;

  // Manager hierarchy: check if requester is an ancestor of record owner.
  const { checkHierarchyAccess } = require('../../utils/hierarchy');
  const authorised = await checkHierarchyAccess(requesterId, record.user_id);
  if (!authorised) return undefined; // signals 403 to caller

  return record;
}

// Update a single attendance record by PK, scoping the WHERE clause to
// records whose user_id the requester is authorised to manage.
// Returns the updated row or null if not found / not authorised.
async function updateAttendanceById(
  attendanceId,
  requesterId,
  { status, remarks },
  client = pool
) {
  // First verify the record exists and the requester is authorised.
  const record = await getAttendanceById(attendanceId, requesterId);
  if (record === null) return null;  // not found
  if (record === undefined) return undefined; // not authorised → 403

  const res = await client.query(
    `UPDATE attendance
     SET status=$1, remarks=$2, updated_at=NOW()
     WHERE id=$3 AND deleted_at IS NULL
     RETURNING *`,
    [status, remarks ?? null, attendanceId]
  );

  return res.rows[0] ?? null;
}

module.exports = {
  markAttendance,
  getAttendance,
  getMonthlyStats,
  bulkMark,
  listHierarchySubordinates,
  getAuthorizedSubordinates,
  getAttendanceById,
  updateAttendanceById,
};
