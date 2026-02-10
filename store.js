const createStore = ({ createMember, defaultMembers }) => {
  const mode = String(process.env.STORE || "json").toLowerCase();
  if (mode === "sqlite") {
    const { createSqliteStore } = require("./store/sqliteStore");
    return createSqliteStore({ createMember, defaultMembers });
  }
  const { createJsonStore } = require("./store/jsonStore");
  return createJsonStore({ createMember, defaultMembers });
};

module.exports = { createStore };
