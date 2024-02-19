const conn = require('./connection.js');
const orchestrator = require('./orchestrator-api.js');

module.exports = function(app) {
    conn.connection();
    orchestrator.setup(app);
};
