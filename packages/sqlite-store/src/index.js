import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

export async function createSqliteSnapshotStore({
  databasePath,
  serviceName,
  tableName = "service_state_snapshots"
} = {}) {
  if (!databasePath) {
    throw new Error("sqlite_store_database_path_required");
  }
  if (!serviceName) {
    throw new Error("sqlite_store_service_name_required");
  }

  const resolvedPath = path.resolve(databasePath);
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  const db = new Database(resolvedPath);

  function migrate() {
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT,
        applied_at TEXT
      );

      CREATE TABLE IF NOT EXISTS ${tableName} (
        service_name TEXT,
        state_json TEXT,
        updated_at TEXT
      );
    `);
  }

  function loadSnapshot() {
    const row = db
      .prepare(`SELECT state_json FROM ${tableName} WHERE service_name = ? ORDER BY rowid DESC LIMIT 1`)
      .get(serviceName);
    return row?.state_json ? JSON.parse(row.state_json) : null;
  }

  function saveSnapshot(snapshot) {
    const transaction = db.transaction((payload) => {
      db.prepare(`DELETE FROM ${tableName} WHERE service_name = ?`).run(serviceName);
      db.prepare(`INSERT INTO ${tableName} (service_name, state_json, updated_at) VALUES (?, ?, ?)`).run(
        serviceName,
        JSON.stringify(payload),
        new Date().toISOString()
      );
    });
    transaction(snapshot);
  }

  function close() {
    db.close();
  }

  return {
    migrate,
    loadSnapshot,
    saveSnapshot,
    close,
    db,
    databasePath: resolvedPath
  };
}
