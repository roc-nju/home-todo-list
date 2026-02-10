const fs = require("fs");
const path = require("path");

const resolveDataFile = () => {
  if (process.env.DATA_FILE) {
    return path.resolve(process.env.DATA_FILE);
  }
  return path.join(__dirname, "..", "data.json");
};

const ensureDir = (filePath) => {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
};

const writeAtomic = (filePath, payload) => {
  ensureDir(filePath);
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, payload, "utf8");
  fs.renameSync(tempPath, filePath);
};

const createJsonStore = ({ createMember, defaultMembers }) => {
  const dataFile = resolveDataFile();
  const state = { members: [], tasks: [] };

  const saveAll = () => {
    writeAtomic(dataFile, JSON.stringify(state, null, 2));
  };

  const load = () => {
    if (fs.existsSync(dataFile)) {
      try {
        const raw = fs.readFileSync(dataFile, "utf8");
        const parsed = JSON.parse(raw);
        state.members = Array.isArray(parsed.members) ? parsed.members : [];
        state.tasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
        return;
      } catch (error) {
        state.members = [];
        state.tasks = [];
      }
    }
    state.members = defaultMembers.map(createMember);
    state.tasks = [];
    saveAll();
  };

  const upsertMember = () => {
    saveAll();
  };

  const upsertMembers = () => {
    saveAll();
  };

  const upsertTask = () => {
    saveAll();
  };

  const upsertTasks = () => {
    saveAll();
  };

  const logReminderEvents = () => {};

  const logTaskEvents = () => {};

  const getReminderStats = () => ({
    byType: [],
    byMember: [],
    byTask: []
  });

  const getReminderTrend = () => ({
    rows: []
  });

  const getTaskEventStats = () => ({
    byAction: [],
    byActor: []
  });

  const getMemberStats = () => ({
    members: []
  });

  return { state, load, saveAll, upsertMember, upsertMembers, upsertTask, upsertTasks, logReminderEvents, logTaskEvents, getReminderStats, getReminderTrend, getTaskEventStats, getMemberStats, dataFile };
};

module.exports = { createJsonStore };
