const dbConfig = process.env;

const MongoClient = require('mongodb').MongoClient;
let mongoDB = null;

module.exports ={
    connection: function() {
        if (mongoDB != null) {
            return;
        }

        const credentials = dbConfig.mongodb_username + ':' + dbConfig.mongodb_password + '@';
        const options = {
            readPreference: 'primaryPreferred',
            useUnifiedTopology: true,
            w: 1,
        };

        const url = 'mongodb://' + credentials + dbConfig.mongoConnURL + '?authSource=' + dbConfig.mongodb_auth;
        MongoClient.connect(url, options, function(err, client) {
            if (err) {
                return console.dir(err);
            }
            mongoDB = client.db(dbConfig.mongodb);
        });
    },
    getDB: function() {
        return mongoDB;
    },
};
