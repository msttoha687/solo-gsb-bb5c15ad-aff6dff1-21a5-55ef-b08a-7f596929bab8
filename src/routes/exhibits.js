'use strict';

const express = require('express');
const { query, withTransaction, withExhibitTransaction } = require('../db');
const { requireRole } = require('../auth');
const { recordAudit } = require('../audit');
const { ValidationError, ConflictError, nonEmptyString, positiveNumber } = require('../validation');
const {
  computeOccupancy,
  lockExhibit,
  decoratePlans,
  buildLimitPreview,
  occupancyFingerprint,
} = require('../service');
const limitTokens = require('../limitPreview');
const { tsToWallString } = require('../dosing');

const router = express.Router();

function serializeMeasurement(m) {
  return {
    id: m.id,
    planId: m.plan_id,
    exhibitId: m.exhibit_id,
    start: tsToWallString(new Date(m.start_ts).getTime()),
    end: tsToWallString(new Date(m.end_ts).getTime()),
    actualLux: Number(m.actual_lux),
    status: m.status,
    note: m.note,
    createdAt: m.created_at,
  };
}

async function exhibitDetail(client, exhibitId, { lock = false } = {}) {
  const exhibit = lock ? await lockExhibit(client, exhibitId)
    : (await client.query('SELECT * FROM exhibits WHERE id = $1', [exhibitId])).rows[0];
  if (!exhibit) throw new ValidationError('展品不存在');

  const occupancy = await computeOccupancy(client, exhibitId);
  const plans = (
    await client.query(
      `SELECT p.*, u.display_name AS creator_name, a.display_name AS approver_name
         FROM plans p
         LEFT JOIN users u ON u.id = p.created_by
         LEFT JOIN users a ON a.id = p.approved_by
        WHERE p.exhibit_id = $1 ORDER BY p.id DESC`,
      [exhibitId]
    )
  ).rows;
  // 附加各计划的待审调整申请（含原值/拟改值试算），原有字段保持不变
  await decoratePlans(client, plans, { withPreview: true });
  const measurements = (
    await client.query(
      `SELECT * FROM measurements WHERE exhibit_id = $1 ORDER BY start_ts DESC, id DESC`,
      [exhibitId]
    )
  ).rows.map(serializeMeasurement);

  return {
    exhibit,
    years: occupancy.years,
    sources: occupancy.sources,
    plans,
    measurements,
  };
}

// 展品列表（带每展品年度额度概况）
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM exhibits ORDER BY id');
    const items = [];
    for (const e of rows) {
      const occupancy = await computeOccupancy({ query }, e.id);
      items.push({ ...e, years: occupancy.years });
    }
    res.json({ exhibits: items });
  } catch (err) {
    next(err);
  }
});

// 展品详情：剩余额度、占用来源、计划、实测
router.get('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const detail = await exhibitDetail({ query }, id);
    res.json(detail);
  } catch (err) {
    next(err);
  }
});

