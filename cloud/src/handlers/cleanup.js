import * as logger from "../utils/logger.js";

// How many days of machine history we keep before pruning
const HISTORY_WINDOW_DAYS = 7;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const DELETE_STALE_MACHINES_SQL = "DELETE FROM machines WHERE updatedAt < ?";

function computeCutoffIso() {
  const cutoffMs = Date.now() - HISTORY_WINDOW_DAYS * MS_PER_DAY;
  return new Date(cutoffMs).toISOString();
}

// Scheduled (cron) entrypoint that prunes stale rows from the machines table in D1.
export async function handleCleanup(env) {
  const cutoffDate = computeCutoffIso();

  logger.info("CLEANUP", `Deleting records older than ${cutoffDate}`);

  try {
    const result = await env.DB
      .prepare(DELETE_STALE_MACHINES_SQL)
      .bind(cutoffDate)
      .run();

    const deletedCount = result.meta?.changes || 0;
    logger.info("CLEANUP", `Deleted ${deletedCount} old records`);

    return { success: true, deleted: deletedCount, cutoffDate };
  } catch (err) {
    logger.error("CLEANUP", err.message);
    return { success: false, error: err.message };
  }
}
