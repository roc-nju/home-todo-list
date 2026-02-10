const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { applyMigrations } = require("../store/migrations");

const resolveSqliteFile = () => {
  if (process.env.SQLITE_FILE) {
    return path.resolve(process.env.SQLITE_FILE);
  }
  return path.join(__dirname, "..", "data.sqlite");
};

const ensureDir = (filePath) => {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
};

const sqliteFile = resolveSqliteFile();
ensureDir(sqliteFile);
const db = new Database(sqliteFile);
db.pragma("journal_mode = WAL");
db.prepare("CREATE TABLE IF NOT EXISTS members (id TEXT PRIMARY KEY, name TEXT, reminder_prefs TEXT)").run();
db.prepare("CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, content TEXT, due_at TEXT, require_confirm INTEGER, state TEXT, created_by TEXT, created_at TEXT, updated_at TEXT, archived_at TEXT, deleted_at TEXT, repeat_rule TEXT, series_id TEXT, occurrence INTEGER, reminders TEXT)").run();
db.prepare("CREATE TABLE IF NOT EXISTS task_owners (task_id TEXT, member_id TEXT, PRIMARY KEY (task_id, member_id))").run();
db.prepare("CREATE TABLE IF NOT EXISTS subtasks (id TEXT PRIMARY KEY, task_id TEXT, content TEXT, done INTEGER, created_at TEXT, done_at TEXT)").run();
db.prepare("CREATE TABLE IF NOT EXISTS comments (id TEXT PRIMARY KEY, task_id TEXT, author_id TEXT, content TEXT, mentions TEXT, created_at TEXT)").run();
applyMigrations(db);
db.close();