// 保管员登记展品
router.post('/', requireRole('conservator'), async (req, res, next) => {
  try {
    const name = nonEmptyString(req.body.name, '展品名称', 200);
    const accessionNo = req.body.accessionNo ? nonEmptyString(req.body.accessionNo, '编号', 100) : null;
    const medium = req.body.medium ? nonEmptyString(req.body.medium, '材质', 200) : null;
    const note = typeof req.body.note === 'string' ? req.body.note.slice(0, 1000) : null;

    const { rows } = await withTransaction(async (client) => {
      const inserted = await client.query(
        `INSERT INTO exhibits (name, accession_no, medium, note, created_by)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [name, accessionNo, medium, note, req.sessionUser.userId]
      );
      await recordAudit(client, req.sessionUser, 'exhibit.create', 'exhibit', inserted.rows[0].id, { name });
      return inserted;
    });
    res.status(201).json({ exhibit: rows[0] });
  } catch (err) {
    next(err);
  }
});

/** 解析并校验上限请求体 { year, limitLxh }，返回 { year, limitLxh }。 */
function parseLimitBody(body) {
  const year = Number((body || {}).year);
  if (!Number.isInteger(year) || year < 1900 || year > 2999) {
    throw new ValidationError('年份必须是 1900-2999 之间的整数');
  }
  const limitLxh = positiveNumber((body || {}).limitLxh, '年度照度时数上限（lx·h）');
  return { year, limitLxh };
}

async function freshPreviewResponse(client, exhibitId, year, limitLxh) {
  const preview = await buildLimitPreview(client, exhibitId, year, limitLxh);
  const fingerprint = await occupancyFingerprint(client, exhibitId);
  const rec = limitTokens.createToken({
    request: { exhibitId, year, limitLxh: preview.proposedLimit },
    fingerprint,
  });
  return {
    previewToken: rec.token,
    expiresAt: new Date(rec.expiresAt).toISOString(),
    preview,
  };
}

// 保管员预演下调某展品某自然年的照度时数上限（只读，不改状态，返回凭证）
router.post('/:id/limits/preview', requireRole('conservator'), async (req, res, next) => {
  try {
    const exhibitId = Number(req.params.id);
    const { year, limitLxh } = parseLimitBody(req.body);
    const result = await withExhibitTransaction(exhibitId, async (client) => {
      await lockExhibit(client, exhibitId);
      const preview = await buildLimitPreview(client, exhibitId, year, limitLxh);
      const fingerprint = await occupancyFingerprint(client, exhibitId);
      const rec = limitTokens.createToken({
        request: { exhibitId, year, limitLxh: preview.proposedLimit },
        fingerprint,
      });
      return {
        previewToken: rec.token,
        expiresAt: new Date(rec.expiresAt).toISOString(),
        preview,
      };
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// 保管员登记/修改某展品某自然年的照度时数上限
// 携带 previewToken：校验凭证未过期、请求字段一致、占用状态指纹未变化，否则 409 并返回新预演。
// 不携带凭证（沿用旧请求字段直接修改）：在同一展品锁事务内即时重算，行为不变。
router.post('/:id/limits', requireRole('conservator'), async (req, res, next) => {
  try {
    const exhibitId = Number(req.params.id);
    const { year, limitLxh } = parseLimitBody(req.body);
    const previewToken =
      req.body && typeof req.body.previewToken === 'string' && req.body.previewToken
        ? req.body.previewToken
        : null;

    const outcome = await withExhibitTransaction(exhibitId, async (client) => {
      await lockExhibit(client, exhibitId);

      // 1) 凭证校验（携凭证提交）
      let tokenRecord = null;
      if (previewToken) {
        tokenRecord = limitTokens.takeToken(previewToken);
        if (!tokenRecord) {
          const fresh = await freshPreviewResponse(client, exhibitId, year, limitLxh);
          throw new ConflictError(
            '预演凭证不存在或已过期，请按最新预演结果重新提交',
            { reason: 'token_invalid', ...fresh }
          );
        }
        const req2 = tokenRecord.payload.request || {};
        if (
          Number(req2.exhibitId) !== exhibitId ||
          Number(req2.year) !== year ||
          Number(req2.limitLxh) !== Number(limitLxh)
        ) {
          // 字段不一致：不作废业务数据，凭证已一次性取走；返回按当前字段核算的新结果
          const fresh = await freshPreviewResponse(client, exhibitId, year, limitLxh);
          throw new ConflictError(
            '提交字段与预演不一致（展品/年份/拟定上限已变化），请按最新预演结果重新提交',
            { reason: 'request_mismatch', ...fresh }
          );
        }
      }

      // 2) 同一事务内即时重算（无论是否携凭证，都以当前库中状态为准）
      const before = await buildLimitPreview(client, exhibitId, year, limitLxh);

      // 3) 携凭证：比对占用状态指纹，额度或相关占用已变化则拒绝并返回新结果
      if (tokenRecord) {
        const fingerprintNow = await occupancyFingerprint(client, exhibitId);
        if (
          JSON.stringify(fingerprintNow) !== JSON.stringify(tokenRecord.payload.fingerprint)
        ) {
          const fresh = await freshPreviewResponse(client, exhibitId, year, limitLxh);
          throw new ConflictError(
            `预演后 ${year} 年额度或相关占用已变化，提交被拒绝，请按最新预演结果重新确认`,
            { reason: 'stale', ...fresh }
          );
        }
      }

      // 4) 原子更新上限（保留原审批与实测记录；INSERT/UPDATE 幂等）
      await client.query(
        `INSERT INTO annual_limits (exhibit_id, year, limit_lxh, created_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (exhibit_id, year) DO UPDATE SET limit_lxh = EXCLUDED.limit_lxh`,
        [exhibitId, year, limitLxh, req.sessionUser.userId]
      );
      await recordAudit(client, req.sessionUser, 'limit.upsert', 'exhibit', exhibitId, {
        year,
        limitLxh,
        previousLimit: before.currentLimit,
      });

      // 5) 下调且仍超额：把本次核算列出的“已批准、尚未开始、该年仍有估算残余”的计划转待复核。
      //    已开始计划不转状态；待复核计划不重复转。原审批/实测保留，不删除占用、不取消计划。
      const flaggedPlans = [];
      if (before.isLowering && before.projectedExcess > 0) {
        for (const cand of before.flagCandidates) {
          const upd = await client.query(
            `UPDATE plans
                SET status = 'pending_review',
                    review_reason = $2,
                    updated_at = now()
              WHERE id = $1 AND status = 'approved'`,
            [
              cand.id,
              `${year} 年照度时数上限由 ${before.currentLimit} 下调至 ${before.proposedLimit}，` +
                `核算预计超额 ${before.projectedExcess} lx·h，转待复核`,
            ]
          );
          if ((upd.rowCount || 0) > 0) {
            flaggedPlans.push({
              id: cand.id,
              title: cand.title,
              firstStart: cand.firstStart,
              overflowYears: [year],
            });
            await recordAudit(client, req.sessionUser, 'plan.flag_review', 'plan', cand.id, {
              trigger: 'limit_lower',
              exhibitId,
              year,
              previousLimit: before.currentLimit,
              newLimit: before.proposedLimit,
              projectedExcess: before.projectedExcess,
            });
          }
        }
        await recordAudit(client, req.sessionUser, 'limit.lower', 'exhibit', exhibitId, {
          year,
          previousLimit: before.currentLimit,
          newLimit: before.proposedLimit,
          projectedExcess: before.projectedExcess,
          flaggedPlanIds: flaggedPlans.map((p) => p.id),
        });
      }

      const detail = await exhibitDetail(client, exhibitId, { lock: true });
      return {
        detail,
        limitChange: {
          year,
          previousLimit: before.currentLimit,
          newLimit: before.proposedLimit,
          isLowering: before.isLowering,
          isUpdate: before.currentLimit !== null,
          used: before.used,
          projectedExcess: before.projectedExcess,
          flagCandidates: before.flagCandidates,
          startedStillOver: before.startedStillOver,
          flaggedPlans,
        },
      };
    });

    // 成功响应保持兼容：仍为展品详情结构，额外附加 limitChange
    res.json({ ...outcome.detail, limitChange: outcome.limitChange });
  } catch (err) {
    next(err);
  }
});

module.exports = { router, exhibitDetail, serializeMeasurement };
